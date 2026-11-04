/**
 * The condition evaluator of declarative checks (mold_v0-196; src/check-spec.ts declares them, src/checks.ts reads the
 * records and answers). Pure: records, inputs and the time in; whether the conditions hold, every condition evaluated
 * and the ones that decided it out. No database, no clock of its own, so `npm run test:checks` drives it at random.
 *
 * Values compare by the field's kind: dates as instants (a date alone is that day's 00:00 UTC; a time without a zone is
 * UTC), numbers as numbers, the rest exactly. An empty value (none, "", []) meets nothing but ne, not_in and
 * exists: false, as the database's filter reads it (src/record-query.ts). A value the asker left out (an optional input
 * with no fallback) meets nothing: a check fails closed.
 */
import { parseTime } from "./clock-math.js";
import { BUCKETS, bucketOf, bucketThreshold, durationMs, isBucket, isGroup, opOf, parseOperand, type BucketCondition, type CheckCondition, type CheckOp, type FieldCondition, type Kind } from "./check-spec.js";

export interface EvalRecord { key: string; title?: string | null; data: Record<string, unknown>; updated_at?: string | null }
export interface EvalContext {
  record: EvalRecord;
  /** The lookup's record (one level), when the rule has one; null when none was found. */
  lookup: EvalRecord | null;
  lookupAs: string | null;
  inputs: Record<string, unknown>;
  /** The time of the question (ms). */
  now: number;
  /** A field's kind by its path ("f", "key", "updated_at", "<as>.f"). */
  kindOf: (path: string) => Kind;
}
/**
 * One condition, evaluated: what it compared, and whether it held. A bucket (mold_v0-226): `field` is what is bucketed
 * (its input or field), `actual` its bucket (0 to 9999), `expected` {percent, below} (the buckets that hold).
 */
export interface Leaf { path: string; field: string; op: CheckOp | "bucket"; expected: unknown; actual: unknown; passed: boolean; label?: string; note?: string }
export interface Outcome { passed: boolean; decided_by: Leaf[]; evaluated: Leaf[] }

const MISSING = Symbol("missing");
const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** A field's value on the decided record (or the lookup's). */
export function valueAt(ctx: Pick<EvalContext, "record" | "lookup" | "lookupAs">, path: string): unknown {
  const dot = path.indexOf(".");
  const [rec, f] = dot < 0 ? [ctx.record, path] : path.slice(0, dot) === ctx.lookupAs ? [ctx.lookup, path.slice(dot + 1)] : [null, path];
  if (!rec) return undefined;
  return f === "key" ? rec.key : f === "updated_at" ? rec.updated_at ?? undefined : rec.data[f];
}

/** An operand's value (src/check-spec.ts parseOperand), or MISSING when it names an input the asker left out. */
function resolveOperand(v: unknown, kind: Kind, ctx: EvalContext): { value: unknown; note?: string } | typeof MISSING {
  const x = parseOperand(v, kind);
  switch (x.t) {
    case "literal": return { value: x.value };
    case "now": return { value: new Date(ctx.now + x.offsetMs).toISOString() };
    case "ref": return { value: valueAt(ctx, x.path) };
    case "input": {
      const got = ctx.inputs[x.name];
      if (got !== undefined && got !== null) return { value: got };
      if (x.orNow) return { value: new Date(ctx.now).toISOString(), note: `$${x.name} not given: now` };
      return MISSING;
    }
  }
}

/** Two values of a kind: equal? (dates as instants, numbers as numbers, the rest exactly) */
export function same(kind: Kind, a: unknown, b: unknown): boolean {
  if (empty(a) || empty(b)) return false;
  if (kind === "date") { const x = parseTime(a), y = parseTime(b); return x !== null && x === y; }
  if (kind === "number") return typeof a === "number" && typeof b === "number" && a === b;
  return a === b;
}
/** a against b: <0, 0, >0, or null when they do not compare (empty, or not of the kind). */
export function order(kind: Kind, a: unknown, b: unknown): number | null {
  if (empty(a) || empty(b)) return null;
  if (kind === "date") { const x = parseTime(a), y = parseTime(b); return x === null || y === null ? null : Math.sign(x - y); }
  if (kind === "number") return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) ? Math.sign(a - b) : null;
  return null;
}

function leaf(c: FieldCondition, path: string, ctx: EvalContext): Leaf {
  const op = opOf(c)[0]!;
  const kind = ctx.kindOf(c.field);
  const actual = valueAt(ctx, c.field);
  const base = { path, field: c.field, op, actual: actual === undefined ? null : actual, ...(c.label ? { label: c.label } : {}) };
  const done = (expected: unknown, passed: boolean, note?: string): Leaf => ({ ...base, expected, passed, ...(note ? { note } : {}) });
  const one = (v: unknown, k: Kind = kind) => resolveOperand(v, k, ctx);
  const missing = (v: unknown) => done(v, false, `no value given for ${String(v).split("|")[0]}`);
  switch (op) {
    case "exists": return done(c.exists, c.exists === !empty(actual));
    case "eq": case "ne": {
      const e = one(c[op]);
      if (e === MISSING) return missing(c[op]);
      const eq = same(kind, actual, e.value);
      return done(e.value, op === "eq" ? eq : !eq, e.note);
    }
    case "in": case "not_in": {
      const got = c[op]!.map((v) => one(v));
      const gone = got.findIndex((x) => x === MISSING);
      if (gone >= 0) return missing(c[op]![gone]);
      const vals = got.map((x) => (x as { value: unknown }).value);
      const hit = vals.some((v) => same(kind, actual, v));
      return done(vals, op === "in" ? hit : !hit);
    }
    case "gt": case "gte": case "lt": case "lte": {
      const e = one(c[op]);
      if (e === MISSING) return missing(c[op]);
      const d = order(kind, actual, e.value);
      const passed = d !== null && (op === "gt" ? d > 0 : op === "gte" ? d >= 0 : op === "lt" ? d < 0 : d <= 0);
      return done(e.value, passed, e.note ?? (d === null && empty(actual) ? `${c.field} has no value` : undefined));
    }
    case "within": {
      const w = c.within!;
      const ofR = w.of === undefined ? { value: new Date(ctx.now).toISOString() } : one(w.of, "date");
      if (ofR === MISSING) return missing(w.of);
      const ref = parseTime(ofR.value), t = parseTime(actual);
      const span = durationMs((w.last ?? w.next)!);
      const from = ref === null ? null : w.last ? ref - span : ref, to = ref === null ? null : w.last ? ref : ref + span;
      const expected = { from: from === null ? null : new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString() };
      return done(expected, t !== null && from !== null && to !== null && t >= from && t <= to, ofR.note);
    }
    case "has": {
      const e = one(c.has, "string");
      if (e === MISSING) return missing(c.has);
      const list = Array.isArray(actual) ? actual : empty(actual) ? [] : [actual];
      return done(e.value, list.some((x) => x === e.value));
    }
  }
}

/** A bucket (mold_v0-226, src/check-spec.ts bucketOf): the input's bucket under the salt, below percent x 100. */
function bucketLeaf(c: BucketCondition, path: string, ctx: EvalContext, checkName: string): Leaf {
  const b = c.bucket;
  const text = (v: string | undefined, fallback: string | null) => {
    if (v === undefined) return fallback;
    const r = resolveOperand(v, "string", ctx);
    return r === MISSING || typeof r.value !== "string" || r.value === "" ? null : r.value;
  };
  const input = text(b.input, null), salt = text(b.salt, checkName);
  const pr = typeof b.percent === "number" ? { value: b.percent } : resolveOperand(b.percent, "number", ctx);
  const percent = pr === MISSING ? null : pr.value;
  const below = bucketThreshold(percent);
  const base = { path, field: b.input.replace(/^[$@]/, ""), op: "bucket" as const, ...(c.label ? { label: c.label } : {}) };
  const expected = { percent: typeof percent === "number" ? percent : null, below, of: BUCKETS };
  if (input === null) return { ...base, expected, actual: null, passed: false, note: `no value to bucket: ${b.input}` };
  if (salt === null) return { ...base, expected, actual: null, passed: false, note: `no salt: ${b.salt}` };
  const bucket = bucketOf(salt, input);
  if (below === null) return { ...base, expected, actual: bucket, passed: false, note: `no percent from 0 to 100 (${String(b.percent)} is ${percent === undefined || percent === null || percent === "" ? "empty" : JSON.stringify(percent)})` };
  return { ...base, expected, actual: bucket, passed: bucket < below };
}

/**
 * Evaluate a condition. all: every one holds (decided by the first that does not, or by all of them); any: one holds
 * (decided by the first that does, or by all of them); not: the opposite (decided by what it negates).
 */
export function evaluate(c: CheckCondition, ctx: EvalContext, path = "require", checkName = ""): Outcome {
  if (isBucket(c)) { const l = bucketLeaf(c, path, ctx, checkName); return { passed: l.passed, decided_by: [l], evaluated: [l] }; }
  if (!isGroup(c)) { const l = leaf(c, path, ctx); return { passed: l.passed, decided_by: [l], evaluated: [l] }; }
  if ("not" in c) { const o = evaluate(c.not, ctx, `${path}.not`, checkName); return { passed: !o.passed, decided_by: o.decided_by, evaluated: o.evaluated }; }
  const isAll = "all" in c;
  const kids = (isAll ? c.all : c.any).map((x, i) => evaluate(x, ctx, `${path}.${isAll ? "all" : "any"}[${i}]`, checkName));
  const evaluated = kids.flatMap((k) => k.evaluated);
  if (isAll) {
    const failed = kids.find((k) => !k.passed);
    return failed ? { passed: false, decided_by: failed.decided_by, evaluated } : { passed: true, decided_by: kids.flatMap((k) => k.decided_by), evaluated };
  }
  const held = kids.find((k) => k.passed);
  return held ? { passed: true, decided_by: held.decided_by, evaluated } : { passed: false, decided_by: kids.flatMap((k) => k.decided_by), evaluated };
}

/**
 * The latest of `records` by `field` (a date or number; key and updated_at too), ties to the greater key, a record
 * without a value last: what `ORDER BY field DESC, key DESC` gives (src/record-query.ts), whatever their order.
 */
export function pickLatest(records: readonly EvalRecord[], field: string, kind: Kind): EvalRecord | null {
  let best: EvalRecord | null = null;
  const v = (r: EvalRecord) => (field === "key" ? r.key : field === "updated_at" ? r.updated_at : r.data[field]);
  for (const r of records) {
    if (!best) { best = r; continue; }
    const d = order(kind, v(r), v(best));
    const rEmpty = d === null && empty(v(r)), bEmpty = d === null && empty(v(best));
    const cmp = d !== null ? d : rEmpty && !bEmpty ? -1 : !rEmpty && bEmpty ? 1 : 0;
    if (cmp > 0 || (cmp === 0 && r.key > best.key)) best = r;
  }
  return best;
}

// ---------- words ----------

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "nothing" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));
const OP_WORDS: Record<CheckOp, string> = { eq: "is", ne: "is not", in: "is one of", not_in: "is none of", gt: "is after/above", gte: "is at or after/above", lt: "is before/below", lte: "is at or before/below", within: "is within", exists: "has a value", has: "includes" };
/** One condition in words: what it asked and what the record holds. */
export function leafWords(l: Leaf, kind: Kind | null = null): string {
  const what = l.label ?? l.field;
  if (l.note?.startsWith("no value given")) return `${what}: ${l.note}`;
  if (l.op === "bucket") {
    const e = l.expected as { percent: number | null; below: number | null };
    const lead = l.label ? `${l.label}: ` : "";
    if (l.note) return `${lead}${l.note}`;
    return `${lead}${l.field} is in bucket ${String(l.actual)} of ${BUCKETS}, ${l.passed ? "" : "not "}below ${e.below} (${e.percent}%)`;
  }
  if (l.op === "exists") return l.expected ? `${what} ${l.passed ? "has a value" : "has no value"}` : `${what} ${l.passed ? "has no value" : `has a value (${show(l.actual)})`}`;
  const cmp = kind === "date" ? { gt: "after", gte: "at or after", lt: "before", lte: "at or before" } : { gt: "above", gte: "at or above", lt: "below", lte: "at or below" };
  const want = l.op === "within" ? `between ${(l.expected as { from: string }).from} and ${(l.expected as { to: string }).to}`
    : l.op in cmp ? `${cmp[l.op as keyof typeof cmp]} ${show(l.expected)}` : l.op === "eq" ? show(l.expected) : l.op === "ne" ? `not ${show(l.expected)}`
    : l.op === "in" ? `one of ${show(l.expected)}` : l.op === "not_in" ? `none of ${show(l.expected)}` : `including ${show(l.expected)}`;
  if (l.passed) return `${what} is ${show(l.actual)} (${l.op === "eq" ? "as required" : `required: ${want}`})`;
  return `${what} is ${show(l.actual)}, not ${want}`;
}
export { OP_WORDS };
