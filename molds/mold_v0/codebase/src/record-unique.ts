/**
 * One record per parent (mold_v0-337; molds/mold_v0/MOLD.md "One at a time, one per parent, two hops"): an area's
 * on_save entry `{unique: {field, value?, within}, message?}` (src/pack-api.ts OnSaveUniqueSchema) keeps a value to one
 * record among its siblings, the records of the workspace with the same `within` values: one Default environment per
 * application. In the record store's save checks (src/record-areas.ts onSaveChecks, and a move), as the shell reads
 * (every record of the workspace, whoever may see it; a batch's own writes so far included), with the area's writes
 * taking their turn (src/connection-test-health.ts lockOnlyOne). The refusal names the other record as the writer
 * reads it, else "another record (one you cannot see)", as a one-only flag's does.
 */
import { PackError, type OnSaveUnique } from "./pack-api.js";
import { pendingRows, shellRead } from "./connection-test-health.js";

interface AreaLike { pack: string; name: string; label?: string; scope?: string; fields: readonly { name: string; label?: string; options?: unknown }[]; on_save?: readonly unknown[] }

/** An area's one-per-parent rules (its on_save entries with unique). */
export const uniqueOf = (area: AreaLike): OnSaveUnique[] =>
  (area.scope === "workspace" ? ((area.on_save ?? []) as OnSaveUnique[]).filter((r) => !!r && typeof r === "object" && "unique" in r) : []);

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown) => a === b || (a != null && b != null && typeof a !== "object" && String(a) === String(b));
/** Whether a record's data is one the rule keeps to one: the field holds the value (any value, without one). */
const holds = (u: OnSaveUnique["unique"], d: Record<string, unknown>) => !empty(d[u.field]) && (u.value === undefined || same(d[u.field], u.value));
/** An option's words (its label), else the value. */
function words(area: AreaLike, field: string, v: unknown): string {
  const f = area.fields.find((x) => x.name === field);
  const opts = Array.isArray(f?.options) ? (f!.options as unknown[]) : [];
  const o = opts.find((x) => (typeof x === "string" ? x : (x as { value?: unknown })?.value) === v);
  return o && typeof o === "object" && (o as { label?: string }).label ? (o as { label: string }).label : String(v);
}
const label = (area: AreaLike, field: string) => (area.fields.find((x) => x.name === field)?.label ?? field).toLowerCase();

/**
 * Refuse a save of `key` (its data after the write) that would make it a second record holding a unique value among
 * its siblings. A record that already held it with the same siblings before this write is left as it is (two from
 * before save as they are); a sibling scope with an empty value is nobody's.
 */
export async function checkUnique(orgId: number, area: AreaLike, key: string, data: Record<string, unknown>, actor: { role: unknown; userId: string | null }, prev: Record<string, unknown> | null): Promise<void> {
  for (const { unique: u, message } of uniqueOf(area)) {
    if (!holds(u, data) || u.within.some((w) => empty(data[w]))) continue;
    if (prev && holds(u, prev) && same(prev[u.field], data[u.field]) && u.within.every((w) => same(prev[w], data[w]))) continue;
    const params: unknown[] = [orgId, area.pack, area.name, key, u.field, JSON.stringify(data[u.field])];
    const scope = u.within.map((w) => { params.push(w, JSON.stringify(data[w])); return `data -> $${params.length - 1} = $${params.length}::jsonb`; });
    // An import preview's own rows first (named by their key in that file), then the stored ones it does not replace.
    const pending = pendingRows();
    const sibling = (d: Record<string, unknown>) => holds(u, d) && same(d[u.field], data[u.field]) && u.within.every((w) => same(d[w], data[w]));
    const inFile = [...(pending ?? new Map()).entries()].find(([k, d]) => k !== key && sibling(d))?.[0];
    const rows = inFile ? [] : (await shellRead<{ key: string }>(orgId,
      `SELECT key FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key <> $4 AND data -> $5 = $6::jsonb AND ${scope.join(" AND ")} ORDER BY key LIMIT 50`, params))
      .filter((r) => !pending?.has(r.key));
    if (!inFile && !rows.length) continue;
    const ra = await import("./record-areas.js");
    const { auditQuiet } = await import("./audit-trail.js");
    const seen = inFile ? null : await auditQuiet(() => ra.getFor(orgId, area.name, rows[0]!.key, actor as never)).catch(() => null);
    const other = inFile ? `"${inFile}" (a row of this file)` : seen ? `"${seen.title || seen.key}"` : "another record (one you cannot see)";
    // An option says itself ("is already Default"); any other value with its field ("already has region eu-west").
    const enumField = Array.isArray(area.fields.find((x) => x.name === u.field)?.options);
    const what = enumField ? `is already ${words(area, u.field, data[u.field])}` : `already has ${label(area, u.field)} ${words(area, u.field, data[u.field])}`;
    throw new PackError(`${message ? `${message} ` : ""}${area.label ?? area.name}: ${other} ${what} for this ${u.within.map((w) => label(area, w)).join(" and ")}, and only one may: change it there first.`, 409);
  }
}
