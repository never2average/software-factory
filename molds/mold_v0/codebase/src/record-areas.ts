/**
 * Record areas (mold_v0-047; molds/mold_v0/MOLD.md "Pack and record-area contract"): what a pack declares in
 * definePack({ recordAreas }) becomes, with no pack code, a list page and a detail page in the console, and the MCP
 * tools list_records and get_record. The rows live in two shell tables (sql/migrations/0004_record_areas.sql):
 *
 *   platform_records   areas with scope "platform": shared by every workspace (a source of requirements, a library of
 *                      checks). The tenant role may only SELECT them: read-only to customers by the database's own
 *                      grants. Written by platform staff (/api/admin/records, need("library")) or a pack's admin route.
 *   workspace_records  areas with scope "workspace": one workspace's own rows (org_id), under row-level security
 *                      (tenant_isolation). Written by the pack's own code for the calling workspace (ctx.records.put)
 *                      and the data API (mold_v0-059). A sealed area's (an asset area's, or one declared `sealed`,
 *                      mold_v0-066) title and data are sealed with the workspace's data key (src/orgcrypto.ts).
 *
 * mold_v0-066: `batch` applies several writes as one transaction (every query of the batch, the reference checks
 * included, runs on that transaction: txScope below), so an index is all-or-nothing; record keys may hold ( and ).
 * mold_v0-059: lists take filters and a sort (src/record-query.ts); an area's rows may come from a repository
 * (src/data-repositories.ts): an area fed by the workspace's files or read live from an API is read only through every
 * door, and only the repository's own writer (writeFromRepository) changes its rows, marking each with its source and
 * a fingerprint so a re-index writes nothing that has not changed and prunes only what it wrote.
 *
 * Every workspace read and write runs inside withTenant for that workspace and names its org_id as well, so the
 * database refuses another workspace's rows even when a query forgets its filter. The HTTP routes are in
 * src/record-routes.ts (this module stays free of the server's modules: src/packs.ts imports it).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, type Queryable } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { ensureOrgKey, isSealed, open, openJson, seal, sealJson } from "./orgcrypto.js";
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLES, canAccount, type AccountRole } from "./account-roles.js";
import { areaLinks, DECLARABLE_ROLES, optionValues, PackError, READ_ONLY_KINDS, RECORD_KEY, RecordAreaSchema, RecordFieldSchema, RepositorySchema, WRITE_ROLES, z, type PackTool, type PlatformRecords, type RecordAction, type RecordInput, type RecordOperation, type RecordOperationResult, type RecordPage, type RecordQuery, type RecordRow, type Repository, type Workspace, type WorkspaceRecords } from "./pack-api.js";
import { packs } from "./packs.js";
import { pageInMemory, parseQuery, readsContent, sqlParts, cursorOf, type Parsed, type QField } from "./record-query.js";
import { asPlatform, currentTenant, withTenant } from "./tenant-scope.js";

/** An area as installed: its declaration, its pack, and the repository its rows come from (null: the shell's tables). */
export type RecordArea = z.output<typeof RecordAreaSchema> & { pack: string; repo: { name: string; kind: Repository["kind"]; settings: Repository } | null };

/** The MCP tools the shell adds when at least one area is declared (a pack may not take these names). */
export const RECORD_TOOL_NAMES = ["list_records", "get_record"] as const;

let cache: { from: unknown; areas: RecordArea[] } | null = null;
/** Every declared area, in pack order then declaration order. Validated (and unique across packs) by installPacks. */
export function recordAreas(): RecordArea[] {
  const list = packs();
  if (cache?.from === list) return cache.areas;
  const areas = list.flatMap((p) => (p.definition.recordAreas ?? []).map((a) => {
    const parsed = RecordAreaSchema.parse(a);
    const raw = parsed.repository ? p.definition.repositories?.[parsed.repository] : undefined;
    const settings = raw ? RepositorySchema.parse(raw) : null;
    return { ...parsed, pack: p.id, repo: settings ? { name: parsed.repository!, kind: settings.kind, settings } : null };
  }));
  cache = { from: list, areas };
  return areas;
}
export const findArea = (name: string) => recordAreas().find((a) => a.name === name) ?? null;
export const areaOrThrow = (name: string) => {
  const a = typeof name === "string" ? findArea(name) : null;
  if (!a) throw new PackError(`no record area ${JSON.stringify(String(name).slice(0, 64))}`, 404);
  return a;
};

// ---------- who may (mold_v0-057) ----------

/**
 * The person a read or write is made for: their account role and sign-in id. A null role is an account API key or the
 * shell itself, which have no role limits (src/pack-api.ts Workspace.role), as for every shell tool.
 */
export interface Actor { role: AccountRole | null; userId: string | null }
export const SYSTEM_ACTOR: Actor = { role: null, userId: null };

const DEFAULT_ROLES: Record<"read" | "create" | "update" | "move", readonly AccountRole[]> = {
  read: DECLARABLE_ROLES, create: WRITE_ROLES, update: WRITE_ROLES, move: WRITE_ROLES,
};
/**
 * The roles that may do `action` on an area's records: its declaration (create/update/move default to the roles that may
 * change anything, delete to update's), never wider than the platform's own (a read needs "read", a write "edit").
 */
export function allowedRoles(area: RecordArea, action: RecordAction): AccountRole[] {
  const p = area.permissions ?? {};
  // Delete defaults to update's roles; on an area with a lifecycle, to the owner (deleting and re-adding a record would
  // otherwise put it back in its initial state past the transitions' roles).
  const declared = p[action] ?? (action === "delete" ? (area.lifecycle ? ["owner" as const] : p.update ?? DEFAULT_ROLES.update) : DEFAULT_ROLES[action]);
  return ACCOUNT_ROLES.filter((r) => declared.includes(r) && canAccount(r, action === "read" ? "read" : "edit"));
}
export const may = (area: RecordArea, action: RecordAction, actor: Actor) => actor.role === null || allowedRoles(area, action).includes(actor.role);
const VERB: Record<RecordAction, string> = { read: "read", create: "add", update: "change", move: "move", delete: "delete" };
function assertMay(area: RecordArea, action: RecordAction, actor: Actor) {
  if (may(area, action, actor)) return;
  const who = allowedRoles(area, action).map((r) => ACCOUNT_ROLE_LABELS[r].toLowerCase());
  throw new PackError(`You can't ${VERB[action]} ${area.label} records with the ${ACCOUNT_ROLE_LABELS[actor.role!]} role${who.length ? ` (${who.join(", ")} can)` : ""}.`, 403);
}

/** A sealed area (mold_v0-066): an asset area, or one declared `sealed`. Its title and data are ciphertext at rest. */
export const isSealedArea = (a: Pick<RecordArea, "role" | "sealed">) => a.role === "asset" || a.sealed === true;
/** An area whose rows come from the workspace's files or an API: no door writes it, only its repository's writer. */
export const isReadOnlyArea = (a: Pick<RecordArea, "repo">) => !!a.repo && (READ_ONLY_KINDS as readonly string[]).includes(a.repo.kind);
const readOnly = (a: RecordArea) =>
  new PackError(`${a.label} records come from ${a.repo!.kind === "http_api" ? "an external API" : "the workspace's files"} (repository ${a.repo!.name}): read only here`, 409);
/** An area read live from an API (src/data-repositories.ts): its rows are not in the shell's tables. */
const isLive = (a: RecordArea) => a.repo?.kind === "http_api";
const live = () => import("./data-repositories.js");

// ---------- the batch's transaction (mold_v0-066) ----------

/**
 * Inside a batch every query of the record store runs on the batch's one transaction, opened for one workspace (or the
 * platform). A query that has left that scope (a callback that lost it, a write to another workspace) is refused, never
 * run outside the transaction.
 */
const txScope = new AsyncLocalStorage<{ tx: Queryable; orgId: number | null }>();
async function q(): Promise<Queryable> {
  const t = txScope.getStore();
  if (!t) return getDb();
  if (currentTenant() !== t.orgId) throw new Error("a record query left its batch's scope: refused");
  return t.tx;
}

// ---------- values ----------

const KEY = RECORD_KEY;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,199}$/;
const FILE_PATH = /^(?!\/)(?!.*\/\/)[A-Za-z0-9._ /-]{1,500}$/;
const MAX_DATA_BYTES = 256 * 1024;
const MAX_LIST = 100;
export const checkKey = (key: unknown): string => {
  if (typeof key !== "string" || !KEY.test(key)) throw new PackError("a record key is 1-200 letters, digits, . _ : ( ) or -, starting with a letter or digit", 400);
  return key;
};

type Field = RecordArea["fields"][number];
const isFile = (v: unknown) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["path", "name", "sha256", "size"].includes(k))) return false;
  return typeof o.path === "string" && FILE_PATH.test(o.path) && !o.path.split("/").some((s) => s === "." || s === "..")
    && (o.name === undefined || (typeof o.name === "string" && o.name.length <= 200 && !/[\u0000-\u001f]/.test(o.name)))
    && (o.sha256 === undefined || (typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256)))
    && (o.size === undefined || (Number.isSafeInteger(o.size) && (o.size as number) >= 0));
};
/** What a field takes, in words (the refusal's sentence). */
const expects = (f: Field) => {
  const many = f.multiple ? "a list of " : "";
  switch (f.type) {
    case "link": return "a record key or a list of keys";
    case "enum": return `${many}one of ${optionValues(f).map((o) => JSON.stringify(o)).join(", ")}`;
    case "person": return `${many}a person's id`;
    case "reference": return `${many}the key of a ${f.to} record`;
    case "file": return `${many}a file reference {path, name?, sha256?, size?} with a path inside the workspace's files`;
    case "number": return `a number${f.min !== undefined ? ` from ${f.min}` : ""}${f.max !== undefined ? ` up to ${f.max}` : ""}`;
    case "text": return `text of up to ${f.max_length ?? 20_000} characters`;
    default: return `a ${f.type}`;
  }
};
/** One element of a list field (enum, person, reference, file) against its type. */
function fitsOne(f: Field, x: unknown): boolean {
  switch (f.type) {
    case "enum": return typeof x === "string" && optionValues(f).includes(x);
    case "person": return typeof x === "string" && PERSON.test(x);
    case "reference": return typeof x === "string" && KEY.test(x);
    case "file": return isFile(x);
    default: return false;
  }
}
/** One value against its field's type (references are only shaped here: whether the record exists is checked on write). */
function fits(f: Field, v: unknown): boolean {
  const one = (x: unknown) => fitsOne(f, x);
  switch (f.type) {
    case "text": return typeof v === "string" && v.length <= (f.max_length ?? 20_000);
    case "number": return typeof v === "number" && Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    case "boolean": return typeof v === "boolean";
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v));
    case "link": return typeof v === "string" ? KEY.test(v) : Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === "string" && KEY.test(x));
    case "json": return true;
    default: return f.multiple ? Array.isArray(v) && v.length <= MAX_LIST && v.every(one) && new Set(v.map((x) => JSON.stringify(x))).size === v.length : one(v);
  }
}
/** Text Postgres can store: no NUL, no unpaired surrogate (else the database refuses it with a 500). */
const storable = (x: string) => !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
const storableDeep = (v: unknown, depth = 0): boolean =>
  depth > 50 ? false : typeof v === "string" ? storable(v) : Array.isArray(v) ? v.every((x) => storableDeep(x, depth + 1))
    : v && typeof v === "object" ? Object.entries(v).every(([k, x]) => storable(k) && storableDeep(x, depth + 1)) : true;
const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** A record's fields against its area: no unknown field, each value of its declared type. Every problem in one refusal. */
export function checkData(area: { name: string; fields: readonly Field[] }, data: unknown, what = `area ${area.name}`): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new PackError("data must be an object of the area's fields", 400);
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const f = area.fields.find((x) => x.name === k);
    if (!f) { problems.push(`${what} has no field ${JSON.stringify(k.slice(0, 64))}`); continue; }
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (!fits(f, v)) { problems.push(`field ${k} of ${what} must be ${expects(f)}`); continue; }
    if (!storableDeep(v)) { problems.push(`field ${k} of ${what} holds a character that cannot be stored (NUL or a broken surrogate pair)`); continue; }
    out[k] = v;
  }
  if (problems.length) throw new PackError(problems.join("; "), 400);
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_DATA_BYTES) throw new PackError(`a record's data is at most ${MAX_DATA_BYTES / 1024} KB`, 413);
  return out;
}

/** The keys of `keys` that exist in `target` as `orgId` sees it (null: a shared area, read as every workspace does). */
async function existing(target: RecordArea, keys: string[], orgId: number | null): Promise<Set<string>> {
  if (!keys.length) return new Set();
  if (target.scope === "platform") {
    const rows = await (await q()).query<{ key: string }>("SELECT key FROM platform_records WHERE pack = $1 AND area = $2 AND key = ANY ($3::text[])", [target.pack, target.name, keys]);
    return new Set(rows.map((r) => r.key));
  }
  if (orgId === null) return new Set(); // a shared row never refers to one workspace's records (refused at build too)
  return withTenant(orgId, async () => new Set((await (await q()).query<{ key: string }>(
    "SELECT key FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = ANY ($4::text[])", [orgId, target.pack, target.name, keys])).map((r) => r.key)));
}

/**
 * A whole record's fields, for a write (mold_v0-057): types (checkData), required fields, and every reference naming a
 * record that exists as the writer sees it (a workspace write sees its own rows and the shared ones, never another
 * workspace's; a shared write sees shared rows only), in an area the writer may read.
 */
export async function checkRecord(area: { name: string; fields: readonly Field[] }, data: unknown, orgId: number | null, actor: Actor, what = `area ${area.name}`, skip: string[] = []): Promise<Record<string, unknown>> {
  const out = checkData(area, data, what);
  const problems: string[] = [];
  for (const f of area.fields) {
    if (skip.includes(f.name)) continue;
    if (f.required && empty(out[f.name])) problems.push(`field ${f.name} of ${what} is required`);
    if (f.type !== "reference" || empty(out[f.name])) continue;
    const target = findArea(f.to!);
    const keys = (Array.isArray(out[f.name]) ? out[f.name] : [out[f.name]]) as string[];
    if (!target || !may(target, "read", actor)) { problems.push(`field ${f.name} of ${what}: no ${f.to} record ${keys[0]}`); continue; }
    const found = await existing(target, keys, target.scope === "platform" ? null : orgId);
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length) problems.push(`field ${f.name} of ${what}: no ${target.name} record ${missing.slice(0, 5).join(", ")}${orgId !== null && target.scope === "workspace" ? " in this workspace" : ""}`);
  }
  if (problems.length) throw new PackError(problems.join("; "), 400);
  return out;
}

/** A run's arguments against its kind's declared `args` (mold_v0-057): the same checks as a record's fields. */
export const checkArgs = (kind: string, args: readonly z.input<typeof RecordFieldSchema>[], scope: unknown, orgId: number | null, actor: Actor = SYSTEM_ACTOR) =>
  checkRecord({ name: kind, fields: args.map((a) => RecordFieldSchema.parse(a)) }, scope, orgId, actor, `job kind ${kind}'s arguments`);

/**
 * A stored row against its area's current declaration (mold_v0-057). The declaration may have changed since the row
 * was written: a field no longer declared is left out of what is shown, a value that no longer fits is shown as stored
 * and named in `drift` with the rest; the next write must fit the declaration again.
 */
export function conform(area: RecordArea, data: Record<string, unknown>): { data: Record<string, unknown>; drift: string[] } {
  const out: Record<string, unknown> = {}, drift: string[] = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    const f = area.fields.find((x) => x.name === k);
    if (!f) { drift.push(k); continue; }
    if (v !== null && v !== undefined && !fits(f, v)) drift.push(k);
    out[k] = v;
  }
  return { data: out, drift: drift.sort() };
}

const title = (t: unknown): string | null => {
  if (t === undefined || t === null || t === "") return null;
  if (typeof t !== "string" || t.length > 500 || !storable(t)) throw new PackError("title must be text of up to 500 characters (no NUL or broken surrogate pair)", 400);
  return t;
};

interface Row { key: string; title: string | null; data: unknown; version?: string | null; updated_at: Date | string }
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
async function toRecord(area: RecordArea, row: Row, orgId: number | null): Promise<RecordRow> {
  // Sealed values open with the row's own workspace key only (a row sealed before its area stopped being sealed opens
  // too); a platform row is never sealed.
  const raw = orgId !== null ? await openJson(orgId, row.data) : (row.data as Record<string, unknown>) ?? {};
  const { data, drift } = conform(area, raw);
  const t = orgId !== null && isSealed(row.title) ? await open(orgId, row.title) : row.title;
  return { area: area.name, key: row.key, title: t ?? null, data, version: row.version ?? null, updated_at: iso(row.updated_at), ...(drift.length ? { drift } : {}) };
}

/** A query (mold_v0-059) against an area's fields: limit, sort, filter, cursor (src/record-query.ts). */
export const queryOf = (area: RecordArea, opts?: RecordQuery | { limit?: unknown; after?: unknown }): Parsed =>
  parseQuery(area.fields as QField[], opts as RecordQuery, fits as (f: QField, v: unknown) => boolean, fitsOne as (f: QField, v: unknown) => boolean);

/** At most this many rows of one workspace's sealed area are opened to filter or sort them in memory. */
export const MEMORY_SCAN_LIMIT = 5000;

// ---------- reads and writes ----------

/**
 * A page of an area's rows in the shell's tables: the area's and (for a workspace area) the workspace's own scope first,
 * then the query's conditions and order (src/record-query.ts), so a filter, sort or cursor only narrows the caller's
 * rows. A sealed area's titles and data are ciphertext in the database: a query that reads them runs on the opened rows.
 */
async function listTable(area: RecordArea, orgId: number | null, p: Parsed): Promise<RecordPage> {
  if (orgId !== null && isSealedArea(area) && readsContent(p)) {
    const all = await scanWorkspace(orgId, area, p.conds.filter((c) => c.target === "key"));
    return pageInMemory(p, all);
  }
  const run = async () => {
    const params: unknown[] = orgId === null ? [area.pack, area.name] : [orgId, area.pack, area.name];
    const base = orgId === null ? ["pack = $1", "area = $2"] : ["org_id = $1", "pack = $2", "area = $3"];
    const parts = sqlParts(p, params);
    params.push(p.limit + 1);
    const table = orgId === null ? "platform_records" : "workspace_records";
    const rows = await (await q()).query<Row & { _sv: string | null }>(
      `SELECT key, title, data, ${orgId === null ? "version" : "NULL::text AS version"}, updated_at, ${parts.sortValue} AS _sv FROM ${table}
        WHERE ${[...base, ...parts.where].join(" AND ")} ORDER BY ${parts.order} LIMIT $${params.length}`, params);
    const page = await Promise.all(rows.slice(0, p.limit).map((r) => toRecord(area, r, orgId)));
    const last = rows[p.limit - 1];
    return { records: page, next: rows.length > p.limit && last ? cursorOf(p.sort, last._sv, last.key) : null };
  };
  return orgId === null ? run() : withTenant(orgId, run);
}

/** Every row of one workspace's area, opened (a sealed area's filter and sort): at most MEMORY_SCAN_LIMIT. */
async function scanWorkspace(orgId: number, area: RecordArea, keyConds: Parsed["conds"]): Promise<RecordRow[]> {
  return withTenant(orgId, async () => {
    const params: unknown[] = [orgId, area.pack, area.name];
    const parts = sqlParts({ limit: 1, conds: keyConds, sort: { target: "key", name: "key", desc: false, text: "key" }, after: null }, params);
    params.push(MEMORY_SCAN_LIMIT + 1);
    const rows = await (await q()).query<Row>(
      `SELECT key, title, data, updated_at FROM workspace_records WHERE ${["org_id = $1", "pack = $2", "area = $3", ...parts.where].join(" AND ")} ORDER BY key LIMIT $${params.length}`, params);
    if (rows.length > MEMORY_SCAN_LIMIT)
      throw new PackError(`${area.label} is sealed: a filter or sort opens every record, and it has more than ${MEMORY_SCAN_LIMIT}. Filter by key first.`, 413);
    return Promise.all(rows.map((r) => toRecord(area, r, orgId)));
  });
}

/** One page of a platform area (any caller: shared rows are every workspace's). */
export async function listPlatform(area: RecordArea, opts?: RecordQuery | { limit?: unknown; after?: unknown }): Promise<RecordPage> {
  const p = queryOf(area, opts);
  if (isLive(area)) return (await live()).listLive(area, null, p);
  return listTable(area, null, p);
}

async function listWorkspace(orgId: number, area: RecordArea, opts?: RecordQuery | { limit?: unknown; after?: unknown }): Promise<RecordPage> {
  const p = queryOf(area, opts);
  if (isLive(area)) return (await live()).listLive(area, orgId, p);
  return listTable(area, orgId, p);
}

export async function getPlatform(area: RecordArea, key: string): Promise<RecordRow | null> {
  checkKey(key);
  if (isLive(area)) return (await live()).getLive(area, null, key);
  const [r] = await (await q()).query<Row>("SELECT key, title, data, version, updated_at FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3",
    [area.pack, area.name, key]);
  return r ? toRecord(area, r, null) : null;
}

/** A workspace row as stored (its raw data, for a compare-and-set) and as read. */
async function readWorkspace(orgId: number, area: RecordArea, key: string): Promise<{ rev: string; record: RecordRow; opened: Record<string, unknown> } | null> {
  return withTenant(orgId, async () => {
    // xmin: the row version, for the compare-and-set of a write or move (exact, whatever the stored values are).
    const [r] = await (await q()).query<Row & { rev: string }>("SELECT key, title, data, updated_at, xmin::text AS rev FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4",
      [orgId, area.pack, area.name, checkKey(key)]);
    if (!r) return null;
    const opened = await openJson(orgId, r.data);
    return { rev: r.rev, record: await toRecord(area, r, orgId), opened };
  });
}
async function getWorkspace(orgId: number, area: RecordArea, key: string): Promise<RecordRow | null> {
  if (isLive(area)) return (await live()).getLive(area, orgId, checkKey(key));
  return (await readWorkspace(orgId, area, key))?.record ?? null;
}

/**
 * One workspace's view of an area: a platform area's shared rows, or the workspace's own rows of a workspace area. With
 * an actor (the person asking), the area's read permission is checked first (mold_v0-057).
 */
export const listFor = (orgId: number, name: string, opts?: RecordQuery | { limit?: unknown; after?: unknown }, actor: Actor = SYSTEM_ACTOR) => {
  const a = areaOrThrow(name);
  assertMay(a, "read", actor);
  return a.scope === "platform" ? listPlatform(a, opts) : listWorkspace(orgId, a, opts);
};
export const getFor = (orgId: number, name: string, key: string, actor: Actor = SYSTEM_ACTOR) => {
  const a = areaOrThrow(name);
  assertMay(a, "read", actor);
  return a.scope === "platform" ? getPlatform(a, key) : getWorkspace(orgId, a, key);
};

/**
 * A record and the records its links and references name (in the same workspace for a workspace area), as one
 * workspace sees them; a linked area the actor may not read is left out.
 */
export async function detailFor(orgId: number, name: string, key: string, actor: Actor = SYSTEM_ACTOR) {
  const area = areaOrThrow(name);
  const record = await getFor(orgId, name, key, actor);
  if (!record) return null;
  const links: { field: string; area: string; records: { key: string; title: string | null }[] }[] = [];
  for (const l of areaLinks(area)) {
    const target = findArea(l.area);
    const v = record.data[l.field];
    const wanted = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string" && KEY.test(x)).slice(0, 50);
    if (!target || !wanted.length || !may(target, "read", actor)) continue;
    // A shared area never resolves into one workspace's rows, whatever its stored values say.
    if (area.scope === "platform" && target.scope === "workspace") continue;
    const found = (await Promise.all(wanted.map((k) => getFor(orgId, target.name, k, actor)))).filter((r): r is RecordRow => !!r);
    links.push({ field: l.field, area: target.name, records: found.map((r) => ({ key: r.key, title: r.title })) });
  }
  return { area: areaSummary(area), record, links };
}

const ownWorkspaceArea = (pack: string, name: string) => {
  const area = areaOrThrow(name);
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared by every workspace: read only here`, 403);
  if (area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return area;
};
/** A record's state; a row with none (written before its area had a lifecycle) is in the initial state. */
const stateOf = (area: RecordArea, data: Record<string, unknown>) => (area.lifecycle ? data[area.lifecycle.field] ?? area.lifecycle.initial : undefined);

/**
 * Who wrote a row (mold_v0-059): null for every door (ctx.records, the data API, staff), or a repository's writer with
 * the row's fingerprint. A write through a door clears both, so the next index writes the row again.
 */
export interface WriteMeta { source: string; fingerprint: string }

/** Sealed values are never stored in the clear: a sealed area's write is refused while the key vault is locked. */
const assertCanSeal = (area: RecordArea) => {
  if (isSealedArea(area) && !vaultUnlocked()) throw new PackError(`${area.label} records are sealed and the key vault is locked: nothing is stored unsealed`, 503);
};

async function writeRow(orgId: number, area: RecordArea, key: string, t: string | null, data: Record<string, unknown>, prev: { rev: string } | null, meta: WriteMeta | null = null): Promise<RecordRow> {
  let stored: Record<string, unknown> = data;
  if (isSealedArea(area)) {
    assertCanSeal(area);
    stored = await withTenant(orgId, () => sealJson(orgId, data));
    if (t) t = await withTenant(orgId, () => seal(orgId, t!));
  }
  const sealed = isSealed((stored as { _sealed?: unknown })._sealed);
  return withTenant(orgId, async () => {
    const db = await q();
    const [r] = prev === null
      ? await db.query<Row>(
        `INSERT INTO workspace_records (org_id, pack, area, key, title, data, sealed, source, fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (org_id, pack, area, key) DO NOTHING RETURNING key, title, data, updated_at`,
        [orgId, area.pack, area.name, key, t, JSON.stringify(stored), sealed, meta?.source ?? null, meta?.fingerprint ?? null])
      // An area with a lifecycle changes a row only from what was read (its state may have moved meanwhile).
      : await db.query<Row>(
        `UPDATE workspace_records SET title = $5, data = $6, sealed = $7, source = $9, fingerprint = $10, updated_at = now()
          WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND ($8::text IS NULL OR xmin::text = $8) RETURNING key, title, data, updated_at`,
        [orgId, area.pack, area.name, key, t, JSON.stringify(stored), sealed, area.lifecycle ? prev.rev : null, meta?.source ?? null, meta?.fingerprint ?? null]);
    if (!r) throw new PackError(prev === null ? `${area.label} record ${key} already exists` : `${area.label} record ${key} was changed by someone else meanwhile: read it again and retry`, 409);
    return toRecord(area, r, orgId);
  });
}

/** put: create or replace; create: only a new key (409 when it exists); update: only an existing key (404). */
export type PutMode = "put" | "create" | "update";

async function putWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, value: RecordInput, mode: PutMode = "put", meta: WriteMeta | null = null): Promise<RecordRow> {
  const area = ownWorkspaceArea(pack, name);
  if (!meta && isReadOnlyArea(area)) throw readOnly(area);
  checkKey(key);
  assertCanSeal(area);
  // A writer must also be a reader: a write's answer (and its refusals) show the stored record.
  assertMay(area, "read", actor);
  const prev = await readWorkspace(orgId, area, key);
  if (prev && mode === "create") throw new PackError(`${area.label} record ${key} already exists`, 409);
  if (!prev && mode === "update") throw new PackError(`no ${area.name} record ${key}`, 404);
  assertMay(area, prev ? "update" : "create", actor);
  const given = value?.data;
  const t = title(value?.title);
  if (!area.lifecycle) return writeRow(orgId, area, key, t, await checkRecord(area, given, orgId, actor), prev, meta);
  // A lifecycle (mold_v0-057): a new record starts in its initial state; a write never changes the state.
  const field = area.lifecycle.field;
  const asked = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>)[field] : undefined;
  const state = prev ? stateOf(area, prev.opened) : area.lifecycle.initial;
  if (asked !== undefined && asked !== null && asked !== state)
    throw new PackError(prev
      ? `${area.label} record ${key} is ${JSON.stringify(state)}: its ${field} changes only by a move (records.move)`
      : `a new ${area.label} record starts as ${JSON.stringify(state)}; it moves from there (records.move)`, 409);
  const rest = { ...(given as Record<string, unknown> ?? {}) };
  delete rest[field];
  const data = await checkRecord(area, rest, orgId, actor, undefined, [field]);
  return writeRow(orgId, area, key, t, { ...data, [field]: state }, prev);
}

/** The moves a record in `from` may make, in words (a refusal's second sentence). */
const movesFrom = (area: RecordArea, from: unknown) => area.lifecycle!.transitions
  .filter((t) => t.from === "*" || (typeof from === "string" && t.from.includes(from)))
  .map((t) => `${JSON.stringify(t.to)}${t.label ? ` (${t.label})` : ""}${t.roles ? ` [${t.roles.join(", ")}]` : ""}`);

async function moveWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, to: unknown): Promise<RecordRow> {
  const area = ownWorkspaceArea(pack, name);
  if (isReadOnlyArea(area)) throw readOnly(area);
  if (!area.lifecycle) throw new PackError(`area ${area.name} has no lifecycle: its records do not move`, 400);
  assertMay(area, "read", actor);
  assertMay(area, "move", actor);
  checkKey(key);
  const prev = await readWorkspace(orgId, area, key);
  if (!prev) throw new PackError(`no ${area.name} record ${key}`, 404);
  const field = area.lifecycle.field, from = stateOf(area, prev.opened);
  if (typeof to !== "string") throw new PackError("to must be a state", 400);
  if (to === from) return prev.record;
  const ways = area.lifecycle.transitions.filter((t) => (t.from === "*" || (typeof from === "string" && t.from.includes(from))) && t.to === to);
  if (!ways.length) {
    const can = movesFrom(area, from);
    throw new PackError(`${area.label} record ${key} cannot move from ${JSON.stringify(from)} to ${JSON.stringify(to)}. ${can.length ? `From ${JSON.stringify(from)} it can move to: ${can.join(", ")}.` : `Nothing moves it from ${JSON.stringify(from)}.`}`, 409);
  }
  if (actor.role !== null && !ways.some((t) => !t.roles || t.roles.includes(actor.role!)))
    throw new PackError(`The move of ${area.label} record ${key} to ${JSON.stringify(to)} is for ${[...new Set(ways.flatMap((t) => t.roles ?? []))].join(", ")}, not the ${ACCOUNT_ROLE_LABELS[actor.role]} role.`, 403);
  return writeRow(orgId, area, key, prev.record.title, { ...prev.opened, [field]: to }, prev);
}

async function deleteWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, source: string | null = null): Promise<boolean> {
  const area = ownWorkspaceArea(pack, name);
  if (source === null && isReadOnlyArea(area)) throw readOnly(area);
  assertMay(area, "read", actor);
  assertMay(area, "delete", actor);
  // A repository's writer deletes only rows it wrote itself (its prune).
  return withTenant(orgId, async () => (await (await q()).query(
    "DELETE FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND ($5::text IS NULL OR source = $5) RETURNING id",
    [orgId, area.pack, area.name, checkKey(key), source])).length > 0);
}

const platformAreaFor = (pack: string | null, name: string) => {
  const area = areaOrThrow(name);
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records: written by the workspace, not here`, 403);
  if (pack !== null && area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return area;
};

/**
 * Platform staff (or a pack's admin route) writing a shared row. `pack` limits a pack to its own areas; null is the admin
 * API. A row written here is a hand row (no source): a repository's re-index never prunes it.
 */
export async function putPlatform(pack: string | null, name: string, key: string, value: RecordInput, mode: PutMode = "put", meta: WriteMeta | null = null): Promise<RecordRow> {
  const area = platformAreaFor(pack, name);
  if (!meta && isReadOnlyArea(area)) throw readOnly(area);
  checkKey(key);
  const data = await checkRecord(area, value?.data, null, SYSTEM_ACTOR);
  const version = value?.version === undefined || value.version === null ? null : String(value.version).slice(0, 120);
  const t = title(value?.title);
  return asPlatform(async () => {
    const db = await q();
    const params = [area.pack, area.name, key, t, JSON.stringify(data), version, meta?.source ?? null, meta?.fingerprint ?? null];
    const [r] = mode === "update"
      ? await db.query<Row>(`UPDATE platform_records SET title = $4, data = $5, version = $6, source = $7, fingerprint = $8, updated_at = now()
          WHERE pack = $1 AND area = $2 AND key = $3 RETURNING key, title, data, version, updated_at`, params)
      : await db.query<Row>(
        `INSERT INTO platform_records (pack, area, key, title, data, version, source, fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (pack, area, key) DO ${mode === "create" ? "NOTHING" : "UPDATE SET title = excluded.title, data = excluded.data, version = excluded.version, source = excluded.source, fingerprint = excluded.fingerprint, updated_at = now()"}
         RETURNING key, title, data, version, updated_at`, params);
    if (!r) throw mode === "create" ? new PackError(`${area.label} record ${key} already exists`, 409) : new PackError(`no ${area.name} record ${key}`, 404);
    return toRecord(area, r, null);
  });
}
export async function deletePlatform(pack: string | null, name: string, key: string, source: string | null = null): Promise<boolean> {
  const area = platformAreaFor(pack, name);
  if (source === null && isReadOnlyArea(area)) throw readOnly(area);
  return asPlatform(async () => (await (await q()).query(
    "DELETE FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3 AND ($4::text IS NULL OR source = $4) RETURNING id", [area.pack, area.name, checkKey(key), source])).length > 0);
}

// ---------- batches (mold_v0-066) ----------

/** The most operations one batch of a door (ctx.records, the data API) may carry; a repository's index may carry more. */
export const MAX_BATCH = 1000;
const MAX_INDEX_BATCH = 100_000;

/** An operation's own refusal, numbered: which one of the batch failed (nothing of the batch was written). */
const numbered = (i: number, op: { op?: unknown; area?: unknown; key?: unknown }, e: unknown) => {
  const what = `operation ${i + 1} (${String(op?.op)} ${String(op?.area).slice(0, 64)} ${String(op?.key).slice(0, 200)})`;
  if (e instanceof PackError) return new PackError(`${what}: ${e.message}. Nothing of the batch was written.`, e.status);
  // Anything else (a database error) is the caller's 500, as for a single write; the batch is still all-or-nothing.
  return e;
};
const checkOps = (ops: unknown, max: number): RecordOperation[] => {
  if (!Array.isArray(ops) || !ops.length) throw new PackError("a batch is a list of 1 or more operations", 400);
  if (ops.length > max) throw new PackError(`a batch holds at most ${max} operations`, 413);
  for (const [i, o] of ops.entries()) {
    const x = o as Record<string, unknown>;
    if (!x || typeof x !== "object" || !["put", "create", "update", "move", "delete"].includes(x.op as string) || typeof x.area !== "string" || typeof x.key !== "string")
      throw new PackError(`operation ${i + 1}: {op: put|create|update|move|delete, area, key, ...}`, 400);
  }
  return ops as RecordOperation[];
};

/**
 * Run `fn` as one transaction for one workspace (orgId) or the platform (null): every record query inside runs on it;
 * any refusal or error rolls all of it back. Batches do not nest.
 */
export async function inTransaction<T>(orgId: number | null, fn: () => Promise<T>): Promise<T> {
  if (txScope.getStore()) throw new Error("a batch inside a batch: refused");
  // The data key is loaded before the transaction: sealing and opening inside it then need no other query.
  if (orgId !== null) await ensureOrgKey(orgId);
  const run = async () => (await getDb()).transaction((tx) => txScope.run({ tx, orgId }, fn));
  return orgId === null ? asPlatform(run) : withTenant(orgId, run);
}

async function batchWorkspace(orgId: number, pack: string, actor: Actor, raw: unknown, max = MAX_BATCH, source: string | null = null, fingerprints?: Map<string, string>): Promise<RecordOperationResult[]> {
  const ops = checkOps(raw, max);
  return inTransaction(orgId, async () => {
    const out: RecordOperationResult[] = [];
    for (const [i, o] of ops.entries()) {
      try {
        if (o.op === "move") out.push({ op: o.op, area: o.area, key: o.key, record: await moveWorkspace(orgId, pack, actor, o.area, o.key, o.to) });
        else if (o.op === "delete") out.push({ op: o.op, area: o.area, key: o.key, deleted: await deleteWorkspace(orgId, pack, actor, o.area, o.key, source) });
        else {
          const fp = source !== null ? fingerprints?.get(`${o.area}\u0000${o.key}`) : undefined;
          out.push({ op: o.op, area: o.area, key: o.key, record: await putWorkspace(orgId, pack, actor, o.area, o.key, { title: o.title, data: o.data }, o.op, source !== null && fp ? { source, fingerprint: fp } : null) });
        }
      } catch (e) { throw numbered(i, o, e); }
    }
    return out;
  });
}

async function batchPlatform(pack: string | null, raw: unknown, max = MAX_BATCH, source: string | null = null, fingerprints?: Map<string, string>): Promise<RecordOperationResult[]> {
  const ops = checkOps(raw, max);
  return inTransaction(null, async () => {
    const out: RecordOperationResult[] = [];
    for (const [i, o] of ops.entries()) {
      try {
        if (o.op === "move") throw new PackError("a shared area has no lifecycle: its records do not move", 400);
        if (o.op === "delete") out.push({ op: o.op, area: o.area, key: o.key, deleted: await deletePlatform(pack, o.area, o.key, source) });
        else {
          const fp = source !== null ? fingerprints?.get(`${o.area}\u0000${o.key}`) : undefined;
          out.push({ op: o.op, area: o.area, key: o.key, record: await putPlatform(pack, o.area, o.key, { title: o.title, data: o.data, version: o.version }, o.op, source !== null && fp ? { source, fingerprint: fp } : null) });
        }
      } catch (e) { throw numbered(i, o, e); }
    }
    return out;
  });
}

// ---------- a repository's own writer (mold_v0-059; src/data-repositories.ts) ----------

/** A row as its repository last wrote it: its key, its source and fingerprint (never its values). */
export interface StoredMark { key: string; source: string | null; fingerprint: string | null }
/** The marks of every row of an area (the workspace's own for a workspace area). */
export async function storedMarks(area: RecordArea, orgId: number | null): Promise<StoredMark[]> {
  if (orgId === null) return asPlatform(async () => (await q()).query<StoredMark>("SELECT key, source, fingerprint FROM platform_records WHERE pack = $1 AND area = $2 ORDER BY key", [area.pack, area.name]));
  return withTenant(orgId, async () => (await q()).query<StoredMark>("SELECT key, source, fingerprint FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 ORDER BY key", [orgId, area.pack, area.name]));
}
/**
 * Write a repository's index as one transaction (all of it or none): puts carry the source and their fingerprints; a
 * delete removes only a row of that source. Not reachable from any door: only src/data-repositories.ts calls it.
 */
export async function writeFromRepository(orgId: number | null, pack: string, source: string, ops: RecordOperation[], fingerprints: Map<string, string>): Promise<RecordOperationResult[]> {
  if (!ops.length) return [];
  return orgId === null ? batchPlatform(pack, ops, MAX_INDEX_BATCH, source, fingerprints) : batchWorkspace(orgId, pack, SYSTEM_ACTOR, ops, MAX_INDEX_BATCH, source, fingerprints);
}

/**
 * ctx.records for a pack's tool or workspace route: this workspace only; writes to the pack's own workspace areas, each
 * checked for `actor` (the person the call is made for) against the area's declaration (mold_v0-057). The generic data
 * API (mold_v0-059) is built on the same functions, so every door applies the same rules.
 */
export const workspaceRecords = (pack: string, orgId: number, actor: Actor = SYSTEM_ACTOR): WorkspaceRecords & {
  create(area: string, key: string, value: RecordInput): Promise<RecordRow>;
  update(area: string, key: string, value: RecordInput): Promise<RecordRow>;
} => ({
  list: async (area, opts) => listFor(orgId, area, opts, actor),
  get: async (area, key) => getFor(orgId, area, key, actor),
  put: (area, key, value) => putWorkspace(orgId, pack, actor, area, key, value),
  create: (area, key, value) => putWorkspace(orgId, pack, actor, area, key, value, "create"),
  update: (area, key, value) => putWorkspace(orgId, pack, actor, area, key, value, "update"),
  move: (area, key, to) => moveWorkspace(orgId, pack, actor, area, key, to),
  delete: (area, key) => deleteWorkspace(orgId, pack, actor, area, key),
  batch: (ops) => batchWorkspace(orgId, pack, actor, ops),
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
    batch: (ops) => batchPlatform(pack, ops),
  };
};
/** The admin API's door to shared areas (any pack's): create, update, put, delete and batch, as staff. */
export const adminRecords = {
  put: (area: string, key: string, value: RecordInput, mode: PutMode = "put") => putPlatform(null, area, key, value, mode),
  delete: (area: string, key: string) => deletePlatform(null, area, key),
  batch: (ops: unknown) => batchPlatform(null, ops),
};

/** What the console and the MCP tools show of an area (never its pack's code). */
export const areaSummary = (a: RecordArea) => ({
  name: a.name, label: a.label, description: a.description ?? null, role: a.role, scope: a.scope, pack: a.pack,
  fields: a.fields, list_columns: a.list_columns ?? a.fields.slice(0, 4).map((f) => f.name), links: areaLinks(a),
  // mold_v0-059/066: where its rows come from, whether a door may write them, and whether they are sealed at rest.
  ...(a.repo ? { repository: { name: a.repo.name, kind: a.repo.kind }, read_only: isReadOnlyArea(a) } : {}),
  ...(isSealedArea(a) ? { sealed: true } : {}),
  // mold_v0-057: the lifecycle and who may do what (each action's roles, never wider than the platform's).
  ...(a.lifecycle ? { lifecycle: a.lifecycle } : {}),
  ...(a.permissions ? { permissions: Object.fromEntries((["read", "create", "update", "move", "delete"] as const).map((k) => [k, allowedRoles(a, k)])) } : {}),
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
        const page = await listFor(ws.id, area.name, { limit: args.limit, after: args.after }, { role: ws.role, userId: ws.userId });
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
        const d = await detailFor(ws.id, args.area, args.key, { role: ws.role, userId: ws.userId });
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
