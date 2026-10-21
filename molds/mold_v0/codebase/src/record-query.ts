/**
 * A page of a record area, filtered and sorted (mold_v0-059; molds/mold_v0/MOLD.md "Pack and record-area contract"):
 * the one parser of a RecordQuery (src/pack-api.ts) and its two engines, so every door (ctx.records, the data API's
 * REST routes, the record tools) reads the same way.
 *
 *   SQL      the shell's tables (src/record-areas.ts adds the area's and the workspace's own conditions first: every
 *            condition here is ANDed after them, so a filter, a sort or a cursor can only narrow the caller's rows).
 *            Field names and values are always parameters, never SQL text.
 *   memory   rows that cannot be read in the database: a sealed area's (its title and data are ciphertext there) and an
 *            area read live from an API. The same conditions and order, on the opened rows.
 *
 * Paging is by cursor. With the default order (by key) `next` is the last key, as it was before 059. With another order
 * it is "~" + base64url(JSON [sort, value, key]): a record key never starts with "~", so the two never mix, and a key
 * holding ( or ) (mold_v0-066) travels inside the JSON, never as cursor syntax. A cursor names its own sort and is
 * refused under another.
 */
import { optionValues, PackError, RECORD_KEY, type RecordQuery, type RecordRow } from "./pack-api.js";

export const MAX_LIMIT = 200;
const MAX_CONDITIONS = 20;
const OPS = ["eq", "ne", "in", "lt", "lte", "gt", "gte", "contains", "prefix", "exists"] as const;
export type Op = (typeof OPS)[number];

/** The part of an area's field this needs (src/pack-api.ts RecordFieldSchema). */
export interface QField { name: string; type: string; multiple?: boolean; options?: (string | { value: string; label?: string })[]; min?: number; max?: number; max_length?: number; to?: string }
type Target = "key" | "title" | "updated_at" | "field";
export interface Cond { target: Target; name: string; field?: QField; op: Op; value: unknown }
export interface SortSpec { target: Target; name: string; field?: QField; desc: boolean; text: string }
export interface Parsed { limit: number; conds: Cond[]; sort: SortSpec; after: { v: string | null; k: string } | null }

const bad = (m: string) => new PackError(m, 400);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The cursor for a row under `sort`: its key (the default order) or "~" + base64url([sort, value, key]). */
export function cursorOf(sort: SortSpec, sortValue: string | null, key: string): string {
  if (sort.target === "key" && !sort.desc) return key;
  return `~${Buffer.from(JSON.stringify([sort.text, sortValue, key]), "utf8").toString("base64url")}`;
}
function readCursor(after: unknown, sort: SortSpec): Parsed["after"] {
  if (after === undefined || after === null || after === "") return null;
  if (typeof after !== "string" || after.length > 2000) throw bad("after is the next value of the previous page");
  if (!after.startsWith("~")) {
    if (!RECORD_KEY.test(after)) throw bad("after is the next value of the previous page");
    if (!(sort.target === "key" && !sort.desc)) throw bad("after: this cursor is for the order by key; ask again with the same sort");
    return { v: null, k: after };
  }
  let x: unknown;
  try { x = JSON.parse(Buffer.from(after.slice(1), "base64url").toString("utf8")); } catch { throw bad("after is the next value of the previous page"); }
  if (!Array.isArray(x) || x.length !== 3 || typeof x[0] !== "string" || !(x[1] === null || typeof x[1] === "string") || typeof x[2] !== "string" || !RECORD_KEY.test(x[2]) || (x[1] ?? "").length > 1_000)
    throw bad("after is the next value of the previous page");
  if (x[0] !== sort.text) throw bad("after: this cursor is for another sort; ask again with the same sort");
  return { v: x[1], k: x[2] };
}

const SPECIAL: Record<string, Target> = { key: "key", title: "title", updated_at: "updated_at" };
const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a query against an area's fields. `fits(field, value)` and `fitsOne(field, value)` are the record store's own
 * type checks (a whole value; one element of a list field), so a filter value is checked as a stored one would be.
 */
export function parseQuery(fields: readonly QField[], q: RecordQuery | undefined, fits: (f: QField, v: unknown) => boolean, fitsOne: (f: QField, v: unknown) => boolean): Parsed {
  const opts = (q ?? {}) as Record<string, unknown>;
  const n = opts.limit === undefined || opts.limit === "" ? 50 : Number(opts.limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad(`limit is 1 to ${MAX_LIMIT}`);
  const target = (name: unknown, what: string): { target: Target; name: string; field?: QField } => {
    if (typeof name !== "string") throw bad(`${what} names a field`);
    if (SPECIAL[name]) return { target: SPECIAL[name]!, name };
    const f = fields.find((x) => x.name === name);
    if (!f) throw bad(`${what}: the area has no field ${JSON.stringify(name.slice(0, 64))}`);
    return { target: "field", name, field: f };
  };

  // ---- sort ----
  let sortText = "key";
  if (opts.sort !== undefined && opts.sort !== "") {
    if (typeof opts.sort !== "string" || opts.sort.length > 80) throw bad("sort is a field name, - first for descending");
    sortText = opts.sort;
  }
  const desc = sortText.startsWith("-");
  const st = target(desc ? sortText.slice(1) : sortText, "sort");
  const sort: SortSpec = { ...st, desc, text: sortText };

  // ---- filter ----
  let filter: unknown = opts.filter;
  if (typeof filter === "string") {
    if (filter.length > 8000) throw bad("filter is at most 8000 characters");
    try { filter = filter === "" ? undefined : JSON.parse(filter); } catch { throw bad("filter must be a JSON object: {\"field\": value} or {\"field\": {\"op\": value}}"); }
  }
  const conds: Cond[] = [];
  if (filter !== undefined && filter !== null) {
    if (!isObj(filter)) throw bad("filter must be an object: {field: value} or {field: {op: value}}");
    for (const [name, spec] of Object.entries(filter)) {
      const t = target(name, "filter");
      const ops: [string, unknown][] = isObj(spec) ? Object.entries(spec) : [["eq", spec]];
      if (!ops.length) throw bad(`filter ${name}: give a value or {op: value}`);
      for (const [op, value] of ops) {
        if (!(OPS as readonly string[]).includes(op)) throw bad(`filter ${name}: ${JSON.stringify(op.slice(0, 20))} is not one of ${OPS.join(", ")}`);
        conds.push(checkCond({ ...t, op: op as Op, value }, fits, fitsOne));
        if (conds.length > MAX_CONDITIONS) throw bad(`at most ${MAX_CONDITIONS} filter conditions`);
      }
    }
  }
  return { limit: n, conds, sort, after: readCursor(opts.after, sort) };
}

/** One condition: an operator its target takes, and a value of the target's type. */
function checkCond(c: Cond, fits: (f: QField, v: unknown) => boolean, fitsOne: (f: QField, v: unknown) => boolean): Cond {
  const where = `filter ${c.name} ${c.op}`;
  const str = (v: unknown, max = 500) => { if (typeof v !== "string" || v.length > max || v.includes("\u0000")) throw bad(`${where}: give text (up to ${max} characters)`); return v; };
  if (c.op === "exists") { if (typeof c.value !== "boolean") throw bad(`${where}: true or false`); return c; }
  if (c.value === null || c.value === undefined) throw bad(`${where}: give a value (for "no value", use {"exists": false})`);
  if (c.target === "key") {
    if (["contains"].includes(c.op)) throw bad(`${where}: a key takes eq, ne, in, prefix, lt, lte, gt, gte or exists`);
    if (c.op === "in") { if (!Array.isArray(c.value) || !c.value.length || c.value.length > 100 || !c.value.every((x) => typeof x === "string" && RECORD_KEY.test(x))) throw bad(`${where}: a list of 1-100 record keys`); return c; }
    str(c.value, 200);
    return c;
  }
  if (c.target === "title") {
    if (!["eq", "ne", "contains", "prefix"].includes(c.op)) throw bad(`${where}: a title takes eq, ne, contains, prefix or exists`);
    str(c.value);
    return c;
  }
  if (c.target === "updated_at") {
    if (!["lt", "lte", "gt", "gte"].includes(c.op)) throw bad(`${where}: updated_at takes lt, lte, gt or gte`);
    if (typeof c.value !== "string" || !ISO.test(c.value) || Number.isNaN(Date.parse(c.value))) throw bad(`${where}: a date or time (ISO 8601)`);
    return c;
  }
  const f = c.field!;
  const list = !!f.multiple || f.type === "link";
  switch (c.op) {
    case "eq": case "ne":
      if (f.type === "json") break;
      if (!fits(f, c.value)) throw bad(`${where}: not a value field ${f.name} takes`);
      break;
    case "in":
      if (list || f.type === "json") throw bad(`${where}: in is for single-value fields (use contains for a list field)`);
      if (!Array.isArray(c.value) || !c.value.length || c.value.length > 100 || !c.value.every((x) => fits(f, x))) throw bad(`${where}: a list of 1-100 values field ${f.name} takes`);
      break;
    case "lt": case "lte": case "gt": case "gte":
      if (!["number", "date", "text"].includes(f.type)) throw bad(`${where}: only number, date and text fields are ordered`);
      if (!fits(f, c.value)) throw bad(`${where}: not a value field ${f.name} takes`);
      break;
    case "contains":
      if (f.type === "text") { str(c.value); break; }
      if (f.type === "link") { if (typeof c.value !== "string" || !RECORD_KEY.test(c.value)) throw bad(`${where}: a record key`); break; }
      if (!f.multiple) throw bad(`${where}: contains is for text and list fields`);
      if (!fitsOne(f, c.value)) throw bad(`${where}: not one value field ${f.name} lists`);
      break;
    case "prefix":
      if (!["text", "date", "enum", "reference", "person"].includes(f.type) || f.multiple) throw bad(`${where}: prefix is for text, date, enum, reference and person fields`);
      str(c.value);
      break;
  }
  return c;
}

/** Does the query need the rows' titles or data (a filter or a sort that is not on the key)? */
export const readsContent = (p: Parsed) => p.sort.target !== "key" || p.conds.some((c) => c.target !== "key");

// ---------- the SQL engine ----------

/**
 * The conditions, order and cursor as SQL over a record table, with `params` already holding the caller's own scope
 * (`base`: the area, and the workspace's id). Returns the WHERE additions, the ORDER BY, and the sort value's text.
 */
export function sqlParts(p: Parsed, params: unknown[]): { where: string[]; order: string; sortValue: string } {
  const $ = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  const fieldExpr = (name: string) => `COALESCE(data -> ${$(name)}, 'null'::jsonb)`;
  for (const c of p.conds) {
    if (c.target === "key" || c.target === "title") {
      const col = c.target === "key" ? "key" : "title";
      switch (c.op) {
        case "exists": where.push(c.value ? `(${col} IS NOT NULL AND ${col} <> '')` : `(${col} IS NULL OR ${col} = '')`); break;
        case "eq": where.push(`${col} = ${$(c.value)}`); break;
        case "ne": where.push(`${col} IS DISTINCT FROM ${$(c.value)}`); break;
        case "in": where.push(`${col} = ANY (${$(c.value)}::text[])`); break;
        case "prefix": { const v = $(c.value); where.push(`left(${col}, char_length(${v})) = ${v}`); break; }
        case "contains": where.push(`strpos(lower(${col}), lower(${$(c.value)})) > 0`); break;
        default: where.push(`${col} ${({ lt: "<", lte: "<=", gt: ">", gte: ">=" } as Record<string, string>)[c.op]} ${$(c.value)}`);
      }
      continue;
    }
    if (c.target === "updated_at") {
      where.push(`updated_at ${({ lt: "<", lte: "<=", gt: ">", gte: ">=" } as Record<string, string>)[c.op]} ${$(c.value)}::timestamptz`);
      continue;
    }
    const f = c.field!;
    switch (c.op) {
      case "exists": {
        const e = fieldExpr(c.name);
        where.push(c.value ? `(${e} NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb))` : `(${e} IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb))`);
        break;
      }
      case "eq": where.push(`${fieldExpr(c.name)} = ${$(JSON.stringify(c.value))}::jsonb`); break;
      case "ne": where.push(`${fieldExpr(c.name)} <> ${$(JSON.stringify(c.value))}::jsonb`); break;
      case "in": where.push(`${$(JSON.stringify(c.value))}::jsonb @> jsonb_build_array(${fieldExpr(c.name)})`); break;
      case "lt": case "lte": case "gt": case "gte": {
        const e = fieldExpr(c.name);
        where.push(`(jsonb_typeof(${e}) = ${$(typeof c.value === "number" ? "number" : "string")} AND ${e} ${({ lt: "<", lte: "<=", gt: ">", gte: ">=" } as Record<string, string>)[c.op]} ${$(JSON.stringify(c.value))}::jsonb)`);
        break;
      }
      case "contains":
        if (f.type === "text") where.push(`strpos(lower(data ->> ${$(c.name)}), lower(${$(c.value)})) > 0`);
        else { const e = fieldExpr(c.name), v = $(JSON.stringify(c.value)); where.push(`(${e} = ${v}::jsonb OR (jsonb_typeof(${e}) = 'array' AND ${e} @> jsonb_build_array(${v}::jsonb)))`); }
        break;
      case "prefix": { const v = $(c.value); where.push(`(jsonb_typeof(data -> ${$(c.name)}) = 'string' AND left(data ->> ${$(c.name)}, char_length(${v})) = ${v})`); break; }
    }
  }
  const s = p.sort;
  const dir = s.desc ? "DESC" : "ASC", cmp = s.desc ? "<" : ">";
  if (s.target === "key") {
    if (p.after) where.push(`key ${cmp} ${$(p.after.k)}`);
    return { where, order: `key ${dir}`, sortValue: "NULL::text" };
  }
  const [expr, cast] = s.target === "title" ? ["COALESCE(title, '')", "text"] : s.target === "updated_at" ? ["updated_at", "timestamptz"] : [fieldExpr(s.name), "jsonb"];
  if (p.after) where.push(`(${expr}, key) ${cmp} (${$(p.after.v ?? (cast === "jsonb" ? "null" : ""))}::${cast}, ${$(p.after.k)})`);
  return { where, order: `${expr} ${dir}, key ${dir}`, sortValue: `(${expr})::text` };
}

// ---------- the memory engine ----------

/** jsonb's order across types (null < string < number < boolean < array < object), then within a type. */
const rank = (v: unknown) => (v === null || v === undefined ? 0 : typeof v === "string" ? 1 : typeof v === "number" ? 2 : typeof v === "boolean" ? 3 : Array.isArray(v) ? 4 : 5);
export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 2) return (a as number) - (b as number);
  if (ra === 3) return Number(a) - Number(b);
  const x = ra === 1 ? (a as string) : JSON.stringify(a), y = ra === 1 ? (b as string) : JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const emptyValue = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => compareValues(a, b) === 0 && rank(a) === rank(b);

function sortValueOf(s: SortSpec, r: RecordRow): unknown {
  return s.target === "key" ? r.key : s.target === "title" ? r.title ?? "" : s.target === "updated_at" ? r.updated_at : r.data[s.name] ?? null;
}
/** The text a cursor carries for a row's sort value (what the SQL engine's ::text gives, for the same engine only). */
const sortText = (s: SortSpec, r: RecordRow): string | null => {
  const v = sortValueOf(s, r);
  return s.target === "field" ? JSON.stringify(v ?? null) : String(v);
};

function matches(c: Cond, r: RecordRow): boolean {
  const v: unknown = c.target === "key" ? r.key : c.target === "title" ? r.title : c.target === "updated_at" ? r.updated_at : r.data[c.name] ?? null;
  switch (c.op) {
    case "exists": return c.value ? !emptyValue(v) : emptyValue(v);
    case "eq": return c.target === "field" ? same(v ?? null, c.value) : v === c.value;
    case "ne": return c.target === "field" ? !same(v ?? null, c.value) : v !== c.value;
    case "in": return (c.value as unknown[]).some((x) => (c.target === "field" ? same(v ?? null, x) : v === x));
    case "prefix": return typeof v === "string" && v.startsWith(c.value as string);
    case "contains":
      if (c.target !== "field" || c.field!.type === "text") return typeof v === "string" && v.toLowerCase().includes(String(c.value).toLowerCase());
      return same(v, c.value) || (Array.isArray(v) && v.some((x) => same(x, c.value)));
    default: {
      if (c.target === "updated_at") { const t = Date.parse(String(v)), w = Date.parse(String(c.value)); return ({ lt: t < w, lte: t <= w, gt: t > w, gte: t >= w } as Record<string, boolean>)[c.op]!; }
      if (c.target === "field" && rank(v) !== rank(c.value)) return false;
      const d = c.target === "field" ? compareValues(v, c.value) : cmpKey(String(v ?? ""), String(c.value));
      return ({ lt: d < 0, lte: d <= 0, gt: d > 0, gte: d >= 0 } as Record<string, boolean>)[c.op]!;
    }
  }
}

/** The page of `rows` (already the caller's own, opened) the query asks for: filtered, ordered, after the cursor. */
export function pageInMemory(p: Parsed, rows: RecordRow[]): { records: RecordRow[]; next: string | null } {
  const s = p.sort;
  const cmp = (a: RecordRow, b: RecordRow) => {
    const d = s.target === "key" ? 0 : s.target === "field" ? compareValues(sortValueOf(s, a), sortValueOf(s, b)) : cmpKey(String(sortValueOf(s, a)), String(sortValueOf(s, b)));
    return (d || cmpKey(a.key, b.key)) * (s.desc ? -1 : 1);
  };
  let list = rows.filter((r) => p.conds.every((c) => matches(c, r))).sort(cmp);
  if (p.after) {
    const at = { key: p.after.k, title: null, data: {}, area: "", version: null, updated_at: "" } as RecordRow;
    const v = p.after.v;
    const after = (r: RecordRow) => {
      let d: number;
      if (s.target === "key") d = cmpKey(r.key, at.key);
      else {
        const rv = sortValueOf(s, r);
        const cv = s.target === "field" ? (() => { try { return JSON.parse(v ?? "null"); } catch { return null; } })() : v ?? "";
        d = (s.target === "field" ? compareValues(rv, cv) : cmpKey(String(rv), String(cv))) || cmpKey(r.key, at.key);
      }
      return s.desc ? d < 0 : d > 0;
    };
    list = list.filter(after);
  }
  const page = list.slice(0, p.limit);
  const last = page.at(-1);
  return { records: page, next: list.length > p.limit && last ? cursorOf(s, s.target === "key" ? null : sortText(s, last), last.key) : null };
}

/** The options of an enum field (re-exported for the record store's checks). */
export { optionValues };
