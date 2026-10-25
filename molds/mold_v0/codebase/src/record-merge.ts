/**
 * A merged tab's rows (mold_v0-135; molds/mold_v0/MOLD.md "Console tabs"): an area tab that declares `areas` shows
 * several record areas as one list, one row per record key, read as one workspace sees each area (src/record-areas.ts
 * listFor: the area's read permission for the person asking, a shared area's rows, the workspace's own rows of a
 * workspace area). Nothing is written and nothing crosses workspaces: every read is one area's own list.
 *
 * Order. Rows come area by area, in the tab's order, each area by key: the first area's rows, then each later area's
 * rows that no earlier area holds (rows: all), so a key is listed once and the order never depends on how the database
 * sorts keys against another area's. An area with rows: matched only adds its fields to rows already listed (a lookup
 * by key, 100 keys at a time). A row's fields are the union of its areas' fields, the first area in the tab's order with
 * a value giving each; its title the first one with a title; its time the latest.
 *
 * Paging. `next` names the stage (the area being listed) and that area's own cursor ("~m" + base64url JSON [stage, key]),
 * so a page picks up where the last one ended. A page is filled from at most a few reads of each area; it may hold fewer
 * rows than `limit` when later areas' rows were mostly listed already, with `next` still set.
 */
import { PackError, RECORD_KEY, type RecordRow, type Tab } from "./pack-api.js";
import { MAX_LIMIT } from "./record-query.js";
import { tabAreas, type MergedArea } from "./metric-spec.js";
import { areaOrThrow, listFor, SYSTEM_ACTOR, type Actor } from "./record-areas.js";

/** A row of a merged tab: the merged record, and the areas that hold its key (in the tab's order). */
export interface MergedRow { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; areas: string[] }
export interface MergedPage { records: MergedRow[]; next: string | null }

const LOOKUP = 100;
/** At most this many reads of a stage's area fill one page (rows mostly listed by earlier areas are skipped, not waited on). */
const READS_PER_PAGE = 4;
const bad = (m: string) => new PackError(m, 400);

function readCursor(after: unknown, stages: number): { stage: number; key: string | null } {
  if (after === undefined || after === null || after === "") return { stage: 0, key: null };
  if (typeof after !== "string" || !after.startsWith("~m") || after.length > 600) throw bad("after is the next value of the previous page");
  let x: unknown;
  try { x = JSON.parse(Buffer.from(after.slice(2), "base64url").toString("utf8")); } catch { throw bad("after is the next value of the previous page"); }
  if (!Array.isArray(x) || x.length !== 2 || !Number.isInteger(x[0]) || x[0] < 0 || x[0] >= stages || !(x[1] === null || (typeof x[1] === "string" && RECORD_KEY.test(x[1]))))
    throw bad("after is the next value of the previous page");
  return { stage: x[0] as number, key: x[1] as string | null };
}
const cursor = (stage: number, key: string | null) => `~m${Buffer.from(JSON.stringify([stage, key]), "utf8").toString("base64url")}`;

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The records of `area` (as `orgId` and `actor` see it) among `keys`, by key. */
async function lookup(orgId: number, area: string, keys: string[], actor: Actor): Promise<Map<string, RecordRow>> {
  const found = new Map<string, RecordRow>();
  for (let i = 0; i < keys.length; i += LOOKUP) {
    const chunk = keys.slice(i, i + LOOKUP);
    const page = await listFor(orgId, area, { limit: chunk.length, filter: { key: { in: chunk } } }, actor);
    for (const r of page.records) found.set(r.key, r);
  }
  return found;
}

/** One row from each area's record of its key, in the tab's order (fields and title: the first with a value). */
export function mergeRow(key: string, parts: { area: string; record: RecordRow | undefined }[]): MergedRow | null {
  const held = parts.filter((p): p is { area: string; record: RecordRow } => !!p.record);
  if (!held.length) return null;
  const data: Record<string, unknown> = {};
  for (const { record } of held) for (const [k, v] of Object.entries(record.data)) if (k[0] !== "$" && empty(data[k]) && !empty(v)) data[k] = v;
  return {
    key, title: held.find((p) => p.record.title)?.record.title ?? null, data,
    updated_at: held.map((p) => p.record.updated_at).sort().at(-1)!, areas: held.map((p) => p.area),
  };
}

/**
 * A page of a merged tab for one workspace. Every area of the tab is checked (declared, readable by `actor`) before
 * anything is read; `limit` 1-200 (default 50).
 */
export async function mergedPage(orgId: number, tab: Pick<Tab, "kind" | "area" | "areas">, opts: { limit?: unknown; after?: unknown }, actor: Actor = SYSTEM_ACTOR): Promise<MergedPage> {
  const list: MergedArea[] = tabAreas(tab);
  if (list.length < 2) throw new PackError("Not found", 404);
  for (const a of list) areaOrThrow(a.area);
  const limit = opts.limit === undefined || opts.limit === "" ? 50 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`limit is 1 to ${MAX_LIMIT}`);
  const stages = list.map((a, i) => ({ ...a, i })).filter((a) => a.rows === "all");
  let { stage, key: after } = readCursor(opts.after, stages.length);
  const rows: MergedRow[] = [];
  let reads = 0;
  while (stage < stages.length && rows.length < limit) {
    const s = stages[stage]!;
    const page = await listFor(orgId, s.area, { limit: limit - rows.length, ...(after ? { after } : {}) }, actor);
    reads++;
    const keys = page.records.map((r) => r.key);
    // A key an earlier area holds was listed with that area's rows.
    const earlier = await Promise.all(list.slice(0, s.i).filter((a) => a.rows === "all").map((a) => lookup(orgId, a.area, keys, actor)));
    const fresh = keys.filter((k) => !earlier.some((m) => m.has(k)));
    // The rest add their fields: every later area, and the matched areas before this one.
    const others = new Map(await Promise.all(list.filter((a, i) => i > s.i || (i < s.i && a.rows === "matched"))
      .map(async (a) => [a.area, await lookup(orgId, a.area, fresh, actor)] as const)));
    const own = new Map(page.records.map((r) => [r.key, r]));
    for (const k of fresh) {
      const row = mergeRow(k, list.map((a, i) => ({ area: a.area, record: i === s.i ? own.get(k) : others.get(a.area)?.get(k) })));
      if (row) rows.push(row);
    }
    if (page.next) after = page.next;
    else { stage++; after = null; }
    if (reads >= READS_PER_PAGE * stages.length) break;
  }
  return { records: rows, next: stage < stages.length ? cursor(stage, after) : null };
}
