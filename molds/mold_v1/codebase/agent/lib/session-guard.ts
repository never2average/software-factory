/**
 * THE SESSION GUARD — ownership enforced by the agent itself, in front of eve's per-session routes.
 *
 * eve 0.25.1's HTTP channel (`eve/channels/eve`) serves four session routes, and each one runs `routeAuth` —
 * AUTHENTICATION — and then acts on whatever session id it was given:
 *
 *     POST /eve/v1/session                  create
 *     POST /eve/v1/session/:sessionId       a message, approval answers (`inputResponses`), or both
 *     GET  /eve/v1/session/:sessionId/stream  the whole transcript, from any index
 *     POST /eve/v1/session/:sessionId/cancel  stop the running turn
 *
 * The channel's only hook, `onMessage`, runs for messages alone (not approvals, not reads, not cancels) and cannot
 * see the session's owner. eve 0.25.1 has no route middleware and no per-session read hook. So a signed-in person
 * from ANY workspace, calling the agent's own deployment directly with a session id (they appear in `?chatSession=`
 * links and shared threads), read the whole transcript — the continuation token included — posted into it,
 * answered its approvals and cancelled it. The web app's proxy checked ownership, but the agent API is its own
 * public project and nothing makes a caller go through the web app.
 *
 * THE INTERCEPTION POINT. A channel is a plain value — `{ __kind, routes: [{ transport, method, path, handler }],
 * adapter, cors, receive }` (eve/dist/src/public/definitions/channel.js) — and eve dispatches each request to
 * `route.handler(request, args)`. So agent/channels/eve.ts builds eve's own channel and exports it through
 * {@link guardSessionRoutes}, which replaces each per-session handler with one that authenticates the caller with
 * the SAME auth list, decides with the shared rule (lib/chat-gate.ts over lib/session-gate.ts, exactly what the web
 * proxy uses), and only then calls eve's handler. Nothing of eve's is patched or forked, and an eve upgrade that
 * renames or adds a per-session route fails this module's route check at startup (or is gated as a write) rather
 * than silently shipping an unguarded route.
 *
 * What the wrapper adds beyond the decision:
 *
 *   · CREATE records the owner. The owner, workspace and token hash are written (agent_session_owners) inside eve's
 *     own `send`, after the session exists and BEFORE the response that carries its id is returned — so there is no
 *     moment at which anyone but the agent knows an id that has no owner. If the write fails, the new session's turn
 *     is cancelled and the caller gets 503: an unowned session is one nobody can ever reach, which is the safe side.
 *   · A MESSAGE is bound to its session by its continuation token. eve delivers a POST by TOKEN and ignores the id in
 *     the path (eve/dist/src/channel/send.js), so a caller admitted to their own session could otherwise deliver
 *     into any session whose token they held. The token must hash to the session's recorded token, or (for a session
 *     created before the record, or a subagent's child) be the one its latest `session.waiting` carries.
 *   · A SUBAGENT's child session belongs to its parent's owner. eve creates it, so no create route records it; its id
 *     reaches clients only on the parent's stream (`subagent.called`), which this guard serves — so the guard records
 *     the child's owner as that line passes, before forwarding it (agent/lib/session-lineage-stream.ts).
 *   · A VIEWER's stream is served without continuation tokens.
 *
 * Failures: a database the guard cannot read answers 503 (closed), never "let it through". Every refusal is 404.
 */
import { createHash } from "node:crypto";
import { routeAuth, verifyJwtEcdsa, type AuthFn } from "eve/channels/auth";
import type { Channel, HttpRouteDefinition, RouteDefinition, RouteHandlerArgs, SendFn } from "eve/channels";
import { DEFAULT_ORG, orgForSession } from "./org-context.ts";
import { agentGateDb, recordChildSession } from "./session-owners.ts";
import { isServicePrincipal, SERVICE_SCOPE_HEADER, sessionAuthForRequest } from "./service-scope.ts";
import { localDevAllowed } from "./local-dev.ts";
import {
  sessionGateDecision,
  type GateCaller,
  type GateDecision,
  type SessionOwnership,
  type SessionRight,
} from "../../lib/chat-gate.ts";
import {
  readCallerFacts,
  readLegacyOwnership,
  readOwnerRecord,
  recordOwner,
  recordTokenHash,
  type GateDb,
} from "../../lib/session-gate.ts";
export { agentGateDb } from "./session-owners.ts";
import {
  SESSION_BOUND_CLAIM,
  SESSION_BOUND_TOKEN_KIND,
  SESSION_VISIBILITY_GRANT_HEADER,
  WORKSPACE_STEP_GRANT_AUDIENCE,
  WORKSPACE_STEP_GRANT_KIND,
} from "../../lib/session-token-kinds.ts";
import { sessionPublicKeyPem } from "./session-public-key.ts";
import { withoutContinuationTokens } from "../../lib/chat-replay-stream.ts";
import { noticeDelegations } from "./session-lineage-stream.ts";

type AuthContext = Exclude<Awaited<ReturnType<typeof routeAuth>>, Response>;
type Handler = HttpRouteDefinition["handler"];

export const CREATE_ROUTE = "POST /eve/v1/session";
export const CONTINUE_ROUTE = "POST /eve/v1/session/:sessionId";
export const STREAM_ROUTE = "GET /eve/v1/session/:sessionId/stream";
export const CANCEL_ROUTE = "POST /eve/v1/session/:sessionId/cancel";
const EXPECTED = [CREATE_ROUTE, CONTINUE_ROUTE, STREAM_ROUTE, CANCEL_ROUTE];

/** What the guard needs from the world. Injected by the handler-level test; defaulted to the agent's own. */
export interface GuardDeps {
  /** The database, or null when none is configured (then every guarded route answers 503). */
  readonly db: () => GateDb | null;
  /** The workspace a new session acts for — the same resolution its turns will make (org-context.ts). */
  readonly workspaceFor: (auth: AuthContext, headers: Headers) => Promise<string>;
  readonly localDevAllowed: () => boolean;
  /** How long to wait on eve's own event stream when checking a continuation token against its tail. */
  readonly streamProbeMs: number;
  /** The email a workspace-step grant was signed for, or null when it does not verify. */
  readonly grantEmail: (grant: string) => Promise<string | null>;
}

export interface GuardOptions {
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly deps?: Partial<GuardDeps>;
}

const defaultDeps: GuardDeps = {
  db: agentGateDb,
  async workspaceFor(auth, headers) {
    // Exactly the auth the session will carry (onMessage's projection), through the resolver every turn uses.
    const current = sessionAuthForRequest(auth, headers);
    return orgForSession({ session: { auth: { current, initiator: current } } });
  },
  localDevAllowed: () => localDevAllowed(),
  streamProbeMs: 3_000,
  async grantEmail(grant) {
    const publicKey = sessionPublicKeyPem();
    if (!publicKey) return null;
    const verified = await verifyJwtEcdsa(grant, {
      algorithm: "ES256",
      publicKey,
      issuer: "delivered",
      audiences: [WORKSPACE_STEP_GRANT_AUDIENCE],
      claims: { kind: [WORKSPACE_STEP_GRANT_KIND] },
    });
    if (!verified.ok) return null;
    const email = verified.sessionAuth.attributes?.email;
    return typeof email === "string" ? email.trim().toLowerCase() : null;
  },
};

/* ---- who is asking ------------------------------------------------------------------------------------------ */

function attr(auth: AuthContext, key: string): string | undefined {
  const v = auth.attributes?.[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** The verified caller, in the terms the rule speaks. Only token-derived fields; one header, and only for a service. */
export function callerOf(auth: AuthContext, headers: Headers): GateCaller {
  const email = (attr(auth, "email") ?? (auth.subject?.includes("@") ? auth.subject : undefined))?.trim().toLowerCase() || null;
  // Bound to ONE session: the queue-delivery kind, or ANY token naming a session in `sid`. Decided FIRST and for every
  // authenticator, so no door that admits such a token — PR #63's, or one added later — can make it more than a
  // token for that one session and its owner (lib/session-token-kinds.ts).
  if (attr(auth, "kind") === SESSION_BOUND_TOKEN_KIND || attr(auth, SESSION_BOUND_CLAIM) !== undefined) {
    return { kind: "session-bound", email, boundSessionId: attr(auth, SESSION_BOUND_CLAIM) ?? null };
  }
  if (auth.authenticator === "local-dev") return { kind: "local-dev", email: null, principalId: auth.principalId };
  if (isServicePrincipal(auth)) {
    return {
      kind: "service",
      email: null,
      principalId: auth.principalId,
      serviceScope: headers.get(SERVICE_SCOPE_HEADER)?.trim() || null,
    };
  }
  if (email) return { kind: "person", email, principalId: auth.principalId };
  if (auth.principalId) return { kind: "principal", email: null, principalId: auth.principalId };
  return { kind: "none", email: null };
}

/* ---- responses ---------------------------------------------------------------------------------------------- */

const noStore = { "cache-control": "no-store" };
/** The one refusal. Worded like eve's own "Session not found." so a stranger learns nothing from it. */
const notFound = () => Response.json({ error: "Session not found.", ok: false }, { status: 404, headers: noStore });
const unavailable = () =>
  Response.json(
    { error: "Conversation access could not be checked right now. Try again in a moment.", ok: false },
    { status: 503, headers: { ...noStore, "retry-after": "5" } },
  );

class GateUnavailable extends Error {}
class OwnerNotRecorded extends Error {}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/* ---- ownership: the shared reads, plus a process cache and a one-time freeze of legacy inference ------------- */

/** Recorded ownership never changes, so a hit is good for the life of the process. */
const owners = new Map<string, SessionOwnership>();
const MAX_OWNERS = 5_000;
function remember(sessionId: string, ownership: SessionOwnership) {
  if (owners.size >= MAX_OWNERS) owners.delete(owners.keys().next().value as string);
  owners.set(sessionId, ownership);
}
/** For tests: forget everything cached. */
export function clearSessionGuardCache(): void {
  owners.clear();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The first event eve holds for a session at `startIndex` (0 = its start, -1 = its latest), or undefined. */
async function probeEvent(
  args: RouteHandlerArgs,
  sessionId: string,
  startIndex: number,
  ms: number,
): Promise<{ type?: string; data?: Record<string, unknown> } | undefined> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  try {
    const stream = await withTimeout(args.getSession(sessionId).getEventStream({ startIndex }), ms);
    if (!stream) return undefined;
    reader = (stream as ReadableStream<unknown>).getReader();
    const first = await withTimeout(reader.read(), ms);
    return first && !first.done ? (first.value as { type?: string; data?: Record<string, unknown> }) : undefined;
  } catch {
    return undefined;
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
}

async function ownershipOf(
  db: GateDb,
  sessionId: string,
  preferOrgs: readonly string[],
): Promise<SessionOwnership | null> {
  const cached = owners.get(sessionId);
  if (cached) return cached;
  const recorded = await readOwnerRecord(db, sessionId, preferOrgs);
  if (recorded) {
    remember(sessionId, recorded);
    return recorded;
  }
  // A session from before owners were recorded (lib/session-gate.ts readLegacyOwnership). Frozen into a record once
  // the inference names an owner or proves a workflow step, so rows written later cannot change it; an UNOWNED answer
  // is never frozen, so the real owner can still reach it once the chat list mirrors it.
  const legacy = await readLegacyOwnership(db, sessionId);
  if (legacy && (legacy.ownerEmail || legacy.visibility === "workspace")) {
    await recordOwner(db, {
      sessionId,
      orgId: legacy.orgId,
      ownerEmail: legacy.ownerEmail,
      ownerPrincipal: null,
      ownerKind: legacy.ownerKind,
      visibility: legacy.visibility,
    });
    remember(sessionId, legacy);
  }
  return legacy;
}

/** Record a delegated child's owner (its parent's), once. See agent/lib/session-lineage-stream.ts. */
async function recordChild(db: GateDb, parent: SessionOwnership, parentId: string, childId: string): Promise<void> {
  if (owners.has(childId)) return;
  const child = await recordChildSession(db, parentId, childId, [parent.orgId]);
  if (child) remember(childId, child);
}

async function decide(
  caller: GateCaller,
  sessionId: string,
  right: SessionRight,
  args: RouteHandlerArgs,
  deps: GuardDeps,
): Promise<GateDecision & { ownership: SessionOwnership | null; db: GateDb | null }> {
  if (caller.kind === "local-dev" && deps.localDevAllowed()) {
    return { allow: true, reason: "local-dev", role: "local-dev", ownership: null, db: deps.db() };
  }
  const db = deps.db();
  if (!db) throw new GateUnavailable("no database configured");
  try {
    const callerOrgs = caller.kind === "person" && caller.email ? await db.orgsOf(caller.email) : [];
    const ownership = await ownershipOf(db, sessionId, callerOrgs);
    const facts = await readCallerFacts(db, caller, sessionId, ownership, callerOrgs);
    const decision = sessionGateDecision({
      caller,
      sessionId,
      right,
      ownership,
      membership: facts.membership,
      callerInWorkspace: facts.callerInWorkspace,
      localDevAllowed: deps.localDevAllowed(),
    });
    return { ...decision, ownership, db };
  } catch (error) {
    throw new GateUnavailable(error instanceof Error ? error.message : String(error));
  }
}

function logDenied(sessionId: string, caller: GateCaller, reason: string, route: string) {
  // Who reached for what — never a token, never a body.
  console.warn(
    `[session-guard] refused ${JSON.stringify({
      route,
      sessionId,
      caller: caller.email ?? caller.principalId ?? caller.kind,
      kind: caller.kind,
      reason,
    })}`,
  );
}

/* ---- the wrappers ------------------------------------------------------------------------------------------- */

type Authenticated = { auth: AuthContext; caller: GateCaller } | Response;
async function authenticate(request: Request, opts: GuardOptions): Promise<Authenticated> {
  const auth = await routeAuth(request, opts.auth);
  if (auth instanceof Response) return auth;
  return { auth, caller: callerOf(auth, request.headers) };
}

function wrapCreate(route: HttpRouteDefinition, opts: GuardOptions, deps: GuardDeps): Handler {
  return async (request, args) => {
    const who = await authenticate(request, opts);
    if (who instanceof Response) return who;
    const { auth, caller } = who;
    // A session-bound token acts on its one session and never starts one; an identity-less caller owns nothing.
    if (caller.kind === "session-bound" || caller.kind === "none") {
      logDenied("(new)", caller, caller.kind === "none" ? "no-caller" : "wrong-session", CREATE_ROUTE);
      return notFound();
    }
    const db = deps.db();
    if (!db) {
      if (caller.kind === "local-dev" && deps.localDevAllowed()) return route.handler(request, args);
      return unavailable();
    }
    // Reachable at all? The workspace resolver below reads a failed lookup as "no membership" and answers with a
    // fallback, so a database that is down must be caught HERE, as the 503 it is, before anything is started.
    try {
      await db.listOrgs();
    } catch (error) {
      console.error("[session-guard] database unreachable — not starting a session (503)", {
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable();
    }
    let orgId: string;
    try {
      orgId = await deps.workspaceFor(auth, request.headers);
    } catch (error) {
      // resolveOrg refuses a personal account outright; the turn would have failed the same way.
      return Response.json(
        { error: error instanceof Error ? error.message : "This account cannot start a conversation.", ok: false },
        { status: 403, headers: noStore },
      );
    }
    // Workspace-visible only for a service (it acts for the workspace) or with the web app's signed grant for THIS
    // person — never on a header any client can set (lib/session-token-kinds.ts). Colleagues then only read.
    const grant = request.headers.get(SESSION_VISIBILITY_GRANT_HEADER)?.trim();
    const granted =
      caller.kind === "person" && Boolean(grant) && (await deps.grantEmail(grant as string).catch(() => null)) === caller.email;
    const visibility = caller.kind === "service" || granted ? "workspace" : "owner";
    const owner = {
      orgId,
      ownerEmail: caller.kind === "person" ? caller.email : null,
      ownerPrincipal: caller.kind === "person" ? null : (caller.principalId ?? null),
      ownerKind: caller.kind,
      visibility,
    };
    const send: SendFn = async (payload, options) => {
      const session = await args.send(payload, options);
      try {
        await recordOwner(db, {
          sessionId: session.id,
          ...owner,
          tokenSha256: session.continuationToken ? sha256(session.continuationToken) : null,
        });
        remember(session.id, {
          ...owner,
          rootSessionId: null,
          tokenSha256: session.continuationToken ? sha256(session.continuationToken) : null,
          source: "record",
        });
      } catch (error) {
        console.error("[session-guard] could not record the owner of a new session; cancelling it", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await session.cancel().catch(() => undefined);
        throw new OwnerNotRecorded();
      }
      return session;
    };
    try {
      return await route.handler(request, { ...args, send });
    } catch (error) {
      if (error instanceof OwnerNotRecorded) return unavailable();
      throw error;
    }
  };
}

/** Is `token` this session's continuation token? `unverifiable` = no record and eve's tail does not show it. */
async function tokenCheck(
  token: string,
  sessionId: string,
  ownership: SessionOwnership | null,
  db: GateDb | null,
  args: RouteHandlerArgs,
  deps: GuardDeps,
): Promise<"ok" | "mismatch" | "unverifiable"> {
  const hashed = sha256(token);
  if (ownership?.tokenSha256) return ownership.tokenSha256 === hashed ? "ok" : "mismatch";
  // No hash on record (a session older than the record, or a subagent's child). A parked session's latest event is
  // the `session.waiting` that carries its current token — eve's own tail, not anything the caller sent.
  const latest = await probeEvent(args, sessionId, -1, deps.streamProbeMs);
  if (latest?.type === "session.waiting" && typeof latest.data?.continuationToken === "string") {
    if (latest.data.continuationToken !== token) return "mismatch";
    if (ownership && db) {
      await recordTokenHash(db, ownership.orgId, sessionId, hashed).catch(() => undefined);
      remember(sessionId, { ...ownership, tokenSha256: hashed });
    }
    return "ok";
  }
  return "unverifiable";
}

function wrapPerSession(route: HttpRouteDefinition, key: string, opts: GuardOptions, deps: GuardDeps): Handler {
  const right: SessionRight = key === STREAM_ROUTE ? "read" : "write";
  return async (request, args) => {
    const sessionId = args.params?.sessionId;
    if (!sessionId) return route.handler(request, args); // eve answers "Missing session id." itself
    const who = await authenticate(request, opts);
    if (who instanceof Response) return who;
    const { caller } = who;

    let decision: Awaited<ReturnType<typeof decide>>;
    try {
      decision = await decide(caller, sessionId, right, args, deps);
    } catch (error) {
      console.error("[session-guard] could not check access — refusing (503)", {
        route: key,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable();
    }
    if (!decision.allow) {
      logDenied(sessionId, caller, decision.reason, key);
      return notFound();
    }

    if (key === CONTINUE_ROUTE) {
      // Read the body once, check its token belongs to THIS session, and hand eve an identical request.
      const text = await request.text();
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text) as unknown;
        body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        body = null; // eve answers "Invalid JSON body." itself
      }
      const token = typeof body?.continuationToken === "string" && body.continuationToken ? body.continuationToken : null;
      if (token && decision.role !== "local-dev") {
        let verdict: "ok" | "mismatch" | "unverifiable";
        try {
          verdict = await tokenCheck(token, sessionId, decision.ownership, decision.db, args, deps);
        } catch {
          return unavailable();
        }
        if (verdict === "mismatch") {
          logDenied(sessionId, caller, "token-of-another-session", key);
          return notFound();
        }
        if (verdict === "unverifiable") {
          return Response.json(
            { error: "This conversation is busy. Try again in a moment.", ok: false },
            { status: 409, headers: noStore },
          );
        }
      }
      const forwarded = new Request(request.url, { method: request.method, headers: request.headers, body: text });
      const ownership = decision.ownership;
      const db = decision.db;
      // eve starts a NEW session when the token is no longer live (a finished session). It continues this
      // conversation, so it belongs to whoever owns this one — recorded before its id is returned, like a create.
      const send: SendFn = async (payload, options) => {
        const session = await args.send(payload, options);
        if (session.id !== sessionId && db) {
          const inherited = ownership ?? {
            orgId: DEFAULT_ORG,
            ownerEmail: null,
            ownerPrincipal: caller.principalId ?? null,
            ownerKind: caller.kind,
            visibility: "owner",
            rootSessionId: null,
            tokenSha256: null,
            source: "record" as const,
          };
          const tokenSha256 = options.continuationToken ? sha256(options.continuationToken) : null;
          try {
            await recordOwner(db, {
              sessionId: session.id,
              orgId: inherited.orgId,
              ownerEmail: inherited.ownerEmail,
              ownerPrincipal: inherited.ownerPrincipal,
              ownerKind: inherited.ownerKind,
              visibility: inherited.visibility,
              rootSessionId: inherited.rootSessionId,
              tokenSha256,
            });
            remember(session.id, { ...inherited, tokenSha256, source: "record" });
          } catch (error) {
            console.error("[session-guard] could not record the owner of a re-started session; cancelling it", {
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
            await session.cancel().catch(() => undefined);
            throw new OwnerNotRecorded();
          }
        }
        return session;
      };
      try {
        return await route.handler(forwarded, { ...args, send });
      } catch (error) {
        if (error instanceof OwnerNotRecorded) return unavailable();
        throw error;
      }
    }

    const response = await route.handler(request, args);
    if (key !== STREAM_ROUTE || !response.ok || !response.body) return response;
    let body = response.body as ReadableStream<Uint8Array>;
    // Every delegation this stream announces gets its child's owner on record before the announcement goes out.
    const { ownership, db } = decision;
    if (ownership && db) body = noticeDelegations(body, (child) => recordChild(db, ownership, sessionId, child));
    // A viewer reads the conversation, never the capability to continue it.
    if (decision.role === "viewer") body = withoutContinuationTokens(body);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** The route key eve dispatches on. */
const keyOf = (route: RouteDefinition): string => `${route.method.toUpperCase()} ${route.path}`;

/**
 * eve's channel with every per-session route behind the ownership gate. Throws at startup if eve's routes are not
 * the ones this was written against — an unguarded route must never ship because a path was renamed.
 */
export function guardSessionRoutes<C extends Channel>(channel: C, opts: GuardOptions): C {
  const deps: GuardDeps = { ...defaultDeps, ...opts.deps };
  const keys = new Set(channel.routes.map(keyOf));
  const missing = EXPECTED.filter((k) => !keys.has(k));
  if (missing.length) {
    throw new Error(
      `session-guard: eve's HTTP channel no longer serves ${missing.join(", ")}. Re-read eve/dist/src/public/channels/eve.js and update agent/lib/session-guard.ts before shipping.`,
    );
  }
  const routes = channel.routes.map((route): RouteDefinition => {
    if (route.transport === "websocket") {
      if (route.path.includes(":sessionId")) {
        throw new Error(`session-guard: unguarded WebSocket session route ${route.path}`);
      }
      return route;
    }
    const key = keyOf(route);
    if (key === CREATE_ROUTE) return { ...route, handler: wrapCreate(route, opts, deps) };
    // Every route that names a session — including any eve adds later — is gated; an unknown one as a write.
    if (route.path.includes(":sessionId")) return { ...route, handler: wrapPerSession(route, key, opts, deps) };
    return route;
  });
  return { ...channel, routes } as C;
}
