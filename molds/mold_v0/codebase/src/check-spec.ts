/**
 * Declarative yes/no checks (mold_v0-196; molds/mold_v0/MOLD.md "Declarative checks"): a pack names a question its own
 * records answer, in pack.json `checks` (or definePack({ checks })), and writes no code. The shell answers it on the API
 * (POST /api/checks/<name>) and as an MCP tool (check_<name>), for the caller's own workspace only (src/checks.ts), with
 * the condition that decided it (src/check-eval.ts).
 *
 *   {
 *     "name": "may_send",
 *     "inputs": { "subject": "string", "topic": "string", "at": "datetime?" },
 *     "rule": {
 *       "area": "permissions_given",
 *       "match": { "subject": "$subject", "topic": "$topic" },
 *       "latest_by": "recorded_at",
 *       "require": [ { "field": "status", "eq": "given" }, { "field": "expires_at", "gt": "$at|now" } ]
 *     },
 *     "explain": true
 *   }
 *
 * inputs     what the asker gives, by name: string, number, boolean, date (YYYY-MM-DD) or datetime (ISO 8601), a trailing
 *            ? when it may be left out. Nothing else is accepted (an unknown input is refused), and the workspace is
 *            never an input: it is the caller's own.
 * rule.area  the record area that answers: one of the build's areas, its rows as the caller's workspace sees them
 *            (a workspace area's own rows, a shared area's shared ones), never one read live from an API.
 * match      the records the answer is about: each field equal to a value (a literal or a required input, "$name"),
 *            or one of a list of them (set membership). At least one: a check never scans a whole area. These are the
 *            database's conditions, so its indexes find the rows (checkIndexHint below).
 * latest_by  a date or number field (or updated_at): the latest matching record alone decides (latest-record-wins).
 *            Without it the answer is yes when any matching record meets `require`; the database then finds that
 *            record itself, so `require` is all-of conditions on the record's own fields with values it can compare.
 * lookup     optional, one level: a record of a second area, by key ({area, as, key}) or by match ({area, as, match,
 *            latest_by?}), its fields read in `require` as "<as>.<field>". Its values may name the first record's
 *            fields ("@field") or the inputs.
 * require    the conditions (a list: all of them), each {field, <op>: value} with op one of eq, ne, in, not_in, gt, gte,
 *            lt, lte (numbers and dates), within ({last|next: "30d", of?}: a time window around now or a value), exists
 *            (true|false), has (a list field holds a value); or {all: [...]}, {any: [...]}, {not: {...}}.
 * values     a literal; "$input"; "$input|now" (the input, else the time of the question); "now", "now-30d", "now+12h";
 *            "@field" or "@<as>.field" (a field of the decided record or the lookup's). "$$" starts a literal "$".
 * explain    the answer lists every condition evaluated and the one that decided it (default true); false keeps the
 *            reason and record references only.
 *
 * Refused at build (checkProblems): a name taken twice, an unknown area or field, an input not declared or of the
 * wrong type for its field, an enum value that is not one of its options, an operator a field's type does not take,
 * a match that is empty or rests on an optional input (an unbounded scan), latest_by on a field that is not a date or
 * number, a lookup more than one level deep, an area read live from an API, and an any-record rule the database
 * cannot find by itself.
 */
import { z } from "zod";

export const CHECK_NAME = /^[a-z][a-z0-9_]{1,50}$/;
/** The MCP tool a check is answered by. */
export const checkToolName = (name: string) => `check_${name}`;
/** The key and client-session scopes that let a caller ask (all checks, or one): src/checks.ts scopeAllows. */
export const CHECK_SCOPE_PATTERN = /^checks(:[a-z][a-z0-9_]{1,50})?$/;
export const CHECK_INPUT_TYPES = ["string", "number", "boolean", "date", "datetime"] as const;
export type CheckInputType = (typeof CHECK_INPUT_TYPES)[number];
/** At most this many conditions in a check (leaves and groups), and this deep. */
export const MAX_CONDITIONS = 30, MAX_DEPTH = 4;
/** An any-record rule reads at most this many candidates the database found (each already meets `require`). */
export const ANY_CANDIDATES = 20;

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lowercase letters, digits and _, starting with a letter");
const condField = z.string().max(130).regex(/^([a-z][a-z0-9_]{1,62}\.)?([a-z][a-z0-9_]{1,62}|key|updated_at)$/, 'a field of the area, key, updated_at or "<lookup>.<field>"');
const scalar = z.union([z.string().max(300), z.number().finite(), z.boolean()]);
const list = z.array(scalar).min(1).max(100);
export const CHECK_DURATION = /^[1-9][0-9]{0,4}(m|h|d)$/;
const duration = z.string().regex(CHECK_DURATION, 'a duration: a whole number then m (minutes), h (hours) or d (days): "30d", "12h"');
const inputType = z.string().regex(/^(string|number|boolean|date|datetime)\??$/, "string, number, boolean, date or datetime, ? after it when it may be left out");

export const CHECK_OPS = ["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "within", "exists", "has"] as const;
export type CheckOp = (typeof CHECK_OPS)[number];
const FieldConditionSchema = z.object({
  field: condField,
  eq: scalar.optional(), ne: scalar.optional(), in: list.optional(), not_in: list.optional(),
  gt: scalar.optional(), gte: scalar.optional(), lt: scalar.optional(), lte: scalar.optional(),
  within: z.object({ last: duration.optional(), next: duration.optional(), of: z.string().max(130).optional() }).strict().optional(),
  exists: z.boolean().optional(),
  has: scalar.optional(),
  /** What the condition means, in words (the explanation shows it). */
  label: z.string().min(1).max(120).optional(),
}).strict();
export type FieldCondition = z.output<typeof FieldConditionSchema>;
export type CheckCondition = FieldCondition | { all: CheckCondition[]; label?: string } | { any: CheckCondition[]; label?: string } | { not: CheckCondition; label?: string };
export const CheckConditionSchema: z.ZodType<CheckCondition> = z.lazy(() => z.union([
  FieldConditionSchema,
  z.object({ all: z.array(CheckConditionSchema).min(1).max(MAX_CONDITIONS), label: z.string().min(1).max(120).optional() }).strict(),
  z.object({ any: z.array(CheckConditionSchema).min(1).max(MAX_CONDITIONS), label: z.string().min(1).max(120).optional() }).strict(),
  z.object({ not: CheckConditionSchema, label: z.string().min(1).max(120).optional() }).strict(),
])) as z.ZodType<CheckCondition>;

const matchSchema = z.record(z.string().max(63).regex(/^([a-z][a-z0-9_]{1,62}|key)$/, "a field of the area, or key"), z.union([scalar, list]));
export const CheckLookupSchema = z.object({
  area: fieldName,
  as: fieldName,
  key: z.string().max(130).optional(),
  match: matchSchema.optional(),
  latest_by: fieldName.optional(),
}).strict();
export const CheckRuleSchema = z.object({
  area: fieldName,
  match: matchSchema,
  latest_by: fieldName.optional(),
  lookup: CheckLookupSchema.optional(),
  require: z.union([z.array(CheckConditionSchema).min(1).max(MAX_CONDITIONS), CheckConditionSchema]),
}).strict();
export const CheckSchema = z.object({
  name: z.string().regex(CHECK_NAME, "2-51 lowercase letters, digits and _, starting with a letter"),
  label: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  inputs: z.record(fieldName, inputType).refine((o) => Object.keys(o).length <= 10, "at most 10 inputs").default({}),
  rule: CheckRuleSchema,
  explain: z.boolean().default(true),
  $comment: z.string().max(2000).optional(),
}).strict();
export type Check = z.output<typeof CheckSchema>;
export type CheckRule = z.output<typeof CheckRuleSchema>;

// ---------- types the build checks against ----------

/** A value's kind, as conditions compare it. */
export type Kind = "string" | "number" | "boolean" | "date" | "list" | "json";
/** The part of a record area a check reads (src/pack-api.ts RecordAreaSchema). */
export interface CheckArea {
  name: string;
  scope: "platform" | "workspace";
  fields: { name: string; type?: string; multiple?: boolean; options?: (string | { value: string })[] }[];
  /** Read live from an API (a repository of kind http_api): no stored rows. */
  live?: boolean;
  sealed?: boolean;
}
export interface FieldType { kind: Kind; options?: string[] }
export function fieldTypeOf(f: CheckArea["fields"][number]): FieldType {
  const t = f.type ?? "text";
  if (f.multiple || t === "link") return { kind: "list", ...(t === "enum" ? { options: (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value)) } : {}) };
  if (t === "number") return { kind: "number" };
  if (t === "boolean") return { kind: "boolean" };
  if (t === "date") return { kind: "date" };
  if (t === "json" || t === "file") return { kind: "json" };
  if (t === "enum") return { kind: "string", options: (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value)) };
  return { kind: "string" };
}
const SPECIAL: Record<string, FieldType> = { key: { kind: "string" }, updated_at: { kind: "date" } };
export const inputKind = (t: string): { kind: Kind; optional: boolean; type: CheckInputType } => {
  const optional = t.endsWith("?"), type = (optional ? t.slice(0, -1) : t) as CheckInputType;
  return { kind: type === "datetime" || type === "date" ? "date" : (type as Kind), optional, type };
};
export const isGroup = (c: CheckCondition): c is Exclude<CheckCondition, FieldCondition> => "all" in c || "any" in c || "not" in c;
export const opOf = (c: FieldCondition): CheckOp[] => CHECK_OPS.filter((k) => c[k] !== undefined);
/** A rule's require as one condition. */
export const requireOf = (r: Pick<CheckRule, "require">): CheckCondition => (Array.isArray(r.require) ? { all: r.require } : r.require);

/**
 * An operand as written: the parts of the grammar (values above). `type-directed`: "now" is a time only when compared
 * with a date; against text it is the word.
 */
export type Operand =
  | { t: "input"; name: string; orNow: boolean }
  | { t: "now"; offsetMs: number }
  | { t: "ref"; path: string }
  | { t: "literal"; value: unknown };
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export const durationMs = (d: string) => Number(d.slice(0, -1)) * UNIT_MS[d.slice(-1)]!;
export function parseOperand(v: unknown, kind: Kind | null): Operand {
  if (typeof v !== "string") return { t: "literal", value: v };
  if (v.startsWith("$$")) return { t: "literal", value: v.slice(1) };
  let m = /^\$([a-z][a-z0-9_]{1,62})(\|now)?$/.exec(v);
  if (m) return { t: "input", name: m[1]!, orNow: !!m[2] };
  m = /^@(([a-z][a-z0-9_]{1,62}\.)?([a-z][a-z0-9_]{1,62}|key|updated_at))$/.exec(v);
  if (m) return { t: "ref", path: m[1]! };
  if (kind === "date") {
    m = /^now(([+-])([1-9][0-9]{0,4}[mhd]))?$/.exec(v);
    if (m) return { t: "now", offsetMs: m[1] ? (m[2] === "-" ? -1 : 1) * durationMs(m[3]!) : 0 };
  }
  return { t: "literal", value: v };
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export const isDateText = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));

// ---------- the build's checks ----------

interface Problem { message: string; path: (string | number)[] }

/**
 * What is wrong with one check against the build's areas (each problem a message and its path under the check). Used
 * at build (scripts/gen-packs.mjs) and when the server installs the packs (src/packs.ts), so a bad declaration never
 * reaches a running server.
 */
export function checkProblems(check: Check, areas: readonly CheckArea[]): Problem[] {
  const out: Problem[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path });
  const r = check.rule;
  const area = areas.find((a) => a.name === r.area);
  if (!area) { bad(`rule.area: ${r.area} is not a record area of this build`, "rule", "area"); return out; }
  if (area.live) bad(`rule.area: ${area.name} is read live from an API (its rows are not kept here): a check reads stored records`, "rule", "area");
  const inputs = new Map(Object.entries(check.inputs ?? {}).map(([k, t]) => [k, inputKind(t)]));
  const lookupArea = r.lookup ? areas.find((a) => a.name === r.lookup!.area) : undefined;
  if (r.lookup && !lookupArea) bad(`lookup.area: ${r.lookup.area} is not a record area of this build`, "rule", "lookup", "area");
  if (lookupArea?.live) bad(`lookup.area: ${lookupArea.name} is read live from an API: a check reads stored records`, "rule", "lookup", "area");
  if (r.lookup && (area.fields.some((f) => f.name === r.lookup!.as) || r.lookup.as === "key" || r.lookup.as === "updated_at"))
    bad(`lookup.as: ${r.lookup.as} is a field of ${area.name}: name the lookup something else`, "rule", "lookup", "as");
  if (lookupArea && area.scope === "platform" && lookupArea.scope === "workspace")
    bad(`lookup.area: ${lookupArea.name} holds each workspace's own records; a check over the shared area ${area.name} looks up shared areas only`, "rule", "lookup", "area");

  const fieldIn = (a: CheckArea, n: string): FieldType | null => SPECIAL[n] ?? (a.fields.find((f) => f.name === n) ? fieldTypeOf(a.fields.find((f) => f.name === n)!) : null);
  /** A condition's or operand's field: one of the area's, or "<as>.<field>" of the lookup's. */
  const resolve = (p: string): FieldType | string => {
    const dot = p.indexOf(".");
    if (dot < 0) return fieldIn(area, p) ?? `${p} is not a field of ${area.name}`;
    const [as, f] = [p.slice(0, dot), p.slice(dot + 1)];
    if (!r.lookup || as !== r.lookup.as) return `${as} is not this rule's lookup${r.lookup ? ` (${r.lookup.as})` : ""}`;
    if (!lookupArea) return `${as}: its area is unknown`;
    return fieldIn(lookupArea, f) ?? `${f} is not a field of ${lookupArea.name}`;
  };
  /** An operand against a field of `want` kind; `where` its path. `refs`: may it name a record's field (@)? */
  const operand = (v: unknown, want: FieldType, where: (string | number)[], o: { refs: boolean; required?: boolean; options?: boolean } = { refs: true }) => {
    const x = parseOperand(v, want.kind);
    const kindOk = (k: Kind) => k === want.kind || (want.kind === "list" && k !== "list" && k !== "json");
    if (x.t === "input") {
      const i = inputs.get(x.name);
      if (!i) return bad(`$${x.name} is not one of the check's inputs`, ...where);
      if (!kindOk(i.kind)) bad(`$${x.name} is a ${i.type}; the field holds ${want.kind === "date" ? "a date" : want.kind === "list" ? "a list" : `a ${want.kind}`}`, ...where);
      if (x.orNow && i.kind !== "date") bad(`$${x.name}|now: only a date or datetime input falls back to now`, ...where);
      if (o.required && i.optional && !x.orNow) bad(`$${x.name} may be left out: a match rests on required inputs or values (else it would scan the whole area)`, ...where);
      return;
    }
    if (x.t === "now") { if (want.kind !== "date") bad("now is a time: compare it with a date field", ...where); return; }
    if (x.t === "ref") {
      if (!o.refs) return bad(`${v as string}: name an input or a value here, not a record's field`, ...where);
      const t = resolve(x.path);
      if (typeof t === "string") return bad(`${v as string}: ${t}`, ...where);
      if (!kindOk(t.kind)) bad(`${v as string} holds ${t.kind === "date" ? "a date" : `a ${t.kind}`}; the field holds ${want.kind === "date" ? "a date" : `a ${want.kind}`}`, ...where);
      return;
    }
    const lit = x.value;
    const litKind: Kind = typeof lit === "number" ? "number" : typeof lit === "boolean" ? "boolean" : isDateText(lit) && want.kind === "date" ? "date" : "string";
    if (!kindOk(litKind)) return bad(`${JSON.stringify(lit)} is not ${want.kind === "date" ? "a date (YYYY-MM-DD or ISO 8601), now or now-30d" : `a ${want.kind}`}`, ...where);
    if (want.options && o.options !== false && !want.options.includes(String(lit))) bad(`${JSON.stringify(lit)} is not one of the field's options (${want.options.join(", ").slice(0, 200)})`, ...where);
  };

  // ---- match: the database's conditions; never empty, never resting on an optional input ----
  const matchFields = (m: Record<string, unknown> | undefined, a: CheckArea, where: (string | number)[], refs: boolean) => {
    const entries = Object.entries(m ?? {});
    for (const [f, v] of entries) {
      const t = f === "key" ? SPECIAL.key! : fieldIn(a, f);
      if (!t) { bad(`${f} is not a field of ${a.name}`, ...where, f); continue; }
      if (t.kind === "json" || t.kind === "list") { bad(`${f} holds ${t.kind === "list" ? "a list" : "JSON"}: match on single values (use has in require)`, ...where, f); continue; }
      for (const [i, x] of (Array.isArray(v) ? v : [v]).entries()) operand(x, t, Array.isArray(v) ? [...where, f, i] : [...where, f], { refs, required: true });
    }
    return entries.length;
  };
  if (!matchFields(r.match, area, ["rule", "match"], false)) bad("rule.match: name at least one field the records must equal (a check never scans a whole area)", "rule", "match");
  const orderable = (a: CheckArea, n: string, where: (string | number)[]) => {
    const t = fieldIn(a, n);
    if (!t) bad(`${n} is not a field of ${a.name}`, ...where);
    else if (t.kind !== "date" && t.kind !== "number") bad(`${n} holds ${t.kind === "list" ? "a list" : `a ${t.kind}`}: the latest record is found by a date or number field (or updated_at)`, ...where);
  };
  if (r.latest_by) orderable(area, r.latest_by, ["rule", "latest_by"]);
  if (r.lookup && lookupArea) {
    const l = r.lookup;
    if ((l.key === undefined) === (l.match === undefined)) bad("lookup: give key (a record's key) or match (fields it must equal), one of them", "rule", "lookup");
    if (l.key !== undefined) operand(l.key, { kind: "string" }, ["rule", "lookup", "key"], { refs: true, required: true });
    if (l.match !== undefined && !matchFields(l.match, lookupArea, ["rule", "lookup", "match"], true)) bad("lookup.match: name at least one field", "rule", "lookup", "match");
    if (l.latest_by) orderable(lookupArea, l.latest_by, ["rule", "lookup", "latest_by"]);
    if (l.latest_by && l.key !== undefined) bad("lookup.latest_by orders a match; a key names one record", "rule", "lookup", "latest_by");
  }

  // ---- require: each condition's field and operator against its type ----
  let count = 0;
  const cond = (c: CheckCondition, where: (string | number)[], depth: number) => {
    if (++count > MAX_CONDITIONS) { if (count === MAX_CONDITIONS + 1) bad(`at most ${MAX_CONDITIONS} conditions in a check`, ...where); return; }
    if (depth > MAX_DEPTH) return bad(`conditions nest at most ${MAX_DEPTH} deep`, ...where);
    if ("all" in c) return c.all.forEach((x, i) => cond(x, [...where, "all", i], depth + 1));
    if ("any" in c) return c.any.forEach((x, i) => cond(x, [...where, "any", i], depth + 1));
    if ("not" in c) return cond(c.not, [...where, "not"], depth + 1);
    const ops = opOf(c);
    if (ops.length !== 1) return bad(`a condition has one operator (${CHECK_OPS.join(", ")}); this one has ${ops.length ? ops.join(", ") : "none"}`, ...where);
    const op = ops[0]!;
    const t = resolve(c.field);
    if (typeof t === "string") return bad(`field ${t}`, ...where, "field");
    const w = [...where, op];
    switch (op) {
      case "exists": return;
      case "eq": case "ne":
        if (t.kind === "json" || t.kind === "list") return bad(`${c.field} holds ${t.kind === "list" ? "a list: use has" : "JSON: only exists"}`, ...w);
        return operand(c[op], t, w);
      case "in": case "not_in":
        if (t.kind === "json" || t.kind === "list") return bad(`${c.field} holds ${t.kind === "list" ? "a list: use has" : "JSON: only exists"}`, ...w);
        return c[op]!.forEach((v, i) => operand(v, t, [...w, i], { refs: false }));
      case "gt": case "gte": case "lt": case "lte":
        if (t.kind !== "number" && t.kind !== "date") return bad(`${c.field} holds ${t.kind === "list" ? "a list" : `a ${t.kind}`}: ${op} compares numbers and dates`, ...w);
        return operand(c[op], t, w);
      case "within": {
        if (t.kind !== "date") return bad(`${c.field} holds ${t.kind === "list" ? "a list" : `a ${t.kind}`}: within is a time window over a date`, ...w);
        const x = c.within!;
        if ((x.last === undefined) === (x.next === undefined)) bad("within: give last (before the time) or next (after it), one of them", ...w);
        if (x.of !== undefined) operand(x.of, { kind: "date" }, [...w, "of"]);
        return;
      }
      case "has":
        if (t.kind !== "list") return bad(`${c.field} holds a single value: has is for list fields (use eq)`, ...w);
        return operand(c.has, { kind: "string", ...(t.options ? { options: t.options } : {}) }, w, { refs: true });
    }
  };
  const req = requireOf(r);
  cond(req, ["rule", "require"], 0);
  // Any-record rules: the database finds a record that meets every condition, so each is one it can test.
  if (!r.latest_by) {
    const leaves = "all" in req ? req.all : [req];
    for (const [i, c] of leaves.entries()) {
      const where = ["rule", "require", ...(Array.isArray(r.require) ? [i] : [])];
      if (isGroup(c)) { bad("without latest_by, require is all-of conditions on the record's own fields (the database finds a record meeting them): add latest_by for any, not or nested groups", ...where); continue; }
      const op = opOf(c)[0];
      if (c.field.includes(".")) bad("without latest_by, a condition reads the record's own fields: add latest_by to read the lookup's", ...where, "field");
      if (op === "not_in") bad("without latest_by, use in or ne (the database tests them)", ...where, "not_in");
      const v = op ? (op === "within" ? c.within?.of : (c as Record<string, unknown>)[op]) : undefined;
      if (typeof v === "string" && parseOperand(v, "date").t === "ref") bad("without latest_by, compare with inputs or values, not another field", ...where, op!);
    }
    if (r.lookup) bad("without latest_by, a rule has no lookup (the record that decides is any of several)", "rule", "lookup");
  }
  return out;
}

/** Every problem of a build's checks: shapes, unique names across packs, each check against the areas. */
export function checksProblems(packs: readonly { id: string; checks: unknown[] }[], areas: readonly CheckArea[]): string[] {
  const out: string[] = [];
  const owner = new Map<string, string>();
  for (const p of packs) for (const [i, raw] of p.checks.entries()) {
    const s = CheckSchema.safeParse(raw);
    if (!s.success) { out.push(`pack ${p.id}: checks[${i}]: ${s.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`); continue; }
    const c = s.data;
    if (owner.has(c.name)) out.push(`pack ${p.id}: check ${c.name} is already ${owner.get(c.name) === p.id ? "declared in this pack" : `pack ${owner.get(c.name)}'s`} (check names are unique in a build)`);
    else owner.set(c.name, p.id);
    for (const pr of checkProblems(c, areas)) out.push(`pack ${p.id}: check ${c.name}: ${pr.path.join(".")}: ${pr.message}`);
  }
  return out;
}

/**
 * How the database finds a check's records (its "index hint", from the declaration). The rows of the caller's
 * workspace and the area come first, by the records' unique (org_id, pack, area, key) index (pack, area, key for a
 * shared area): a match on key is that index alone ("key"); other matches are equality filters on the record's fields
 * within the area's rows ("fields"), then the latest by its field (LIMIT 1) or the first ANY_CANDIDATES meeting
 * `require`. A sealed area's values are ciphertext in the database: its rows are opened and filtered in memory
 * ("memory", at most src/record-areas.ts MEMORY_SCAN_LIMIT). `suggest` is the expression index that would serve the
 * match alone on a large area: a hint for the operator (the shell adds no per-app index).
 */
export function checkIndexHint(c: Check, area?: Pick<CheckArea, "sealed" | "scope">): { area: string; by: "key" | "fields" | "memory"; equal: string[]; order: string | null; limit: number; suggest: string | null } {
  const equal = Object.keys(c.rule.match).sort();
  const by = area?.sealed ? "memory" : equal.includes("key") ? "key" : "fields";
  const table = area?.scope === "platform" ? "platform_records" : "workspace_records";
  const cols = [...(table === "workspace_records" ? ["org_id"] : []), ...equal.filter((f) => f !== "key").map((f) => `(COALESCE(data -> '${f}', 'null'::jsonb))`), ...(c.rule.latest_by ? [`(COALESCE(data -> '${c.rule.latest_by}', 'null'::jsonb)) DESC`] : [])];
  const suggest = by === "fields" ? `CREATE INDEX ON ${table} (${cols.join(", ")}) WHERE area = '${c.rule.area}' (the expressions the record store's filter and order use, src/record-query.ts)` : null;
  return { area: c.rule.area, by, equal, order: c.rule.latest_by ?? null, limit: c.rule.latest_by ? 1 : ANY_CANDIDATES, suggest };
}
