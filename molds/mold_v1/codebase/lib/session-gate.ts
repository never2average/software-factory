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
 * tenancy-ok: every tenant-table statement runs inside `deps.inOrg(orgId, …)` (the workspace's RLS scope). The
 * only reads outside one are `org_members` via `deps.orgsOf` / `deps.isMember` — the tenancy control plane, which
 * carries no RLS (scripts/bootstrap-test-db.mjs EXEMPT) — and the workspace LIST, which is the same.
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

type Tx = PostgresJsDatabase<typeof schema>;

/** The database, as each side reaches it. */
export interface GateDb {
  /** Run `fn` inside workspace `orgId`'s RLS scope (withOrgDb / withOrgRls). */
  inOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Every workspace id (the `orgs` control plane). */
  listOrgs(): Promise<string[]>;
  /** The workspaces `email` belongs to (`org_members`, control plane). Tried first, so an owner is found in one read. */
  orgsOf(email: string): Promise<string[]>;
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

/** A session's recorded owner, found in whichever workspace holds it (the row is unique across all of them). */
export async function readOwnerRecord(
  db: GateDb,
  sessionId: string,
  preferOrgs: readonly string[] = [],
): Promise<SessionOwnership | null> {
  const orgs = [...new Set([...preferOrgs, ...(await db.listOrgs())])];
  for (const orgId of orgs) {
    const found = await readOwnerRecordIn(db, orgId, sessionId);
    if (found) return found;
  }
  return null;
}

/**
 * OWNERSHIP OF A SESSION CREATED BEFORE THE AGENT RECORDED OWNERS, inferred from the rows that existed then.
 *
 * Weaker evidence than a record, so each kind of row is trusted for exactly one thing:
 *
 *   · `agent_session_scopes` anchors the WORKSPACE, and nothing else. It was written by the agent from a verified
 *     token, but it was last-writer-wins and any signed-in caller could post into any session while the hole was
 *     open, so its `principal_email` names whoever spoke LAST — possibly a colleague who was never the owner. It is
 *     never read as an owner, and never as evidence that a session is the workspace's.
 *   · The OWNER comes only from the chat rows: the shared thread's owner, else the ONLY person with a
 *     `chat_sessions` row for it (two claimants prove nothing) IN THE ANCHOR'S WORKSPACE — a claimant in any other
 *     workspace is ignored, and since mold_v1-140 the mirror refuses to file one (lib/chat-sessions-mirror rule 4).
 *   · WORKSPACE visibility (colleagues may read) comes only from positive evidence that the session was a workflow,
 *     app or cron step: a `workflow_run_journal` step naming it (as its session or its child session), or an app /
 *     app version whose last run it was.
 *   · With no scope row at all (sessions older than migration 0016), whichever single workspace holds any of that
 *     evidence is the anchor; evidence in two workspaces is a conflict, and a conflict is refused.
 *
 * Anything else is UNOWNED (null): refused to everyone, and — because the guard freezes only an answer that names an
 * owner or a step — still reachable by its real owner the moment the chat list mirrors it.
 */
export async function readLegacyOwnership(db: GateDb, sessionId: string): Promise<SessionOwnership | null> {
  const orgs = await db.listOrgs();
  type Evidence = { orgId: string; scoped: boolean; threadOwners: string[]; claimants: string[]; step: boolean };
  const found: Evidence[] = [];
  for (const orgId of orgs) {
    const evidence = await db.inOrg(orgId, async (tx) => {
      const [scope] = await tx
        .select({ sessionId: agentSessionScopes.sessionId, orgId: agentSessionScopes.orgId })
        .from(agentSessionScopes)
        .where(eq(agentSessionScopes.sessionId, sessionId))
        .limit(1);
      const threads = await tx
        .select({ ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        .where(eq(chatThreads.eveSessionId, sessionId));
      const mirrors = await tx
        .select({ ownerEmail: chatSessions.ownerEmail, orgId: chatSessions.orgId })
        .from(chatSessions)
        .where(eq(chatSessions.eveSessionId, sessionId));
      const [journal] = await tx
        .select({ runId: workflowRunJournal.runId })
        .from(workflowRunJournal)
        .where(or(eq(workflowRunJournal.sessionId, sessionId), eq(workflowRunJournal.childSessionId, sessionId)))
        .limit(1);
      const [app] = journal
        ? []
        : await tx.select({ id: apps.id }).from(apps).where(eq(apps.lastSessionId, sessionId)).limit(1);
      const [version] = journal || app
        ? []
        : await tx.select({ id: appVersions.id }).from(appVersions).where(eq(appVersions.sessionId, sessionId)).limit(1);
      return {
        orgId,
        // Each piece counts for THIS workspace only when its own org_id says so — not merely because the scope let
        // the row through (a policy that is permissive, or a row read on a wider handle, must not move a claimant
        // or an anchor between workspaces). A claimant counts only in the scope row's workspace (mold_v1-140).
        scoped: Boolean(scope && scope.orgId === orgId),
        threadOwners: [...new Set(threads.map((t) => norm(t.ownerEmail)).filter(Boolean))],
        claimants: [...new Set(mirrors.filter((m) => m.orgId === orgId).map((m) => norm(m.ownerEmail)).filter(Boolean))],
        step: Boolean(journal || app || version),
      };
    });
    if (evidence.scoped || evidence.threadOwners.length || evidence.claimants.length || evidence.step) found.push(evidence);
  }
  const anchored = found.filter((e) => e.scoped);
  const chosen = anchored.length === 1 ? anchored[0] : anchored.length === 0 && found.length === 1 ? found[0] : null;
  if (!chosen) return null;

  const ownerEmail =
    chosen.threadOwners.length > 0
      ? chosen.threadOwners.length === 1
        ? chosen.threadOwners[0]
        : null
      : chosen.claimants.length === 1
        ? chosen.claimants[0]
        : null;
  if (!ownerEmail && !chosen.step) return null;
  return {
    orgId: chosen.orgId,
    ownerEmail,
    ownerPrincipal: null,
    ownerKind: ownerEmail ? "person" : "step",
    visibility: chosen.step ? "workspace" : "owner",
    rootSessionId: null,
    tokenSha256: null,
    source: "legacy",
  };
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
): Promise<{ role: string } | null> {
  const owner = norm(ownership.ownerEmail);
  const me = norm(callerEmail);
  if (!owner || !me) return null;
  const sessions = [...new Set([sessionId, ownership.rootSessionId].filter((s): s is string => Boolean(s)))];
  const [row] = await db.inOrg(ownership.orgId, (tx) =>
    tx
      .select({ role: chatThreadMembers.role })
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

export interface GateFacts {
  readonly ownership: SessionOwnership | null;
  readonly membership: { role: string } | null;
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

/** The recorded owner, else the legacy inference. */
export async function readOwnership(
  db: GateDb,
  sessionId: string,
  preferOrgs: readonly string[] = [],
): Promise<SessionOwnership | null> {
  return (await readOwnerRecord(db, sessionId, preferOrgs)) ?? (await readLegacyOwnership(db, sessionId));
}

/**
 * The whole gate for a caller the web proxy has identified: read, then decide. The agent composes the same pieces
 * itself (it adds a cache and eve's subagent lineage), and both end in `sessionGateDecision`.
 */
export async function gateSessionRequest(
  db: GateDb,
  caller: GateCaller,
  sessionId: string,
  right: SessionRight,
  opts: { localDevAllowed?: boolean } = {},
): Promise<GateDecision & { ownership: SessionOwnership | null }> {
  const callerOrgs = caller.kind === "person" && caller.email ? await db.orgsOf(norm(caller.email)) : [];
  const ownership = await readOwnership(db, sessionId, callerOrgs);
  const facts = await readCallerFacts(db, caller, sessionId, ownership, callerOrgs);
  const decision = sessionGateDecision({
    caller,
    sessionId,
    right,
    ownership: facts.ownership,
    membership: facts.membership,
    callerInWorkspace: facts.callerInWorkspace,
    localDevAllowed: opts.localDevAllowed ?? false,
  });
  return { ...decision, ownership };
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
