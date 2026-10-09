/**
 * SYSTEM PATH — the one-time owner backfill for sessions from before the agent recorded owners (#66).
 *
 * Never imported by anything a person's request runs: `npm run check:tenancy` fails if a request handler, a model
 * tool, an agent hook or channel can reach a function here. It is run by the factory, once, after the deploy that made
 * the session gate read ONE workspace per request (scripts/backfill-session-owners.mjs), and it may be re-run: it only
 * ever INSERTS a record for a session that has none (recordOwner is insert-only), and never changes one.
 *
 * WHY IT EXISTS. The gate used to infer a legacy session's owner on every request by reading every workspace
 * (`readLegacyOwnership` over `listOrgs()`): the scope row anchored the workspace, the chat rows named the owner, and
 * evidence in two workspaces was a conflict. Workspaces are not aware of each other now, so the request path infers
 * only inside the request's own workspace, and only when that workspace holds server-written evidence (the agent's
 * scope row, a workflow / app / cron step — lib/session-gate.ts readLegacyOwnershipIn). The sessions that need more
 * than that — older than migration 0016, never a step, known only from chat rows — are decided HERE, with exactly the
 * cross-workspace rule the gate used to apply, and frozen into owner records; from then on the record decides.
 *
 * tenancy-ok: every tenant-table statement runs inside `db.inOrg(orgId, …)`; the workspace list is `orgs`, the control
 * plane. Cross-workspace by construction — which is why it is a system job and not a request.
 */
import { eq, isNotNull } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import {
  agentSessionOwners,
  agentSessionScopes,
  appVersions,
  apps,
  chatSessions,
  chatThreads,
  orgMembers,
  orgs,
  workflowRunJournal,
} from "./db/schema.ts";
import type { SessionOwnership } from "../../lib/chat-gate.ts";
import {
  ownershipFromEvidence,
  readLegacyEvidenceIn,
  recordOwner,
  type GateDb,
  type LegacyEvidence,
} from "../../lib/session-gate.ts";

/** A gate database that may also enumerate the workspaces. Only system jobs (this module, the lineage backfill) get one. */
export interface SystemGateDb extends GateDb {
  /** Every workspace id (the `orgs` control plane), suspended ones included. */
  listOrgs(): Promise<string[]>;
}

/** The agent's database with the workspace list — for system scripts only. Null without a database. */
export function agentSystemGateDb(): SystemGateDb | null {
  const handle = getDb();
  if (!handle) return null;
  return {
    inOrg: (orgId, fn) => withOrgDb(orgId, fn),
    async listOrgs() {
      const rows = await handle.select({ orgId: orgs.orgId }).from(orgs);
      return rows.map((r) => r.orgId);
    },
    async orgsOf(email) {
      const rows = await handle
        .select({ orgId: orgMembers.orgId })
        .from(orgMembers)
        .where(eq(orgMembers.email, email.trim().toLowerCase()));
      return rows.map((r) => r.orgId);
    },
  };
}

/**
 * The cross-workspace inference the gate used to run on every request (kept exactly): every workspace's evidence,
 * each read in its own scope; the ONE workspace whose agent scope row anchors the session, else — with no anchor
 * anywhere — the one workspace holding any evidence at all; evidence in two workspaces is a conflict (null).
 */
export async function inferAcrossWorkspaces(db: SystemGateDb, sessionId: string): Promise<SessionOwnership | null> {
  const found: LegacyEvidence[] = [];
  for (const orgId of await db.listOrgs()) {
    const e = await readLegacyEvidenceIn(db, orgId, sessionId);
    if (e.scoped || e.threadOwners.length || e.claimants.length || e.step) found.push(e);
  }
  const anchored = found.filter((e) => e.scoped);
  const chosen = anchored.length === 1 ? anchored[0] : anchored.length === 0 && found.length === 1 ? found[0] : null;
  return chosen ? ownershipFromEvidence(chosen) : null;
}

/** Every session id some workspace holds legacy evidence about, and the ids that already have an owner record. */
async function candidates(db: SystemGateDb): Promise<{ sessions: Set<string>; recorded: Set<string> }> {
  const sessions = new Set<string>();
  const recorded = new Set<string>();
  for (const orgId of await db.listOrgs()) {
    await db.inOrg(orgId, async (tx) => {
      const add = (rows: { id: string | null }[]) => rows.forEach((r) => r.id && sessions.add(r.id));
      add(await tx.select({ id: chatSessions.eveSessionId }).from(chatSessions).where(isNotNull(chatSessions.eveSessionId)));
      add(await tx.select({ id: chatThreads.eveSessionId }).from(chatThreads));
      add(await tx.select({ id: agentSessionScopes.sessionId }).from(agentSessionScopes));
      add(await tx.select({ id: workflowRunJournal.sessionId }).from(workflowRunJournal).where(isNotNull(workflowRunJournal.sessionId)));
      add(await tx.select({ id: workflowRunJournal.childSessionId }).from(workflowRunJournal).where(isNotNull(workflowRunJournal.childSessionId)));
      add(await tx.select({ id: apps.lastSessionId }).from(apps).where(isNotNull(apps.lastSessionId)));
      add(await tx.select({ id: appVersions.sessionId }).from(appVersions).where(isNotNull(appVersions.sessionId)));
      for (const r of await tx.select({ id: agentSessionOwners.sessionId }).from(agentSessionOwners)) recorded.add(r.id);
    });
  }
  return { sessions, recorded };
}

export interface OwnerBackfillResult {
  /** Sessions with legacy evidence and no owner record. */
  readonly candidates: number;
  /** Records written (or, on a dry run, that would be). */
  readonly recorded: number;
  /** Evidence in two workspaces, or none naming an owner or a step: left unowned (refused to everyone). */
  readonly unresolved: number;
  readonly sample: readonly { sessionId: string; orgId: string; ownerEmail: string | null; visibility: string }[];
}

/**
 * Record an owner for every legacy session the cross-workspace rule can decide. Dry run unless `apply`. A session is
 * recorded only when the rule names an owner or proves a step — the same condition under which the guard used to
 * freeze its inference — so an UNOWNED session stays unrecorded (and refused), never tombstoned.
 */
export async function backfillLegacyOwners(
  db: SystemGateDb,
  opts: { readonly apply?: boolean } = {},
): Promise<OwnerBackfillResult> {
  const { sessions, recorded: already } = await candidates(db);
  let candidatesCount = 0;
  let recorded = 0;
  let unresolved = 0;
  const sample: { sessionId: string; orgId: string; ownerEmail: string | null; visibility: string }[] = [];
  for (const sessionId of [...sessions].sort()) {
    if (already.has(sessionId)) continue;
    candidatesCount++;
    const owner = await inferAcrossWorkspaces(db, sessionId);
    if (!owner || !(owner.ownerEmail || owner.visibility === "workspace")) {
      unresolved++;
      continue;
    }
    if (opts.apply) {
      await recordOwner(db, {
        sessionId,
        orgId: owner.orgId,
        ownerEmail: owner.ownerEmail,
        ownerPrincipal: null,
        ownerKind: owner.ownerKind,
        visibility: owner.visibility,
      });
    }
    recorded++;
    if (sample.length < 20) sample.push({ sessionId, orgId: owner.orgId, ownerEmail: owner.ownerEmail, visibility: owner.visibility });
  }
  return { candidates: candidatesCount, recorded, unresolved, sample };
}
