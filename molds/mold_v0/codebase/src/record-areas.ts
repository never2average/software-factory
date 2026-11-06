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
import { historyKept, writeHistory } from "./record-history.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, type Queryable } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { ensureOrgKey, isSealed, open, openJson, seal, sealJson } from "./orgcrypto.js";
import { ACCOUNT_ROLE_LABELS, ACCOUNT_ROLES, canAccount, type AccountRole } from "./account-roles.js";
import { conditionHolds, referenceWhereWords, type DetailCondition } from "./pack-api.js";
import { areaLinks, DECLARABLE_ROLES, isFieldUrl, URL_MAX, optionValues, PackError, READ_ONLY_KINDS, RECORD_KEY, RecordAreaSchema, RecordFieldSchema, RepositorySchema, WRITE_ROLES, z, type PackTool, type PlatformRecords, type RecordAction, type RecordInput, type RecordOperation, type RecordOperationResult, type RecordPage, type RecordQuery, type RecordRow, type Repository, type Workspace, type WorkspaceRecords } from "./pack-api.js";
import { packs } from "./packs.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { cursorOf, goneCursor, pageInMemory, parseQuery, readsContent, sqlParts, type Parsed, type QField } from "./record-query.js";
import { asPlatform, currentTenant, withTenant } from "./tenant-scope.js";
import { auditAs, auditAtomic, auditData, auditQuiet } from "./audit-trail.js";
import { BLIND_PREFIX, blindIndex, checkEncryptedQuery, decryptValue, encryptedFields, hasEncryptedFields, isEncryptedField, isEnvelope, maskFields, needsMasking, needsSealing, sealFields, splitEncryptedInput, type EncField } from "./encrypted-fields.js";
import type { RevealedFields } from "./pack-api.js";
import { featureSetting } from "./feature-flags.js";
import { isStoredFileRef } from "./record-files-config.js";

/** An area as installed: its declaration, its pack, and the repository its rows come from (null: the shell's tables). */
export type RecordArea = z.output<typeof RecordAreaSchema> & { pack: string; repo: { name: string; kind: Repository["kind"]; settings: Repository } | null };

/** The MCP tools the shell adds when at least one area is declared (a pack may not take these names; src/shell-tools.ts). */
export { RECORD_TOOL_NAMES } from "./shell-tools.js";

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

// ---------- the contract's import, export and reveal (mold_v0-234, mold_v0-235) ----------

type Grant = NonNullable<RecordArea["contract"]>["actions"]["read"];
/** The contract's grant for `action`, when the area declares a contract (else undefined: today's behaviour). */
const contractGrant = (area: RecordArea, action: "import" | "export" | "reveal"): Grant | undefined => area.contract?.actions[action];
const isNone = (g: Grant | undefined) => !!g && typeof g === "object" && !Array.isArray(g) && "none" in g;
/** A grant's workspace roles, in the platform's order ([] for {staff} or {none}). */
const grantRoles = (g: Grant | undefined): AccountRole[] => (Array.isArray(g) ? ACCOUNT_ROLES.filter((r) => (g as readonly string[]).includes(r)) : []);

/**
 * Who may export an area's records (mold_v0-235): the contract's `export` roles that may also read it; read's roles when
 * the contract does not say; nobody (not even an account key) when it says {none}.
 */
export function exportRoles(area: RecordArea): AccountRole[] {
  const g = contractGrant(area, "export");
  const read = allowedRoles(area, "read");
  return g === undefined ? read : grantRoles(g).filter((r) => read.includes(r));
}
export const mayExport = (area: RecordArea, actor: Actor) =>
  !isNone(contractGrant(area, "export")) && may(area, "read", actor) && (actor.role === null || exportRoles(area).includes(actor.role));
/** An export refused for this person (the Export CSV pages, export_<area>), with who may. */
export function assertMayExport(area: RecordArea, actor: Actor) {
  if (mayExport(area, actor)) return;
  if (isNone(contractGrant(area, "export"))) throw new PackError(`${area.label} records are not exported (${(contractGrant(area, "export") as { none: string }).none})`, 403);
  if (!may(area, "read", actor)) assertMay(area, "read", actor);
  const who = exportRoles(area).map((r) => ACCOUNT_ROLE_LABELS[r].toLowerCase());
  throw new PackError(`You can't export ${area.label} records with the ${ACCOUNT_ROLE_LABELS[actor.role!]} role${who.length ? ` (${who.join(", ")} can)` : ""}.`, 403);
}

/**
 * Who may import a file into a workspace area's own records (mold_v0-234): the contract's `import` roles that may also
 * add and change its records; nobody when the contract does not say (today's behaviour) or says {none}. A shared area's
 * import is staff's (src/record-import.ts importRecords), never a workspace role's.
 */
export function importRoles(area: RecordArea): AccountRole[] {
  if (area.scope !== "workspace" || isReadOnlyArea(area)) return [];
  const create = allowedRoles(area, "create"), update = allowedRoles(area, "update");
  return grantRoles(contractGrant(area, "import")).filter((r) => create.includes(r) && update.includes(r));
}
/** Whether the area takes a workspace's import at all (its contract grants one), and whether `actor` may make it. */
export const takesImport = (area: RecordArea) => Array.isArray(contractGrant(area, "import")) && importRoles(area).length > 0;
export const mayImport = (area: RecordArea, actor: Actor) => takesImport(area) && (actor.role === null || importRoles(area).includes(actor.role));
export function assertMayImport(area: RecordArea, actor: Actor) {
  if (mayImport(area, actor)) return;
  const g = contractGrant(area, "import");
  if (!takesImport(area)) throw new PackError(`${area.label} takes no import${isNone(g) ? ` (${(g as { none: string }).none})` : ": its contract grants none"}`, 403);
  const who = importRoles(area).map((r) => ACCOUNT_ROLE_LABELS[r].toLowerCase());
  throw new PackError(`You can't import ${area.label} records with the ${ACCOUNT_ROLE_LABELS[actor.role!]} role${who.length ? ` (${who.join(", ")} can)` : ""}.`, 403);
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
const txScope = new AsyncLocalStorage<{ tx: Queryable; orgId: number | null; changes?: RecordChange[] }>();

// ---------- record changes (mold_v0-193: the developer surface's record events) ----------

/** A workspace record that was written: told to the listeners after it is stored (after its batch commits). */
export interface RecordChange {
  orgId: number; pack: string; area: string; key: string;
  change: "created" | "updated" | "state_changed" | "deleted";
  record: RecordRow | null; from?: unknown; to?: unknown;
  /**
   * mold_v0-256: what the change's history line needs (src/record-history.ts, a transaction listener): the record's title
   * and data before (null: it is new) and after (null: deleted), as stored before sealing (an encrypted field's value is
   * compared, never kept), and who wrote it ("<kind>:<who>", as workspace_records.updated_by).
   */
  history?: { before: { title: string | null; data: Record<string, unknown> } | null; after: { title: string | null; data: Record<string, unknown> } | null; by: string | null };
}
const changeListeners: ((c: RecordChange) => unknown)[] = [];
/** Hear every workspace record change once it is stored (after its transaction commits): nothing it does undoes the change. */
export const onRecordChange = (fn: (c: RecordChange) => unknown) => void changeListeners.push(fn);
/**
 * A listener inside the change's own transaction (mold_v0-202: the developer surface's event outbox): what it writes on
 * `tx` commits with the change or not at all, and a throw rolls the change back. `wants(area)` says whether a write to
 * that area needs it: only then is a single write (outside a batch) made a transaction of its own, so an app that wants
 * none (a tool app) writes exactly as before.
 */
interface TxListener { fn: (c: RecordChange, tx: Queryable) => Promise<unknown>; wants: (area: string) => boolean }
const txListeners: TxListener[] = [];
export const onRecordChangeInTransaction = (fn: TxListener["fn"], wants: TxListener["wants"]) => void txListeners.push({ fn, wants });
// mold_v0-256: a laid-out area's change history (src/record-history.ts), in the change's own transaction; only for an area
// whose page has a history section while record_pages is on (else no transaction of its own, as before).
onRecordChangeInTransaction((c, tx) => writeHistory(findArea(c.area)!, c, tx), (name) => historyKept(findArea(name)));
/** Run a single write as a transaction when a transaction listener wants its area (inside a batch: the batch's). */
const atomic = <T>(orgId: number, area: string, fn: () => Promise<T>): Promise<T> =>
  !txScope.getStore() && txListeners.some((l) => l.wants(area)) ? auditAtomic(() => inTransaction(orgId, fn)) : fn();
const tell = async (list: RecordChange[]) => {
  for (const c of list) for (const fn of changeListeners) {
    try { await fn(c); } catch (e) { console.error(`record change listener: ${(e as Error).message}`); }
  }
};
/** A change: told now, or, inside a batch, once the batch has committed (a batch rolled back tells nothing). */
async function changed(c: RecordChange) {
  const t = txScope.getStore();
  if (t) for (const l of txListeners) if (l.wants(c.area)) await l.fn(c, t.tx);
  if (!changeListeners.length) return;
  if (t) { (t.changes ??= []).push(c); return; }
  await tell([c]);
}
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
  // A stored file (mold_v0-220, src/record-files.ts): whether it opens for this record is checked on read.
  if ("object" in v) return isStoredFileRef(v);
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
    case "file": return `${many}a file reference {path, name?, sha256?, size?} with a path inside the workspace's files, or a stored file {object, name, size, content_type, sha256}`;
    case "number": return `a number${f.min !== undefined ? ` from ${f.min}` : ""}${f.max !== undefined ? ` up to ${f.max}` : ""}`;
    case "text": return `text of up to ${f.max_length ?? 20_000} characters`;
    case "url": return `an http or https address of up to ${URL_MAX} characters, with no user name or password`;
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
    case "url": return isFieldUrl(v);
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
    // mold_v0-260 (flag record_rules): the records it may name are those its `where` keeps, as the writer reads them.
    else if (f.where && featureSetting("record_rules")) {
      const kept: string[] = [];
      for (const k of keys) {
        const row = await (target.scope === "platform" ? getPlatform(target, k) : orgId === null ? null : getWorkspace(orgId, target, k));
        if (row && conditionHolds(f.where as DetailCondition, row.data ?? {})) kept.push(k);
      }
      const out_ = keys.filter((k) => !kept.includes(k));
      const label = (n: string) => (target.fields.find((x) => x.name === n)?.label ?? n).toLowerCase();
      if (out_.length) problems.push(`field ${f.name} of ${what}: ${out_.slice(0, 5).join(", ")} ${out_.length > 1 ? "are not" : "is not"} a ${target.label} record ${referenceWhereWords(f.where, label)}`);
    }
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
    // The shell's own keys (when each state was entered; mold_v0-194's tag and blind indexes): never a field (a field
    // name starts with a letter).
    if (k.startsWith("$")) continue;
    const f = area.fields.find((x) => x.name === k);
    if (!f) { drift.push(k); continue; }
    // An encrypted field (mold_v0-194) is shown masked: its type is the stored value's, never checked here.
    if (v !== null && v !== undefined && !f.encrypted && !fits(f, v)) drift.push(k);
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
  let raw = orgId !== null ? await openJson(orgId, row.data) : (row.data as Record<string, unknown>) ?? {};
  // Encrypted fields (mold_v0-194): never a value on any read, only the mask; an explicit reveal opens them (revealFor).
  if (orgId !== null && needsMasking(area, raw)) raw = await maskFields(orgId, area, row.key, raw);
  const { data, drift } = conform(area, raw);
  const t = orgId !== null && isSealed(row.title) ? await open(orgId, row.title) : row.title;
  return { area: area.name, key: row.key, title: t ?? null, data, version: row.version ?? null, updated_at: iso(row.updated_at), ...(drift.length ? { drift } : {}) };
}

/** A query (mold_v0-059) against an area's fields: limit, sort, filter, cursor (src/record-query.ts). */
export const queryOf = (area: RecordArea, opts?: RecordQuery | { limit?: unknown; after?: unknown }): Parsed => {
  const p = parseQuery(area.fields as QField[], opts as RecordQuery, fits as (f: QField, v: unknown) => boolean, fitsOne as (f: QField, v: unknown) => boolean);
  // mold_v0-194: an encrypted field is filtered by equality only, through its blind index, and never sorted on.
  checkEncryptedQuery(area, p);
  return p;
};

/**
 * A query's equality conditions on encrypted fields (mold_v0-194) as conditions on their blind indexes in the stored row
 * ("$bi:<field>", outside a sealed area's ciphertext too), keyed with this workspace's data key: so they run in SQL.
 */
async function blindConds(orgId: number, area: RecordArea, p: Parsed): Promise<{ p: Parsed; blind: Parsed["conds"] }> {
  if (!hasEncryptedFields(area)) return { p, blind: [] };
  const blind: Parsed["conds"] = [], rest: Parsed["conds"] = [];
  for (const c of p.conds) {
    if (c.target !== "field" || !isEncryptedField(area, c.name)) { rest.push(c); continue; }
    const name = `${BLIND_PREFIX}${c.name}`;
    blind.push({ target: "field", name, field: { name, type: "text" }, op: "eq", value: await withTenant(orgId, () => blindIndex(orgId, area, c.name, c.value)) });
  }
  return { p: { ...p, conds: rest }, blind };
}

/** At most this many rows of one workspace's sealed area are opened to filter or sort them in memory. */
export const MEMORY_SCAN_LIMIT = 5000;

// ---------- reads and writes ----------

/**
 * A page of an area's rows in the shell's tables: the area's and (for a workspace area) the workspace's own scope first,
 * then the query's conditions and order (src/record-query.ts), so a filter, sort or cursor only narrows the caller's
 * rows. A sealed area's titles and data are ciphertext in the database: a query that reads them runs on the opened rows.
 */
async function listTable(area: RecordArea, orgId: number | null, query: Parsed): Promise<RecordPage> {
  // Equality on an encrypted field (mold_v0-194): its blind index, in SQL; the rest of the query as before.
  const { p: open, blind } = orgId !== null ? await blindConds(orgId, area, query) : { p: query, blind: [] };
  if (orgId !== null && isSealedArea(area) && readsContent(open)) {
    const all = await scanWorkspace(orgId, area, [...open.conds.filter((c) => c.target === "key"), ...blind]);
    return pageInMemory(open, all);
  }
  const p: Parsed = blind.length ? { ...open, conds: [...open.conds, ...blind] } : open;
  const run = async () => {
    const params: unknown[] = orgId === null ? [area.pack, area.name] : [orgId, area.pack, area.name];
    const base = orgId === null ? ["pack = $1", "area = $2"] : ["org_id = $1", "pack = $2", "area = $3"];
    const table = orgId === null ? "platform_records" : "workspace_records";
    // A sorted page starts after its cursor's row, read again in this same scope (its sort value is never the caller's).
    if (p.after && p.sort.target !== "key" && !(await (await q()).query(`SELECT 1 FROM ${table} WHERE ${[...base, `key = $${params.length + 1}`].join(" AND ")}`, [...params, p.after.k])).length)
      throw goneCursor();
    const parts = sqlParts(p, params, { table, where: base });
    params.push(p.limit + 1);
    const rows = await (await q()).query<Row>(
      `SELECT key, title, data, ${orgId === null ? "version" : "NULL::text AS version"}, updated_at FROM ${table}
        WHERE ${[...base, ...parts.where].join(" AND ")} ORDER BY ${parts.order} LIMIT $${params.length}`, params);
    const page = await Promise.all(rows.slice(0, p.limit).map((r) => toRecord(area, r, orgId)));
    const last = rows[p.limit - 1];
    return { records: page, next: rows.length > p.limit && last ? cursorOf(p.sort, last.key) : null };
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
  const page = await listTable(area, null, p);
  // An upstream catalog's area read empty, unfiltered (mold_v0-128): start its automatic index and wait a moment for it.
  if (!page.records.length && !p.after && !p.conds.length && area.repo?.kind === "upstream_catalog"
    && await (await import("./repository-index.js")).onEmptyCatalogArea(area).catch(() => false)) return listTable(area, null, p);
  return page;
}

async function listWorkspace(orgId: number, area: RecordArea, opts?: RecordQuery | { limit?: unknown; after?: unknown }): Promise<RecordPage> {
  const p = queryOf(area, opts);
  // The data trail (mold_v0-197): one entry per page of a workspace's records, never one per row, never their values.
  return auditAs(orgId, async () => (isLive(area) ? (await live()).listLive(area, orgId, p) : listTable(area, orgId, p)),
    (page) => ({ action: "list", pack: area.pack, area: area.name, rows: page.records.length }));
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
  // The data trail (mold_v0-197): one read of a record (a sealed area's is a reveal), never its values.
  return auditAs(orgId, async () => (isLive(area) ? (await live()).getLive(area, orgId, checkKey(key)) : (await readWorkspace(orgId, area, key))?.record ?? null),
    (r) => (r ? { action: isSealedArea(area) ? "reveal" : "read", pack: area.pack, area: area.name, key: r.key } : null));
}

/**
 * One workspace's view of an area: a platform area's shared rows, or the workspace's own rows of a workspace area. With
 * an actor (the person asking), the area's read permission is checked first (mold_v0-057).
 */
export const listFor = async (orgId: number, name: string, opts?: RecordQuery | { limit?: unknown; after?: unknown }, actor: Actor = SYSTEM_ACTOR): Promise<RecordPage> => {
  const a = areaOrThrow(name);
  assertMay(a, "read", actor);
  if (a.scope === "platform") return listPlatform(a, opts);
  const page = await listWorkspace(orgId, a, opts);
  return hasClocks(a) ? { ...page, records: await (await clocks()).withClocks(orgId, a, page.records) } : page;
};
export const getFor = async (orgId: number, name: string, key: string, actor: Actor = SYSTEM_ACTOR): Promise<RecordRow | null> => {
  const a = areaOrThrow(name);
  assertMay(a, "read", actor);
  if (a.scope === "platform") return getPlatform(a, key);
  const r = await getWorkspace(orgId, a, key);
  return r && hasClocks(a) ? (await (await clocks()).withClocks(orgId, a, [r]))[0]! : r;
};
// ---------- encrypted fields: reveal (mold_v0-194, src/encrypted-fields.ts) ----------

/**
 * Who may reveal an encrypted field: its reveal_roles, else the area's (mold_v0-235: the contract's `reveal` roles), else
 * the roles that may update the area's records. A contract whose reveal is {none} reveals nothing to anyone (an account
 * key included); a field's reveal_roles only narrow the area's (the build refuses wider).
 */
export const revealRoles = (area: RecordArea, f: EncField): AccountRole[] => {
  const g = contractGrant(area, "reveal");
  if (isNone(g)) return [];
  const own = f.reveal_roles ? ACCOUNT_ROLES.filter((r) => (f.reveal_roles as readonly string[]).includes(r)) : null;
  const areaRoles = Array.isArray(g) ? grantRoles(g) : null;
  return own ? (areaRoles ? own.filter((r) => areaRoles.includes(r)) : own) : areaRoles ?? allowedRoles(area, "update");
};
export const mayReveal = (area: RecordArea, f: EncField, actor: Actor) =>
  !isNone(contractGrant(area, "reveal")) && may(area, "read", actor) && (actor.role === null || revealRoles(area, f).includes(actor.role));

/**
 * The values of a record's encrypted fields, for `actor` (mold_v0-194): the area's read permission, then each asked
 * field's reveal roles (an account key, or the shell, has no role limits, as for every shell rule). `fields` absent:
 * every encrypted field the actor may reveal. One `reveal` entry in the data trail (never a value); a value that does
 * not open (moved from another record or workspace) is refused, never shown.
 */
export async function revealFor(orgId: number, name: string, key: string, fields: unknown, actor: Actor = SYSTEM_ACTOR): Promise<RevealedFields> {
  const area = areaOrThrow(name);
  if (area.scope !== "workspace" || !hasEncryptedFields(area)) throw new PackError(`${area.label} has no encrypted fields`, 404);
  // The features registry (mold_v0-219): with encrypted_fields off nothing is revealed (values stay masked: fail closed).
  if (!featureSetting("encrypted_fields")) throw new PackError("Encrypted fields are off in this app", 404);
  assertMay(area, "read", actor);
  // mold_v0-235: the area's contract says nothing of it is revealed.
  const closed = contractGrant(area, "reveal");
  if (isNone(closed)) throw new PackError(`${area.label}'s encrypted fields are never revealed (${(closed as { none: string }).none})`, 403);
  const enc = encryptedFields(area);
  let wanted: EncField[];
  if (fields === undefined || fields === null) {
    wanted = enc.filter((f) => mayReveal(area, f, actor));
    if (!wanted.length) throw new PackError(`You can't reveal ${area.label}'s encrypted fields with the ${ACCOUNT_ROLE_LABELS[actor.role!]} role.`, 403);
  } else {
    if (!Array.isArray(fields) || !fields.length || fields.length > enc.length || !fields.every((x) => typeof x === "string"))
      throw new PackError(`fields: a list of ${area.label}'s encrypted fields (${enc.map((f) => f.name).join(", ")})`, 400);
    wanted = [];
    for (const n of new Set(fields as string[])) {
      const f = enc.find((x) => x.name === n);
      if (!f) throw new PackError(`${JSON.stringify(n.slice(0, 64))} is not an encrypted field of ${area.label} (${enc.map((x) => x.name).join(", ")})`, 400);
      if (!mayReveal(area, f, actor)) {
        const who = revealRoles(area, f).map((r) => ACCOUNT_ROLE_LABELS[r].toLowerCase());
        throw new PackError(`You can't reveal ${f.name} of ${area.label} with the ${ACCOUNT_ROLE_LABELS[actor.role!]} role${who.length ? ` (${who.join(", ")} can)` : ""}.`, 403);
      }
      wanted.push(f);
    }
  }
  if (!vaultUnlocked()) throw new PackError(`${area.label}'s encrypted fields cannot be opened while the key vault is locked`, 503);
  const row = await auditQuiet(() => readWorkspace(orgId, area, key));
  if (!row) throw new PackError(`no ${area.name} record ${key}`, 404);
  const out: Record<string, unknown> = {};
  for (const f of wanted) {
    const v = row.opened[f.name];
    if (v === null || v === undefined) { out[f.name] = null; continue; }
    // A value written before the field was encrypted (the migration has not reached the row yet) is still plain.
    if (!isEnvelope(v)) { out[f.name] = v; continue; }
    try { out[f.name] = await withTenant(orgId, () => decryptValue(orgId, area, row.record.key, f.name, v)); }
    catch { throw new PackError(`field ${f.name} of ${area.label} record ${row.record.key} does not open with this workspace's key`, 409); }
  }
  auditData(orgId, { action: "reveal", pack: area.pack, area: area.name, key: row.record.key });
  return { area: area.name, key: row.record.key, fields: out };
}

/**
 * Clocks (mold_v0-191, src/record-clocks.ts): a workspace area's records carry their deadlines on every read, except
 * inside a batch's transaction (its writes' answers are the store's own) and for an area read live from an API.
 */
const hasClocks = (a: RecordArea) => clocksShown(a) && !isLive(a) && !txScope.getStore();
/** The area's clocks count (mold_v0-219): it declares some and the features registry's record_clocks flag is not off. */
const clocksShown = (a: RecordArea) => (a.clocks?.length ?? 0) > 0 && featureSetting("record_clocks");
const clocks = () => import("./record-clocks.js");

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
    // Only the linked records' titles: part of the detail's one entry in the data trail (mold_v0-197), none of their own.
    const found = (await auditQuiet(() => Promise.all(wanted.map((k) => getFor(orgId, target.name, k, actor))))).filter((r): r is RecordRow => !!r);
    links.push({ field: l.field, area: target.name, records: found.map((r) => ({ key: r.key, title: r.title })) });
  }
  // A clock area's record page shows what its clocks did (mold_v0-191): the latest events, newest first.
  const clockEvents = hasClocks(area) ? { clock_events: await (await clocks()).clockEvents(orgId, area, record.key) } : {};
  // mold_v0-236: where a workspace row came from and who last wrote it (a row written before 0042 has no mark).
  const written = area.scope === "workspace" ? (await workspaceProvenance(orgId, area, [record.key])).get(record.key) : undefined;
  return { area: areaSummary(area), record, links, ...clockEvents, ...(written && (written.by || written.updated_by) ? { provenance: written } : {}) };
}

const ownWorkspaceArea = (pack: string, name: string) => {
  const area = areaOrThrow(name);
  if (area.scope !== "workspace") throw new PackError(`area ${area.name} is shared by every workspace: read only here`, 403);
  if (area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return area;
};
/**
 * When a record last entered each state of its lifecycle (mold_v0-063: the metrics' state:<value> points, time to fix):
 * kept in the row's data under this key, which no field can be named (field names start with a letter), so no write can
 * set it; the store stamps it when a record is created and on every move, and carries it over on writes.
 */
export const STATE_TIMES = "$state_at";
const stateTimes = (data: Record<string, unknown> | undefined): Record<string, string> => {
  const v = data?.[STATE_TIMES];
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, string>) } : {};
};
/** A record's state; a row with none (written before its area had a lifecycle) is in the initial state. */
const stateOf = (area: RecordArea, data: Record<string, unknown>) => (area.lifecycle ? data[area.lifecycle.field] ?? area.lifecycle.initial : undefined);

/**
 * Who wrote a row (mold_v0-059): null for every door (ctx.records, the data API, staff), or a repository's writer with
 * the row's fingerprint. A write through a door clears both, so the next index writes the row again.
 */
export interface WriteMeta { source: string; fingerprint: string; /** Staff forced the index: it may take over a hand row. */ claim?: boolean }

// ---------- who or what wrote a workspace row (mold_v0-236) ----------

/**
 * The writer of a workspace record (sql/migrations/0042_workspace_record_provenance.sql): one of the contract's
 * provenances (src/pack-api.ts RECORD_PROVENANCES) with who exactly, or "shell" for the shell's own changes (a clock's
 * escalation step) that never add a row. Kept on the row as
 *   provenance   where the row came from: the kind of its first writer (a repository's index taking a row over makes it
 *                "repository"); NULL for rows written before 0042 and rows only the shell wrote
 *   written_by   "<kind>:<who>" of that first writer: a person's sign-in id (people), a staff pseudonym (staff), the
 *                intake's message (intake), a run's id or the pack's tool or route (run), the repository's name
 *   updated_by   "<kind>:<who>" of the latest write (a move included)
 * Never a value of the record. The doors say who they write for with asWriter; a write with none is the data API's
 * (people, the person or account key the call is made for), or the shell's own code acting for nobody (run).
 */
export type RecordProvenance = "staff" | "people" | "repository" | "intake" | "run";
export interface RecordWriter { by: RecordProvenance | "shell"; id: string | null }
const writerScope = new AsyncLocalStorage<RecordWriter>();
/** Run `fn` with every workspace write inside it made as `w` (an inner asWriter wins). */
export const asWriter = <T>(w: RecordWriter, fn: () => T): T => writerScope.run(w, fn);
/** Run `fn` as `w` unless a writer is already set (the data API's people, under a staff call's or a pack tool's scope). */
export const asWriterUnlessSet = <T>(w: RecordWriter, fn: () => T): T => (writerScope.getStore() ? fn() : writerScope.run(w, fn));
/** The writer set for this call, if any. */
export const currentWriter = (): RecordWriter | null => writerScope.getStore() ?? null;
const writerOf = (actor: Actor, meta: WriteMeta | null): RecordWriter =>
  meta ? { by: "repository", id: meta.source } : writerScope.getStore() ?? (actor.role !== null || actor.userId ? { by: "people", id: actor.userId } : { by: "run", id: null });
const writerText = (w: RecordWriter) => (w.id ? `${w.by}:${w.id}` : w.by).replace(/[\u0000-\u001f]/g, "").slice(0, 200);
/** Where a workspace row came from and who last wrote it (mold_v0-236); null for a row with no mark (written before 0042). */
export interface RowProvenance { by: RecordProvenance | null; written_by: string | null; updated_by: string | null }

/** Sealed values are never stored in the clear: a sealed area's write is refused while the key vault is locked. */
const assertCanSeal = (area: RecordArea) => {
  if ((isSealedArea(area) || hasEncryptedFields(area)) && !vaultUnlocked()) throw new PackError(`${area.label} records are sealed and the key vault is locked: nothing is stored unsealed`, 503);
};

async function writeRow(orgId: number, area: RecordArea, key: string, t: string | null, data: Record<string, unknown>, prev: { rev: string } | null, writer: RecordWriter, meta: WriteMeta | null = null, action: "move" | null = null): Promise<RecordRow> {
  let stored: Record<string, unknown> = data;
  // Encrypted fields (mold_v0-194): each value sealed for this record and field, with its blind index and the tag.
  let outside: Record<string, unknown> = {};
  if (needsSealing(area, data)) {
    assertCanSeal(area);
    stored = await withTenant(orgId, () => sealFields(orgId, area, key, data));
    if (isSealedArea(area)) {
      // A sealed area's blind indexes and tag stay beside its ciphertext, so equality and the migration run in SQL.
      outside = Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith("$") && k !== STATE_TIMES));
      stored = Object.fromEntries(Object.entries(stored).filter(([k]) => !(k in outside)));
    }
  }
  if (isSealedArea(area)) {
    assertCanSeal(area);
    stored = { ...(await withTenant(orgId, () => sealJson(orgId, stored))), ...outside };
    if (t) t = await withTenant(orgId, () => seal(orgId, t!));
  }
  const sealed = isSealed((stored as { _sealed?: unknown })._sealed);
  return withTenant(orgId, async () => {
    const db = await q();
    // mold_v0-236: who wrote it. A new row takes its writer's kind; a later write keeps where the row came from (a
    // repository's index taking a row over makes it the repository's) and records only who wrote it last.
    const kind = writer.by === "shell" ? null : writer.by, who = writerText(writer);
    const [r] = prev === null
      ? await db.query<Row>(
        `INSERT INTO workspace_records (org_id, pack, area, key, title, data, sealed, source, fingerprint, chained, provenance, written_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (org_id, pack, area, key) DO NOTHING RETURNING key, title, data, updated_at`,
        [orgId, area.pack, area.name, key, t, JSON.stringify(stored), sealed, meta?.source ?? null, meta?.fingerprint ?? null, area.chain === true, kind, kind ? who : null])
      // An area with a lifecycle changes a row only from what was read (its state may have moved meanwhile).
      : await db.query<Row>(
        `UPDATE workspace_records SET title = $5, data = $6, sealed = $7, source = $9, fingerprint = $10, updated_at = now(),
            written_by = CASE WHEN $9::text IS NOT NULL AND provenance IS DISTINCT FROM 'repository' THEN $11 ELSE written_by END,
            provenance = CASE WHEN $9::text IS NOT NULL THEN 'repository' ELSE provenance END, updated_by = $11
          WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND ($8::text IS NULL OR xmin::text = $8) RETURNING key, title, data, updated_at`,
        [orgId, area.pack, area.name, key, t, JSON.stringify(stored), sealed, area.lifecycle ? prev.rev : null, meta?.source ?? null, meta?.fingerprint ?? null, who]);
    if (!r) throw new PackError(prev === null ? `${area.label} record ${key} already exists` : `${area.label} record ${key} was changed by someone else meanwhile: read it again and retry`, 409);
    auditData(orgId, { action: action ?? (prev === null ? "create" : "update"), pack: area.pack, area: area.name, key }); // mold_v0-197: never the values
    return toRecord(area, r, orgId);
  });
}

/** A change's history input (mold_v0-256): before (the row as read), after (as written, before sealing) and its writer. */
const historyOf = (prev: { record: RecordRow; opened: Record<string, unknown> } | null, after: { title: string | null; data: Record<string, unknown> }, w: RecordWriter): RecordChange["history"] =>
  ({ before: prev ? { title: prev.record.title, data: prev.opened } : null, after, by: writerText(w) });

/**
 * mold_v0-260 (flag record_rules): an area's checks on save. Each names a declarative check (mold_v0-196), its inputs
 * taken from the record being saved (`@field`, `$key`, `$title`, else the literal); a create or change for which it
 * answers no is refused (409) with the declared message. Asked as the writer (the check reads what the writer may), in
 * the writer's own workspace. A field that is empty leaves its input out (the check's own rules then decide).
 */
export async function onSaveChecks(orgId: number, area: RecordArea, key: string, title: string | null, data: Record<string, unknown>, op: "create" | "update", actor: Actor) {
  const rules = (area as { on_save?: { check: string; inputs: Record<string, unknown>; message: string; on?: ("create" | "update")[] }[] }).on_save;
  if (!rules?.length || !featureSetting("record_rules")) return;
  const { answerCheck } = await import("./checks.js");
  for (const r of rules) {
    if (r.on && !r.on.includes(op)) continue;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.inputs)) {
      const got = typeof v !== "string" ? v : v === "$key" ? key : v === "$title" ? title : v.startsWith("@") ? data[v.slice(1)] : v.startsWith("$$") ? v.slice(1) : v;
      if (got !== undefined && got !== null && got !== "") inputs[k] = got;
    }
    const a = await answerCheck({ orgId, role: actor.role ?? null, userId: actor.userId ?? null, scopes: null }, r.check, inputs);
    if (!a.allowed) throw new PackError(r.message, 409);
  }
}

/** An append-only area's record (mold_v0-195): added once, never changed or deleted. */
const appendOnly = (area: RecordArea, key: string) => new PackError(`${area.label} records are append-only: ${key} is never changed or deleted once added`, 409);

/** put: create or replace; create: only a new key (409 when it exists); update: only an existing key (404). */
export type PutMode = "put" | "create" | "update";

function putWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, value: RecordInput, mode: PutMode = "put", meta: WriteMeta | null = null): Promise<RecordRow> {
  return atomic(orgId, name, () => putWorkspaceNow(orgId, pack, actor, name, key, value, mode, meta));
}
async function putWorkspaceNow(orgId: number, pack: string, actor: Actor, name: string, key: string, value: RecordInput, mode: PutMode = "put", meta: WriteMeta | null = null): Promise<RecordRow> {
  const area = ownWorkspaceArea(pack, name);
  if (!meta && isReadOnlyArea(area)) throw readOnly(area);
  checkKey(key);
  assertCanSeal(area);
  // A writer must also be a reader: a write's answer (and its refusals) show the stored record.
  assertMay(area, "read", actor);
  const prev = await readWorkspace(orgId, area, key);
  if (prev && mode === "create") throw new PackError(`${area.label} record ${key} already exists`, 409);
  if (prev && area.append_only) throw appendOnly(area, key); // mold_v0-195: added once, never changed
  if (!prev && mode === "update") throw new PackError(`no ${area.name} record ${key}`, 404);
  assertMay(area, prev ? "update" : "create", actor);
  // Encrypted fields (mold_v0-194): the mask, or a field left out, keeps the stored value; null clears it.
  const { input: given, carried } = splitEncryptedInput(area, value?.data, prev?.opened ?? null);
  const t = title(value?.title);
  if (!area.lifecycle) {
    const data = { ...(await checkRecord(area, given, orgId, actor, undefined, Object.keys(carried))), ...carried }, w = writerOf(actor, meta);
    await onSaveChecks(orgId, area, key, t, data, prev ? "update" : "create", actor);
    const r = await writeRow(orgId, area, key, t, data, prev, w, meta);
    await changed({ orgId, pack: area.pack, area: area.name, key, change: prev ? "updated" : "created", record: r, history: historyOf(prev, { title: t, data }, w) });
    return r;
  }
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
  const data = { ...(await checkRecord(area, rest, orgId, actor, undefined, [field, ...Object.keys(carried)])), ...carried };
  const times = prev ? stateTimes(prev.opened) : { [String(state)]: new Date().toISOString() };
  const after = { ...data, [field]: state, ...(Object.keys(times).length ? { [STATE_TIMES]: times } : {}) }, w = writerOf(actor, meta);
  await onSaveChecks(orgId, area, key, t, { ...data, [field]: state }, prev ? "update" : "create", actor);
  const r = await writeRow(orgId, area, key, t, after, prev, w, meta);
  await changed({ orgId, pack: area.pack, area: area.name, key, change: prev ? "updated" : "created", record: r, history: historyOf(prev, { title: t, data: after }, w) });
  return r;
}

/** The moves a record in `from` may make, in words (a refusal's second sentence). */
const movesFrom = (area: RecordArea, from: unknown) => area.lifecycle!.transitions
  .filter((t) => t.from === "*" || (typeof from === "string" && t.from.includes(from)))
  .map((t) => `${JSON.stringify(t.to)}${t.label ? ` (${t.label})` : ""}${t.roles ? ` [${t.roles.join(", ")}]` : ""}`);

function moveWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, to: unknown): Promise<RecordRow> {
  return atomic(orgId, name, () => moveWorkspaceNow(orgId, pack, actor, name, key, to));
}
async function moveWorkspaceNow(orgId: number, pack: string, actor: Actor, name: string, key: string, to: unknown): Promise<RecordRow> {
  const area = ownWorkspaceArea(pack, name);
  if (isReadOnlyArea(area)) throw readOnly(area);
  assertCanSeal(area);
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
  const after = { ...prev.opened, [field]: to, [STATE_TIMES]: { ...stateTimes(prev.opened), [to]: new Date().toISOString() } }, w = writerOf(actor, null);
  const r = await writeRow(orgId, area, key, prev.record.title, after, prev, w, null, "move");
  await changed({ orgId, pack: area.pack, area: area.name, key, change: "state_changed", record: r, from, to, history: historyOf(prev, { title: prev.record.title, data: after }, w) });
  return r;
}

function deleteWorkspace(orgId: number, pack: string, actor: Actor, name: string, key: string, source: string | null = null): Promise<boolean> {
  return atomic(orgId, name, () => deleteWorkspaceNow(orgId, pack, actor, name, key, source));
}
async function deleteWorkspaceNow(orgId: number, pack: string, actor: Actor, name: string, key: string, source: string | null = null): Promise<boolean> {
  const area = ownWorkspaceArea(pack, name);
  if (source === null && isReadOnlyArea(area)) throw readOnly(area);
  assertMay(area, "read", actor);
  assertMay(area, "delete", actor);
  if (area.append_only) throw appendOnly(area, key); // mold_v0-195
  // A repository's writer deletes only rows it wrote itself (its prune).
  const gone = await withTenant(orgId, async () => (await (await q()).query(
    "DELETE FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND ($5::text IS NULL OR source = $5) RETURNING id",
    [orgId, area.pack, area.name, checkKey(key), source])).length > 0);
  if (gone) auditData(orgId, { action: "delete", pack: area.pack, area: area.name, key });
  if (gone) await changed({ orgId, pack: area.pack, area: area.name, key, change: "deleted", record: null,
    history: { before: null, after: null, by: writerText(source !== null ? { by: "repository", id: source } : writerOf(actor, null)) } });
  return gone;
}

const platformAreaFor = (pack: string | null, name: string) => {
  const area = areaOrThrow(name);
  if (area.scope !== "platform") throw new PackError(`area ${area.name} holds each workspace's own records: written by the workspace, not here`, 403);
  if (pack !== null && area.pack !== pack) throw new PackError(`area ${area.name} belongs to pack ${area.pack}`, 403);
  return area;
};

/**
 * Platform staff (or a pack's admin route) writing a shared row. `pack` limits a pack to its own areas; null is the admin
 * API. A row written here is a hand row (no source; provenance "staff"): a repository's re-index never prunes or
 * overwrites it. mold_v0-221: written over a repository's row it is an override, the repository's version kept behind
 * it (`upstream`, sql/migrations/0040) until deletePlatform removes the override and puts that version back.
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
    // What stays behind the row (mold_v0-221): a repository's write has nothing behind it; a hand write over a
    // repository's row keeps that row; a hand write over a hand row keeps what was behind it.
    const behind = (row: string, incoming: string) => `CASE WHEN ${incoming} IS NOT NULL THEN NULL WHEN ${row}.source IS NOT NULL THEN jsonb_build_object('title', ${row}.title, 'data', ${row}.data, 'version', ${row}.version, 'source', ${row}.source, 'fingerprint', ${row}.fingerprint) ELSE ${row}.upstream END`;
    const [r] = mode === "update"
      ? await db.query<Row>(`UPDATE platform_records SET upstream = ${behind("platform_records", "$7::text")}, title = $4, data = $5, version = $6, source = $7, fingerprint = $8, updated_at = now()
          WHERE pack = $1 AND area = $2 AND key = $3 RETURNING key, title, data, version, updated_at`, params)
      : await db.query<Row>(
        `INSERT INTO platform_records (pack, area, key, title, data, version, source, fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (pack, area, key) DO ${mode === "create" ? "NOTHING" : `UPDATE SET upstream = ${behind("platform_records", "excluded.source")}, title = excluded.title, data = excluded.data, version = excluded.version, source = excluded.source, fingerprint = excluded.fingerprint, updated_at = now()${
           // A repository's writer replaces only its own rows: a row written by hand meanwhile stays (unless staff forced it).
           meta && !meta.claim ? " WHERE platform_records.source = excluded.source" : ""}`}
         RETURNING key, title, data, version, updated_at`, params);
    if (!r && meta) throw new PackError(`${area.label} record ${key} was written by hand meanwhile: kept (index again, or force it)`, 409);
    if (!r) throw mode === "create" ? new PackError(`${area.label} record ${key} already exists`, 409) : new PackError(`no ${area.name} record ${key}`, 404);
    return toRecord(area, r, null);
  });
}
/**
 * Delete a shared row. A repository's writer (`source`) deletes only rows it wrote (its prune). A door (staff, a pack's
 * admin route) deletes only hand rows (mold_v0-221): a repository's row is read only (override it instead), and removing
 * an override puts the repository's version kept behind it back (its title, fields, version, source and fingerprint).
 */
export async function deletePlatform(pack: string | null, name: string, key: string, source: string | null = null): Promise<boolean> {
  const area = platformAreaFor(pack, name);
  if (source === null && isReadOnlyArea(area)) throw readOnly(area);
  checkKey(key);
  return asPlatform(async () => {
    const db = await q();
    if (source !== null) return (await db.query("DELETE FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3 AND source = $4 RETURNING id", [area.pack, area.name, key, source])).length > 0;
    const restored = await db.query(`UPDATE platform_records SET title = upstream->>'title', data = COALESCE(upstream->'data', '{}'::jsonb), version = upstream->>'version',
        source = upstream->>'source', fingerprint = upstream->>'fingerprint', upstream = NULL, updated_at = now()
      WHERE pack = $1 AND area = $2 AND key = $3 AND source IS NULL AND upstream IS NOT NULL RETURNING id`, [area.pack, area.name, key]);
    if (restored.length) return true;
    const [row] = await db.query<{ source: string | null }>("SELECT source FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3", [area.pack, area.name, key]);
    if (row?.source) throw new PackError(`${area.label} record ${key} comes from repository ${row.source}: read only (override it instead)`, 409);
    return (await db.query("DELETE FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3 AND source IS NULL RETURNING id", [area.pack, area.name, key])).length > 0;
  });
}

/** Shared rows as stored, by key (mold_v0-221, src/record-import.ts): title, fields and source, for an import's plan. */
export async function platformStored(area: RecordArea, keys: string[]): Promise<Map<string, { title: string | null; data: Record<string, unknown>; source: string | null }>> {
  if (!keys.length || isLive(area)) return new Map();
  const rows = await asPlatform(async () => (await q()).query<{ key: string; title: string | null; data: Record<string, unknown>; source: string | null }>(
    "SELECT key, title, data, source FROM platform_records WHERE pack = $1 AND area = $2 AND key = ANY($3::text[])", [area.pack, area.name, keys]));
  return new Map(rows.map((r) => [r.key, { title: r.title, data: r.data ?? {}, source: r.source }]));
}
/** Where a shared row comes from (mold_v0-221): the staff record pages' marks and Override. */
export interface Provenance {
  /** "staff": written by hand through a door; "repository": its repository's index wrote it. */
  by: "staff" | "repository";
  /** The repository whose row it is, or whose row a staff override stands over. */
  repository: string | null;
  /** A staff row over a repository's row: what the repository says (shown, never the row). */
  overrides: { title: string | null; version: string | null } | null;
}
/** The provenance of shared rows by key (rows not found are left out). */
export async function platformProvenance(area: RecordArea, keys: string[]): Promise<Map<string, Provenance>> {
  if (!keys.length || isLive(area)) return new Map();
  const rows = await asPlatform(async () => (await q()).query<{ key: string; source: string | null; up_source: string | null; up_title: string | null; up_version: string | null; overridden: boolean }>(
    `SELECT key, source, upstream->>'source' AS up_source, upstream->>'title' AS up_title, upstream->>'version' AS up_version, upstream IS NOT NULL AS overridden
     FROM platform_records WHERE pack = $1 AND area = $2 AND key = ANY($3::text[])`, [area.pack, area.name, keys]));
  return new Map(rows.map((r) => [r.key, {
    by: r.source ? "repository" : "staff", repository: r.source ?? r.up_source ?? null,
    overrides: !r.source && r.overridden ? { title: r.up_title ?? null, version: r.up_version ?? null } : null,
  } satisfies Provenance]));
}

/** Where workspace rows came from and who last wrote them, by key (mold_v0-236; rows not found are left out). */
export async function workspaceProvenance(orgId: number, area: RecordArea, keys: string[]): Promise<Map<string, RowProvenance>> {
  if (!keys.length || isLive(area)) return new Map();
  const rows = await withTenant(orgId, async () => (await q()).query<{ key: string; provenance: RecordProvenance | null; written_by: string | null; updated_by: string | null }>(
    "SELECT key, provenance, written_by, updated_by FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = ANY($4::text[])", [orgId, area.pack, area.name, keys]));
  return new Map(rows.map((r) => [r.key, { by: r.provenance, written_by: r.written_by, updated_by: r.updated_by }]));
}

/**
 * What wrote each workspace area's rows, across every workspace (mold_v0-236): how many rows each provenance has (and
 * how many have none: written before 0042), and the ones its declared contract leaves out. So an area's provenance,
 * `run` included, is worked out from the rows, not only declared. Counts only: never a key, a value or a workspace.
 */
export async function observedProvenance(): Promise<{ pack: string; area: string; declared: RecordProvenance[] | null; rows: Partial<Record<RecordProvenance | "unknown", number>>; undeclared: RecordProvenance[] }[]> {
  const areas = recordAreas().filter((a) => a.scope === "workspace" && !isLive(a));
  if (!areas.length) return [];
  const counts = await asPlatform(async () => (await q()).query<{ pack: string; area: string; provenance: RecordProvenance | null; n: number }>(
    `/* tenant: platform staff, counts per area across every workspace (no key, value or workspace leaves) */
     SELECT pack, area, provenance, count(*)::int AS n FROM workspace_records WHERE pack = ANY($1::text[]) GROUP BY pack, area, provenance`, [[...new Set(areas.map((a) => a.pack))]]));
  return areas.map((a) => {
    const rows: Partial<Record<RecordProvenance | "unknown", number>> = {};
    for (const c of counts) if (c.pack === a.pack && c.area === a.name) rows[c.provenance ?? "unknown"] = (rows[c.provenance ?? "unknown"] ?? 0) + c.n;
    const declared = a.contract ? [...a.contract.provenance] as RecordProvenance[] : null;
    const seen = (Object.keys(rows) as (RecordProvenance | "unknown")[]).filter((k): k is RecordProvenance => k !== "unknown");
    return { pack: a.pack, area: a.name, declared, rows, undeclared: declared ? seen.filter((k) => !declared.includes(k)) : [] };
  });
}

/** A workspace's own rows as stored, by key, opened (mold_v0-234, src/record-import.ts): title and fields, for an import's plan. */
export async function workspaceStored(orgId: number, area: RecordArea, keys: string[]): Promise<Map<string, { title: string | null; data: Record<string, unknown> }>> {
  if (!keys.length || isLive(area)) return new Map();
  return withTenant(orgId, async () => {
    const rows = await (await q()).query<Row>("SELECT key, title, data, updated_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = ANY($4::text[])",
      [orgId, area.pack, area.name, keys]);
    const out = new Map<string, { title: string | null; data: Record<string, unknown> }>();
    for (const r of rows) {
      const data = await openJson(orgId, r.data);
      out.set(r.key, { title: isSealed(r.title) ? await open(orgId, r.title as string) : r.title, data: conform(area, data).data });
    }
    return out;
  });
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
  const scope: { tx: Queryable; orgId: number | null; changes?: RecordChange[] } = { tx: null as unknown as Queryable, orgId };
  const run = async () => (await getDb()).transaction((tx) => txScope.run(Object.assign(scope, { tx }), fn));
  const out = await (orgId === null ? asPlatform(run) : withTenant(orgId, run));
  if (scope.changes?.length) await tell(scope.changes);
  return out;
}

async function batchWorkspace(orgId: number, pack: string, actor: Actor, raw: unknown, max = MAX_BATCH, source: string | null = null, fingerprints?: Map<string, string>, claim = false): Promise<RecordOperationResult[]> {
  const ops = checkOps(raw, max);
  // The data trail (mold_v0-197): each operation's entry, written only when the whole batch commits.
  return auditAtomic(() => inTransaction(orgId, async () => {
    const out: RecordOperationResult[] = [];
    for (const [i, o] of ops.entries()) {
      try {
        if (o.op === "move") out.push({ op: o.op, area: o.area, key: o.key, record: await moveWorkspace(orgId, pack, actor, o.area, o.key, o.to) });
        else if (o.op === "delete") out.push({ op: o.op, area: o.area, key: o.key, deleted: await deleteWorkspace(orgId, pack, actor, o.area, o.key, source) });
        else {
          const fp = source !== null ? fingerprints?.get(`${o.area}\u0000${o.key}`) : undefined;
          out.push({ op: o.op, area: o.area, key: o.key, record: await putWorkspace(orgId, pack, actor, o.area, o.key, { title: o.title, data: o.data }, o.op, source !== null && fp ? { source, fingerprint: fp, claim } : null) });
        }
      } catch (e) { throw numbered(i, o, e); }
    }
    return out;
  }));
}

async function batchPlatform(pack: string | null, raw: unknown, max = MAX_BATCH, source: string | null = null, fingerprints?: Map<string, string>, claim = false): Promise<RecordOperationResult[]> {
  const ops = checkOps(raw, max);
  return inTransaction(null, () => platformOps(pack, ops, source, fingerprints, claim));
}
/** A shared batch's operations, inside its transaction (inTransaction). */
async function platformOps(pack: string | null, ops: RecordOperation[], source: string | null, fingerprints: Map<string, string> | undefined, claim: boolean): Promise<RecordOperationResult[]> {
  const out: RecordOperationResult[] = [];
  for (const [i, o] of ops.entries()) {
    try {
      if (o.op === "move") throw new PackError("a shared area has no lifecycle: its records do not move", 400);
      if (o.op === "delete") out.push({ op: o.op, area: o.area, key: o.key, deleted: await deletePlatform(pack, o.area, o.key, source) });
      else {
        const fp = source !== null ? fingerprints?.get(`${o.area}\u0000${o.key}`) : undefined;
        out.push({ op: o.op, area: o.area, key: o.key, record: await putPlatform(pack, o.area, o.key, { title: o.title, data: o.data, version: o.version }, o.op, source !== null && fp ? { source, fingerprint: fp, claim } : null) });
      }
    } catch (e) { throw numbered(i, o, e); }
  }
  return out;
}

// ---------- a repository's own writer (mold_v0-059; src/data-repositories.ts) ----------

/**
 * A row as its repository last wrote it: its key, its source and fingerprint (never its values); for a shared staff row
 * (mold_v0-221), the source and fingerprint of the repository's version kept behind it.
 */
export interface StoredMark { key: string; source: string | null; fingerprint: string | null; behind_source?: string | null; behind_fingerprint?: string | null }
/** The marks of every row of an area (the workspace's own for a workspace area). */
export async function storedMarks(area: RecordArea, orgId: number | null): Promise<StoredMark[]> {
  if (orgId === null) return asPlatform(async () => (await q()).query<StoredMark>(
    "SELECT key, source, fingerprint, upstream->>'source' AS behind_source, upstream->>'fingerprint' AS behind_fingerprint FROM platform_records WHERE pack = $1 AND area = $2 ORDER BY key", [area.pack, area.name]));
  return withTenant(orgId, async () => (await q()).query<StoredMark>("SELECT key, source, fingerprint FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 ORDER BY key", [orgId, area.pack, area.name]));
}
/**
 * Write a repository's index as one transaction (all of it or none): puts carry the source and their fingerprints; a
 * delete removes only a row of that source. Not reachable from any door: only src/data-repositories.ts calls it.
 */
export async function writeFromRepository(orgId: number | null, pack: string, source: string, ops: RecordOperation[], fingerprints: Map<string, string>, claim = false, behind: BehindOp[] = []): Promise<RecordOperationResult[]> {
  if (!ops.length && !behind.length) return [];
  // mold_v0-221: the repository's versions behind staff rows of shared areas, in the same transaction as its rows.
  if (orgId === null) return inTransaction(null, async () => {
    const out = ops.length ? await platformOps(pack, checkOps(ops, MAX_INDEX_BATCH), source, fingerprints, claim) : [];
    for (const b of behind) await keepBehind(pack, source, b, fingerprints);
    return out;
  });
  // The data trail (mold_v0-197): an index's writes are one entry (its source and how many rows), not one per row.
  return auditAs(orgId, () => batchWorkspace(orgId, pack, SYSTEM_ACTOR, ops, MAX_INDEX_BATCH, source, fingerprints, claim), (r) => ({ action: "update", pack, area: null, key: `index:${source}`.slice(0, 200), rows: r.length }));
}
/**
 * What a repository's index writes behind a shared staff row of one of its keys (mold_v0-221): "put" its version of
 * the row (an override's repository version, refreshed; never the row staff see), "clear" when the repository no
 * longer has the key (the staff row stays, nothing behind it).
 */
export type BehindOp = { op: "put"; area: string; key: string; title?: string | null; data: Record<string, unknown>; version?: string | null } | { op: "clear"; area: string; key: string };
async function keepBehind(pack: string, source: string, b: BehindOp, fingerprints: Map<string, string>) {
  const area = platformAreaFor(pack, b.area);
  const db = await q();
  if (b.op === "clear") {
    await db.query("UPDATE platform_records SET upstream = NULL WHERE pack = $1 AND area = $2 AND key = $3 AND source IS NULL AND upstream->>'source' = $4", [area.pack, area.name, checkKey(b.key), source]);
    return;
  }
  // Checked as the row would be (types, required fields), not its references: it is never read as a record until it is put back.
  const data = checkData(area, b.data, `${area.name} record ${b.key}`);
  await db.query(`UPDATE platform_records SET upstream = jsonb_build_object('title', $4::text, 'data', $5::jsonb, 'version', $6::text, 'source', $7::text, 'fingerprint', $8::text)
    WHERE pack = $1 AND area = $2 AND key = $3 AND source IS NULL`,
    [area.pack, area.name, checkKey(b.key), title(b.title), JSON.stringify(data), b.version == null ? null : String(b.version).slice(0, 120), source, fingerprints.get(`${b.area}\u0000${b.key}`) ?? null]);
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
  reveal: (area, key, fields) => revealFor(orgId, area, key, fields, actor),
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
  // mold_v0-191: the clocks its records run against (what each counts from, its durations, its steps).
  ...(clocksShown(a) ? { clocks: a.clocks!.map((c) => ({ name: c.name, label: c.label, starts: c.starts, after: c.after, ...(c.not_later_than ? { not_later_than: c.not_later_than } : {}),
    ...(c.stops_when ? { stops_when: c.stops_when } : {}), ...(c.pauses_when ? { pauses_when: c.pauses_when } : {}) })) } : {}),
  ...(a.permissions ? { permissions: Object.fromEntries((["read", "create", "update", "move", "delete"] as const).map((k) => [k, allowedRoles(a, k)])) } : {}),
  // mold_v0-234/235: who may export and import, when the area's contract says (else export is read's, and no import).
  ...(a.contract ? { export: exportRoles(a), ...(takesImport(a) ? { import: importRoles(a) } : {}) } : {}),
});

// ---------- MCP: list_records and get_record ----------

/** The two shell tools, built for the declared areas; empty when no pack declares one (the MCP surface is unchanged). */
export function recordTools(): PackTool[] {
  const all = recordAreas();
  if (!all.length) return [];
  // An area whose generated list_ or get_ tool its pack withholds (mold_v0-067: exclude, admin_only) is not offered
  // through these two either (src/mcp-withheld.ts); with nothing withheld both are exactly as before.
  const offered = (op: "list" | "get") => all.filter((a) => !areaOpWithheld(a.name, op));
  const tools = (["list", "get"] as const).map((op) => {
    const areas = offered(op);
    return areas.length ? { names: areas.map((a) => a.name) as [string, ...string[]], catalog: areas.map((a) => `${a.name} (${a.label}: ${a.role}, ${a.scope === "platform" ? "shared" : "this workspace's own"})`).join("; ") } : null;
  });
  return [
    tools[0] && {
      name: "list_records",
      title: "List records",
      description: `List the records of one area, by key, a page at a time (pass next as after for the following page). Areas: ${tools[0].catalog}.`,
      inputSchema: {
        area: z.enum(tools[0].names).describe("The record area"),
        limit: z.number().int().min(1).max(200).optional().describe("Records per page (default 50)"),
        after: z.string().max(200).optional().describe("The next value of the previous page"),
      },
      annotations: { title: "List records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (ws: Workspace, args: { area: string; limit?: number; after?: string }) => {
        const area = areaOrThrow(args.area);
        if (areaOpWithheld(area.name, "list")) throw new PackError(`no record area ${area.name}`, 404);
        const page = await listFor(ws.id, area.name, { limit: args.limit, after: args.after }, { role: ws.role, userId: ws.userId });
        const cols = areaSummary(area).list_columns;
        return {
          area: area.name, label: area.label, role: area.role, scope: area.scope,
          records: page.records.map((r) => ({ key: r.key, title: r.title, ...Object.fromEntries(cols.map((c) => [c, r.data[c] ?? null])),
            // mold_v0-191: a clock area's records say when each is due and whether it is overdue.
            ...(r.clocks ? { due: Object.values(r.clocks).map((v) => ({ clock: v.name, status: v.status, due_at: v.due_at, overdue: v.overdue })) } : {}) })),
          next: page.next,
        };
      },
    },
    tools[1] && {
      name: "get_record",
      title: "Get a record",
      description: `One record of an area by its key, with every field and the records its links name. Areas: ${tools[1].catalog}.`,
      inputSchema: {
        area: z.enum(tools[1].names).describe("The record area"),
        key: z.string().min(1).max(200).describe("The record's key"),
      },
      annotations: { title: "Get a record", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (ws: Workspace, args: { area: string; key: string }) => {
        if (areaOpWithheld(args.area, "get")) throw new PackError(`no record area ${String(args.area).slice(0, 80)}`, 404);
        const d = await detailFor(ws.id, args.area, args.key, { role: ws.role, userId: ws.userId });
        if (!d) throw new PackError(`no record ${args.key} in ${args.area}`, 404);
        return { record: d.record, links: d.links };
      },
    },
  ].filter(Boolean) as unknown as PackTool[];
}

export function registerRecordTools(server: McpServer, run: (t: PackTool, args: Record<string, unknown>) => unknown) {
  for (const t of recordTools())
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema ?? {}, annotations: t.annotations },
      (args: Record<string, unknown>) => run(t, args) as never);
}
