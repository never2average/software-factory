/**
 * The agent's side of `agent_session_owners`: its database handle for the shared gate reads (lib/session-gate.ts),
 * and the write that gives a SUBAGENT's child session its root's owner.
 *
 * Used by the session guard (agent/lib/session-guard.ts), which records a session's owner at creation and a
 * delegated child's as the parent's `subagent.called` passes through the stream it serves
 * (agent/lib/session-lineage-stream.ts) — so the chat's subagent rail, which opens a child's stream the moment that
 * event arrives, finds an owner there rather than a refusal.
 *
 * tenancy-ok: `org_members` is the tenancy control plane (no RLS — scripts/bootstrap-test-db.mjs EXEMPT), read for
 * the caller's own memberships only; every tenant-table read and write goes through `withOrgDb` via `inOrg`.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { orgMembers } from "./db/schema.ts";
import type { SessionOwnership } from "../../lib/chat-gate.ts";
import { recordOwner, type GateDb } from "../../lib/session-gate.ts";

/**
 * The agent's database as the shared gate reads want it, or null when none is configured. No workspace list: a
 * request reads the one workspace it is in (lib/session-gate.ts). The system jobs that enumerate workspaces use
 * agent/lib/session-owner-backfill.ts `agentSystemGateDb` instead.
 */
export function agentGateDb(): GateDb | null {
  const handle = getDb();
  if (!handle) return null;
  return {
    inOrg: (orgId, fn) => withOrgDb(orgId, fn),
    async orgsOf(email) {
      const rows = await handle
        .select({ orgId: orgMembers.orgId })
        .from(orgMembers)
        .where(eq(orgMembers.email, email.trim().toLowerCase()));
      return rows.map((r) => r.orgId);
    },
    async ping() {
      await handle.execute(sql`select 1`);
    },
  };
}

/**
 * Give `childSessionId` the ownership of the session that delegated to it (and so of its root). The parent id comes
 * from eve (the stream of the session that announced the delegation), never from a caller, and the parent's ownership
 * is the one the guard has just decided on — so nothing is read here, and the child lands in the PARENT's workspace.
 * It used to look the parent up again in every workspace.
 */
export async function recordChildSession(
  db: Pick<GateDb, "inOrg">,
  parent: SessionOwnership,
  parentSessionId: string,
  childSessionId: string,
): Promise<SessionOwnership | null> {
  if (!parentSessionId || !childSessionId || parentSessionId === childSessionId) return null;
  const child: SessionOwnership = {
    ...parent,
    rootSessionId: parent.rootSessionId ?? parentSessionId,
    tokenSha256: null,
    source: "lineage",
  };
  await recordOwner(db, {
    sessionId: childSessionId,
    orgId: child.orgId,
    ownerEmail: child.ownerEmail,
    ownerPrincipal: child.ownerPrincipal,
    ownerKind: child.ownerKind,
    visibility: child.visibility,
    rootSessionId: child.rootSessionId,
    parentSessionId,
  });
  return child;
}
