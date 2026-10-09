/**
 * The specialist sweep's ledger — `specialist_sweeps` (agent/lib/db/schema.ts has the why; mold_v1-196). Every
 * statement runs inside the WORKSPACE's row-level scope (`inOrg`), the main thread owner's: a row is visible to, and
 * writable by, that workspace only. Workspaces are not aware of each other.
 *
 * tenancy-ok: every statement runs inside `inOrg(orgId, …)` and names the workspace.
 */
import { sql } from "drizzle-orm";
import type { GateDb } from "../../lib/session-gate.ts";
import type { SweepAction, SweepClaim, SweepLedger } from "./specialist-sweep.ts";

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? [])) as Array<Record<string, unknown>>;

/** A claim (or an unfinished outcome) untouched for this long is taken over by the next sweep. */
export const SWEEP_RETRY_SECONDS = 120;
/** The statuses a later sweep may take over once they are stale. */
const RETRYABLE = ["claimed", "pending", "sent"];
/** How long the chat shows what the sweep did. */
export const NOTE_HOURS = 24;

const iso = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function sweepLedger(db: Pick<GateDb, "inOrg">, orgId: string): SweepLedger {
  return {
    async claim(row: SweepClaim) {
      // THE claim: one INSERT against the primary key, or the take-over of a row nobody is finishing (a waiting note
      // that turned into something to act on, a stale claim, a pending or unread delivery). One winner, any process.
      const won = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            insert into specialist_sweeps (org_id, parent_session_id, call_id, child_session_id, name, kind, status, facts, since)
            values (${orgId}, ${row.parentSessionId}, ${row.callId}, ${row.childSessionId}, ${row.name}, ${row.kind}, 'claimed',
                    ${JSON.stringify(row.facts)}::jsonb, ${iso(row.since)})
            on conflict (parent_session_id, call_id) do update
              -- A delivery already SENT keeps what it was (the frozen one stopped by the sweep reads "stopped" on the
              -- next pass, and its note must still say why); anything else takes what is found now.
              set kind = case when specialist_sweeps.status = 'sent' then specialist_sweeps.kind else excluded.kind end,
                  facts = case when specialist_sweeps.status = 'sent' then specialist_sweeps.facts else excluded.facts end,
                  since = case when specialist_sweeps.status = 'sent' then specialist_sweeps.since else excluded.since end,
                  child_session_id = excluded.child_session_id, name = excluded.name, status = 'claimed', updated_at = now()
              where specialist_sweeps.org_id = ${orgId}
                and (specialist_sweeps.status in ('surfaced', 'cleared')
                  or (specialist_sweeps.status in ('claimed', 'pending', 'sent')
                      and specialist_sweeps.updated_at < now() - make_interval(secs => ${SWEEP_RETRY_SECONDS})))
            returning call_id`),
        ),
      );
      return won.length === 1 ? "won" : "held";
    },
    async settle(parentSessionId: string, callId: string, status: SweepAction) {
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`
          update specialist_sweeps set status = ${status}, updated_at = now()
          where org_id = ${orgId} and parent_session_id = ${parentSessionId} and call_id = ${callId} and status = 'claimed'`),
      );
    },
    async surfaceWaiting(row: SweepClaim) {
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`
          insert into specialist_sweeps (org_id, parent_session_id, call_id, child_session_id, name, kind, status, facts, since)
          values (${orgId}, ${row.parentSessionId}, ${row.callId}, ${row.childSessionId}, ${row.name}, 'waiting', 'surfaced',
                  ${JSON.stringify(row.facts)}::jsonb, ${iso(row.since)})
          on conflict (parent_session_id, call_id) do update
            set status = 'surfaced', since = excluded.since, facts = excluded.facts,
                updated_at = case when specialist_sweeps.status = 'surfaced' then specialist_sweeps.updated_at else now() end
            where specialist_sweeps.org_id = ${orgId} and specialist_sweeps.kind = 'waiting'
              and specialist_sweeps.status in ('surfaced', 'cleared')`),
      );
    },
    async clearWaiting(parentSessionId: string, stillWaiting: readonly string[]) {
      // Call ids are never empty, so an empty list keeps nothing.
      const keep = stillWaiting.length ? stillWaiting : [""];
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`
          update specialist_sweeps set status = 'cleared', updated_at = now()
          where org_id = ${orgId} and parent_session_id = ${parentSessionId} and kind = 'waiting' and status = 'surfaced'
            and call_id not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`),
      );
    },
    async frozenToEnd(parentSessionId: string) {
      const rows = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            select call_id, child_session_id, updated_at from specialist_sweeps
            where org_id = ${orgId} and parent_session_id = ${parentSessionId} and kind = 'frozen'
              and status in ('delivered', 'sent', 'stopped') and ended = false`),
        ),
      );
      return rows
        .filter((r) => typeof r.call_id === "string" && typeof r.child_session_id === "string")
        .map((r) => ({ callId: r.call_id as string, childSessionId: r.child_session_id as string, stoppedAt: new Date(String(r.updated_at)).getTime() }));
    },
    async ended(parentSessionId: string, callId: string) {
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`update specialist_sweeps set ended = true where org_id = ${orgId} and parent_session_id = ${parentSessionId} and call_id = ${callId}`),
      );
    },
  };
}

/** One note the chat shows (lib/specialist-sweep-client.ts words it). No session ids: the name and the facts only. */
export interface SweepNote {
  readonly kind: string;
  readonly status: string;
  readonly name: string;
  readonly facts: Readonly<Record<string, string | number>>;
  /** When the condition began (ms), or null. */
  readonly since: number | null;
  /** When the sweep last acted (ms). */
  readonly at: number;
}

/** What the sweep did on this main thread, and what it is surfacing: the notes the chat reads. */
export async function sweepNotes(db: Pick<GateDb, "inOrg">, orgId: string, parentSessionId: string): Promise<SweepNote[]> {
  const rows = rowsOf(
    await db.inOrg(orgId, (tx) =>
      tx.execute(sql`
        select kind, status, name, facts, since, updated_at from specialist_sweeps
        where org_id = ${orgId} and parent_session_id = ${parentSessionId}
          and (status = 'surfaced'
            or (status in ('delivered', 'handed-over', 'sent', 'stopped') and updated_at > now() - make_interval(hours => ${NOTE_HOURS})))
        order by updated_at desc
        limit 20`),
    ),
  );
  return rows.map((r) => ({
    kind: String(r.kind),
    status: String(r.status),
    name: String(r.name),
    facts: (r.facts && typeof r.facts === "object" ? r.facts : {}) as Record<string, string | number>,
    since: r.since ? new Date(String(r.since)).getTime() : null,
    at: new Date(String(r.updated_at)).getTime(),
  }));
}

/**
 * The main threads of ONE workspace the scheduled sweep looks at (mold_v1-199): those with a delegation within the
 * window that the sweep has not yet seen settled, and those the ledger still has something open for. Read in that
 * workspace's scope only.
 *
 * A delegation's CALLED mark is its child's owner record (`agent_session_owners`: written as eve's `subagent.called`
 * passes through the session guard, so the call is already in the main thread's history when it exists); its SETTLED
 * mark is a `specialist_sweep_settled` row (`markSettled`, written after a sweep read that history and saw the call
 * settled for good). The difference is the outstanding delegations: an old finished thread costs an index probe here
 * and no stream read. Only a main thread's DIRECT children are counted (a nested specialist's record names its own
 * parent; the main thread's stream never announces it, so it would never be marked); a record from before
 * `parent_session_id` was kept counts as direct.
 *
 * THE CATCH-UP: every delegation recorded before the settled marks existed has no mark, so the first passes after the
 * deploy read exactly the threads the sweep read before (the same window, under the same per-pass budget), find any
 * delegation lost before then, and mark the rest. From then on each delegation is read until it is seen settled once.
 *
 * Without the table (the agent deployed before drizzle/0035): the old list, every thread that delegated within the
 * window. Slow, never wrong.
 */
export async function sweepCandidates(db: Pick<GateDb, "inOrg">, orgId: string, lookbackMs: number): Promise<string[]> {
  const secs = Math.max(60, Math.round(lookbackMs / 1000));
  const open = sql`
        union
        select distinct parent_session_id as id from specialist_sweeps
          where org_id = ${orgId}
            and (status in ('claimed', 'pending', 'sent', 'surfaced') or (kind = 'frozen' and ended = false))`;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = rowsOf(
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`
          select distinct o.root_session_id as id from agent_session_owners o
            where o.org_id = ${orgId} and o.root_session_id is not null and o.created_at > now() - make_interval(secs => ${secs})
              and (o.parent_session_id is null or o.parent_session_id = o.root_session_id)
              and not exists (
                select 1 from specialist_sweep_settled s
                where s.org_id = ${orgId} and s.parent_session_id = o.root_session_id and s.child_session_id = o.session_id)
          ${open}`),
      ),
    );
  } catch (error) {
    if (!missingSettledTable(error)) throw error;
    rows = rowsOf(
      await db.inOrg(orgId, (tx) =>
        tx.execute(sql`
          select distinct root_session_id as id from agent_session_owners
            where org_id = ${orgId} and root_session_id is not null and created_at > now() - make_interval(secs => ${secs})
          ${open}`),
      ),
    );
  }
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

let reportedMissing = false;
/** `specialist_sweep_settled` is not there yet (drizzle/0035 not applied): said once per process. */
function missingSettledTable(error: unknown): boolean {
  const seen = [error, (error as { cause?: unknown } | null)?.cause];
  const missing = seen.some((e) => {
    const code = (e as { code?: unknown } | null)?.code;
    const message = e instanceof Error ? e.message : String(e ?? "");
    return code === "42P01" || /specialist_sweep_settled/.test(message);
  });
  if (missing && !reportedMissing) {
    reportedMissing = true;
    console.error("[specialist-sweep] specialist_sweep_settled is missing (apply drizzle/0035): every thread in the window is read, as before.");
  }
  return missing;
}

/**
 * The SETTLED marks (mold_v1-199): these delegations of `parentSessionId` are done with for good — the sweep read the
 * main thread's own stream and saw it can never act on them again (`settledChildren` in agent/lib/specialist-sweep.ts).
 * Idempotent; never removed. A missing table is not an error here (the candidates fall back without it).
 */
export async function markSettled(db: Pick<GateDb, "inOrg">, orgId: string, parentSessionId: string, childSessionIds: readonly string[]): Promise<void> {
  const ids = [...new Set(childSessionIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (!ids.length || !parentSessionId) return;
  try {
    await db.inOrg(orgId, (tx) =>
      tx.execute(sql`
        insert into specialist_sweep_settled (org_id, parent_session_id, child_session_id)
        values ${sql.join(ids.map((id) => sql`(${orgId}, ${parentSessionId}, ${id})`), sql`, `)}
        on conflict (org_id, parent_session_id, child_session_id) do nothing`),
    );
  } catch (error) {
    if (!missingSettledTable(error)) throw error;
  }
}
