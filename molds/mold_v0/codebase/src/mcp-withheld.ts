/**
 * What a pack's mcp settings withhold beyond the MCP tool (mold_v0-067; src/mcp-catalog.ts WithheldTool). A tool a pack
 * `exclude`s (or leaves out of `include`) or marks `admin_only` is not only off the customer MCP: the same operation's
 * route for the workspace answers 404 and its console tab is not shown (scripts/gen-packs.mjs leaves it out of the
 * sidebar). An excluded staff tool (admin_list_, admin_get_, admin_create_, admin_update_, admin_delete_, admin_sync_)
 * withholds the staff route of the same operation likewise. An admin_only tool stays usable by staff on the admin MCP.
 *
 *   tool op          workspace route(s) withheld
 *   list             GET /api/data/:area, GET /api/records/:area, the area's console tab and Records entry
 *   get              GET /api/data/:area/:key, GET /api/records/:area/:key
 *   export           the console's Export CSV on the area's pages (mold_v0-108: they read the list routes above)
 *   create           POST /api/data/:area; _batch create and put
 *   update           PUT /api/data/:area/:key; _batch update and put
 *   move             POST /api/data/:area/:key/move; _batch move
 *   (all three)      DELETE /api/data/:area/:key; _batch delete (no delete tool: withheld when every write is)
 *   metrics          GET /api/metrics for the pack's metrics
 *   list_runs        the pack's runs in GET /api/runs; the runs tab of the pack
 *   run_status       a run's status, cost and error on GET /api/runs/:id (both withheld: the run is not found)
 *   run_results      its results on GET /api/runs/:id and its result counts on GET /api/runs
 *   start            POST /api/schedules for the kind (the pack's own default schedules still fire)
 *   admin_list/get/create/update/delete   the same on /api/admin/data and /api/admin/records
 *   admin_sync       POST /api/admin/data/_repositories/:pack/:name/sync
 *   get_started      nothing beyond the tool (mold_v0-105: the console's Setup page still shows the checklist)
 *
 * With zero packs, or packs with no mcp settings, nothing is withheld and every route answers as before.
 */
import { generateCatalog, type GeneratedOp, type WithheldTool } from "./mcp-catalog.js";
import { packs } from "./packs.js";

let cache: { from: unknown; list: WithheldTool[] } | null = null;
/** Every generated tool the build's packs withhold (checked when the packs were installed: src/packs.ts installPacks). */
export function withheldTools(): WithheldTool[] {
  const list = packs();
  if (cache?.from === list) return cache.list;
  const withheld = generateCatalog(list.map((p) => ({ id: p.id, name: p.manifest.name, words: p.manifest.words, definition: p.definition }))).withheld;
  cache = { from: list, list: withheld };
  return withheld;
}

/**
 * Whether `op` on record area `area` is withheld from its door's HTTP routes. "delete" (no generated tool) is withheld
 * for a workspace area when every write its pack generates for it (create, update, move) is: a pack that keeps an
 * area's writes to staff keeps its deletes there too.
 */
export const areaOpWithheld = (area: string, op: GeneratedOp | "delete"): boolean => {
  const held = withheldTools();
  if (op !== "delete") return held.some((w) => w.area === area && w.op === op);
  const writes = held.filter((w) => w.area === area && w.door === "workspace" && (w.op === "create" || w.op === "update" || w.op === "move"));
  const generated = writesOf(area);
  return generated.length > 0 && generated.every((g) => writes.some((w) => w.op === g));
};
/** The write ops the catalog generates for an area on the workspace door (none for a shared or read-only area). */
let unsettled: { from: unknown; tools: ReturnType<typeof generateCatalog>["tools"] } | null = null;
const writesOf = (area: string): GeneratedOp[] => {
  const list = packs();
  if (unsettled?.from !== list) unsettled = { from: list, tools: generateCatalog(list.map((p) => ({ id: p.id, name: p.manifest.name, words: p.manifest.words, definition: { ...p.definition, mcp: undefined } }))).tools };
  return unsettled.tools.filter((t) => t.area === area && t.door === "workspace" && (t.op === "create" || t.op === "update" || t.op === "move")).map((t) => t.op);
};

/** The record ops a data API batch operation needs (put is a create or an update). */
const BATCH_OPS: Record<string, (GeneratedOp | "delete")[]> = { create: ["create"], update: ["update"], put: ["create", "update"], move: ["move"], delete: ["delete"] };
const ADMIN_BATCH_OPS: Record<string, (GeneratedOp | "delete")[]> = { create: ["admin_create"], update: ["admin_update"], put: ["admin_create", "admin_update"], delete: ["admin_delete"] };

/** The first operation of a batch that names a withheld op, as "op area", or null. */
export function batchWithheld(ops: unknown, door: "workspace" | "admin"): string | null {
  if (!Array.isArray(ops)) return null;
  for (const o of ops) {
    const { op, area } = (o ?? {}) as { op?: unknown; area?: unknown };
    if (typeof op !== "string" || typeof area !== "string") continue;
    const map = door === "admin" ? ADMIN_BATCH_OPS : BATCH_OPS;
    // An own key only: an op named like an Object built-in ("constructor") needs nothing here (the data API refuses it).
    for (const need of Object.hasOwn(map, op) ? map[op]! : []) if (areaOpWithheld(area, need)) return `${op} ${area}`;
  }
  return null;
}

/** Whether a pack's run op (list_runs, run_status, run_results) or its metrics are withheld. */
export const packOpWithheld = (pack: string, op: GeneratedOp): boolean => withheldTools().some((w) => w.pack === pack && w.op === op);

/** Whether an upstream catalog's sync is withheld from staff. */
export const syncWithheld = (pack: string, repository: string): boolean =>
  withheldTools().some((w) => w.pack === pack && w.op === "admin_sync" && w.repository === repository);
