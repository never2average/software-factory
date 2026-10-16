/**
 * A LIST OF AN ACCOUNT RECORD AREA, FILTERED, SORTED AND PAGED IN THE DATABASE (deployments, implementations): what the
 * ops list routes take as `?where=&sort=&q=&cursor=&limit=` and the agent's `list_<area>` tools take as input.
 *
 *   parseRecordQuery()    pure: the caller's filters, sorts and search checked against the area's compiled definition.
 *                         A key is a field of the area (or its alias, or `account`), never anything else: the only
 *                         identifiers that reach SQL come from the definition (a whitelist). A value is checked and put
 *                         in its stored form (a choice's label becomes its value). Answers in sentences.
 *   compileRecordQuery()  the parsed query as Drizzle SQL over the area's table: a column by its column, an own field
 *                         under `custom` (`custom @> {"k": v}` for equality, which a GIN index on `custom` serves; text
 *                         and numbers read out of it for ranges and sorting, a malformed stored value read as nothing,
 *                         never an error). Every value is a bound parameter.
 *
 * The workspace is the caller's: every query runs inside withOrgRls / withOrgDb and also names `org_id`.
 * Pages are an opaque cursor over a total order (the sort, then the row's key), at most MAX_LIMIT rows a page.
 */
import { and, asc, eq, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { RECORD_AREAS, type RecordCategory, type RecordField } from "./record-areas.generated.ts";
import { areaView, CATEGORIES, type AreaView, type RecordAreas } from "./record-areas.ts";
import { coerceFieldValue } from "./record-values.ts";
import { ACCOUNT_FIELD, type AccountAreaId } from "./record-area-records.ts";

/** Today's page size for the lists (the 300-row cap the routes always had). */
export const MAX_LIMIT = 300;

export type FilterOp = "eq" | "ne" | "in" | "not_in" | "lt" | "lte" | "gt" | "gte" | "set" | "contains" | "category";
export interface RecordQueryInput {
  /** `{ field: value | { eq, ne, in, not_in, lt, lte, gt, gte, set, contains, category } }`, every condition must hold. */
  where?: Record<string, unknown> | null;
  /** `[{ field, dir }]`, or "field" / "-field" / "field:desc", comma-separated. */
  sort?: { field: string; dir?: "asc" | "desc" }[] | string | null;
  /** Words to find in the record's searchable text. */
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
}
/** One condition on one field, its value(s) in stored form. */
export interface Condition { key: string; field: RecordField | null; op: FilterOp; value: unknown }
export interface ParsedQuery { conditions: Condition[]; sort: { key: string; field: RecordField | null; dir: "asc" | "desc" }[]; q: string | null; offset: number; limit: number }

const OPS: readonly FilterOp[] = ["eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte", "set", "contains", "category"];
const ORDERED = new Set(["integer", "number", "percent", "money", "date", "datetime", "text", "pick_list", "email", "person", "link"]);
const NUMERIC = new Set(["integer", "number", "percent", "money"]);
const LISTS = new Set(["multi_pick", "tags"]);
const isList = (f: RecordField) => LISTS.has(f.type) || (Boolean(f.many) && ["person", "record", "file"].includes(f.type));

/** The fields a query may name, in order, as a sentence's list. */
function fieldList(v: AreaView): string {
  return [ACCOUNT_FIELD, ...v.visibleFields.map((f) => f.key)].map((k) => `\`${k}\``).join(", ");
}

/** A cursor is the offset of the next page, opaque to the caller. */
export const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`, "utf8").toString("base64url");
function decodeCursor(c: string): number | null {
  try {
    const m = /^o:(\d{1,9})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The caller's query, checked against the area's definition. */
export function parseRecordQuery(id: AccountAreaId, input: RecordQueryInput, areas: RecordAreas = RECORD_AREAS, opts: { defaultLimit?: number } = {}): { ok: true; query: ParsedQuery } | { ok: false; errors: string[] } {
  const v = areaView(id, areas);
  const errors: string[] = [];
  const resolve = (key: string, what: string): { key: string; field: RecordField | null } | null => {
    if (key === ACCOUNT_FIELD) return { key, field: null };
    const f = v.field(key);
    if (!f || f.hidden) {
      errors.push(`There is no field "${key}" to ${what} here. The fields are: ${fieldList(v)}.`);
      return null;
    }
    if (f.computed) {
      const why = computedUnsupported(v, f);
      if (why) {
        errors.push(`${label(f)} is computed from the record's other fields in a way the server cannot ${what === "sort by" ? "sort" : "filter"} on (${why}); ${what === "sort by" ? "sort" : "filter"} on the fields it is computed from.`);
        return null;
      }
    }
    return { key: f.key, field: f };
  };
  const label = (f: RecordField) => `"${f.label ?? f.key}" (${f.key})`;
  /** One value of a field in stored form, or null after saying why. */
  const one = (f: RecordField | null, raw: unknown, key: string): unknown => {
    if (f === null) {
      if (typeof raw !== "string" || !raw.trim()) { errors.push(`\`${ACCOUNT_FIELD}\` takes an account id.`); return null; }
      return raw.trim();
    }
    const base = isList(f) ? { ...f, type: f.type === "multi_pick" ? ("pick_list" as const) : f.type === "tags" ? ("text" as const) : f.type, many: false } : f;
    if (base.type === "date" || base.type === "datetime") {
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) { errors.push(`${label(f)} is compared with a date, for example 2026-07-31.`); return null; }
      return raw.trim();
    }
    if (base.type === "boolean") {
      if (typeof raw === "boolean") return raw;
      errors.push(`${label(f)} is true or false.`);
      return null;
    }
    // A column keeps the text it was given (an email in any case is still that email); a choice is its stored value.
    const out = coerceFieldValue({ ...base, required: undefined, pattern: undefined, min: undefined, max: undefined } as RecordField, raw);
    if ("error" in out) { errors.push(out.error); return null; }
    return out.value;
  };

  const conditions: Condition[] = [];
  const where = input.where ?? {};
  if (typeof where !== "object" || Array.isArray(where)) errors.push("`where` maps a field to the value it must have, or to { eq, in, lt, gt, set, … }.");
  else {
    for (const [key, cond] of Object.entries(where)) {
      const r = resolve(key, "filter on");
      if (!r) continue;
      const { field } = r;
      const ops: [FilterOp, unknown][] = cond !== null && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond as Record<string, unknown>).map(([op, x]) => [op as FilterOp, x]) : [[Array.isArray(cond) ? "in" : "eq", cond]];
      for (const [op, raw] of ops) {
        if (!OPS.includes(op)) { errors.push(`"${op}" is not a comparison. Use one of: ${OPS.join(", ")}.`); continue; }
        if (op === "set") {
          if (typeof raw !== "boolean") errors.push(`\`set\` on ${key} is true (has a value) or false (has none).`);
          else conditions.push({ key: r.key, field, op, value: raw });
          continue;
        }
        if (op === "category") {
          const lc = v.lifecycle;
          if (!lc || !field || lc.field !== field.key) { errors.push(`\`category\` applies to the lifecycle's field${lc ? ` (\`${lc.field}\`)` : ", and this area has no lifecycle"}.`); continue; }
          const cats = (Array.isArray(raw) ? raw : [raw]).map(String);
          const bad = cats.filter((c) => !CATEGORIES.includes(c as RecordCategory));
          if (bad.length) { errors.push(`${bad.map((c) => `"${c}"`).join(", ")} is not a category. Use: ${CATEGORIES.join(", ")}.`); continue; }
          const states = (lc.states ?? []).filter((s) => cats.includes(String(s.category))).map((s) => s.value);
          conditions.push({ key: r.key, field, op: "in", value: states });
          continue;
        }
        if (op === "in" || op === "not_in") {
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) { errors.push(`\`${op}\` on ${key} takes a list of 1 to 50 values.`); continue; }
          const vals = raw.map((x) => one(field, x, key));
          if (vals.some((x) => x === null)) continue;
          conditions.push({ key: r.key, field, op, value: vals });
          continue;
        }
        if (op === "contains" && !(field && isList(field))) { errors.push(`\`contains\` applies to a list field; ${key} is not one.`); continue; }
        if (["lt", "lte", "gt", "gte"].includes(op) && field && !ORDERED.has(field.type)) { errors.push(`${label(field)} cannot be compared as greater or smaller.`); continue; }
        if (field && isList(field) && op !== "contains") { errors.push(`${label(field)} is a list: use \`contains\` (or \`set\`).`); continue; }
        const val = one(field, raw, key);
        if (val === null) continue;
        conditions.push({ key: r.key, field, op, value: val });
      }
    }
  }

  const sort: ParsedQuery["sort"] = [];
  const asList = typeof input.sort === "string"
    ? input.sort.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const [k, d] = s.startsWith("-") ? [s.slice(1), "desc"] : s.split(":");
        return { field: k, dir: (d === "desc" ? "desc" : "asc") as "asc" | "desc" };
      })
    : input.sort ?? [];
  for (const s of asList.slice(0, 3)) {
    const r = resolve(s.field, "sort by");
    if (!r) continue;
    if (r.field && (!ORDERED.has(r.field.type) || isList(r.field))) { errors.push(`${label(r.field)} cannot be sorted.`); continue; }
    sort.push({ ...r, dir: s.dir === "desc" ? "desc" : "asc" });
  }

  const limitIn = input.limit ?? opts.defaultLimit ?? MAX_LIMIT;
  if (!Number.isInteger(limitIn) || limitIn < 1 || limitIn > MAX_LIMIT) errors.push(`\`limit\` is a whole number from 1 to ${MAX_LIMIT}.`);
  let offset = 0;
  if (input.cursor) {
    const o = decodeCursor(input.cursor);
    if (o === null) errors.push("That cursor is not one this list gave out; start again without it.");
    else offset = o;
  }
  const q = typeof input.q === "string" && input.q.trim() ? input.q.trim().slice(0, 200) : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, query: { conditions, sort, q, offset, limit: limitIn } };
}

/* ------------------------------------------------------------------------------------------------ SQL */

/** What compileRecordQuery needs of the area's table: its columns by key, `custom`, `customerId`. */
export type AreaTable = Record<string, unknown> & { custom: AnyColumn; customerId: AnyColumn; orgId: AnyColumn };

/** What compiling a computed field needs: the area, and the moment `{today}` is read at. */
interface Cx { v: AreaView; now: Date }

/**
 * An own field's stored JSON value, as agent/lib/record-areas.ts `get` reads it: under its key, else (a field declared
 * with `renamed_from`) under the key rows written before the rename carry it. Only a renamed field reads two keys, so
 * every other own field's SQL is what it always was.
 */
function ownJson(t: AreaTable, field: RecordField): SQL {
  return field.renamed_from
    ? sql`coalesce(${t.custom} -> ${field.key}::text, ${t.custom} -> ${field.renamed_from}::text)`
    : sql`(${t.custom} -> ${field.key}::text)`;
}

/**
 * Containment of `{key: value}` in `custom` (which the GIN index on `custom` serves); for a renamed field, also a row
 * that carries no value under the new key and has it under the old one.
 */
function ownContains(t: AreaTable, field: RecordField, value: unknown): SQL {
  const now = sql`${t.custom} @> ${JSON.stringify({ [field.key]: value })}::jsonb`;
  if (!field.renamed_from) return now;
  return sql`(${now} or (not jsonb_exists(${t.custom}, ${field.key}::text) and ${t.custom} @> ${JSON.stringify({ [field.renamed_from]: value })}::jsonb))`;
}

/** A field as SQL text (an own field read out of `custom`), or a number for a number field; a computed one as its CASE. */
function expr(t: AreaTable, key: string, field: RecordField | null, cx?: Cx): SQL {
  if (field === null) return sql`${t.customerId}`;
  if (field.computed) {
    if (!cx) throw new Error(`${field.key} is computed; compile it with its area`);
    return computedSql(t, cx, field, new Set([field.key]));
  }
  if (field.column) {
    const col = t[field.key] as AnyColumn | undefined;
    if (!col) throw new Error(`${field.key} is not a column of this table`);
    return sql`${col}`;
  }
  if (field.renamed_from) {
    const j = ownJson(t, field);
    if (NUMERIC.has(field.type)) return sql`(case when jsonb_typeof(${j}) = 'number' then (${j} #>> '{}')::numeric end)`;
    return sql`(${j} #>> '{}')`;
  }
  if (NUMERIC.has(field.type)) return sql`(case when jsonb_typeof(${t.custom} -> ${key}::text) = 'number' then (${t.custom} ->> ${key}::text)::numeric end)`;
  return sql`(${t.custom} ->> ${key}::text)`;
}
/** A value bound for comparison with expr(): a number for a numeric own field, else as it is. */
const bound = (field: RecordField | null, value: unknown): SQL => (field && !field.column && NUMERIC.has(field.type) ? sql`${Number(value)}::numeric` : sql`${value}`);

function condition(t: AreaTable, c: Condition, cx: Cx): SQL {
  const f = c.field;
  const e = expr(t, c.key, f, cx);
  const own = f !== null && !f.column && !f.computed;
  const eqOne = (value: unknown): SQL => {
    if (f?.computed) return sql`${e} = ${String(value)}::text`;
    if (own && !NUMERIC.has(f!.type)) return ownContains(t, f!, value);
    // An email is the same address in any case (a person field is stored lower case, an older column as typed).
    if (f && (f.type === "person" || f.type === "email")) return sql`lower(${e}) = lower(${String(value)})`;
    return sql`${e} = ${bound(f, value)}`;
  };
  switch (c.op) {
    case "eq": return eqOne(c.value);
    case "ne": return sql`(${e} is null or not (${eqOne(c.value)}))`;
    case "in": return or(...(c.value as unknown[]).map(eqOne)) ?? sql`false`;
    case "not_in": return sql`(${e} is null or not (${or(...(c.value as unknown[]).map(eqOne))}))`;
    case "lt": return sql`${e} < ${bound(f, c.value)}`;
    case "lte": return sql`${e} <= ${bound(f, c.value)}`;
    case "gt": return sql`${e} > ${bound(f, c.value)}`;
    case "gte": return sql`${e} >= ${bound(f, c.value)}`;
    case "contains":
      return f!.column ? sql`${t[f!.key] as AnyColumn} @> ${JSON.stringify([c.value])}::jsonb` : ownContains(t, f!, [c.value]);
    case "set": {
      if (f?.computed) return c.value ? sql`(${e} is not null and ${e} <> '')` : sql`(${e} is null or ${e} = '')`;
      const j = own && f!.renamed_from ? ownJson(t, f!) : null;
      const has = j ? sql`(${j} is not null and jsonb_typeof(${j}) <> 'null' and coalesce(${j} #>> '{}', '') <> '' and ${j} <> '[]'::jsonb)` : own ? sql`(jsonb_exists(${t.custom}, ${c.key}::text) and jsonb_typeof(${t.custom} -> ${c.key}::text) <> 'null' and coalesce(${t.custom} ->> ${c.key}::text, '') <> '' and ${t.custom} -> ${c.key}::text <> '[]'::jsonb)` : sql`(${e} is not null and ${e}::text <> '' and ${e}::text <> '[]')`;
      return c.value ? has : sql`not ${has}`;
    }
    default: return sql`false`;
  }
}

/** The fields the search reads: those marked `search`, else every visible text-like field. */
function searchFields(v: AreaView): RecordField[] {
  const marked = v.visibleFields.filter((f) => f.search);
  if (marked.length) return marked;
  return v.visibleFields.filter((f) => !f.computed && ["text", "long_text", "pick_list", "email", "person", "link"].includes(f.type));
}

/** The parsed query as SQL over the area's table, inside the caller's workspace (`orgId`). */
export function compileRecordQuery(id: AccountAreaId, q: ParsedQuery, t: AreaTable, orgId: string, areas: RecordAreas = RECORD_AREAS, now: Date = new Date()): { where: SQL; orderBy: SQL[]; limit: number; offset: number } {
  const v = areaView(id, areas);
  const cx: Cx = { v, now };
  const parts: SQL[] = [eq(t.orgId, orgId), ...q.conditions.map((c) => condition(t, c, cx))];
  if (q.q) {
    const words = q.q.split(/\s+/).filter(Boolean).slice(0, 8);
    const text = sql.join([sql`${t.customerId}`, ...searchFields(v).map((f) => sql`coalesce((${expr(t, f.key, f)})::text, '')`)], sql`, `);
    for (const w of words) parts.push(sql`concat_ws(' ', ${text}) ilike ${`%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
  }
  const orderBy: SQL[] = q.sort.map((s) => (s.dir === "desc" ? sql`${expr(t, s.key, s.field, cx)} desc nulls last` : sql`${expr(t, s.key, s.field, cx)} asc nulls last`));
  // The row's own key last: a total order, so a page never repeats or skips a row.
  orderBy.push(asc(t.customerId));
  if (id === "deployments") orderBy.push(asc(t.deploymentId as AnyColumn));
  return { where: and(...parts)!, orderBy, limit: q.limit, offset: q.offset };
}

/** The default sort of a list: the definition's default, else the routes' own order (account, then id). */
export function defaultSort(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS): { field: string; dir: "asc" | "desc" }[] {
  const d = areaView(id, areas).sorts.find((s) => s.default);
  return d ? [{ field: d.field, dir: d.dir }] : [];
}


/* ------------------------------------------------------------------------------------------- computed fields */
/*
 * A computed field (`computed: { when: [{ if, then }], else }`) compiled to one SQL CASE, so a list filters and sorts on
 * it in the database. It means exactly what agent/lib/record-area-records.ts computedValue() evaluates for display:
 *   - a value is read as a number (number, percent, money, integer fields), a day (date and datetime fields: the first
 *     ten characters, so a timestamp compares by its day), or text; an empty value is no value;
 *   - eq/lt/lte/gt/gte with no value on either side are false; ne and not_in with no value are true; `set` is whether
 *     there is a value; `category` is the lifecycle field's states of those categories;
 *   - an operand is a literal, `{today}` / `{today+Nd}` / `{today-Nd}` (the day the query runs), or `{field}`.
 * Not compiled (computedUnsupported says which, and the list refuses it in a sentence): a condition on a list field
 * (multi-pick, tags, several people or files), a key that is no field of the area, an operator outside the grammar,
 * a field computed from itself.
 */
const COMPUTED_OPS = new Set(["eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte", "set", "category"]);
type Kind = "num" | "day" | "text";
const kindOf = (f: RecordField | null): Kind => (f && NUMERIC.has(f.type) ? "num" : f && (f.type === "date" || f.type === "datetime") ? "day" : "text");
const operandField = (x: unknown) => (typeof x === "string" && /^\{[A-Za-z0-9_]+\}$/.test(x) && !/^\{today/.test(x) ? x.slice(1, -1) : null);

/** Why a computed field cannot be compiled, or null when it can. */
export function computedUnsupported(v: AreaView, f: RecordField, seen: Set<string> = new Set([f.key])): string | null {
  const refOk = (key: string): string | null => {
    if (key === ACCOUNT_FIELD) return null;
    const g = v.field(key);
    if (!g) return `"${key}" is not a field of this area`;
    if (isList(g)) return `"${g.key}" holds a list`;
    if (g.computed) {
      if (seen.has(g.key)) return `"${g.key}" is computed from itself`;
      return computedUnsupported(v, g, new Set([...seen, g.key]));
    }
    return null;
  };
  for (const w of f.computed?.when ?? []) {
    for (const [key, cond] of Object.entries(w.if)) {
      const bad = refOk(key);
      if (bad) return bad;
      const ops = cond !== null && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond) : [["eq", cond] as [string, unknown]];
      for (const [op, raw] of ops) {
        if (!COMPUTED_OPS.has(op)) return `"${op}" is not an operator it can compile`;
        for (const x of Array.isArray(raw) ? raw : [raw]) {
          const ref = operandField(x);
          const badRef = ref ? refOk(ref) : null;
          if (badRef) return badRef;
        }
      }
    }
  }
  return null;
}

/** A field read for a computed field's condition, as its kind compares: a number, a day, or text; empty is no value. */
function readAs(t: AreaTable, cx: Cx, key: string, seen: Set<string>): { e: SQL; kind: Kind } {
  const f = key === ACCOUNT_FIELD ? null : cx.v.field(key)!;
  const kind = kindOf(f);
  const raw = f?.computed ? computedSql(t, cx, f, new Set([...seen, f.key])) : expr(t, key, f);
  if (kind === "num") return { e: f && f.column ? sql`(${raw})::numeric` : raw, kind };
  if (kind === "day") return { e: sql`nullif(left((${raw})::text, 10), '')`, kind };
  return { e: sql`nullif((${raw})::text, '')`, kind };
}

/** An operand as SQL of `kind`. */
function operandSql(t: AreaTable, cx: Cx, x: unknown, kind: Kind, seen: Set<string>): SQL {
  const ref = operandField(x);
  if (ref) {
    const r = readAs(t, cx, ref, seen);
    if (r.kind === kind) return r.e;
    return kind === "num" ? sql`(${r.e})::numeric` : kind === "day" ? sql`nullif(left((${r.e})::text, 10), '')` : sql`(${r.e})::text`;
  }
  const today = typeof x === "string" ? /^\{today(?:([+-]\d{1,3})d)?\}$/.exec(x) : null;
  if (today) return sql`${new Date(cx.now.getTime() + (today[1] ? Number(today[1]) : 0) * 86_400_000).toISOString().slice(0, 10)}::text`;
  if (x === null || x === undefined || x === "") return sql`null`;
  if (kind === "num") return Number.isFinite(Number(x)) ? sql`${Number(x)}::numeric` : sql`null`;
  const text = String(x);
  return kind === "day" ? sql`${/^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text}::text` : sql`${text}::text`;
}

/** One `if` of a computed field: every condition holds. */
function whereSql(t: AreaTable, cx: Cx, where: Record<string, unknown>, seen: Set<string>): SQL {
  const parts: SQL[] = [];
  for (const [key, cond] of Object.entries(where)) {
    const { e, kind } = readAs(t, cx, key, seen);
    const R = (x: unknown) => operandSql(t, cx, x, kind, seen);
    const ops = cond !== null && typeof cond === "object" && !Array.isArray(cond) ? Object.entries(cond as Record<string, unknown>) : [["eq", cond] as [string, unknown]];
    for (const [op, raw] of ops) {
      const list = (Array.isArray(raw) ? raw : [raw]) as unknown[];
      const anyEq = list.length ? sql.join(list.map((x) => sql`coalesce(${e} = ${R(x)}, false)`), sql` or `) : sql`false`;
      switch (op) {
        case "eq": parts.push(sql`coalesce(${e} = ${R(raw)}, false)`); break;
        case "ne": parts.push(sql`not coalesce(${e} = ${R(raw)}, false)`); break;
        case "lt": parts.push(sql`coalesce(${e} < ${R(raw)}, false)`); break;
        case "lte": parts.push(sql`coalesce(${e} <= ${R(raw)}, false)`); break;
        case "gt": parts.push(sql`coalesce(${e} > ${R(raw)}, false)`); break;
        case "gte": parts.push(sql`coalesce(${e} >= ${R(raw)}, false)`); break;
        case "in": parts.push(sql`(${anyEq})`); break;
        case "not_in": parts.push(sql`not (${anyEq})`); break;
        case "set": parts.push(raw ? sql`(${e} is not null and (${e})::text <> '[]')` : sql`(${e} is null or (${e})::text = '[]')`); break;
        case "category": {
          const lc = cx.v.lifecycle;
          const cats = (Array.isArray(raw) ? raw : [raw]).map(String);
          const states = lc && lc.field === (cx.v.field(key)?.key ?? key) ? lc.states.filter((st) => cats.includes(String(st.category))).map((st) => st.value) : [];
          parts.push(states.length ? sql`(${sql.join(states.map((st) => sql`coalesce(${e} = ${st}::text, false)`), sql` or `)})` : sql`false`);
          break;
        }
        default: parts.push(sql`false`);
      }
    }
  }
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

/** A computed field as one CASE: the first `when` that holds, else `else`. */
function computedSql(t: AreaTable, cx: Cx, f: RecordField, seen: Set<string>): SQL {
  const c = f.computed!;
  const whens = c.when.map((w) => sql`when ${whereSql(t, cx, w.if as Record<string, unknown>, seen)} then ${String(w.then)}::text`);
  const otherwise = c.else === undefined || c.else === null ? sql`null::text` : sql`${String(c.else)}::text`;
  return sql`(case ${sql.join(whens, sql` `)} else ${otherwise} end)`;
}

/** A number field as SQL numeric, in the caller's workspace's table: what a metric's `sum` adds up (agent/lib/record-metrics.ts). */
export function numericFieldSql(id: AccountAreaId, key: string, t: AreaTable, areas: RecordAreas = RECORD_AREAS, now: Date = new Date()): SQL {
  const v = areaView(id, areas);
  const f = v.field(key);
  if (!f || !NUMERIC.has(f.type) || f.computed) throw new Error(`${key} is not a number field of this area`);
  const e = expr(t, f.key, f, { v, now });
  return f.column ? sql`(${e})::numeric` : e;
}
