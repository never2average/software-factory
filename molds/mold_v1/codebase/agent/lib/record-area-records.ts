/**
 * THE TWO RECORD AREAS OF AN ACCOUNT (deployments, implementations) AS A DEFINITION DRAWS THEM: what the ops routes,
 * the agent's per-area tools and the screens share about a record once a profile states the area in the record-area
 * form (`records.areas.<area>`, compiled with `declared: true`; docs/DEPLOYMENT_PROFILE.md "records").
 *
 *   - a record's title from the definition's template ("{runtime} · {deployedVersion}"), and its computed fields
 *     (evaluated here for display, never stored);
 *   - a row as the API returns it: every visible field by key, a column or the area's own field under `custom`;
 *   - which fields a write may name, and what identifies a row.
 *
 * A write is prepared by agent/lib/record-area-write.ts (one check for every write path).
 *
 * A profile that does not state the area in that form (the default, the legacy `domains.<area>`) keeps today's screens
 * and routes.
 *
 * Pure: no database, no fetch. `areas` is a parameter so a preview page or a test can pass another profile's.
 */
import { RECORD_AREAS, type RecordAreaId, type RecordField, type RecordWhere } from "./record-areas.generated.ts";
import { areaView, type AreaRow, type AreaView, type RecordAreas } from "./record-areas.ts";

export type AccountAreaId = Extract<RecordAreaId, "deployments" | "implementations">;
export const ACCOUNT_AREAS: readonly AccountAreaId[] = ["deployments", "implementations"];

/** The pseudo-field every account record has: the account it belongs to (the `customerId` column). */
export const ACCOUNT_FIELD = "account";

/** Is this area drawn from its definition (stated in the record-area form, and enabled)? */
export function isDeclared(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS): boolean {
  return Boolean(areas[id].declared) && areas[id].enabled;
}

const isBlank = (x: unknown) => x === null || x === undefined || (typeof x === "string" && x.trim() === "") || (Array.isArray(x) && x.length === 0);
const DAY = 86_400_000;
const isoDay = (now: Date, days = 0) => new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);

/* ------------------------------------------------------------------------------------------- reading a record */

/** A field's value on a row: the account, a computed field (evaluated), a column, or an own field under `custom`. */
export function valueOf(v: AreaView, row: AreaRow, key: string, now: Date = new Date()): unknown {
  if (key === ACCOUNT_FIELD) return row.customerId ?? null;
  const f = v.field(key);
  if (f?.computed) return computedValue(v, f, row, now);
  return v.get(row, key);
}

/** A `{today}`, `{today+7d}` or `{field}` in a condition, resolved against the row. */
function operand(v: AreaView, row: AreaRow, x: unknown, now: Date, seen: Set<string>): unknown {
  if (typeof x !== "string" || !x.startsWith("{") || !x.endsWith("}")) return x;
  const m = /^\{today(?:([+-]\d{1,3})d)?\}$/.exec(x);
  if (m) return isoDay(now, m[1] ? Number(m[1]) : 0);
  const key = x.slice(1, -1);
  if (!v.field(key) && key !== ACCOUNT_FIELD) return x;
  return fieldFor(v, row, key, now, seen);
}

function fieldFor(v: AreaView, row: AreaRow, key: string, now: Date, seen: Set<string>): unknown {
  const f = v.field(key);
  if (f?.computed) {
    if (seen.has(f.key)) return null; // the build refuses a cycle; a hand-made definition gets nothing
    return computedValue(v, f, row, now, new Set([...seen, f.key]));
  }
  return key === ACCOUNT_FIELD ? row.customerId ?? null : v.get(row, key);
}

/** Two values compared as the definition means them: numbers as numbers, dates and text as text. */
function compare(a: unknown, b: unknown): number | null {
  if (isBlank(a) || isBlank(b)) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === "number" || typeof b === "number") return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : null;
  // A date (yyyy-mm-dd) against a timestamp: the day of the timestamp.
  const sa = String(a);
  const sb = String(b);
  const day = (s: string) => (/^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s);
  return day(sa) < day(sb) ? -1 : day(sa) > day(sb) ? 1 : 0;
}

/** Does a row meet a condition (`{ field: value | { eq, ne, in, not_in, lt, lte, gt, gte, set, category } }`)? */
export function matchesWhere(v: AreaView, where: RecordWhere, row: AreaRow, now: Date = new Date(), seen: Set<string> = new Set()): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = fieldFor(v, row, key, now, seen);
    const of = (x: unknown) => operand(v, row, x, now, seen);
    if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
      if (compare(value, of(cond)) !== 0) return false;
      continue;
    }
    for (const [op, raw] of Object.entries(cond)) {
      const c = op === "set" || op === "category" || op === "in" || op === "not_in" ? null : compare(value, of(raw));
      const ok =
        op === "eq" ? c === 0
        : op === "ne" ? c !== 0
        : op === "lt" ? c !== null && c < 0
        : op === "lte" ? c !== null && c <= 0
        : op === "gt" ? c !== null && c > 0
        : op === "gte" ? c !== null && c >= 0
        : op === "set" ? isBlank(value) !== Boolean(raw)
        : op === "in" ? Array.isArray(raw) && raw.some((x) => compare(value, of(x)) === 0)
        : op === "not_in" ? !Array.isArray(raw) || !raw.some((x) => compare(value, of(x)) === 0)
        : op === "category" ? (() => {
            const lc = v.lifecycle;
            const cat = lc && lc.field === (v.field(key)?.key ?? key) ? lc.categoryOf(value) : null;
            return cat !== null && (Array.isArray(raw) ? raw.includes(cat) : raw === cat);
          })()
        : false;
      if (!ok) return false;
    }
  }
  return true;
}

/** A computed field's value on a row: the first `when` that holds, else `else`. Read-only, never stored. */
export function computedValue(v: AreaView, f: RecordField, row: AreaRow, now: Date = new Date(), seen: Set<string> = new Set([f.key])): unknown {
  const c = f.computed;
  if (!c) return undefined;
  for (const w of c.when) if (matchesWhere(v, w.if, row, now, seen)) return w.then;
  return c.else ?? null;
}

/** A value as a person reads it ("" when unset): the choice's label, a list joined, a number with its unit. */
export function shown(v: AreaView, row: AreaRow, key: string, now: Date = new Date()): string {
  return v.display(key, valueOf(v, row, key, now));
}

/**
 * A record's title: the definition's template with each `{field}` as a person reads it, the separators of the parts
 * that are empty dropped; else what the routes have always composed (`legacy`).
 */
export function recordTitle(v: AreaView, row: AreaRow, legacy: string, now: Date = new Date()): string {
  const template = v.area.title;
  if (!template) return legacy;
  const parts = template.split(/(\{[A-Za-z0-9_]+\})/).map((p) => (/^\{[A-Za-z0-9_]+\}$/.test(p) ? shown(v, row, p.slice(1, -1), now) : p));
  // "{a} · {b}" with b empty reads "A", not "A · ".
  const text = parts.join("").split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean).join(" · ").trim();
  return text || legacy;
}

/**
 * A row as the API returns it under a declared area: every field a person may see, by key (a column's stored value,
 * an own field's canonical value, a computed field's value), plus `custom` as stored (hidden own keys carried).
 */
export function recordValues(v: AreaView, row: AreaRow, now: Date = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of v.visibleFields) {
    const x = valueOf(v, row, f.key, now);
    if (x !== undefined) out[f.key] = x;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- the definition */

/** The field keys a write may name (visible, not computed, not stamped): the agent's tools and the forms offer these. */
export function writableFields(v: AreaView): RecordField[] {
  return v.visibleFields.filter((f) => !f.computed);
}

/** The field that identifies a row besides the account (deployments: its id; implementations: none, one per account). */
export function idFieldOf(id: AccountAreaId, areas: RecordAreas = RECORD_AREAS): string | null {
  return id === "deployments" ? areas.deployments.id?.field ?? "deploymentId" : null;
}
