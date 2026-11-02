/**
 * The encrypted fields' data migration (mold_v0-194; src/encrypted-fields.ts): when a pack newly marks a field
 * `encrypted` (or makes one searchable), the rows already stored hold its values in the clear (or without a blind
 * index). Every row carries the tag of the declaration it was written under ("$enc"); the scheduler's tick
 * (src/schedules.ts schedulerTick: every minute on a server, the cron on Vercel) rewrites the rows whose tag differs,
 * a batch at a time:
 *
 *   idempotent   a row is rewritten by the record store's own sealFields: a value already sealed for that record and
 *                field is kept as it is, a plain one sealed, the blind indexes recomputed, the tag set. Run it again,
 *                or twice at once, and nothing more changes (each UPDATE is a compare-and-set on the row's version).
 *   resumable    the work left is exactly the rows whose tag differs: an interrupted run (a deploy, a crash, a batch
 *                limit) leaves rows that are either done or untouched, and the next tick goes on from there.
 *   quiet        nothing else of the row changes (not its updated_at, title or sealing); no record event is told; one
 *                data trail entry per workspace and batch (an `update` keyed "encrypt:fields", how many rows), no value.
 *   locked vault nothing runs (a value is never sealed without the vault).
 *   chained      a chained area's rows (mold_v0-195) never change: their values written before the field was encrypted
 *                stay as they were stored (masked on every read like any other); new rows are sealed when written.
 *
 * Reads never wait for it: a value not yet sealed is masked like any other (src/encrypted-fields.ts maskFields).
 */
import { auditData } from "./audit-trail.js";
import { getDb } from "./db.js";
import { encryptedFields, FIELDS_TAG, fieldsTag, sealFields } from "./encrypted-fields.js";
import { vaultUnlocked } from "./keyvault.js";
import { isSealed, openJson, sealJson } from "./orgcrypto.js";
import { recordAreas, STATE_TIMES, type RecordArea } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

/** Rows rewritten per tick, at most (across every area). */
export const MIGRATION_BATCH = 500;

export interface EncryptionReport { ran: boolean; areas: number; rows: number; updated: number; raced: number; failed: number; pending: number }

/** The areas whose rows may need the migration: every area with an encrypted field. */
export const encryptedAreas = (): RecordArea[] => recordAreas().filter((a) => a.scope === "workspace" && encryptedFields(a).length > 0);

/** Per area, the last row id a pass reached (in this process): a row that will not open does not hold up the rest. */
const cursors = new Map<string, number>();

interface Raw { id: string; org_id: number; key: string; data: Record<string, unknown>; rev: string }

/** One row as it is stored after the migration (its sealing as it was: a sealed row stays sealed). */
async function rewritten(area: RecordArea, r: Raw): Promise<Record<string, unknown>> {
  const sealedRow = isSealed((r.data as { _sealed?: unknown })._sealed);
  const fields = sealedRow ? await openJson(r.org_id, r.data) : r.data;
  const stored = await sealFields(r.org_id, area, r.key, fields);
  if (!sealedRow) return stored;
  const outside = Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith("$") && k !== STATE_TIMES));
  const inner = Object.fromEntries(Object.entries(stored).filter(([k]) => !(k in outside)));
  return { ...(await sealJson(r.org_id, inner)), ...outside };
}

/**
 * One pass: up to `batch` rows, area by area, whose stored tag is not their area's. -> what it did, and how many rows
 * are still pending after it (0: every encrypted area is done).
 */
export async function encryptFieldsTick(opts: { batch?: number } = {}): Promise<EncryptionReport> {
  const report: EncryptionReport = { ran: false, areas: 0, rows: 0, updated: 0, raced: 0, failed: 0, pending: 0 };
  const areas = encryptedAreas();
  if (!areas.length || !vaultUnlocked()) return report;
  report.ran = true;
  let left = Math.max(1, opts.batch ?? MIGRATION_BATCH);
  const db = await getDb();
  for (const area of areas) {
    report.areas++;
    const tag = fieldsTag(area)!;
    const id = `${area.pack}/${area.name}`;
    if (left > 0) {
      const after = cursors.get(id) ?? 0;
      const rows = await asPlatform(() => db.query<Raw>(
        `/* tenant: the encrypted-fields migration reads one area's rows of every workspace; each row is rewritten under withTenant for its own org_id */
         SELECT id::text AS id, org_id, key, data, xmin::text AS rev FROM workspace_records
          WHERE pack = $1 AND area = $2 AND (data ->> '${FIELDS_TAG}') IS DISTINCT FROM $3 AND NOT chained AND id > $4 ORDER BY id LIMIT $5`,
        [area.pack, area.name, tag, after, left]));
      cursors.set(id, rows.length < left ? 0 : Number(rows.at(-1)!.id)); // a short page ends the pass: start over next time
      left -= rows.length;
      report.rows += rows.length;
      const perOrg = new Map<number, number>();
      for (const r of rows) {
        try {
          const done = await withTenant(r.org_id, async () => {
            const data = await rewritten(area, r);
            return (await db.query(
              "UPDATE workspace_records SET data = $4 WHERE org_id = $1 AND id = $2 AND xmin::text = $3 RETURNING id",
              [r.org_id, r.id, r.rev, JSON.stringify(data)])).length > 0;
          });
          if (done) { report.updated++; perOrg.set(r.org_id, (perOrg.get(r.org_id) ?? 0) + 1); } else report.raced++; // written meanwhile: by the store, already in the new form
        } catch (e) {
          report.failed++;
          // Never the message's values: only that this row of this area did not open (its workspace's key, or its seal).
          console.error(`encrypted fields: a row of ${id} could not be rewritten (${(e as Error).name})`);
        }
      }
      for (const [org, n] of perOrg) auditData(org, { action: "update", pack: area.pack, area: area.name, key: "encrypt:fields", rows: n });
    }
    report.pending += Number((await asPlatform(() => db.query<{ n: number }>(
      `/* tenant: a count of one area's rows across workspaces still to migrate (no value read) */
       SELECT count(*)::int AS n FROM workspace_records WHERE pack = $1 AND area = $2 AND (data ->> '${FIELDS_TAG}') IS DISTINCT FROM $3 AND NOT chained AND org_id IS NOT NULL`,
      [area.pack, area.name, tag])))[0]?.n ?? 0);
  }
  return report;
}

/** Tests only: forget where each pass got to. */
export const resetMigrationCursors = () => cursors.clear();
