/**
 * Record areas (mold_v0-047; molds/mold_v0/MOLD.md "Pack and record-area contract"): what a pack declares in
 * definePack({ recordAreas }) becomes, with no pack code, a list page and a detail page in the console, and the MCP
 * tools list_records and get_record. The rows live in two shell tables (sql/migrations/0004_record_areas.sql):
 *
 *   platform_records   areas with scope "platform": shared by every workspace (a source of requirements, a library of
 *                      checks). The tenant role may only SELECT them: read-only to customers by the database's own
 *                      grants. Written by platform staff (/api/admin/records, need("library")) or a pack's admin route.
 *   workspace_records  areas with scope "workspace": one workspace's own rows (org_id), under row-level security
 *                      (tenant_isolation). Written by the pack's own code for the calling workspace (ctx.records.put).
 *                      An "asset" area's title and data are sealed with the workspace's data key (src/orgcrypto.ts).
 *
 * Every workspace read and write runs inside withTenant for that workspace and names its org_id as well, so the
 * database refuses another workspace's rows even when a query forgets its filter. The HTTP routes are in
 * src/record-routes.ts (this module stays free of the server's modules: src/packs.ts imports it).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "./db.js";
import { isSealed, open, openJson, seal, sealJson } from "./orgcrypto.js";
import { PackError, RecordAreaSchema, z, type PackTool, type PlatformRecords, type RecordInput, type RecordPage, type RecordRow, type Workspace, type WorkspaceRecords } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

export type RecordArea = z.output<typeof RecordAreaSchema> & { pack: string };

/** The MCP tools the shell adds when at least one area is declared (a pack may not take these names). */
export const RECORD_TOOL_NAMES = ["list_records", "get_record"] as const;

let cache: { from: unknown; areas: RecordArea[] } | null = null;
/** Every declared area, in pack order then declaration order. Validated (and unique across packs) by installPacks. */
export function recordAreas(): RecordArea[] {
  const list = packs();
  if (cache?.from === list) return cache.areas;
  const areas = list.flatMap((p) => (p.definition.recordAreas ?? []).map((a) => ({ ...RecordAreaSchema.parse(a), pack: p.id })));
  cache = { from: list, areas };
  return areas;
}
export const findArea = (name: string) => recordAreas().find((a) => a.name === name) ?? null;
export const areaOrThrow = (name: string) => {
  const a = typeof name === "string" ? findArea(name) : null;
  if (!a) throw new PackError(`no record area ${JSON.stringify(String(name).slice(0, 64))}`, 404);
  return a;
};

// ---------- values ----------

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_DATA_BYTES = 256 * 1024;
export const checkKey = (key: unknown): string => {
  if (typeof key !== "string" || !KEY.test(key)) throw new PackError("a record key is 1-200 letters, digits, . _ : or -, starting with a letter or digit", 400);
  return key;
};

/** A record's fields against its area: no unknown field, each value of its declared type. */
export function checkData(area: RecordArea, data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new PackError("data must be an object of the area's fields", 400);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const f = area.fields.find((x) => x.name === k);
    if (!f) throw new PackError(`area ${area.name} has no field ${JSON.stringify(k.slice(0, 64))}`, 400);
    if (v === null || v === undefined) { out[k] = null; continue; }
    const bad = () => new PackError(`field ${k} of area ${area.name} must be ${f.type === "link" ? "a record key or a list of keys" : `a ${f.type}`}`, 400);
    switch (f.type) {
      case "text": if (typeof v !== "string" || v.length > 20_000) throw bad(); break;
      case "number": if (typeof v !== "number" || !Number.isFinite(v)) throw bad(); break;
      case "boolean": if (typeof v !== "boolean") throw bad(); break;
      case "date": if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(); break;
      case "link": if (!(typeof v === "string" ? KEY.test(v) : Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === "string" && KEY.test(x)))) throw bad(); break;
      case "json": break;
    }
    out[k] = v;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_DATA_BYTES) throw new PackError(`a record's data is at most ${MAX_DATA_BYTES / 1024} KB`, 413);
  return out;
}

const title = (t: unknown): string | null => {
  if (t === undefined || t === null || t === "") return null;
  if (typeof t !== "string" || t.length > 500) throw new PackError("title must be text of up to 500 characters", 400);
  return t;
};

interface Row { key: string; title: string | null; data: unknown; version?: string | null; updated_at: Date | string }
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
async function toRecord(area: RecordArea, row: Row, orgId: number | null): Promise<RecordRow> {
  // Sealed values (an asset area's) open with the row's own workspace key only; a platform row is never sealed.
  const data = orgId !== null && area.role === "asset" ? await openJson(orgId, row.data) : (row.data as Record<string, unknown>) ?? {};
  const t = orgId !== null && isSealed(row.title) ? await open(orgId, row.title) : row.title;
  return { area: area.name, key: row.key, title: t ?? null, data, version: row.version ?? null, updated_at: iso(row.updated_at) };
}

const pageArgs = (opts: { limit?: unknown; after?: unknown } = {}) => {
  const n = opts.limit === undefined ? 50 : Number(opts.limit);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new PackError("limit is 1 to 200", 400);
  const after = opts.after === undefined || opts.after === "" ? "" : checkKey(opts.after);
  return { limit: n, after };
};

// ---------- reads and writes ----------

export async function listPlatform(area: RecordArea, opts?: { limit?: unknown; after?: unknown }): Promise<RecordPage> {
  const { limit, after } = pageArgs(opts);
  const rows = await (await getDb()).query<Row>(
    "SELECT key, title, data, version, updated_at FROM platform_records WHERE pack = $1 AND area = $2 AND key > $3 ORDER BY key LIMIT $4",
    [area.pack, area.name, after, limit + 1]);
  const page = await Promise.all(rows.slice(0, limit).map((r) => toRecord(area, r, null)));
  return { records: page, next: rows.length > limit ? page.at(-1)!.key : null };
}

async function listWorkspace(orgId: number, area: RecordArea, opts?: { limit?: unknown; after?: unknown }): Promise<RecordPage> {
  const { limit, after } = pageArgs(opts);
  return withTenant(orgId, async () => {
    const rows = await (await getDb()).query<Row>(
      "SELECT key, title, data, updated_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key > $4 ORDER BY key LIMIT $5",
      [orgId, area.pack, area.name, after, limit + 1]);
    const page = await Promise.all(rows.slice(0, limit).map((r) => toRecord(area, r, orgId)));
    return { records: page, next: rows.length > limit ? page.at(-1)!.key : null };
  });
}

export async function getPlatform(area: RecordArea, key: string): Promise<RecordRow | null> {
  const [r] = await (await getDb()).query<Row>("SELECT key, title, data, version, updated_at FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3",
    [area.pack, area.name, checkKey(key)]);
  return r ? toRecord(area, r, null) : null;
}

async function getWorkspace(orgId: number, area: RecordArea, key: string): Promise<RecordRow | null> {
  return withTenant(orgId, async () => {
    const [r] = await (await getDb()).query<Row>("SELECT key, title, data, updated_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4",
      [orgId, area.pack, area.name, checkKey(key)]);
    return r ? toRecord(area, r, orgId) : null;
  });
}

/** One workspace's view of an area: a platform area's shared rows, or the workspace's own rows of a workspace area. */
export const listFor = (orgId: number, name: string, opts?: { limit?: unknown; after?: unknown }) => {
  const a = areaOrThrow(name);
  return a.scope === "platform" ? listPlatform(a, opts) : listWorkspace(orgId, a, opts);
};
export const getFor = (orgId: number, name: string, key: string) => {
  const a = areaOrThrow(name);
  return a.scope === "platform" ? getPlatform(a, key) : getWorkspace(orgId, a, key);
};

/** A record and the records its link fields name (in the same workspace for a workspace area), as one workspace sees them. */
export async function detailFor(orgId: number, name: string, key: string) {
  const area = areaOrThrow(name);
  const record = await getFor(orgId, name, key);
  if (!record) return null;
  const links: { field: string; area: string; records: { key: string; title: string | null }[] }[] = [];
  for (const l of area.links ?? []) {
    const target = findArea(l.area);
    const v = record.data[l.field];
    const wanted = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string" && KEY.test(x)).slice(0, 50);
    if (!target || !wanted.length) continue;
    const found = (await Promise.all(wanted.map((k) => getFor(orgId, target.name, k)))).filter((r): r is RecordRow => !!r);
    links.push({ field: l.field, area: target.name, records: found.map((r) => ({ key: r.key, title: r.title })) });
  }
  return { area: areaSummary(area), record, links };
}

async function putWorkspace(orgId: number, pack: string, name: string, key: string, value: RecordInput): Promise<RecordRow> {
  const area = areaOrThrow(name);
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared by every workspace: read only here`, 403);
  if (area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  checkKey(key);
  const data = checkData(area, value?.data);
  let t = title(value?.title);
  let stored: Record<string, unknown> = data;
  if (area.role === "asset") {
    stored = await withTenant(orgId, () => sealJson(orgId, data));
    if (t) t = await withTenant(orgId, () => seal(orgId, t!));
  }
  return withTenant(orgId, async () => {
    const [r] = await (await getDb()).query<Row>(
      `INSERT INTO workspace_records (org_id, pack, area, key, title, data, sealed) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, pack, area, key) DO UPDATE SET title = excluded.title, data = excluded.data, sealed = excluded.sealed, updated_at = now()
       RETURNING key, title, data, updated_at`,
      [orgId, area.pack, area.name, key, t, JSON.stringify(stored), isSealed((stored as { _sealed?: unknown })._sealed)]);
    return toRecord(area, r!, orgId);
  });
}

async function deleteWorkspace(orgId: number, pack: string, name: string, key: string): Promise<boolean> {
  const area = areaOrThrow(name);
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared by every workspace: read only here`, 403);
  if (area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return withTenant(orgId, async () => (await (await getDb()).query(
    "DELETE FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 RETURNING id", [orgId, area.pack, area.name, checkKey(key)])).length > 0);
}

/** Platform staff (or a pack's admin route) writing a shared row. `pack` limits a pack to its own areas; null is the admin API. */
export async function putPlatform(pack: string | null, name: string, key: string, value: RecordInput): Promise<RecordRow> {
  const area = areaOrThrow(name);
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records: written by the workspace, not here`, 403);
  if (pack !== null && area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  checkKey(key);
  const data = checkData(area, value?.data);
  const version = value?.version === undefined || value.version === null ? null : String(value.version).slice(0, 120);
  return asPlatform(async () => {
    const [r] = await (await getDb()).query<Row>(
      `INSERT INTO platform_records (pack, area, key, title, data, version) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pack, area, key) DO UPDATE SET title = excluded.title, data = excluded.data, version = excluded.version, updated_at = now()
       RETURNING key, title, data, version, updated_at`,
      [area.pack, area.name, key, title(value?.title), JSON.stringify(data), version]);
    return toRecord(area, r!, null);
  });
}
export async function deletePlatform(pack: string | null, name: string, key: string): Promise<boolean> {
  const area = areaOrThrow(name);
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records`, 403);
  if (pack !== null && area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return asPlatform(async () => (await (await getDb()).query(
    "DELETE FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3 RETURNING id", [area.pack, area.name, checkKey(key)])).length > 0);
}

/** ctx.records for a pack's tool or workspace route: this workspace only; writes to the pack's own workspace areas. */
export const workspaceRecords = (pack: string, orgId: number): WorkspaceRecords => ({
  list: (area, opts) => listFor(orgId, area, opts),
  get: (area, key) => getFor(orgId, area, key),
  put: (area, key, value) => putWorkspace(orgId, pack, area, key, value),
  delete: (area, key) => deleteWorkspace(orgId, pack, area, key),
});
/** ctx.records for a pack's admin route: platform areas only; writes to the pack's own platform areas. */
export const platformRecords = (pack: string): PlatformRecords => {
  const platformArea = (name: string) => {
    const a = areaOrThrow(name);
    if (a.scope !== "platform") throw new PackError(`area ${a.name} holds each workspace's own records: not readable here`, 403);
    return a;
  };
  return {
    list: async (area, opts) => listPlatform(platformArea(area), opts),
    get: async (area, key) => getPlatform(platformArea(area), key),
    put: (area, key, value) => putPlatform(pack, area, key, value),
    delete: (area, key) => deletePlatform(pack, area, key),
  };
};

/** What the console and the MCP tools show of an area (never its pack's code). */
export const areaSummary = (a: RecordArea) => ({
  name: a.name, label: a.label, description: a.description ?? null, role: a.role, scope: a.scope, pack: a.pack,
  fields: a.fields, list_columns: a.list_columns ?? a.fields.slice(0, 4).map((f) => f.name), links: a.links ?? [],
});

// ---------- MCP: list_records and get_record ----------

/** The two shell tools, built for the declared areas; empty when no pack declares one (the MCP surface is unchanged). */
export function recordTools(): PackTool[] {
  const areas = recordAreas();
  if (!areas.length) return [];
  const names = areas.map((a) => a.name) as [string, ...string[]];
  const catalog = areas.map((a) => `${a.name} (${a.label}: ${a.role}, ${a.scope === "platform" ? "shared" : "this workspace's own"})`).join("; ");
  return [
    {
      name: "list_records",
      title: "List records",
      description: `List the records of one area, by key, a page at a time (pass next as after for the following page). Areas: ${catalog}.`,
      inputSchema: {
        area: z.enum(names).describe("The record area"),
        limit: z.number().int().min(1).max(200).optional().describe("Records per page (default 50)"),
        after: z.string().max(200).optional().describe("The next value of the previous page"),
      },
      annotations: { title: "List records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (ws: Workspace, args: { area: string; limit?: number; after?: string }) => {
        const area = areaOrThrow(args.area);
        const page = await listFor(ws.id, area.name, { limit: args.limit, after: args.after });
        const cols = areaSummary(area).list_columns;
        return {
          area: area.name, label: area.label, role: area.role, scope: area.scope,
          records: page.records.map((r) => ({ key: r.key, title: r.title, ...Object.fromEntries(cols.map((c) => [c, r.data[c] ?? null])) })),
          next: page.next,
        };
      },
    },
    {
      name: "get_record",
      title: "Get a record",
      description: `One record of an area by its key, with every field and the records its links name. Areas: ${catalog}.`,
      inputSchema: {
        area: z.enum(names).describe("The record area"),
        key: z.string().min(1).max(200).describe("The record's key"),
      },
      annotations: { title: "Get a record", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (ws: Workspace, args: { area: string; key: string }) => {
        const d = await detailFor(ws.id, args.area, args.key);
        if (!d) throw new PackError(`no record ${args.key} in ${args.area}`, 404);
        return { record: d.record, links: d.links };
      },
    },
  ] as unknown as PackTool[];
}

export function registerRecordTools(server: McpServer, run: (t: PackTool, args: Record<string, unknown>) => unknown) {
  for (const t of recordTools())
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema ?? {}, annotations: t.annotations },
      (args: Record<string, unknown>) => run(t, args) as never);
}
