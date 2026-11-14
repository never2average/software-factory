/**
 * A program's results kept as records (mold_v0-303, M7; src/program-spec.ts ProgramRecord): once a child's (or a machine's)
 * outputs have passed their schema and it has settled done, the server writes them into the workspace area its program
 * names, mapped field by field, as one batch (all or none), through the record store (the area's fields, references and
 * lifecycle). The agent never writes them: provenance is the run, `run:program:<program>:<handle>`. Writing a key again
 * replaces that record, so a settle seen twice writes the same rows.
 */
import type { RecordOperation } from "./pack-api.js";
import { recordPath, recordProblems, type ProgramRecord, type RecordAreaShape } from "./program-spec.js";

/** The most records one result writes. */
export const MAX_RECORDS = 200;

/** The build's workspace record areas, as program-spec checks a record against (src/record-areas.ts). */
export async function recordAreaShapes(): Promise<RecordAreaShape[]> {
  const { recordAreas } = await import("./record-areas.js");
  return recordAreas().map((a) => ({ name: a.name, scope: a.scope, fields: a.fields.map((f) => f.name) }));
}

/** The record operations a result maps to (pure): refused in words when the outputs do not hold what the mapping names. */
export function recordOps(rec: ProgramRecord, outputs: unknown, handle: string): RecordOperation[] {
  const items = rec.items ? recordPath(outputs, rec.items) : [outputs];
  if (!Array.isArray(items)) throw new Error(`its outputs have no list at ${rec.items}`);
  if (items.length > MAX_RECORDS) throw new Error(`at most ${MAX_RECORDS} records a result (it has ${items.length})`);
  return items.map((it, i) => {
    const k = rec.key ? recordPath(it, rec.key) : rec.items ? `${handle}-${i + 1}` : handle;
    if ((typeof k !== "string" && typeof k !== "number") || String(k) === "") throw new Error(`${rec.items ? `item ${i + 1}: ` : ""}no key at ${rec.key}`);
    const t = rec.title ? recordPath(it, rec.title) : undefined;
    const data: Record<string, unknown> = {};
    for (const [f, p] of Object.entries(rec.fields)) { const v = recordPath(it, p); if (v !== undefined) data[f] = v; }
    return { op: "put" as const, area: rec.area, key: String(k).slice(0, 200), ...(typeof t === "string" ? { title: t.slice(0, 500) } : {}), data };
  });
}

/** Write one settled result's records in its workspace. Answers the keys written. */
export async function writeProgramRecords(orgId: number, h: { id: string; program_id: string | null; outputs: unknown }, rec: ProgramRecord): Promise<string[]> {
  const RA = await import("./record-areas.js");
  const shapes = await recordAreaShapes();
  const bad = recordProblems(rec, shapes);
  if (bad.length) throw new Error(bad.join("; "));
  const area = RA.findArea(rec.area)!;
  const ops = recordOps(rec, h.outputs ?? {}, h.id);
  if (!ops.length) return [];
  const { withTenant } = await import("./tenant-scope.js");
  const results = await RA.asWriter({ by: "run", id: `program:${h.program_id ?? "unknown"}:${h.id}` }, () => withTenant(orgId, () => RA.workspaceRecords(area.pack, orgId, RA.SYSTEM_ACTOR).batch(ops)));
  return results.map((r) => r.key);
}
