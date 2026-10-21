/**
 * The generic data API (mold_v0-059; molds/mold_v0/MOLD.md "Pack and record-area contract"): for every declared record
 * area, with no pack code, list (filter, sort, paging), get, create, update, move, delete and batch, through the record
 * store's own functions (src/record-areas.ts: the same checks as ctx.records: the area's permissions for the caller's
 * role, typed fields, references, the lifecycle, sealing, read-only repositories), for two doors:
 *
 *   workspace   a person of one workspace (or the shell for them): every area as that workspace sees it, writes to its
 *               own workspace areas only. The workspace is always the caller's, never an argument.
 *   admin       platform staff: shared (platform) areas only, and the upstream catalogs' index.
 *
 * REST is src/data-routes.ts (/api/data, /api/admin/data). DATA_API_OPERATIONS is the list a later door wraps (the MCP
 * tools of mold_v0-060): each entry names its function, its door, the record action it needs and whether it writes.
 */
import type { AccountRole } from "./account-roles.js";
import { PackError, type RecordInput, type RecordOperation, type RecordQuery } from "./pack-api.js";
import { adminRecords, areaOrThrow, areaSummary, detailFor, getPlatform, listFor, listPlatform, recordAreas, workspaceRecords, type Actor } from "./record-areas.js";

/** Who a workspace call is for: the workspace (from the session or key, never from input), the person's role and id. */
export interface DataCaller { orgId: number; role: AccountRole | null; userId: string | null }
const actorOf = (c: DataCaller): Actor => ({ role: c.role, userId: c.userId });
const recordsFor = (c: DataCaller, area: string) => workspaceRecords(areaOrThrow(area).pack, c.orgId, actorOf(c));
const input = (v: unknown): RecordInput => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PackError("give {title?, data}", 400);
  const o = v as Record<string, unknown>;
  return { title: o.title as string | null | undefined, data: (o.data ?? {}) as Record<string, unknown> };
};
const platformArea = (name: string) => {
  const a = areaOrThrow(name);
  if (a.scope !== "platform") throw new PackError(`area ${a.name} holds each workspace's own records`, 404);
  return a;
};

/** The workspace door. */
export const dataApi = {
  /** The areas, as the console shows them (fields, lifecycle, permissions, repository, sealed). */
  areas: () => ({ areas: recordAreas().map(areaSummary) }),
  /** A page of an area: its own rows for a workspace area, the shared rows for a platform one. */
  list: async (c: DataCaller, area: string, query?: RecordQuery) => {
    const a = areaOrThrow(area);
    return { area: areaSummary(a), ...(await listFor(c.orgId, a.name, query, actorOf(c))) };
  },
  /** One record with the records its links name (as this workspace sees them); null when there is none. */
  get: (c: DataCaller, area: string, key: string) => detailFor(c.orgId, area, key, actorOf(c)),
  /** A new record (409 when the key exists). */
  create: async (c: DataCaller, area: string, key: string, value: unknown) => ({ record: await recordsFor(c, area).create(area, key, input(value)) }),
  /** Replace an existing record's title and fields (404 when there is none); its state is kept. */
  update: async (c: DataCaller, area: string, key: string, value: unknown) => ({ record: await recordsFor(c, area).update(area, key, input(value)) }),
  /** Move a record along its area's lifecycle. */
  move: async (c: DataCaller, area: string, key: string, to: unknown) => ({ record: await recordsFor(c, area).move(area, key, to as string) }),
  /** Delete a record; false when there was none. */
  delete: (c: DataCaller, area: string, key: string) => recordsFor(c, area).delete(area, key),
  /** Several writes to one pack's workspace areas as one transaction: every one of them, or none. */
  batch: async (c: DataCaller, ops: unknown) => {
    if (!Array.isArray(ops) || !ops.length) throw new PackError("operations: a list of 1 or more {op, area, key, ...}", 400);
    const packsOf = new Set(ops.map((o) => areaOrThrow(String((o as { area?: unknown })?.area)).pack));
    if (packsOf.size !== 1) throw new PackError("a batch writes the areas of one pack", 400);
    return { results: await workspaceRecords([...packsOf][0]!, c.orgId, actorOf(c)).batch(ops as RecordOperation[]) };
  },
};

/** The admin door: shared areas only (a workspace's rows are never listed across workspaces here). */
export const adminDataApi = {
  areas: () => ({ areas: recordAreas().filter((a) => a.scope === "platform").map(areaSummary) }),
  list: async (area: string, query?: RecordQuery) => {
    const a = platformArea(area);
    return { area: areaSummary(a), ...(await listPlatform(a, query)) };
  },
  get: async (area: string, key: string) => {
    const a = platformArea(area);
    const record = await getPlatform(a, key);
    return record ? { area: areaSummary(a), record, links: [] } : null;
  },
  create: async (area: string, key: string, value: unknown) => ({ record: await adminRecords.put(platformArea(area).name, key, input(value), "create") }),
  update: async (area: string, key: string, value: unknown) => ({ record: await adminRecords.put(platformArea(area).name, key, input(value), "update") }),
  delete: (area: string, key: string) => adminRecords.delete(platformArea(area).name, key),
  batch: async (ops: unknown) => {
    if (Array.isArray(ops)) for (const o of ops) platformArea(String((o as { area?: unknown })?.area));
    return { results: await adminRecords.batch(ops) };
  },
  /** Every repository of the build: its kind, the areas it feeds, who indexes it. */
  repositories: async () => ({ repositories: (await import("./data-repositories.js")).allRepositories() }),
  /** Index an upstream catalog at its pin into its shared areas (idempotent; `force` passes the prune guard). */
  sync: async (pack: string, name: string, opts: { force?: boolean } = {}) => ({ index: await (await import("./data-repositories.js")).syncUpstreamCatalog(pack, name, opts) }),
};

/** Index a workspace's files into its rows (after a commit: mold_v0-064's hook calls this). */
export const indexWorkspace = async (orgId: number, pack: string, files?: { path: string; body: Uint8Array | string }[]) =>
  (await import("./data-repositories.js")).indexWorkspaceFiles(orgId, pack, files);

/**
 * The data API's operations, for a door that wraps them (mold_v0-060's MCP tools): the function, its door, the record
 * action it needs (checked by the record store for the caller), and whether it writes.
 */
export const DATA_API_OPERATIONS = [
  { name: "areas", door: "workspace", action: "read", writes: false, description: "The record areas, their fields, lifecycles and permissions." },
  { name: "list", door: "workspace", action: "read", writes: false, description: "A page of an area's records: filter, sort, limit, after." },
  { name: "get", door: "workspace", action: "read", writes: false, description: "One record and the records its links name." },
  { name: "create", door: "workspace", action: "create", writes: true, description: "Add a record to one of the workspace's areas." },
  { name: "update", door: "workspace", action: "update", writes: true, description: "Replace a record's title and fields (its state is kept)." },
  { name: "move", door: "workspace", action: "move", writes: true, description: "Move a record along its area's lifecycle." },
  { name: "delete", door: "workspace", action: "delete", writes: true, description: "Delete a record." },
  { name: "batch", door: "workspace", action: "create", writes: true, description: "Several writes as one transaction: all or none." },
  { name: "areas", door: "admin", action: "read", writes: false, description: "The shared areas." },
  { name: "list", door: "admin", action: "read", writes: false, description: "A page of a shared area." },
  { name: "get", door: "admin", action: "read", writes: false, description: "One shared record." },
  { name: "create", door: "admin", action: "create", writes: true, description: "Add a shared record (staff, library)." },
  { name: "update", door: "admin", action: "update", writes: true, description: "Replace a shared record (staff, library)." },
  { name: "delete", door: "admin", action: "delete", writes: true, description: "Delete a shared record (staff, delete)." },
  { name: "batch", door: "admin", action: "create", writes: true, description: "Several shared writes as one transaction." },
  { name: "repositories", door: "admin", action: "read", writes: false, description: "The build's data repositories." },
  { name: "sync", door: "admin", action: "create", writes: true, description: "Index an upstream catalog at its pin." },
] as const;
