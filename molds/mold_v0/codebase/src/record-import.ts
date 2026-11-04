/**
 * Staff import into a shared record area (mold_v0-221; POST /api/admin/records/_console/<area>/import, src/record-routes.ts;
 * the console's Import card, web/src/features/records/staff-import.tsx). The console reads a CSV or JSON file and maps
 * its columns to the area's fields; the rows arrive here as {key, title?, data} with each value as the file held it
 * (text from a CSV, any JSON value from a JSON file).
 *
 *   dry_run (the default)  each row coerced to its fields' types and checked as a write would be (types, required
 *                          fields, references), and what importing it would do: create, update (a staff row), override
 *                          (a repository's row: the staff row wins over it until removed, src/record-areas.ts
 *                          putPlatform), unchanged (the stored row already says this), or invalid with its problems.
 *                          Nothing is written.
 *   dry_run: false         the valid rows that change something, written as staff rows (provenance staff) in one
 *                          transaction through the record store's own batch (src/record-areas.ts adminRecords), so a
 *                          repository's index never overwrites or prunes them; invalid rows are skipped and reported.
 *
 * Idempotent by key: a row's fields are merged over the stored row's (a column the file leaves out keeps its value), and
 * a row that changes nothing is not written, so importing the same file twice writes nothing the second time. A key
 * given twice in one file is refused on its later row. The route records the import and each row it wrote in the staff
 * access log (admin_access_log: the request, then one IMPORT line per row) and the platform trail when it is on.
 */
import { canonical } from "./data-repositories.js";
import { PackError, RECORD_KEY } from "./pack-api.js";
import { adminRecords, checkRecord, platformStored, SYSTEM_ACTOR, type RecordArea } from "./record-areas.js";

/** At most this many rows per import (the record store's batch). */
export const IMPORT_MAX_ROWS = 1000;

export type ImportAction = "create" | "update" | "override" | "unchanged" | "invalid";
export interface ImportRowReport { row: number; key: string; action: ImportAction; errors: string[] }
export interface ImportReport {
  area: string; dry_run: boolean; rows: ImportRowReport[];
  counts: Record<ImportAction, number>;
  /** Rows written (dry_run false): created, updated and overridden. */
  written: number;
}

type Field = RecordArea["fields"][number];
const TRUE = /^(true|yes|y|1)$/i, FALSE = /^(false|no|n|0)$/i;
const split = (s: string) => s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
const optionOf = (f: Field, v: string): string | null => {
  for (const o of f.options ?? []) {
    const value = typeof o === "string" ? o : o.value, label = typeof o === "string" ? o : o.label ?? o.value;
    if (value === v || value.toLowerCase() === v.toLowerCase() || label.toLowerCase() === v.toLowerCase()) return value;
  }
  return null;
};

/**
 * One cell, as the field stores it: text from a CSV becomes a number, a yes or no, JSON, a list, an option's value (by
 * its value or its label). Blank: undefined (the stored value is kept). Anything else is left for the record store's check.
 */
export function coerceCell(f: Field, v: unknown): { value?: unknown; problem?: string } {
  if (v === null || v === undefined) return {};
  if (typeof v !== "string") {
    if (f.type === "enum" && typeof v === "object" && Array.isArray(v)) return { value: v.map((x) => (typeof x === "string" ? optionOf(f, x) ?? x : x)) };
    return { value: v };
  }
  const t = v.trim();
  if (!t) return {};
  switch (f.type) {
    case "number": { const n = Number(t); return Number.isFinite(n) ? { value: n } : { problem: `${f.label} is not a number (${t.slice(0, 40)})` }; }
    case "boolean": return TRUE.test(t) ? { value: true } : FALSE.test(t) ? { value: false } : { problem: `${f.label} is not yes or no (${t.slice(0, 40)})` };
    case "json": try { return { value: JSON.parse(t) }; } catch { return { problem: `${f.label} is not valid JSON` }; }
    case "enum": {
      const one = (x: string) => optionOf(f, x) ?? x;
      return { value: f.multiple ? split(t).map(one) : one(t) };
    }
    case "link": { const l = split(t); return { value: l.length > 1 ? l : l[0] }; }
    case "file": return { value: f.multiple ? split(t).map((path) => ({ path })) : { path: t } };
    default: return { value: f.multiple ? split(t) : t };
  }
}

/** The import: checked always, written unless `dryRun`. */
export async function importRecords(area: RecordArea, raw: unknown, opts: { dryRun: boolean }): Promise<ImportReport> {
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records`, 404);
  if (area.fields.some((f) => f.encrypted)) throw new PackError(`${area.label} has an encrypted field: its values are never imported from a file`, 409);
  if (!Array.isArray(raw) || !raw.length) throw new PackError("rows: a list of 1 or more {key, title?, data}", 400);
  if (raw.length > IMPORT_MAX_ROWS) throw new PackError(`an import holds at most ${IMPORT_MAX_ROWS} rows; split the file`, 413);
  const keyOf = (r: unknown) => { const k = (r as { key?: unknown })?.key; return typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : ""; };
  const stored = await platformStored(area, [...new Set(raw.map(keyOf).filter((k) => RECORD_KEY.test(k)))]);
  const seen = new Map<string, number>();
  const rows: ImportRowReport[] = [];
  const writes: { op: "put"; area: string; key: string; title: string | null; data: Record<string, unknown> }[] = [];
  for (const [i, r] of raw.entries()) {
    const n = i + 1, key = keyOf(r), errors: string[] = [];
    const report = (action: ImportAction) => rows.push({ row: n, key, action, errors });
    if (!r || typeof r !== "object" || Array.isArray(r)) { errors.push("not a row of the file"); report("invalid"); continue; }
    if (!key) errors.push("no key");
    else if (!RECORD_KEY.test(key)) errors.push(`the key ${JSON.stringify(key.slice(0, 60))} is not a record key (a letter or digit first, then letters, digits and . _ - : ( ), up to 200)`);
    else if (seen.has(key)) errors.push(`the key ${key} is also on row ${seen.get(key)}`);
    if (key && !seen.has(key)) seen.set(key, n);
    const { title, data } = r as { title?: unknown; data?: unknown };
    if (title !== undefined && title !== null && typeof title !== "string") errors.push("the title is not text");
    const given: Record<string, unknown> = {};
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) errors.push("data is not an object of fields");
    else for (const [name, v] of Object.entries((data ?? {}) as Record<string, unknown>)) {
      const f = area.fields.find((x) => x.name === name);
      if (!f) { errors.push(`${area.label} has no field ${JSON.stringify(name.slice(0, 60))}`); continue; }
      const c = coerceCell(f, v);
      if (c.problem) errors.push(c.problem);
      else if (c.value !== undefined) given[name] = c.value;
    }
    if (errors.length) { report("invalid"); continue; }
    const before = stored.get(key);
    // Merged over what is stored: a field the file leaves out keeps its value; no title column keeps the title.
    const merged = { ...(before?.data ?? {}), ...given };
    const t = typeof title === "string" && title.trim() ? title.trim().slice(0, 500) : before?.title ?? null;
    try { await checkRecord(area, merged, null, SYSTEM_ACTOR, `row ${n}`); }
    catch (e) { if (!(e instanceof PackError)) throw e; errors.push(...e.message.split("; ")); report("invalid"); continue; }
    if (before && before.title === t && canonical(before.data) === canonical(merged)) { report("unchanged"); continue; }
    report(!before ? "create" : before.source ? "override" : "update");
    writes.push({ op: "put", area: area.name, key, title: t, data: merged });
  }
  if (!opts.dryRun && writes.length) await adminRecords.batch(writes);
  const counts = { create: 0, update: 0, override: 0, unchanged: 0, invalid: 0 } satisfies Record<ImportAction, number>;
  for (const r of rows) counts[r.action]++;
  return { area: area.name, dry_run: opts.dryRun, rows, counts, written: opts.dryRun ? 0 : writes.length };
}
