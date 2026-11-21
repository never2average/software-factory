/**
 * A program's results kept as records (mold_v0-303, M7; src/program-spec.ts ProgramRecord): once a child's (or a machine's)
 * outputs have passed their schema and it has settled done, the server writes them into the workspace area its program
 * names, mapped field by field, as one batch (all or none), through the record store (the area's fields, references and
 * lifecycle). The agent never writes them: provenance is the run, `run:program:<program>:<handle>`. Writing a key again
 * replaces that record, so a settle seen twice writes the same rows.
 *
 * mold_v0-334, truthful state:
 *   update_by "key"  each result updates the record its key names (the record a program was started for: `$inputs.<name>`),
 *                    the fields it maps written over the stored ones; a key with no record refuses the whole write
 *   move_to          each record written is moved to that state when a transition of its lifecycle allows it from where it
 *                    is (a person's later move is never undone by a result seen twice: from there it no longer moves)
 *   dedupe_on        a new record whose values of these fields match a record the area keeps under another key is left
 *                    out (text trimmed, case-blind); a batch's own repeats once
 */
import type { RecordOperation } from "./pack-api.js";
import { recordPath, recordProblems, type ProgramRecord, type RecordAreaShape } from "./program-spec.js";

/** The most records one result writes. */
export const MAX_RECORDS = 200;

/** The build's workspace record areas, as program-spec checks a record against (src/record-areas.ts). */
export async function recordAreaShapes(): Promise<RecordAreaShape[]> {
  const { recordAreas } = await import("./record-areas.js");
  return recordAreas().map((a) => ({ name: a.name, scope: a.scope, fields: a.fields.map((f) => f.name),
    states: a.lifecycle ? [...new Set(a.lifecycle.transitions.map((t) => t.to))] : [], encrypted: a.fields.filter((f) => f.encrypted).map((f) => f.name) }));
}

/** The record operations a result maps to (pure): refused in words when the outputs do not hold what the mapping names. */
export function recordOps(rec: ProgramRecord, outputs: unknown, handle: string, inputs: unknown = {}): RecordOperation[] {
  const items = rec.items ? recordPath(outputs, rec.items) : [outputs];
  if (!Array.isArray(items)) throw new Error(`its outputs have no list at ${rec.items}`);
  if (items.length > MAX_RECORDS) throw new Error(`at most ${MAX_RECORDS} records a result (it has ${items.length})`);
  return items.map((it, i) => {
    // mold_v0-334: an update's key may be the program's input (the record it was started for).
    const k = rec.key?.startsWith("$inputs.") ? recordPath(inputs, rec.key.slice(8)) : rec.key ? recordPath(it, rec.key) : rec.items ? `${handle}-${i + 1}` : handle;
    if ((typeof k !== "string" && typeof k !== "number") || String(k) === "") throw new Error(`${rec.items ? `item ${i + 1}: ` : ""}no key at ${rec.key}`);
    const t = rec.title ? recordPath(it, rec.title) : undefined;
    const data: Record<string, unknown> = {};
    for (const [f, p] of Object.entries(rec.fields)) { const v = recordPath(it, p); if (v !== undefined) data[f] = v; }
    return { op: "put" as const, area: rec.area, key: String(k).slice(0, 200), ...(typeof t === "string" ? { title: t.slice(0, 500) } : {}), data };
  });
}

/** A value as dedupe compares it: text trimmed and case-blind, anything else as its JSON. */
export const dedupeValue = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : v === undefined || v === null ? "" : JSON.stringify(v));
/** A record's fingerprint over `fields` (null when every one is empty: nothing to match on). */
export const fingerprintOf = (data: Record<string, unknown>, fields: readonly string[]): string | null => {
  const parts = fields.map((f) => dedupeValue(data[f]));
  return parts.every((p) => p === "") ? null : JSON.stringify(parts);
};

/** What one settled result wrote: the keys written, those left out as repeats of a kept record, and moves it could not make. */
export interface RecordsWritten { keys: string[]; deduped: { key: string; kept: string }[]; unmoved: { key: string; from: string }[] }

/** Write one settled result's records in its workspace. Answers the keys written (writeProgramResult says what else). */
export async function writeProgramRecords(orgId: number, h: { id: string; program_id: string | null; outputs: unknown; inputs?: unknown }, rec: ProgramRecord): Promise<string[]> {
  return (await writeProgramResult(orgId, h, rec)).keys;
}

export async function writeProgramResult(orgId: number, h: { id: string; program_id: string | null; outputs: unknown; inputs?: unknown }, rec: ProgramRecord): Promise<RecordsWritten> {
  const RA = await import("./record-areas.js");
  const shapes = await recordAreaShapes();
  const bad = recordProblems(rec, shapes);
  if (bad.length) throw new Error(bad.join("; "));
  const area = RA.findArea(rec.area)!;
  let ops = recordOps(rec, h.outputs ?? {}, h.id, h.inputs ?? {});
  const out: RecordsWritten = { keys: [], deduped: [], unmoved: [] };
  if (!ops.length) return out;
  const { withTenant } = await import("./tenant-scope.js");
  const writer = { by: "run" as const, id: `program:${h.program_id ?? "unknown"}:${h.id}` };
  const stored = await RA.workspaceStored(orgId, area, [...new Set(ops.map((o) => o.key))]);
  const lc = area.lifecycle;
  if (rec.update_by === "key") {
    const missing = [...new Set(ops.filter((o) => !stored.has(o.key)).map((o) => o.key))];
    if (missing.length) throw new Error(`no ${area.name} record ${missing.slice(0, 5).join(", ")} to update`);
    // Over the stored record: its encrypted fields and its state are left out (kept as stored), the rest carried.
    const keep = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("$") && k !== lc?.field && !area.fields.some((f) => f.name === k && f.encrypted)));
    ops = ops.map((o) => {
      const s = stored.get(o.key)!, x = o as { title?: string; data: Record<string, unknown> };
      return { op: "update" as const, area: area.name, key: o.key, title: x.title ?? s.title, data: { ...keep(s.data), ...x.data } };
    });
  } else if (rec.dedupe_on?.length) {
    ops = await dedupe(orgId, area.name, rec.dedupe_on, ops, out);
    if (!ops.length) return out;
  }
  // A move only along a transition from where the record is (new: its initial state); else the record stays and it is said.
  const moves: RecordOperation[] = [];
  if (rec.move_to && lc) for (const o of ops) {
    const from = String(stored.get(o.key)?.data[lc.field] ?? lc.initial);
    if (from === rec.move_to || moves.some((m) => m.key === o.key)) continue;
    if (lc.transitions.some((t) => t.to === rec.move_to && (t.from === "*" || t.from.includes(from)))) moves.push({ op: "move", area: area.name, key: o.key, to: rec.move_to });
    else out.unmoved.push({ key: o.key, from });
  }
  const results = await RA.asWriter(writer, () => withTenant(orgId, () => RA.workspaceRecords(area.pack, orgId, RA.SYSTEM_ACTOR).batch([...ops, ...moves])));
  out.keys = [...new Set(results.map((r) => r.key))];
  return out;
}

/** The ops whose fingerprint no other record of the area holds (and each fingerprint of the batch once). */
async function dedupe(orgId: number, areaName: string, fields: readonly string[], ops: RecordOperation[], out: RecordsWritten): Promise<RecordOperation[]> {
  const RA = await import("./record-areas.js");
  const held = new Map<string, string>();
  let after: string | undefined;
  for (let page = 0; page < 25; page++) {
    const p = await RA.listFor(orgId, areaName, { limit: 200, ...(after ? { after } : {}) });
    for (const r of p.records) { const f = fingerprintOf(r.data, fields); if (f && !held.has(f)) held.set(f, r.key); }
    if (!p.next) break;
    after = p.next;
  }
  const kept: RecordOperation[] = [];
  for (const o of ops) {
    const f = fingerprintOf((o as { data: Record<string, unknown> }).data ?? {}, fields);
    const other = f ? held.get(f) : undefined;
    if (other !== undefined && other !== o.key) { out.deduped.push({ key: o.key, kept: other }); continue; }
    if (f) held.set(f, o.key);
    kept.push(o);
  }
  return kept;
}
