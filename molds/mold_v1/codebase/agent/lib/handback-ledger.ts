/**
 * The durable record of a stopped specialist's hand-back — `specialist_handbacks` (agent/lib/db/schema.ts has the
 * why). Every statement runs inside the WORKSPACE's row-level scope (`inOrg`), the session owner's, exactly as the
 * session guard's other reads and writes do: a row is visible to, and writable by, that workspace only.
 *
 * tenancy-ok: every statement runs inside `inOrg(orgId, …)`.
 */
import { sql } from "drizzle-orm";
import type { GateDb } from "../../lib/session-gate.ts";
import type { HandbackKey, HandbackLedger } from "./specialist-handback.ts";

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? [])) as Array<Record<string, unknown>>;

/** A claim whose holder has said nothing for this long is taken to be dead (a serverless instance that was frozen). */
export const STALE_CLAIM_SECONDS = 120;

export function handbackLedger(db: Pick<GateDb, "inOrg">, orgId: string): HandbackLedger {
  const where = (k: HandbackKey) =>
    sql`org_id = ${orgId} and parent_session_id = ${k.parentSessionId} and child_session_id = ${k.childSessionId} and turn_id = ${k.turnId}`;
  return {
    async claim(key) {
      // THE claim: one INSERT against the primary key. Two requests, in any two processes: one row, one winner.
      const won = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            insert into specialist_handbacks (org_id, parent_session_id, child_session_id, turn_id, status)
            values (${orgId}, ${key.parentSessionId}, ${key.childSessionId}, ${key.turnId}, 'claimed')
            on conflict do nothing
            returning child_session_id`),
        ),
      );
      return won.length === 1 ? "won" : "held";
    },
    async write(key, message) {
      await db.inOrg(orgId, (tx) => tx.execute(sql`update specialist_handbacks set message = ${message}, updated_at = now() where ${where(key)}`));
    },
    async settle(key, status) {
      await db.inOrg(orgId, (tx) => tx.execute(sql`update specialist_handbacks set status = ${status}, updated_at = now() where ${where(key)}`));
    },
    async release(key) {
      await db.inOrg(orgId, (tx) => tx.execute(sql`delete from specialist_handbacks where ${where(key)} and status = 'claimed'`));
    },
    async retry(parentSessionId, childSessionId) {
      // Atomic take-over: the UPDATE's own row lock lets one retrier through; the other matches no row.
      const [row] = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            update specialist_handbacks set status = 'claimed', updated_at = now()
            where org_id = ${orgId} and parent_session_id = ${parentSessionId} and child_session_id = ${childSessionId}
              and (status = 'undelivered' or (status = 'claimed' and updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})))
            returning turn_id, message`),
        ),
      );
      if (!row || typeof row.turn_id !== "string") return null;
      return { key: { parentSessionId, childSessionId, turnId: row.turn_id }, message: typeof row.message === "string" && row.message ? row.message : null };
    },
  };
}
