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
 *   create           POST /api/data/:area; _batch create and put
 *   update           PUT /api/data/:area/:key; _batch update and put
 *   move             POST /api/data/:area/:key/move; _batch move
 *   metrics          GET /api/metrics for the pack's metrics
 *   list_runs        the pack's runs in GET /api/runs; the runs tab of the pack
 *   run_status, run_results   GET /api/runs/:id for the pack's runs
 *   admin_list/get/create/update/delete   the same on /api/admin/data and /api/admin/records
 *   admin_sync       POST /api/admin/data/_repositories/:pack/:name/sync
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

/** Whether `op` on record area `area` is withheld from its door's HTTP routes. */
export const areaOpWithheld = (area: string, op: GeneratedOp): boolean => withheldTools().some((w) => w.area === area && w.op === op);

/** The record ops a data API batch operation needs (put is a create or an update). */
const BATCH_OPS: Record<string, GeneratedOp[]> = { create: ["create"], update: ["update"], put: ["create", "update"], move: ["move"], delete: [] };
const ADMIN_BATCH_OPS: Record<string, GeneratedOp[]> = { create: ["admin_create"], update: ["admin_update"], put: ["admin_create", "admin_update"], delete: ["admin_delete"] };

/** The first operation of a batch that names a withheld op, as "op area", or null. */
export function batchWithheld(ops: unknown, door: "workspace" | "admin"): string | null {
  if (!Array.isArray(ops)) return null;
  for (const o of ops) {
    const { op, area } = (o ?? {}) as { op?: unknown; area?: unknown };
    if (typeof op !== "string" || typeof area !== "string") continue;
    for (const need of (door === "admin" ? ADMIN_BATCH_OPS : BATCH_OPS)[op] ?? []) if (areaOpWithheld(area, need)) return `${op} ${area}`;
  }
  return null;
}

/** Whether a pack's run op (list_runs, run_status, run_results) or its metrics are withheld. */
export const packOpWithheld = (pack: string, op: GeneratedOp): boolean => withheldTools().some((w) => w.pack === pack && w.op === op);

/** Whether an upstream catalog's sync is withheld from staff. */
export const syncWithheld = (pack: string, repository: string): boolean =>
  withheldTools().some((w) => w.pack === pack && w.op === "admin_sync" && w.repository === repository);
