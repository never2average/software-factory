/**
 * Imports of a CSV or JSON file into record areas. The console reads the file and maps its columns to the area's fields;
 * the rows arrive here as {key, title?, data} with each value as the file held it (text from a CSV, any JSON value from
 * a JSON file). Two doors, the same rules for a row:
 *
 *   staff, a shared area (mold_v0-221; POST /api/admin/records/_console/<area>/import, src/record-routes.ts; the
 *   console's Import card, web/src/features/records/staff-import.tsx): importRecords. Rows become staff rows
 *   (provenance staff) through the record store's own batch (src/record-areas.ts adminRecords), so a repository's index
 *   never overwrites or prunes them; over a repository's row a row is an override (the staff row wins until removed).
 *
 *   a workspace, its own records (mold_v0-234; POST /api/data/<area>/_import, src/data-routes.ts; the Import beside a
 *   list's Export, web/src/features/tabs/export.tsx): importWorkspaceRecords. Only where the area's contract grants
 *   `import` (src/record-areas.ts importRoles: its roles that may also add and change the area's records; none when the
 *   contract does not say), for the person's role. Rows are written through the workspace's own record store (each
 *   row's create or update permission, its fields, references and lifecycle, sealing) in one transaction, as that
 *   person (provenance people, mold_v0-236), each write in the data trail. A lifecycle's state is never set by a file:
 *   a new record starts in the initial state, an existing one keeps its own (a row that names another state is invalid).
 *
 *   dry_run (the default)  each row coerced to its fields' types and checked as a write would be (types, required
 *                          fields, references), and what importing it would do: create, update, override (staff, a
 *                          repository's row), unchanged (the stored row already says this), or invalid with its
 *                          problems. Nothing is written.
 *   dry_run: false         the valid rows that change something, in one transaction; invalid rows are skipped and
 *                          reported.
 *
 * Idempotent by key: a row's fields are merged over the stored row's (a column the file leaves out keeps its value), and
 * a row that changes nothing is not written, so importing the same file twice writes nothing the second time. A key
 * given twice in one file is refused on its later row. An area with an encrypted field takes no import (its values
 * never come from a file). The staff route records the import and each row it wrote in the staff access log
 * (admin_access_log: the request, then one IMPORT line per row) and the platform trail when it is on.
 */
import { canonical } from "./data-repositories.js";
import { PackError, RECORD_KEY } from "./pack-api.js";
import { adminRecords, asWriterUnlessSet, assertMayImport, checkRecord, isReadOnlyArea, may, platformStored, SYSTEM_ACTOR, workspaceRecords, workspaceStored, type Actor, type RecordArea } from "./record-areas.js";

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

/** One row of the file, read against the area's fields: its key, title and coerced fields, or its problems. */
interface ReadRow { n: number; key: string; title: unknown; given: Record<string, unknown>; errors: string[] }
function readRows(area: RecordArea, raw: unknown): ReadRow[] {
  if (area.fields.some((f) => f.encrypted)) throw new PackError(`${area.label} has an encrypted field: its values are never imported from a file`, 409);
  if (!Array.isArray(raw) || !raw.length) throw new PackError("rows: a list of 1 or more {key, title?, data}", 400);
  if (raw.length > IMPORT_MAX_ROWS) throw new PackError(`an import holds at most ${IMPORT_MAX_ROWS} rows; split the file`, 413);
  const seen = new Map<string, number>();
  return raw.map((r, i) => {
    const n = i + 1, key = keyOf(r), errors: string[] = [], given: Record<string, unknown> = {};
    if (!r || typeof r !== "object" || Array.isArray(r)) return { n, key, title: undefined, given, errors: ["not a row of the file"] };
    if (!key) errors.push("no key");
    else if (!RECORD_KEY.test(key)) errors.push(`the key ${JSON.stringify(key.slice(0, 60))} is not a record key (a letter or digit first, then letters, digits and . _ - : ( ), up to 200)`);
    else if (seen.has(key)) errors.push(`the key ${key} is also on row ${seen.get(key)}`);
    if (key && !seen.has(key)) seen.set(key, n);
    const { title, data } = r as { title?: unknown; data?: unknown };
    if (title !== undefined && title !== null && typeof title !== "string") errors.push("the title is not text");
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) errors.push("data is not an object of fields");
    else for (const [name, v] of Object.entries((data ?? {}) as Record<string, unknown>)) {
      const f = area.fields.find((x) => x.name === name);
      if (!f) { errors.push(`${area.label} has no field ${JSON.stringify(name.slice(0, 60))}`); continue; }
      const c = coerceCell(f, v);
      if (c.problem) errors.push(c.problem);
      else if (c.value !== undefined) given[name] = c.value;
    }
    return { n, key, title, given, errors };
  });
}
const keyOf = (r: unknown) => { const k = (r as { key?: unknown })?.key; return typeof k === "string" ? k.trim() : typeof k === "number" ? String(k) : ""; };
const titleOf = (title: unknown, before: string | null | undefined) => (typeof title === "string" && title.trim() ? title.trim().slice(0, 500) : before ?? null);
const countOf = <A extends string>(actions: readonly A[], rows: { action: A }[]) => {
  const counts = Object.fromEntries(actions.map((a) => [a, 0])) as Record<A, number>;
  for (const r of rows) counts[r.action]++;
  return counts;
};

/** The staff import into a shared area: checked always, written unless `dryRun`. */
export async function importRecords(area: RecordArea, raw: unknown, opts: { dryRun: boolean }): Promise<ImportReport> {
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records`, 404);
  const read = readRows(area, raw);
  const stored = await platformStored(area, [...new Set(read.map((r) => r.key).filter((k) => RECORD_KEY.test(k)))]);
  const rows: ImportRowReport[] = [];
  const writes: { op: "put"; area: string; key: string; title: string | null; data: Record<string, unknown> }[] = [];
  for (const { n, key, title, given, errors } of read) {
    const report = (action: ImportAction) => rows.push({ row: n, key, action, errors });
    if (errors.length) { report("invalid"); continue; }
    const before = stored.get(key);
    // Merged over what is stored: a field the file leaves out keeps its value; no title column keeps the title.
    const merged = { ...(before?.data ?? {}), ...given };
    const t = titleOf(title, before?.title);
    try { await checkRecord(area, merged, null, SYSTEM_ACTOR, `row ${n}`); }
    catch (e) { if (!(e instanceof PackError)) throw e; errors.push(...e.message.split("; ")); report("invalid"); continue; }
    if (before && before.title === t && canonical(before.data) === canonical(merged)) { report("unchanged"); continue; }
    report(!before ? "create" : before.source ? "override" : "update");
    writes.push({ op: "put", area: area.name, key, title: t, data: merged });
  }
  if (!opts.dryRun && writes.length) await adminRecords.batch(writes);
  return { area: area.name, dry_run: opts.dryRun, rows, counts: countOf(["create", "update", "override", "unchanged", "invalid"], rows), written: opts.dryRun ? 0 : writes.length };
}

export type WorkspaceImportAction = "create" | "update" | "unchanged" | "invalid";
export interface WorkspaceImportReport {
  area: string; dry_run: boolean; rows: { row: number; key: string; action: WorkspaceImportAction; errors: string[] }[];
  counts: Record<WorkspaceImportAction, number>;
  /** Rows written (dry_run false): created and updated. */
  written: number;
}

/**
 * A workspace's import into one of its own areas (mold_v0-234): checked always, written unless `dryRun`, for `actor`
 * (the person the call is made for: the contract's import roles, then each row's create or update permission).
 */
export async function importWorkspaceRecords(orgId: number, actor: Actor, area: RecordArea, raw: unknown, opts: { dryRun: boolean }): Promise<WorkspaceImportReport> {
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared by every workspace: platform staff import it`, 403);
  if (isReadOnlyArea(area)) throw new PackError(`${area.label} records come from its repository ${area.repo!.name}: read only here`, 409);
  assertMayImport(area, actor);
  const read = readRows(area, raw);
  const stored = await workspaceStored(orgId, area, [...new Set(read.map((r) => r.key).filter((k) => RECORD_KEY.test(k)))]);
  const life = area.lifecycle;
  const rows: WorkspaceImportReport["rows"] = [];
  const writes: { op: "create" | "update"; area: string; key: string; title: string | null; data: Record<string, unknown> }[] = [];
  for (const { n, key, title, given, errors } of read) {
    const report = (action: WorkspaceImportAction) => rows.push({ row: n, key, action, errors });
    if (errors.length) { report("invalid"); continue; }
    const before = stored.get(key);
    if (before && area.append_only) { errors.push(`${area.label} records are append-only: ${key} is never changed once added`); report("invalid"); continue; }
    if (!may(area, before ? "update" : "create", actor)) { errors.push(`your role may not ${before ? "change" : "add"} ${area.label} records`); report("invalid"); continue; }
    // A lifecycle's state comes from its moves, never a file: the stored state (or the initial one) or nothing.
    const fields = { ...given };
    if (life && life.field in fields) {
      const state = before ? before.data[life.field] ?? life.initial : life.initial;
      if (fields[life.field] !== state) {
        errors.push(before ? `${life.field} is ${JSON.stringify(state)}: it changes only by a move, never an import` : `a new ${area.label} record starts as ${JSON.stringify(life.initial)}; it moves from there`);
        report("invalid"); continue;
      }
      delete fields[life.field];
    }
    const kept = { ...(before?.data ?? {}) };
    if (life) delete kept[life.field];
    const merged = { ...kept, ...fields };
    const t = titleOf(title, before?.title);
    try { await checkRecord(area, merged, orgId, actor, `row ${n}`, life ? [life.field] : []); }
    catch (e) { if (!(e instanceof PackError)) throw e; errors.push(...e.message.split("; ")); report("invalid"); continue; }
    if (before && before.title === t && canonical(kept) === canonical(merged)) { report("unchanged"); continue; }
    report(before ? "update" : "create");
    writes.push({ op: before ? "update" : "create", area: area.name, key, title: t, data: merged });
  }
  // One transaction through the workspace's record store, as the person (provenance people, mold_v0-236).
  if (!opts.dryRun && writes.length)
    await asWriterUnlessSet({ by: "people", id: actor.userId }, () => workspaceRecords(area.pack, orgId, actor).batch(writes));
  return { area: area.name, dry_run: opts.dryRun, rows, counts: countOf(["create", "update", "unchanged", "invalid"], rows), written: opts.dryRun ? 0 : writes.length };
}
