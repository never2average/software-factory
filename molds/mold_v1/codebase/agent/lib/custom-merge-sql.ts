/**
 * The `custom` column's new value as ONE SQL expression over what is stored at write time, for an
 * `INSERT … ON CONFLICT DO UPDATE SET custom = <this>`.
 *
 * The account write paths used to read the record, merge in memory, and write the whole column back. A note
 * written between the read and the write (the ops API, another agent turn, a coding agent through MCP) was then
 * overwritten with the value read before it: against a real Postgres, upsert_customer({ id, healthReason })
 * racing a scoped `UPDATE customers SET custom = …` lost the note in 39 of 40 rounds. Now a write that does not
 * name `custom` leaves the column out of its SET, and one that does changes only the keys it names:
 *
 *   ((coalesce(custom, '{}') || set) with each append concatenated onto the stored text) - clear…
 *
 * and NULL when that leaves nothing (customers.custom is nullable: NULL is "no own values").
 *
 * Keys are profile field keys (snake_case, checked by the generator); every key and value is a bound parameter.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { APPEND_SEPARATOR, type CustomDelta } from "./custom-fields.ts";

export function customMergeSql(column: AnyColumn, delta: CustomDelta): SQL {
  let expr: SQL = sql`(coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(delta.set)}::jsonb)`;
  for (const [key, text] of Object.entries(delta.append)) {
    // The stored text (if any), the separator, the addition: appended to what is there NOW, not what was read.
    expr = sql`jsonb_set(${expr}, ARRAY[${key}::text], to_jsonb(coalesce(nullif(${column} ->> ${key}::text, '') || ${APPEND_SEPARATOR}::text, '') || ${text}::text))`;
  }
  for (const key of delta.clear) expr = sql`(${expr} - ${key}::text)`;
  return sql`(select case when m = '{}'::jsonb then null else m end from (select ${expr} as m) as merged)`;
}

/** The value a brand-new row starts with: the same delta over nothing. */
export function customForNewRow(delta: CustomDelta): Record<string, string | number> | null {
  const out: Record<string, string | number> = { ...delta.set };
  for (const [key, text] of Object.entries(delta.append)) out[key] = text;
  for (const key of delta.clear) delete out[key];
  return Object.keys(out).length ? out : null;
}
