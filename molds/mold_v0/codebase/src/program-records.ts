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
 * mold_v0-339:
 *   on_repeat        {from, move_to}: a repeat dedupe_on leaves out moves the stored record it repeats from one of `from`
 *                    to `move_to`, as the run's starter, guarded as an outcome's move (writeProgramResult)
 */
import { PackError, type RecordOperation } from "./pack-api.js";
import { recordPath, recordProblems, type ProgramRecord, type RecordAreaShape } from "./program-spec.js";

/** The most records one result writes. */
export const MAX_RECORDS = 200;

/** The build's workspace record areas, as program-spec checks a record against (src/record-areas.ts). */
export async function recordAreaShapes(): Promise<RecordAreaShape[]> {
  const { recordAreas } = await import("./record-areas.js");
  return recordAreas().map((a) => ({ name: a.name, scope: a.scope, fields: a.fields.map((f) => f.name),
    states: a.lifecycle ? [...new Set(a.lifecycle.transitions.map((t) => t.to))] : [], encrypted: a.fields.filter((f) => f.encrypted).map((f) => f.name),
    transitions: a.lifecycle?.transitions.map((t) => ({ from: t.from, to: t.to })) ?? [] }));
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
export interface RecordsWritten { keys: string[]; deduped: { key: string; kept: string }[]; unmoved: { key: string; from: string }[];
  /** mold_v0-334: keys of records that were there already, not this run's: left as they are, never replaced. */
  existing: string[];
  /**
   * mold_v0-339 (on_repeat): the kept records a repeat found in one of on_repeat.from: moved (to on_repeat.move_to), or
   * left where they are and why (a person moved it since the run started, the starter may not make the move, or left).
   */
  repeated?: { key: string; from: string; moved: boolean; why?: string }[] }

/**
 * Where a run came from: the record its root session was started on, when, and who started it (`actor`), or why they no
 * longer may (`refused`: asked for only when a write is theirs: an update or a move of a record that was there).
 */
export interface RunOrigin { record: { area: string; key: string } | null; started_at: Date | null; actor: import("./record-areas.js").Actor | null; refused?: string }

/**
 * A tree's origin from its root session (null fields: no root given, as a test's direct call). The starter's role is
 * read now (a person who left the workspace: `refused`); a run the workspace's account started (a schedule, an account
 * key) acts as an owner: never with no role checks (a null role skips them all), and never more than the key itself may
 * (an account key's own calls, its MCP record tools, have no role limits at all; the data API takes people only).
 */
export async function runOrigin(orgId: number, rootId: string | null | undefined): Promise<RunOrigin> {
  if (!rootId) return { record: null, started_at: null, actor: null };
  const { getDb } = await import("./db.js");
  const { asPlatform } = await import("./tenant-scope.js");
  const [r] = await asPlatform(async () => (await getDb()).query<{ record_area: string | null; record_key: string | null; created_at: Date; started_by: string | null; clerk_org_id: string | null }>(
    "SELECT s.record_area, s.record_key, s.created_at, s.started_by, o.clerk_org_id FROM harness_sessions s JOIN organizations o ON o.id = s.org_id WHERE s.org_id = $1 AND s.id = $2", [orgId, rootId]));
  if (!r) throw new Error("its run's root session is gone");
  let actor: import("./record-areas.js").Actor;
  const record = r.record_area && r.record_key ? { area: r.record_area, key: r.record_key } : null;
  if (!r.started_by || r.started_by === "account") actor = { role: "owner", userId: null };
  else {
    const role = await (await import("./auth.js")).memberRole(r.started_by, r.clerk_org_id);
    if (!role) return { record, started_at: r.created_at, actor: null, refused: "the person who started this run is no longer a member of the workspace" };
    actor = { role, userId: r.started_by };
  }
  return { record, started_at: r.created_at, actor };
}

/** Write one settled result's records in its workspace. Answers the keys written (writeProgramResult says what else). */
export async function writeProgramRecords(orgId: number, h: ResultHandle, rec: ProgramRecord): Promise<string[]> {
  return (await writeProgramResult(orgId, h, rec)).keys;
}
type ResultHandle = { id: string; program_id: string | null; outputs: unknown; inputs?: unknown; root_id?: string | null };

/**
 * mold_v0-334, who writes: a new record the server, as before; a record that is there already is never replaced by a
 * key the agent's outputs give, only by the same run's own result seen again (its writer): any other is left as it is
 * and said (`existing`). An update (update_by) and every move of a record that was there already, the person who started
 * the run (their role, the area's permissions, the transitions' roles and
 * what they may see apply). An update writes only the record the run was started on. A move of a record that was there
 * already goes only along a transition that names where it is (never a "*" one), and never when it entered that state
 * after the run started (a person moved it since: it stays, said as unmoved). Reads and writes in one transaction, the
 * rows it changes locked.
 */
export async function writeProgramResult(orgId: number, h: ResultHandle, rec: ProgramRecord): Promise<RecordsWritten> {
  const RA = await import("./record-areas.js");
  const shapes = await recordAreaShapes();
  const bad = recordProblems(rec, shapes);
  if (bad.length) throw new Error(bad.join("; "));
  const area = RA.findArea(rec.area)!;
  let ops = recordOps(rec, h.outputs ?? {}, h.id, h.inputs ?? {});
  const out: RecordsWritten = { keys: [], deduped: [], unmoved: [], existing: [] };
  if (!ops.length) return out;
  const origin = await runOrigin(orgId, h.root_id);
  if (rec.update_by === "key") {
    if (origin.refused) throw new Error(origin.refused);
    // Only the record the run was started on: an input the agent passed (it may be steered) names nothing else.
    const other = ops.find((o) => !origin.record || origin.record.area !== area.name || origin.record.key !== o.key);
    if (other) throw new Error(`a program updates only the record its run was started on${origin.record ? ` (${origin.record.area} ${origin.record.key})` : ""}, not ${area.name} ${other.key}`);
  }
  // mold_v0-339: the stored records a repeat names (never one of this result's own), moved below when on_repeat says so.
  let repeats: string[] = [];
  if (rec.update_by !== "key" && rec.dedupe_on?.length) {
    const d = await dedupe(orgId, area.name, rec.dedupe_on, ops, out, origin.actor ?? RA.SYSTEM_ACTOR);
    ops = d.kept;
    if (rec.on_repeat && area.lifecycle) repeats = d.stored;
    if (!ops.length && !repeats.length) return out;
  }
  const lc = area.lifecycle;
  const person = origin.actor ?? RA.SYSTEM_ACTOR;
  // A record that is there already is replaced only by this same run's result seen again (a settle seen twice).
  const writerText = `run:program:${h.program_id ?? "unknown"}:${h.id}`;
  const prov = rec.update_by === "key" ? new Map() : await RA.workspaceProvenance(orgId, area, [...new Set(ops.map((o) => o.key))]);
  const writer = { by: "run" as const, id: `program:${h.program_id ?? "unknown"}:${h.id}` };
  const { auditAtomic } = await import("./audit-trail.js");
  const keys = await RA.asWriter(writer, () => auditAtomic(() => RA.inTransaction(orgId, async () => {
    const server = RA.workspaceRecords(area.pack, orgId, RA.SYSTEM_ACTOR), starter = RA.workspaceRecords(area.pack, orgId, person);
    const done: string[] = [];
    for (const o of ops) {
      const row = await RA.lockedWorkspaceRow(orgId, area, o.key);
      const x = o as { title?: string; data: Record<string, unknown> };
      if (rec.update_by === "key") {
        if (!row) throw new PackError(`no ${area.name} record ${o.key} to update`, 404);
        // Over the stored record: its encrypted fields and its state are left out (kept as stored), the rest carried.
        const keep = Object.fromEntries(Object.entries(row.data).filter(([k]) => !k.startsWith("$") && k !== lc?.field && !area.fields.some((f) => f.name === k && f.encrypted)));
        await starter.update(area.name, o.key, { title: x.title ?? row.title, data: { ...keep, ...x.data } });
      } else if (row && prov.get(o.key)?.written_by !== writerText) { if (!out.existing.includes(o.key)) out.existing.push(o.key); continue; }
      else await server.put(area.name, o.key, { ...(x.title !== undefined ? { title: x.title } : {}), data: x.data });
      if (!done.includes(o.key)) done.push(o.key);
      if (!rec.move_to || !lc) continue;
      const from = String(row?.data[lc.field] ?? lc.initial);
      if (from === rec.move_to) continue;
      const since = row ? RA.stateEnteredAt(row.data, from) : null;
      const moved = row && origin.started_at && since && since > origin.started_at;
      const way = lc.transitions.some((t) => t.to === rec.move_to && (row ? Array.isArray(t.from) && t.from.includes(from) : t.from === "*" || t.from.includes(from)));
      if (moved || !way) { out.unmoved.push({ key: o.key, from }); continue; }
      if (row && origin.refused) throw new PackError(origin.refused, 403);
      await (row ? starter : server).move(area.name, o.key, rec.move_to);
    }
    // mold_v0-339: a repeat moves the record it repeats (a solved item found again), guarded as an outcome's move: the
    // row locked and read again here, only from one of on_repeat.from (so once: from move_to it is no longer there),
    // never when a person moved it after the run started (that move stands), along a transition naming where it is,
    // as the person who started the run (their role, the area's move permission, the transition's roles).
    if (rec.on_repeat && lc) {
      const rep = rec.on_repeat;
      out.repeated = [];
      for (const k of repeats) {
        const row = await RA.lockedWorkspaceRow(orgId, area, k);
        if (!row) continue;
        const from = String(row.data[lc.field] ?? lc.initial);
        if (!rep.from.includes(from)) continue;
        const stay = (why: string) => out.repeated!.push({ key: k, from, moved: false, why });
        const since = RA.stateEnteredAt(row.data, from);
        if (!origin.actor) { stay(origin.refused ?? "no person or account started this run"); continue; }
        if (origin.started_at && since && since > origin.started_at) { stay("a person moved it after the run started"); continue; }
        const role = origin.actor.role;
        const ways = lc.transitions.filter((t) => t.to === rep.move_to && Array.isArray(t.from) && t.from.includes(from));
        if (!ways.length) { stay(`no transition moves ${from} to ${rep.move_to}`); continue; }
        if (!RA.may(area, "move", origin.actor) || (role !== null && !ways.some((t) => !t.roles || t.roles.includes(role)))) { stay("the person who started the run may not make this move"); continue; }
        await starter.move(area.name, k, rep.move_to);
        out.repeated.push({ key: k, from, moved: true });
      }
    }
    return done;
  })));
  out.keys = keys;
  return out;
}

/**
 * The ops whose fingerprint no other record of the area the reader sees holds (and each fingerprint of the batch once);
 * mold_v0-339: and the stored records the left-out ones repeat (`stored`, each once; never one of the batch's own).
 */
async function dedupe(orgId: number, areaName: string, fields: readonly string[], ops: RecordOperation[], out: RecordsWritten, reader: import("./record-areas.js").Actor): Promise<{ kept: RecordOperation[]; stored: string[] }> {
  const RA = await import("./record-areas.js");
  const held = new Map<string, string>();
  let after: string | undefined;
  // Every record of the area the reader may see, page by page (no cap: a repeat past any limit is still a repeat).
  for (;;) {
    const p = await RA.listFor(orgId, areaName, { limit: 200, ...(after ? { after } : {}) }, reader);
    for (const r of p.records) { const f = fingerprintOf(r.data, fields); if (f && !held.has(f)) held.set(f, r.key); }
    if (!p.next || !p.records.length) break;
    after = p.next;
  }
  const inStore = new Set(held.values());
  const kept: RecordOperation[] = [], stored: string[] = [];
  for (const o of ops) {
    const f = fingerprintOf((o as { data: Record<string, unknown> }).data ?? {}, fields);
    const other = f ? held.get(f) : undefined;
    if (other !== undefined && other !== o.key) {
      out.deduped.push({ key: o.key, kept: other });
      if (inStore.has(other) && !ops.some((x) => x.key === other) && !stored.includes(other)) stored.push(other);
      continue;
    }
    if (f) held.set(f, o.key);
    kept.push(o);
  }
  return { kept, stored };
}
