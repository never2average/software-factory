/**
 * THE READS BEHIND THE SESSION GATE — one implementation, used by the agent and by the web proxy.
 *
 * The rule is `sessionGateDecision` (lib/chat-gate.ts). This file reads the facts it is decided on: who owns the
 * session, whether the caller is a live member of a thread the owner shared, whether the caller belongs to the
 * session's workspace. The agent (agent/lib/session-guard.ts) and the web proxy (lib/chat-session-access.ts) each
 * hand it their own way into the database — `withOrgDb` and `withOrgRls` have the same shape — and nothing else,
 * so the two cannot read different things and reach different answers.
 *
 * Nothing here swallows a database error. A gate that cannot read refuses; the callers answer 503.
 *
 * Relative imports with their extensions: the agent's bundler, Next's and plain node (the tests) all load this.
 *
 * ONE WORKSPACE PER REQUEST. Workspaces are not aware of each other: every read here is made in the ONE workspace the
 * request is in — the caller's, resolved before the gate runs — and nothing here lists the workspaces or looks a
 * session up in any other. A session recorded in another workspace is simply not found (and refused, 404) exactly
 * like a session nobody recorded. It used to be looked up in EVERY workspace (`readOwnerRecord`, `readLegacyOwnership`
 * over `listOrgs()`), so a request made in workspace B read workspace A's scope to decide. The cross-workspace
 * inference that the legacy (pre-#66) sessions still need is a SYSTEM backfill now, run once by the factory
 * (agent/lib/session-owner-backfill.ts, scripts/backfill-session-owners.mjs), never on a person's request.
 *
 * tenancy-ok: every tenant-table statement runs inside `deps.inOrg(orgId, …)` (the workspace's RLS scope). The
 * only reads outside one are `org_members` via `deps.orgsOf` — the tenancy control plane, which carries no RLS
 * (scripts/bootstrap-test-db.mjs EXEMPT), and only the CALLER's own memberships.
 */
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../agent/lib/db/schema.ts";
import {
  agentSessionOwners,
  agentSessionScopes,
  appVersions,
  apps,
  chatSessions,
  chatThreadMembers,
  chatThreads,
  workflowRunJournal,
} from "../agent/lib/db/schema.ts";
import {
  sessionGateDecision,
  type GateCaller,
  type GateDecision,
  type SessionOwnership,
  type SessionRight,
} from "./chat-gate.ts";
import { guestInviteLive } from "./guest-invite-rules.ts";

type Tx = PostgresJsDatabase<typeof schema>;

/**
 * The database, as each side reaches it on a REQUEST path. There is deliberately no way to list the workspaces here:
 * a request reads the one workspace it is in (see the header). The system paths that must enumerate workspaces (the
 * owner backfill) take a `SystemGateDb` (agent/lib/session-owner-backfill.ts), which no request handler may reach —
 * `npm run check:tenancy` fails if one does.
 */
export interface GateDb {
  /** Run `fn` inside workspace `orgId`'s RLS scope (withOrgDb / withOrgRls). */
  inOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The workspaces `email` belongs to (`org_members`, control plane): the CALLER's own memberships, nobody else's. */
  orgsOf(email: string): Promise<string[]>;
  /** Is the database reachable at all? Throws when it is not (the create route answers 503 before starting anything). */
  ping?(): Promise<void>;
}

const norm = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/** A session's recorded owner IN ONE WORKSPACE (inside its RLS scope), or null. */
export async function readOwnerRecordIn(
  db: Pick<GateDb, "inOrg">,
  orgId: string,
  sessionId: string,
): Promise<SessionOwnership | null> {
  const [row] = await db.inOrg(orgId, (tx) =>
    tx.select().from(agentSessionOwners).where(eq(agentSessionOwners.sessionId, sessionId)).limit(1),
  );
  if (!row || row.orgId !== orgId) return null;
  return {
    orgId: row.orgId,
    ownerEmail: row.ownerEmail ? norm(row.ownerEmail) : null,
    ownerPrincipal: row.ownerPrincipal,
    ownerKind: row.ownerKind,
    visibility: row.visibility,
    rootSessionId: row.rootSessionId,
    tokenSha256: row.tokenSha256,
    source: row.parentSessionId ? "lineage" : "record",
  };
}

/** What one workspace holds about a session from before owners were recorded (read inside that workspace's scope). */
export interface LegacyEvidence {
  readonly orgId: string;
  /** An `agent_session_scopes` row IN this workspace (written by the agent, from a verified token). */
  readonly scoped: boolean;
  /** Owners of shared threads on it (a thread row anybody can write — never an anchor, only an owner hint). */
  readonly threadOwners: readonly string[];
  /** People with a chat-list row for it in this workspace (browser-written — never an anchor). */
  readonly claimants: readonly string[];
  /** A workflow / app / cron step names it here (server-written). */
  readonly step: boolean;
}

/** Read one workspace's evidence about `sessionId`, inside that workspace's RLS scope. */
export async function readLegacyEvidenceIn(
  db: Pick<GateDb, "inOrg">,
  orgId: string,
  sessionId: string,
): Promise<LegacyEvidence> {
  return db.inOrg(orgId, async (tx) => {
    const [scope] = await tx
      .select({ sessionId: agentSessionScopes.sessionId, orgId: agentSessionScopes.orgId })
      .from(agentSessionScopes)
      .where(eq(agentSessionScopes.sessionId, sessionId))
      .limit(1);
    const threads = await tx
      .select({ ownerEmail: chatThreads.ownerEmail, orgId: chatThreads.orgId })
      .from(chatThreads)
      .where(eq(chatThreads.eveSessionId, sessionId));
    const mirrors = await tx
      .select({ ownerEmail: chatSessions.ownerEmail, orgId: chatSessions.orgId })
      .from(chatSessions)
      .where(eq(chatSessions.eveSessionId, sessionId));
    const [journal] = await tx
      .select({ runId: workflowRunJournal.runId, orgId: workflowRunJournal.orgId })
      .from(workflowRunJournal)
      .where(or(eq(workflowRunJournal.sessionId, sessionId), eq(workflowRunJournal.childSessionId, sessionId)))
      .limit(1);
    const [app] = journal
      ? []
      : await tx.select({ id: apps.id, orgId: apps.orgId }).from(apps).where(eq(apps.lastSessionId, sessionId)).limit(1);
    const [version] = journal || app
      ? []
      : await tx
          .select({ id: appVersions.id, orgId: appVersions.orgId })
          .from(appVersions)
          .where(eq(appVersions.sessionId, sessionId))
          .limit(1);
    // Each piece counts for THIS workspace only when its own org_id says so — not merely because the scope let the
    // row through (a policy that is permissive, or a row read on a wider handle, must not move evidence between
    // workspaces).
    const here = <T extends { orgId: string | null }>(rows: T[]) => rows.filter((r) => r.orgId === orgId);
    return {
      orgId,
      scoped: Boolean(scope && scope.orgId === orgId),
      threadOwners: [...new Set(here(threads).map((t) => norm(t.ownerEmail)).filter(Boolean))],
      claimants: [...new Set(here(mirrors).map((m) => norm(m.ownerEmail)).filter(Boolean))],
      step: Boolean((journal && journal.orgId === orgId) || (app && app.orgId === orgId) || (version && version.orgId === orgId)),
    };
  });
}

/**
 * The ownership one workspace's evidence proves, or null. Each kind of row is trusted for exactly one thing:
 *
 *   · the thread owner (one), else the ONLY claimant with a chat row, names the OWNER — two claimants prove nothing;
 *   · a workflow / app / cron step makes the session WORKSPACE-visible (colleagues may read);
 *   · `agent_session_scopes.principal_email` is never read as an owner: it was last-writer-wins while any signed-in
 *     caller could post into any session.
 */
export function ownershipFromEvidence(evidence: LegacyEvidence): SessionOwnership | null {
  const ownerEmail =
    evidence.threadOwners.length > 0
      ? evidence.threadOwners.length === 1
        ? evidence.threadOwners[0]
        : null
      : evidence.claimants.length === 1
        ? evidence.claimants[0]
        : null;
  if (!ownerEmail && !evidence.step) return null;
  return {
    orgId: evidence.orgId,
    ownerEmail,
    ownerPrincipal: null,
    ownerKind: ownerEmail ? "person" : "step",
    visibility: evidence.step ? "workspace" : "owner",
    rootSessionId: null,
    tokenSha256: null,
    source: "legacy",
  };
}

/**
 * OWNERSHIP OF A SESSION CREATED BEFORE THE AGENT RECORDED OWNERS (#66), inferred IN ONE WORKSPACE — the request's.
 *
 * Only when that workspace holds SERVER-written evidence that the session is its own: the agent's scope row, or a
 * workflow / app / cron step. Chat-list rows and thread rows are written by browsers, so on their own they anchor
 * nothing: a member of workspace B could file one in B for a session of A, and B's own evidence would then name them.
 * With an anchor, the owner is read from this workspace's rows only ({@link ownershipFromEvidence}), so nothing any
 * other workspace holds can change the answer — and nothing any other workspace holds is read.
 *
 * A legacy session with no anchor (older than migration 0016, and never a step) is UNOWNED on the request path. The
 * factory's one-time owner backfill (agent/lib/session-owner-backfill.ts) records those — reading across workspaces,
 * as a system job, never as part of a person's request — and from then on the record decides.
 */
export async function readLegacyOwnershipIn(
  db: Pick<GateDb, "inOrg">,
  orgId: string,
  sessionId: string,
): Promise<SessionOwnership | null> {
  const evidence = await readLegacyEvidenceIn(db, orgId, sessionId);
  if (!evidence.scoped && !evidence.step) return null;
  return ownershipFromEvidence(evidence);
}

/**
 * The caller's live membership of a thread the OWNER shared on this session (or on its root), or null.
 *
 * Three conditions, each of which used to be missing somewhere: the member row is not revoked; the thread is not
 * archived (un-sharing is `archived_at`); and the thread's owner IS the session's owner. The last one is new, and it
 * is what makes a thread row trustworthy at all: `POST /api/ops/threads` writes a thread for any session id a
 * caller names, so a thread someone else wrote on your session must confer nothing on anybody.
 */
export async function readMembership(
  db: GateDb,
  ownership: SessionOwnership,
  sessionId: string,
  callerEmail: string,
): Promise<{ role: string; status: string; expiresAt: Date | null } | null> {
  const owner = norm(ownership.ownerEmail);
  const me = norm(callerEmail);
  if (!owner || !me) return null;
  const sessions = [...new Set([sessionId, ownership.rootSessionId].filter((s): s is string => Boolean(s)))];
  const [row] = await db.inOrg(ownership.orgId, (tx) =>
    tx
      .select({ role: chatThreadMembers.role, status: chatThreadMembers.status, expiresAt: chatThreadMembers.expiresAt })
      .from(chatThreadMembers)
      .innerJoin(chatThreads, eq(chatThreads.id, chatThreadMembers.threadId))
      .where(
        and(
          inArray(chatThreads.eveSessionId, sessions),
          isNull(chatThreads.archivedAt),
          sql`lower(${chatThreads.ownerEmail}) = ${owner}`,
          sql`lower(${chatThreadMembers.email}) = ${me}`,
          ne(chatThreadMembers.status, "revoked"),
        ),
      )
      // A participant row outranks a viewer row if the caller somehow holds both.
      .orderBy(sql`case when ${chatThreadMembers.role} = 'viewer' then 1 else 0 end`)
      .limit(1),
  );
  return row ?? null;
}

/**
 * READING A SHARED CHAT IS OPENING IT — on every path. The thread routes have always moved an invited member to
 * "accepted" when they open it (lib/chat-threads.ts resolveAccess); a chat read through the live stream (the web proxy,
 * the agent's own routes) or its cached transcript did not, so a guest who only ever read it that way stayed
 * "invited" and their invite would lapse under them (lib/guest-invite-rules.ts). Every gate that admits a caller by a
 * thread membership calls this. Only rows still "invited" change; best-effort, and never the reason a read fails.
 */
export async function markMembershipOpened(
  db: Pick<GateDb, "inOrg">,
  ownership: SessionOwnership,
  sessionId: string,
  callerEmail: string,
): Promise<void> {
  const owner = norm(ownership.ownerEmail);
  const me = norm(callerEmail);
  if (!owner || !me) return;
  const sessions = [...new Set([sessionId, ownership.rootSessionId].filter((s): s is string => Boolean(s)))];
  await db
    .inOrg(ownership.orgId, (tx) =>
      tx
        .update(chatThreadMembers)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(
          and(
            eq(chatThreadMembers.status, "invited"),
            sql`lower(${chatThreadMembers.email}) = ${me}`,
            inArray(
              chatThreadMembers.threadId,
              tx
                .select({ id: chatThreads.id })
                .from(chatThreads)
                .where(
                  and(
                    inArray(chatThreads.eveSessionId, sessions),
                    isNull(chatThreads.archivedAt),
                    sql`lower(${chatThreads.ownerEmail}) = ${owner}`,
                  ),
                ),
            ),
          ),
        ),
    )
    .catch(() => undefined);
}

/** {@link markMembershipOpened} when a gate has just admitted the caller on a membership that is still "invited". */
export async function openedIfAdmitted(
  db: Pick<GateDb, "inOrg">,
  decision: { allow: boolean },
  ownership: SessionOwnership | null,
  membership: { status?: string } | null,
  sessionId: string,
  callerEmail: string | null | undefined,
): Promise<void> {
  if (!decision.allow || !ownership || membership?.status !== "invited" || !callerEmail) return;
  await markMembershipOpened(db, ownership, sessionId, callerEmail);
}

export interface GateFacts {
  readonly ownership: SessionOwnership | null;
  readonly membership: { role: string; status?: string; expiresAt?: Date | null } | null;
  readonly callerInWorkspace: boolean;
}

/**
 * Everything `sessionGateDecision` needs about one caller and one session, given the ownership (which the agent
 * may have from its cache or from eve's own lineage, and the web reads with {@link readOwnership}).
 */
export async function readCallerFacts(
  db: GateDb,
  caller: GateCaller,
  sessionId: string,
  ownership: SessionOwnership | null,
  callerOrgs: readonly string[] | null = null,
): Promise<GateFacts> {
  const me = norm(caller.email);
  if (!ownership || !me || caller.kind !== "person") return { ownership, membership: null, callerInWorkspace: false };
  if (me === norm(ownership.ownerEmail)) return { ownership, membership: null, callerInWorkspace: false };
  const membership = await readMembership(db, ownership, sessionId, me);
  const callerInWorkspace =
    !membership && ownership.visibility === "workspace"
      ? (callerOrgs ?? (await db.orgsOf(me))).includes(ownership.orgId)
      : false;
  return { ownership, membership, callerInWorkspace };
}

/** The owner recorded in `orgId`, else the in-workspace legacy inference — `orgId` only, never another workspace. */
export async function readOwnership(
  db: Pick<GateDb, "inOrg">,
  sessionId: string,
  orgId: string,
): Promise<SessionOwnership | null> {
  if (!orgId) return null;
  return (await readOwnerRecordIn(db, orgId, sessionId)) ?? (await readLegacyOwnershipIn(db, orgId, sessionId));
}

/**
 * The whole gate for a caller the web proxy has identified, IN THE WORKSPACE THE REQUEST IS IN: read, then decide. The
 * agent composes the same pieces itself (it adds a cache and eve's subagent lineage), and both end in
 * `sessionGateDecision`.
 */
export async function gateSessionRequest(
  db: GateDb,
  caller: GateCaller,
  sessionId: string,
  right: SessionRight,
  opts: {
    readonly workspace: string | null;
    /** The workspace the request NAMES (x-ops-org / ?org=), when it is not `workspace`: a guest's link. */
    readonly named?: string | null;
    readonly localDevAllowed?: boolean;
  },
): Promise<GateDecision & { ownership: SessionOwnership | null }> {
  // The request's workspace, and no other: a session held anywhere else is not found here (refused as unknown).
  const workspace = opts?.workspace ?? null;
  const ownership = workspace ? await readOwnership(db, sessionId, workspace) : null;
  const facts = await readCallerFacts(db, caller, sessionId, ownership);
  const decision = sessionGateDecision({
    caller,
    sessionId,
    right,
    ownership: facts.ownership,
    membership: facts.membership,
    callerInWorkspace: facts.callerInWorkspace,
    localDevAllowed: opts.localDevAllowed ?? false,
  });
  if (!decision.allow && decision.reason === "unknown" && opts.named && opts.named !== workspace) {
    const guest = await guestSessionDecision(db, caller, sessionId, right, opts.named);
    if (guest) return guest;
  }
  await openedIfAdmitted(db, decision, facts.ownership, facts.membership, sessionId, caller.email);
  return { ...decision, ownership };
}

/**
 * A GUEST OF ONE CHAT: someone outside the chat's workspace whom its owner shared it with.
 *
 * A chat lives in one workspace and is visible only in that workspace's context. An outside person invited to it
 * opens it through its link, and every request of theirs NAMES the chat's workspace (`named`) — which is the only
 * workspace this reads, by the session's id. They are admitted only by a live membership of a thread the OWNER
 * shared on it (readMembership, in that workspace), and only to READ: a guest never sends, answers or cancels,
 * whatever role the invite named, because a turn they started would run the agent with their identity. Someone who
 * IS a member of the named workspace is never a guest: they switch workspace (the switcher's path) and are then
 * gated as a member. Returns null when the named workspace admits no guest; the caller's own refusal then stands.
 */
export async function guestSessionDecision(
  db: GateDb,
  caller: GateCaller,
  sessionId: string,
  right: SessionRight,
  named: string,
): Promise<(GateDecision & { ownership: SessionOwnership | null }) | null> {
  const me = norm(caller.email);
  if (caller.kind !== "person" || !me || !named) return null;
  if ((await db.orgsOf(me)).includes(named)) return null;
  const ownership = await readOwnership(db, sessionId, named);
  if (!ownership) return null;
  const membership = await readMembership(db, ownership, sessionId, me);
  // A guest's invite must still be good: not withdrawn, and opened or not yet expired
  // (lib/guest-invite-rules.ts — the same rule the guest sign-in doors apply).
  if (!membership || !guestInviteLive(membership)) return null;
  if (right !== "read") return { allow: false, reason: "read-only", ownership };
  // Reading it is opening it: from now on the invite does not expire.
  if (membership.status === "invited") await markMembershipOpened(db, ownership, sessionId, me);
  return { allow: true, reason: "member", role: "viewer", ownership };
}

/**
 * MAY THIS PERSON READ (or replace) THE CACHED TRANSCRIPT of a session, in workspace `orgId`? — the rule behind
 * /api/ops/chat-snapshots and /api/ops/chat-replay (lib/chat-session-access.ts `accessForSession`).
 *
 * It used to decide ownership from the chat LIST: the caller owned an unshared session when they were the only person
 * with a `chat_sessions` row for it in the workspace. Those rows are written by the browser, so a colleague who knew
 * an id could be that sole claimant for a session whose real owner had not mirrored it (a new chat, a step, a
 * delegated child, a session the owner deleted from their list) and read or overwrite its cached transcript — the
 * most complete copy of a conversation stored anywhere. A thread row was trusted the same way, whoever wrote it.
 *
 * Now it is the gate's own answer on the agent's record (agent_session_owners, written at creation, never by a
 * client): READ when the session gate would let this person read the stream — the recorded owner, a live member of a
 * thread the OWNER shared, a colleague on a workspace-visible step — and WRITE only for the recorded owner (see
 * lib/chat-snapshot.ts snapshotAccess for why nobody else may replace it). No record in this workspace, no access:
 * a session from before owners were recorded gets one the first time its owner opens it through the gate, and until
 * then the open simply falls back to the replay.
 */
export async function readTranscriptAccess(
  db: GateDb,
  orgId: string,
  email: string,
  sessionId: string,
): Promise<{ read: boolean; write: boolean }> {
  const me = norm(email);
  if (!me || !orgId || !sessionId) return { read: false, write: false };
  const ownership = await readOwnerRecordIn(db, orgId, sessionId);
  if (!ownership) return { read: false, write: false };
  const caller: GateCaller = { kind: "person", email: me };
  const facts = await readCallerFacts(db, caller, sessionId, ownership);
  const decision = sessionGateDecision({
    caller,
    sessionId,
    right: "read",
    ownership,
    membership: facts.membership,
    callerInWorkspace: facts.callerInWorkspace,
    localDevAllowed: false,
  });
  await openedIfAdmitted(db, decision, ownership, facts.membership, sessionId, me);
  return { read: decision.allow, write: decision.allow && decision.role === "owner" };
}

/** The row the agent writes when it creates (or first resolves) a session. Never overwrites an existing owner. */
export async function recordOwner(
  db: Pick<GateDb, "inOrg">,
  row: {
    sessionId: string;
    orgId: string;
    ownerEmail: string | null;
    ownerPrincipal: string | null;
    ownerKind: string;
    visibility: string;
    rootSessionId?: string | null;
    parentSessionId?: string | null;
    tokenSha256?: string | null;
  },
): Promise<void> {
  await db.inOrg(row.orgId, (tx) =>
    tx
      .insert(agentSessionOwners)
      .values({
        sessionId: row.sessionId,
        orgId: row.orgId,
        ownerEmail: row.ownerEmail ? norm(row.ownerEmail) : null,
        ownerPrincipal: row.ownerPrincipal,
        ownerKind: row.ownerKind,
        visibility: row.visibility,
        rootSessionId: row.rootSessionId ?? null,
        parentSessionId: row.parentSessionId ?? null,
        tokenSha256: row.tokenSha256 ?? null,
      })
      .onConflictDoNothing({ target: agentSessionOwners.sessionId }),
  );
}

/** Fill a session's token hash once, when it was not known at creation (a legacy or child session). */
export async function recordTokenHash(
  db: Pick<GateDb, "inOrg">,
  orgId: string,
  sessionId: string,
  tokenSha256: string,
): Promise<void> {
  await db.inOrg(orgId, (tx) =>
    tx
      .update(agentSessionOwners)
      .set({ tokenSha256, updatedAt: new Date() })
      .where(and(eq(agentSessionOwners.sessionId, sessionId), isNull(agentSessionOwners.tokenSha256))),
  );
}
