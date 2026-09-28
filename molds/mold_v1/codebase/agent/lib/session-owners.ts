/**
 * The agent's side of `agent_session_owners`: its database handle for the shared gate reads (lib/session-gate.ts),
 * and the write that gives a SUBAGENT's child session its root's owner.
 *
 * Used by the session guard (agent/lib/session-guard.ts), which records a session's owner at creation and a
 * delegated child's as the parent's `subagent.called` passes through the stream it serves
 * (agent/lib/session-lineage-stream.ts) — so the chat's subagent rail, which opens a child's stream the moment that
 * event arrives, finds an owner there rather than a refusal.
 *
 * tenancy-ok: `orgs` and `org_members` are the tenancy control plane (no RLS — scripts/bootstrap-test-db.mjs
 * EXEMPT); every tenant-table read and write goes through `withOrgDb` via `inOrg`.
 */
import { eq } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { orgMembers, orgs } from "./db/schema.ts";
import { DEFAULT_ORG } from "./org-context.ts";
import type { SessionOwnership } from "../../lib/chat-gate.ts";
import { readLegacyOwnership, readOwnerRecord, recordOwner, type GateDb } from "../../lib/session-gate.ts";

/** The agent's database as the shared gate reads want it, or null when none is configured. */
export function agentGateDb(): GateDb | null {
  const handle = getDb();
  if (!handle) return null;
  return {
    inOrg: (orgId, fn) => withOrgDb(orgId, fn),
    async listOrgs() {
      const rows = await handle.select({ orgId: orgs.orgId }).from(orgs);
      return rows.length ? rows.map((r) => r.orgId) : [DEFAULT_ORG];
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
 * Give `childSessionId` the ownership of the session that delegated to it (and so of its root). The parent id comes
 * from eve (the stream of the session that announced the delegation), never from a caller. Returns the
 * child's ownership, or null when the parent has none on record — the child then stays unowned, which the gate
 * refuses.
 */
export async function recordChildSession(
  db: GateDb,
  parentSessionId: string,
  childSessionId: string,
  preferOrgs: readonly string[] = [],
): Promise<SessionOwnership | null> {
  if (!parentSessionId || !childSessionId || parentSessionId === childSessionId) return null;
  const parent = (await readOwnerRecord(db, parentSessionId, preferOrgs)) ?? (await readLegacyOwnership(db, parentSessionId));
  if (!parent) return null;
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
