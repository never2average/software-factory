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
 *   · A message to a DELEGATED SPECIALIST's own session is refused (409, saying what to do instead): eve cannot
 *     deliver it there and would start an unrelated conversation (lib/specialist-run-actions.ts). Every stream it
 *     serves says which kind of session it is (`x-eve-session-delegation`), so no panel offers such a message.
 *
 * Failures: a database the guard cannot read answers 503 (closed), never "let it through". Every refusal is 404.
 */
import { createHash, randomUUID } from "node:crypto";
import { routeAuth, verifyJwtEcdsa, type AuthFn } from "eve/channels/auth";
import type { Channel, HttpRouteDefinition, RouteDefinition, RouteHandlerArgs, SendFn } from "eve/channels";
import { DEFAULT_ORG, orgForSession, WorkspaceRefusedError } from "./org-context.ts";
import { agentGateDb, recordChildSession } from "./session-owners.ts";
import { isServicePrincipal, SERVICE_SCOPE_HEADER, sessionAuthForRequest, WORKSPACE_PIN_HEADER } from "./service-scope.ts";
import { localDevAllowed } from "./local-dev.ts";
import {
  sessionGateDecision,
  type GateCaller,
  type GateDecision,
  type SessionOwnership,
  type SessionRight,
} from "../../lib/chat-gate.ts";
import {
  guestSessionDecision,
  readCallerFacts,
  openedIfAdmitted,
  readLegacyOwnershipIn,
  readOwnerRecordIn,
  recordOwner,
  recordTokenHash,
  type GateDb,
} from "../../lib/session-gate.ts";
export { agentGateDb } from "./session-owners.ts";
import {
  SESSION_BOUND_ACT_CLAIM,
  SESSION_BOUND_CLAIM,
  SESSION_BOUND_TOKEN_KIND,
  SESSION_VISIBILITY_GRANT_HEADER,
  WORKSPACE_STEP_GRANT_AUDIENCE,
  WORKSPACE_STEP_GRANT_KIND,
} from "../../lib/session-token-kinds.ts";
import { claimsOf, consumePostInDb, postClaimOf, type PostClaim } from "./queue-delivery-auth.ts";
import { sessionPublicKeyPem } from "./session-public-key.ts";
import { withoutContinuationTokens } from "../../lib/chat-replay-stream.ts";
import { noticeDelegations } from "./session-lineage-stream.ts";
import { candidateParents, scanForChildren } from "./session-lineage-backfill.ts";
import { DELEGATION_EVENT_TYPES, delegationRunRecorder } from "./session-delegation-runs.ts";
import { handBackStopped, planStop, refusalMessage, retryOwed, type HandbackOutcome, type HandbackWorld, type StreamEvent } from "./specialist-handback.ts";
import { SESSION_DELEGATION_HEADER, SPECIALIST_MESSAGE_REFUSAL, SPECIALIST_MESSAGE_REFUSAL_CODE } from "../../lib/specialist-run-actions.ts";
import { handbackLedger } from "./handback-ledger.ts";

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
  /**
   * SPEND a session-bound post token (PR #63's queue delivery) — once, for exactly its claimed item's body. True when
   * this request may go on. The guard runs first on every per-session route, and eve re-runs the auth list inside
   * its handler, so this is the one place a single-use token can be spent exactly once per request.
   */
  readonly consumeSessionPost: (post: PostClaim) => Promise<boolean>;
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
  consumeSessionPost: consumePostInDb,
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
    return {
      kind: "session-bound",
      email,
      boundSessionId: attr(auth, SESSION_BOUND_CLAIM) ?? null,
      boundAct: attr(auth, SESSION_BOUND_ACT_CLAIM) ?? null,
    };
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
/**
 * How far into each session's history this process has already looked for delegations (mold_v1-133), so the skipped
 * part of a stream is read server-side at most once per process — and a scan already running is shared, not repeated.
 */
/**
 * Per session: how many of its events this process has already looked through for delegations (`cursor` — every
 * child before it is on record), and when a scan last CAUGHT UP with its live tail (`caughtUpAt`). A scan cut short
 * by its deadline moves the cursor but does not count as caught up, so the next read resumes where it stopped.
 */
const lineageState = new Map<string, { cursor: number; caughtUpAt?: number }>();
const lineageScanning = new Map<string, Promise<void>>();
const MAX_SCANNED = 5_000;
/** A tail read re-checks a caught-up session's new events at most this often (tail probes arrive every few seconds). */
const TAIL_RESCAN_MS = 60_000;
/** (caller, child id) pairs this process has already tried to recover a parent for, and failed (recoverChildLineage). */
const recoveryTried = new Map<string, number>();
const RECOVERY_RETRY_MS = 60_000;
/** For tests: forget everything cached. */
export function clearSessionGuardCache(): void {
  owners.clear();
  lineageState.clear();
  lineageScanning.clear();
  recoveryTried.clear();
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

/**
 * Who owns `sessionId`, as the REQUEST'S workspace records it — that workspace only. A session recorded in any other
 * workspace is not found here (null → refused as unknown), exactly like one nobody recorded: workspaces are not aware
 * of each other. It used to be looked up in every workspace (readOwnerRecord / readLegacyOwnership over listOrgs()).
 * The process cache answers only for the same workspace.
 */
async function ownershipOf(
  db: GateDb,
  sessionId: string,
  workspace: string | null,
): Promise<SessionOwnership | null> {
  if (!workspace) return null;
  const cached = owners.get(sessionId);
  if (cached) return cached.orgId === workspace ? cached : null;
  const recorded = await readOwnerRecordIn(db, workspace, sessionId);
  if (recorded) {
    remember(sessionId, recorded);
    return recorded;
  }
  // A session from before owners were recorded, inferred IN THIS WORKSPACE from evidence the agent or the server
  // wrote here (lib/session-gate.ts readLegacyOwnershipIn). Frozen into a record once the inference names an owner or
  // proves a workflow step, so rows written later cannot change it; an UNOWNED answer is never frozen.
  const legacy = await readLegacyOwnershipIn(db, workspace, sessionId);
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

/** Record a delegated child's owner (its parent's, in its parent's workspace), once. See agent/lib/session-lineage-stream.ts. */
async function recordChild(db: GateDb, parent: SessionOwnership, parentId: string, childId: string): Promise<void> {
  if (owners.has(childId)) return;
  const child = await recordChildSession(db, parent, parentId, childId);
  if (child) remember(childId, child);
}

/**
 * Children announced in the part of a session's history a caller is about to SKIP (a stream opened at `startIndex`
 * > 0 — the chat reopens from its transcript cache and streams only what is new — or from the tail), recorded
 * before the stream is served. The #66 live path only sees lines it forwards, so a child delegated before #66, or
 * announced while nobody streamed the parent through the guard, stayed unowned and was refused to its own owner.
 *
 * Reads eve's own history of THIS session (never anything a client wrote) from index 0, once per process, bounded
 * (agent/lib/session-lineage-backfill.ts). The child inherits this session's recorded ownership and nothing else, so
 * it reaches exactly who may read this session. A scan that fails or times out records what it found and is retried
 * by a later read.
 */
async function recordSkippedLineage(
  args: RouteHandlerArgs,
  sessionId: string,
  startIndex: number | undefined,
  ownership: SessionOwnership,
  db: GateDb,
  deps: GuardDeps,
): Promise<void> {
  if (startIndex === undefined || startIndex === 0) return; // the stream itself passes every line (noticeDelegations)
  const until = startIndex > 0 ? startIndex : undefined;
  const state = lineageState.get(sessionId);
  const cursor = state?.cursor ?? 0;
  if (until !== undefined && cursor >= until) return;
  if (until === undefined && state?.caughtUpAt !== undefined && Date.now() - state.caughtUpAt < TAIL_RESCAN_MS) return;
  const running = lineageScanning.get(sessionId);
  if (running) return running;
  const scan = (async () => {
    // Resume where this process last stopped: only the part not yet looked at is read.
    const result = await scanForChildren(
      async () => (await args.getSession(sessionId).getEventStream({ startIndex: cursor })) as ReadableStream<unknown>,
      { until: until === undefined ? undefined : until - cursor, idleMs: deps.streamProbeMs / 4, totalMs: deps.streamProbeMs },
    );
    for (const child of result.children) {
      await recordChild(db, ownership, sessionId, child).catch((error) =>
        console.error("[session-guard] could not record a delegated child session found in history", {
          sessionId,
          child,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (result.stop === "error") return;
    if (lineageState.size >= MAX_SCANNED && !lineageState.has(sessionId)) {
      lineageState.delete(lineageState.keys().next().value as string);
    }
    const caughtUp = until === undefined && (result.stop === "idle" || result.stop === "end");
    lineageState.set(sessionId, {
      cursor: Math.max(cursor + result.reached, state?.cursor ?? 0),
      caughtUpAt: caughtUp ? Date.now() : state?.caughtUpAt,
    });
  })().finally(() => lineageScanning.delete(sessionId));
  lineageScanning.set(sessionId, scan);
  return scan;
}

/**
 * A CHILD this guard has no owner for, asked for by a person: before refusing, find its parent and read the parent's
 * history once (#75 review). The rail can ask for a child a moment after its parent's stream was served from a cursor
 * (the guard waits at most LINEAGE_INLINE_MS for that history), or on another instance entirely.
 *
 *   1. A history read already running in this process is awaited (bounded) — the common, same-instance case.
 *   2. Otherwise the parent is looked for in the transcript caches of the workspace this REQUEST is in (never any
 *      other), which is where a client that holds the child's id got it from. That is only a HINT (a browser writes those rows): the candidate parent
 *      must be one the caller may READ through this same gate, and the child must appear in eve's OWN history of it.
 *      Then the child inherits the parent's recorded ownership and the request is decided again, as usual.
 *
 * Tried once per caller and child id per process per minute, so an id nobody can resolve costs one bounded attempt.
 */
async function recoverChildLineage(
  caller: GateCaller,
  childId: string,
  args: RouteHandlerArgs,
  deps: GuardDeps,
  workspace: string | null,
): Promise<boolean> {
  const db = deps.db();
  if (!db || !workspace || caller.kind !== "person" || !caller.email) return false;
  // Per CALLER and child: one person's failed attempt must never delay the real owner's.
  const attempt = `${caller.email}\u0000${childId}`;
  const tried = recoveryTried.get(attempt);
  if (tried !== undefined && Date.now() - tried < RECOVERY_RETRY_MS) return false;
  if (recoveryTried.size >= MAX_SCANNED) recoveryTried.delete(recoveryTried.keys().next().value as string);
  recoveryTried.set(attempt, Date.now());
  if (lineageScanning.size) {
    await Promise.race([Promise.allSettled([...lineageScanning.values()]), delay(deps.streamProbeMs)]);
    if (owners.has(childId) || (await readOwnerRecordIn(db, workspace, childId).catch(() => null))) return true;
  }
  const candidates = await candidateParents(db, [workspace], childId).catch(() => []);
  for (const parentId of candidates) {
    if (parentId === childId) continue;
    const parent = await decide(caller, parentId, "read", args, deps, workspace).catch(() => null);
    if (!parent?.allow || !parent.ownership) continue; // only a parent the caller may read
    const found = await scanForChildren(
      async () => (await args.getSession(parentId).getEventStream({ startIndex: 0 })) as ReadableStream<unknown>,
      { idleMs: deps.streamProbeMs / 4, totalMs: deps.streamProbeMs, stopAt: childId },
    );
    if (!found.children.includes(childId)) continue; // eve's own history does not name it: the hint was wrong
    await recordChild(db, parent.ownership, parentId, childId);
    recoveryTried.delete(attempt);
    return true;
  }
  return false;
}

/**
 * A session's COMPLETE history as of each ask, read incrementally: the first ask reads from the start, every later
 * one only what is new (a Stop polls the same two or three sessions several times).
 *
 * "Complete" is explicit, not a guess from silence. A live session's stream never ends, so each ask first takes
 * eve's LATEST event (`startIndex: -1`) and then reads forward from its cursor until it has read that very event:
 * the history is then whole as of the moment the ask began. A stream that ends is whole by definition. Anything
 * else — eve unreadable, the latest event not reached before `totalMs` — is `undefined`, and no caller decides on
 * it. (The latest event is matched by its full content, timestamp included. Two text deltas can be identical to the
 * millisecond; nothing here decides on a delta, and the boundary events it does decide on are unique.)
 */
function historyReader(args: RouteHandlerArgs, totalMs: number): (sessionId: string) => Promise<StreamEvent[] | undefined> {
  const read = new Map<string, StreamEvent[]>();
  return async (sessionId) => {
    const events = read.get(sessionId) ?? [];
    const deadline = Date.now() + totalMs;
    const latest = await probeEvent(args, sessionId, -1, Math.min(3_000, totalMs));
    if (!latest) return undefined;
    const target = JSON.stringify(latest);
    if (events.length > 0 && JSON.stringify(events[events.length - 1]) === target) return events;
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    try {
      const stream = await withTimeout(args.getSession(sessionId).getEventStream({ startIndex: events.length }), totalMs);
      if (!stream) return undefined;
      reader = (stream as ReadableStream<unknown>).getReader();
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return undefined;
        const next = await withTimeout(reader.read(), left);
        if (!next) return undefined;
        if (next.done) break;
        events.push(next.value as StreamEvent);
        read.set(sessionId, events);
        if (JSON.stringify(next.value) === target) break;
      }
      return events;
    } catch {
      return undefined;
    } finally {
      void reader?.cancel().catch(() => undefined);
    }
  };
}

/** What the Control Panel is told about the main thread, beside eve's own answer to the cancel. */
const HANDBACK_FIELD: Partial<Record<HandbackOutcome, string>> = {
  told: "main-thread-told",
  "not-delivered": "not-delivered",
  "finished-anyway": "finished-anyway",
  "main-thread-moved-on": "main-thread-moved-on",
};

/**
 * STOPPING A DELEGATED SPECIALIST (agent/lib/specialist-handback.ts has the why and the order). Returns the response
 * when this request was a stop of a delegation of its root's current turn — refused because a sibling still works,
 * or carried out — and null when it is any other cancel, which eve then handles as always.
 */
async function stopDelegatedSpecialist(
  route: HttpRouteDefinition,
  request: Request,
  args: RouteHandlerArgs,
  sessionId: string,
  parentSessionId: string,
  auth: AuthContext,
  db: GateDb,
  orgId: string,
): Promise<Response | null> {
  const world: HandbackWorld = {
    history: historyReader(args, HANDBACK_READ_MS),
    cancel: async (id, turnId) => String(((await args.getSession(id).cancel(turnId ? { turnId } : undefined)) as { status?: unknown } | undefined)?.status ?? ""),
    send: async (message, continuationToken) => {
      const session = await args.send({ message }, { auth: sessionAuthForRequest(auth, request.headers), continuationToken });
      return { id: session.id, cancel: () => session.cancel() };
    },
    sleep: delay,
    ledger: handbackLedger(db, orgId),
    nonce: () => randomUUID(),
  };
  const plan = await planStop(world, parentSessionId, sessionId);
  if (plan.kind === "refuse") {
    return Response.json(
      { ok: false, sessionId, status: "refused", error: refusalMessage(plan.name, plan.working, plan.asking) },
      { status: 409, headers: noStore },
    );
  }
  let answered: Response | undefined;
  const forward = async () => {
    answered = await route.handler(request, args);
    if (!answered.ok) return "error";
    const body = (await answered.clone().json().catch(() => null)) as { status?: unknown } | null;
    return typeof body?.status === "string" ? body.status : "";
  };
  let outcome: HandbackOutcome;
  if (plan.kind === "hand-back") {
    outcome = await handBackStopped(world, { parentSessionId, plan, cancelChild: forward });
  } else {
    // Nothing of this specialist's to stop now — but an earlier Stop may have left a hand-back it could not deliver.
    await forward();
    outcome = await retryOwed(world, parentSessionId, sessionId);
  }
  if (!answered) return null;
  const field = HANDBACK_FIELD[outcome];
  if (!field) return answered; // nothing was owed, or another request is carrying it out: eve's answer as it is
  const body = ((await answered.clone().json().catch(() => null)) as Record<string, unknown> | null) ?? { ok: true, sessionId };
  return Response.json({ ...body, handback: field }, { status: answered.status, headers: answered.headers });
}
/** Reading a session's history whole before a specialist is stopped. Generous: a wrong plan is worse than a slow Stop. */
const HANDBACK_READ_MS = 10_000;

/** How long a stream opened from a cursor waits for the skipped history to be read before it is served anyway. */
const LINEAGE_INLINE_MS = 400;
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

function startIndexOf(request: Request): number | undefined {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (raw === null || !/^-?\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The workspace a per-session request is IN — the same resolution a new session's owner is recorded under
 * (`deps.workspaceFor`: the workspace the token's `org` claim or the tab's `x-ops-org` names when its holder is a
 * member, the person's current workspace when it names none), or, for a trusted service, the workspace it names
 * (`x-workspace-scope`). Null when there is none (an identity-less caller, a personal account, a person naming a
 * workspace they are not a member of — which is never swapped for their own): the gate then finds no session and
 * refuses, and only a guest's read of the NAMED workspace's one shared chat can still be admitted (namedWorkspace).
 */
async function requestWorkspace(auth: AuthContext, caller: GateCaller, headers: Headers, deps: GuardDeps): Promise<string | null> {
  if (caller.kind === "service") return caller.serviceScope ?? null;
  if (caller.kind === "none" || caller.kind === "local-dev") return null;
  try {
    return (await deps.workspaceFor(auth, headers)) || null;
  } catch {
    return null;
  }
}

/** The workspace a person's request NAMES (x-ops-org) when it is not the one they are in: a guest's link. */
function namedWorkspace(caller: GateCaller, headers: Headers, workspace: string | null): string | null {
  if (caller.kind !== "person") return null;
  const named = headers.get(WORKSPACE_PIN_HEADER)?.trim();
  return named && named !== workspace && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(named) ? named : null;
}

async function decide(
  caller: GateCaller,
  sessionId: string,
  right: SessionRight,
  args: RouteHandlerArgs,
  deps: GuardDeps,
  workspace: string | null,
): Promise<GateDecision & { ownership: SessionOwnership | null; db: GateDb | null }> {
  if (caller.kind === "local-dev" && deps.localDevAllowed()) {
    return { allow: true, reason: "local-dev", role: "local-dev", ownership: null, db: deps.db() };
  }
  const db = deps.db();
  if (!db) throw new GateUnavailable("no database configured");
  try {
    // Reachable at all? The workspace resolver reads a failed lookup as "no membership" and answers with a fallback
    // workspace, where a cached or absent owner would then decide — so a database that is down is caught HERE, as the
    // 503 it is (it used to surface through the per-request membership read this replaced).
    await db.ping?.();
    const ownership = await ownershipOf(db, sessionId, workspace);
    const facts = await readCallerFacts(db, caller, sessionId, ownership);
    const decision = sessionGateDecision({
      caller,
      sessionId,
      right,
      ownership,
      membership: facts.membership,
      callerInWorkspace: facts.callerInWorkspace,
      localDevAllowed: deps.localDevAllowed(),
    });
    // Reading (or taking part in) a shared chat through the agent's own routes is opening it (lib/session-gate.ts).
    await openedIfAdmitted(db, decision, ownership, facts.membership, sessionId, caller.email);
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
    // A service acts for ONE workspace and must say which. Without the header its session resolved to an empty
    // fallback workspace, and it is the header that later admits it back to the session (lib/chat-gate.ts).
    if (caller.kind === "service" && !caller.serviceScope) {
      logDenied("(new)", caller, "no-workspace", CREATE_ROUTE);
      return Response.json(
        { error: `A service call must name the workspace it acts for (${SERVICE_SCOPE_HEADER}).`, ok: false },
        { status: 403, headers: noStore },
      );
    }
    const db = deps.db();
    if (!db) {
      if (caller.kind === "local-dev" && deps.localDevAllowed()) return route.handler(request, args);
      return unavailable();
    }
    // Reachable at all? The workspace resolver below reads a failed lookup as "no membership" and answers with a
    // fallback, so a database that is down must be caught HERE, as the 503 it is, before anything is started.
    try {
      await db.ping?.();
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
      // resolveOrg refuses a personal account outright; the turn would have failed the same way. A request that names
      // a workspace its person is not a member of (x-ops-org, or the token's own `org`) is refused here too, with the
      // web's words and code: nothing is started in any other workspace (org-context.ts WorkspaceRefusedError).
      if (error instanceof WorkspaceRefusedError) logDenied("(new)", caller, "workspace-refused", CREATE_ROUTE);
      return Response.json(
        {
          error: error instanceof Error ? error.message : "This account cannot start a conversation.",
          ...(error instanceof WorkspaceRefusedError ? { code: error.code } : {}),
          ok: false,
        },
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
    const { auth, caller } = who;
    // The ONE workspace this request is in; the gate reads it and no other (workspaces are not aware of each other).
    const workspace = await requestWorkspace(auth, caller, request.headers, deps);

    let decision: Awaited<ReturnType<typeof decide>>;
    try {
      decision = await decide(caller, sessionId, right, args, deps, workspace);
    } catch (error) {
      console.error("[session-guard] could not check access — refusing (503)", {
        route: key,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable();
    }
    // An unowned CHILD asked for before its parent's history was read (see recoverChildLineage): recover, decide again.
    if (!decision.allow && decision.reason === "unknown" && (await recoverChildLineage(caller, sessionId, args, deps, workspace).catch(() => false))) {
      try {
        decision = await decide(caller, sessionId, right, args, deps, workspace);
      } catch {
        return unavailable();
      }
    }
    // A GUEST of one shared chat: the request names the chat's workspace (its link), which the caller is not in. Read
    // there, by this session's id only, and admitted read-only by the owner's thread membership (lib/session-gate.ts
    // guestSessionDecision) — never as a member of that workspace, never to write.
    const named = namedWorkspace(caller, request.headers, workspace);
    if (!decision.allow && decision.reason === "unknown" && named) {
      const db = deps.db();
      try {
        const guest = db ? await guestSessionDecision(db, caller, sessionId, right, named) : null;
        if (guest) decision = { ...guest, db };
      } catch {
        return unavailable();
      }
    }
    if (!decision.allow) {
      logDenied(sessionId, caller, decision.reason, key);
      return notFound();
    }
    // A session-bound token writes ONE thing: a message POST (its body checked and the token spent below). Never a
    // cancel, nor any per-session write eve adds later.
    if (caller.kind === "session-bound" && right === "write" && key !== CONTINUE_ROUTE) {
      logDenied(sessionId, caller, "read-only", key);
      return notFound();
    }

    if (key === CONTINUE_ROUTE) {
      // A DELEGATED SPECIALIST's own session cannot take a message: its token is the one eve minted for the delegation
      // (`<parent>:<callId>`), which this channel namespaces into one no session holds, so eve would answer 200 and
      // start a new, unrelated conversation (the Control Panel's old Resume; lib/specialist-run-actions.ts has the
      // measurement). Refused before anything is spent or started, and only once access was decided, so a stranger
      // still gets the plain 404.
      if (decision.ownership?.source === "lineage") {
        return Response.json(
          { error: SPECIALIST_MESSAGE_REFUSAL, code: SPECIALIST_MESSAGE_REFUSAL_CODE, ok: false },
          { status: 409, headers: noStore },
        );
      }
      // Read the body once, check its token belongs to THIS session, and hand eve an identical request.
      const text = await request.text();
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text) as unknown;
        body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        body = null; // eve answers "Invalid JSON body." itself
      }
      if (caller.kind === "session-bound") {
        // Spent here, once: the claimed queued item's exact body, a higher seq than any admitted before.
        const post = postClaimOf(claimsOf(request), sessionId, body);
        let spent = false;
        try {
          spent = Boolean(post) && (await deps.consumeSessionPost(post as PostClaim));
        } catch {
          return unavailable();
        }
        if (!spent) {
          logDenied(sessionId, caller, "read-only", key);
          return notFound();
        }
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

    const { ownership, db } = decision;
    // Children announced in the history this reader skips get their owner on record first (mold_v1-133).
    if (key === STREAM_ROUTE && ownership && db) {
      // Bounded: the reopen-from-cache path and the tail probes are latency-sensitive. A cursor read waits at most
      // LINEAGE_INLINE_MS for the (usually instant) history read; a tail read never waits. Either way the read
      // finishes in the background (waitUntil), so the children are on record moments later at worst.
      const startIndex = startIndexOf(request);
      const scan = recordSkippedLineage(args, sessionId, startIndex, ownership, db, deps).catch(() => undefined);
      try {
        args.waitUntil?.(scan);
      } catch {
        /* no request lifetime to extend (tests, local) */
      }
      if (startIndex !== undefined && startIndex > 0) await Promise.race([scan, delay(LINEAGE_INLINE_MS)]);
    }
    // A delegated specialist stopped on its own would leave its parent waiting in silence, for ever: end the waiting
    // turn and tell the main agent, or refuse while a sibling still works (agent/lib/specialist-handback.ts).
    const parentId = ownership?.rootSessionId;
    if (key === CANCEL_ROUTE && parentId && parentId !== sessionId) {
      const parent = await decide(caller, parentId, "write", args, deps, workspace).catch(() => null);
      if (parent?.allow && db && ownership) {
        const stopped = await stopDelegatedSpecialist(route, request, args, sessionId, parentId, auth, db, ownership.orgId);
        if (stopped) return stopped;
      }
    }
    const response = await route.handler(request, args);
    if (key !== STREAM_ROUTE || !response.ok || !response.body) return response;
    let body = response.body as ReadableStream<Uint8Array>;
    // Every delegation this stream announces gets its child's owner on record before the announcement goes out.
    // …and each delegation's run history (a child that died before its first turn, a child parked on a question) is
    // recorded from the same pass: `subagent.called` reaches no authored hook in eve 0.25.1 (session-delegation-runs.ts).
    if (ownership && db) {
      body = noticeDelegations(body, (child) => recordChild(db, ownership, sessionId, child), {
        eventTypes: DELEGATION_EVENT_TYPES,
        handle: delegationRunRecorder(sessionId, undefined, ownership.orgId),
      });
    }
    // A viewer reads the conversation, never the capability to continue it.
    if (decision.role === "viewer") body = withoutContinuationTokens(body);
    // Say whether this session is a delegation, by the fact a message to it is refused on (above), so a panel never
    // offers a message, a steer or a Resume that can only be refused (lib/specialist-run-actions.ts).
    const headers = new Headers(response.headers);
    if (ownership) headers.set(SESSION_DELEGATION_HEADER, ownership.source === "lineage" ? "1" : "0");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
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
