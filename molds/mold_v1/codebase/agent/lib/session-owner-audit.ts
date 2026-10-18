/**
 * SYSTEM PATH — a READ-ONLY audit of session owner records against the server's own evidence (mold_v1-293).
 *
 * Never imported by anything a person's request runs (`npm run check:tenancy` holds the system modules to that). Run by
 * the factory through scripts/audit-session-owners.mjs to look for past abuse of the hole mold_v1-293 closed: until
 * then, the agent's guard froze a legacy session's owner from the session's THREAD rows first, and any member could
 * file a thread naming themselves on any session id (POST /api/ops/threads). Someone who did so on a colleague's old
 * session became its recorded owner on the next pass of the guard.
 *
 * It writes nothing: every transaction is put in read-only mode before its first read, so a statement that would
 * write fails instead.
 *
 * What it lists, per workspace (each read inside that workspace's own RLS scope):
 *
 *   · `disagrees` — a person-owned ROOT record whose owner is not the person the agent's scope row names (the verified
 *     caller of the session's first turn). The likeliest sign of a hijack, though a scope row from before first-writer
 *     -wins may name a participant who posted last, so each one is for a person to look at, not to fix blind.
 *   · `thread-first` — a person-owned root record with NO scope principal, whose owner filed a thread on the session no
 *     later than the record was written: an owner the old rule may have taken from that thread alone.
 *   · `unrecorded-claims` — a session with no owner record yet, whose thread or chat rows name someone other than its
 *     scope principal: an attempt that the fixed rule now refuses, worth knowing about.
 *
 * Delegated (child) records are not listed: they copy their root's owner, and the root is audited.
 *
 * tenancy-ok: every tenant-table statement runs inside `db.inOrg(orgId, …)`; the workspace list is `orgs`, the control
 * plane. Cross-workspace by construction — which is why it is a system job and not a request.
 */
import { sql } from "drizzle-orm";
import type { SystemGateDb } from "./session-owner-backfill.ts";

export type AuditKind = "disagrees" | "thread-first" | "unrecorded-claims";

export interface AuditFinding {
  readonly kind: AuditKind;
  readonly orgId: string;
  readonly sessionId: string;
  /** The recorded owner (null for `unrecorded-claims`). */
  readonly recordedOwner: string | null;
  /** The person the agent's scope row names, or null. */
  readonly scopePrincipal: string | null;
  /** Owners of thread rows on the session (browser-written). */
  readonly threadOwners: readonly string[];
  /** People with a chat-list row for the session (browser-written). */
  readonly claimants: readonly string[];
  readonly recordedAt: string | null;
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : (((r as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]);

const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string" && v.startsWith("{")) return v.slice(1, -1).split(",").filter((s) => s && s !== "NULL");
  return [];
};

const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** Every finding in one workspace. Read-only. */
export async function auditWorkspace(db: Pick<SystemGateDb, "inOrg">, orgId: string): Promise<AuditFinding[]> {
  return db.inOrg(orgId, async (tx) => {
    // Before any read: from here on this transaction cannot write.
    await tx.execute(sql`set transaction read only`);
    const recorded = rowsOf(
      await tx.execute(sql`
        select o.session_id, lower(o.owner_email) as owner, o.created_at::text as recorded_at,
          (select lower(s.principal_email) from agent_session_scopes s
            where s.session_id = o.session_id and s.org_id = ${orgId}) as principal,
          array(select distinct lower(t.owner_email) from chat_threads t
                 where t.eve_session_id = o.session_id and t.org_id = ${orgId}) as thread_owners,
          array(select distinct lower(c.owner_email) from chat_sessions c
                 where c.eve_session_id = o.session_id and c.org_id = ${orgId}) as claimants,
          exists (select 1 from chat_threads t
                   where t.eve_session_id = o.session_id and t.org_id = ${orgId}
                     and lower(t.owner_email) = lower(o.owner_email) and t.created_at <= o.created_at) as thread_first
        from agent_session_owners o
        where o.org_id = ${orgId} and o.owner_kind = 'person' and o.owner_email is not null
          and o.parent_session_id is null
        order by o.created_at`),
    );
    const out: AuditFinding[] = [];
    for (const r of recorded) {
      const owner = text(r.owner);
      const principal = text(r.principal);
      const base = {
        orgId,
        sessionId: String(r.session_id),
        recordedOwner: owner,
        scopePrincipal: principal,
        threadOwners: list(r.thread_owners),
        claimants: list(r.claimants),
        recordedAt: text(r.recorded_at),
      };
      if (principal && principal !== owner) out.push({ kind: "disagrees", ...base });
      else if (!principal && r.thread_first === true) out.push({ kind: "thread-first", ...base });
    }
    const unrecorded = rowsOf(
      await tx.execute(sql`
        with named as (
          select t.eve_session_id as session_id, lower(t.owner_email) as who from chat_threads t where t.org_id = ${orgId}
          union
          select c.eve_session_id, lower(c.owner_email) from chat_sessions c where c.org_id = ${orgId} and c.eve_session_id is not null
        )
        select n.session_id,
          (select lower(s.principal_email) from agent_session_scopes s
            where s.session_id = n.session_id and s.org_id = ${orgId}) as principal,
          array(select distinct lower(t.owner_email) from chat_threads t
                 where t.eve_session_id = n.session_id and t.org_id = ${orgId}) as thread_owners,
          array(select distinct lower(c.owner_email) from chat_sessions c
                 where c.eve_session_id = n.session_id and c.org_id = ${orgId}) as claimants
        from named n
        where not exists (select 1 from agent_session_owners o where o.session_id = n.session_id)
        group by n.session_id
        order by n.session_id`),
    );
    for (const r of unrecorded) {
      const principal = text(r.principal);
      const threadOwners = list(r.thread_owners);
      const claimants = list(r.claimants);
      const others = [...threadOwners, ...claimants].filter((who) => who !== principal);
      // A session with no scope row and one person's rows is the ordinary unanchored legacy chat: nothing to say.
      if (!others.length || (!principal && new Set(others).size < 2)) continue;
      out.push({
        kind: "unrecorded-claims",
        orgId,
        sessionId: String(r.session_id),
        recordedOwner: null,
        scopePrincipal: principal,
        threadOwners,
        claimants,
        recordedAt: null,
      });
    }
    return out;
  });
}

/** Every workspace's findings. Read-only. */
export async function auditSessionOwners(db: SystemGateDb): Promise<AuditFinding[]> {
  const out: AuditFinding[] = [];
  for (const orgId of await db.listOrgs()) out.push(...(await auditWorkspace(db, orgId)));
  return out;
}
