/**
 * The pack seam (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract"): the one shell module a pack may
 * import. A pack is a directory `packs/<id>/` in the build copy with a `pack.json` (id, entry, migrations, console
 * pages, profile words) and an entry module whose default export is `definePack({...})`. `scripts/gen-packs.mjs`
 * reads every pack.json and writes the registry the server and the console import (src/packs.generated.ts,
 * src/pack-migrations.generated.ts, web/src/config/pack-nav.generated.ts); nothing in the shell names a pack.
 *
 * What the shell does with each field today:
 *   tools        wired: registered on the customer MCP server after the shell's own (src/packs.ts), each call run for
 *                the calling workspace under row-level security (withTenant), with the account permission it needs
 *   routes       wired: mounted at /api/packs/<id> (a signed-in person of the workspace; src/pack-routes.ts) and
 *                /api/admin/packs/<id> (platform admins, need(permission) on every change)
 *   migrations   wired (from pack.json): applied after the shell's, in pack order, on the versioned runner
 *                (src/migrate.ts); every pack table ships with row-level security or the build refuses it
 *   recordAreas  wired (mold_v0-047): each area gets a list page and a detail page in the console, and the MCP tools
 *                list_records and get_record, with no pack code (src/record-areas.ts); its rows live in the shell's
 *                platform_records (platform scope: read-only to customers) or workspace_records (workspace scope,
 *                row-level security); a handler reaches them through ctx.records
 *   jobKinds     wired (mold_v0-041): ctx.runs.start(kind, ...) queues a run of the pack's own kind for the calling
 *                workspace; a runner claims it (src/runs.ts, /api/worker/runs) and the workspace harness runs it
 *                (src/run-harness.ts); results become run_results rows checked against the record areas
 *   credentials  wired (mold_v0-034): the workspace credential vault (src/credentials.ts). A workspace's people give
 *                each value in the console (Settings › Credentials; only its last 4 characters are ever shown again); it is
 *                sealed with the workspace's data key; a run of a job kind that names the field in `credentials`
 *                receives it (an environment variable, or a file in a private directory) for the asset and environment
 *                the run targets. Pack code on the server never sees a value: no handler context carries one
 *   onboarding   wired (mold_v0-011): the /app Setup page's pack checklist (src/onboarding.ts, /api/onboarding); each
 *                step's done_when is read for the calling workspace only, from its own events and rows
 *   schedules    wired (mold_v0-035): each workspace gets the pack's default schedules (a job kind of the pack, a cron
 *                expression in UTC, the pack's asset records it runs over); owners turn them off and on, change when they
 *                run and over which assets, and add their own in the console (/app/schedules). The scheduler
 *                (src/schedules.ts) starts due runs through the run engine; a missed tick runs at most once
 *   recordAreas  `due` (mold_v0-035): a workspace check area may name a date field; a daily check posts an in-app
 *                notice and emails the workspace's owners about records due within `within_days`
 *   agentJobKinds wired (mold_v0-061): the agent-workspace runner (src/agent-workspace.ts): an agent repository at a
 *                pinned commit, a declared command, validation and write-back; runs like jobKinds (ctx.runs.start)
 *   onWorkspaceCommit  wired (mold_v0-064): called after a workspace run's snapshot commits, before its results are checked
 *   metrics      wired (mold_v0-063): counts, sums, averages, rates and durations over a record area or the runs'
 *                results, by group or over time, computed for one workspace under its row-level security
 *                (src/metrics.ts, /api/metrics); `charts` show them on the console's tabs
 *   tabs         wired (mold_v0-058): the /app sidebar and its pages (overview charts, an area's table, board, timeline,
 *                runs, reports and the shell's own pages); with no tabs the sidebar is the shell's
 *   repositories wired (mold_v0-059; src/data-repositories.ts): where an area's rows come from, through one adapter
 *                interface: the shell's tables (the default), the workspace store's files (indexed after a commit), an
 *                external HTTP API (read live). No upstream catalogs (mold_v0-283): shared lists are staff records.
 *                `loaders` (code only) turn a repository's files into rows when the declared mapping is not enough
                (mold_v0-123: a map's computed values, retires and only_latest say what an app pack's loader did)
 *   the data API wired (mold_v0-059; src/data-api.ts, src/data-routes.ts): list (filter, sort, paging), get, create,
 *                update, move, delete and batch for every area, at /api/data and /api/admin/data, through the same
 *                record store as ctx.records
 *   mcp          wired (mold_v0-060; src/mcp-tools.ts): MCP tools generated from the declarations above, over the data
 *                API and the run engine, shaped by the pack's `mcp` settings (McpSettingsSchema)
 *
 * Declarative packs (mold_v0-057): everything above but tools and routes can be written in pack.json instead
 * (src/pack-manifest.ts, the schema at packs/pack.schema.json), with no entry at all. gen-packs compiles it into this
 * same definition; a code entry, when there is one, extends it (src/packs.ts mergePack).
 *
 * A pack never imports another shell module (the build refuses it: scripts/gen-packs.mjs), so everything it may use
 * is here: the definition helpers, zod, and the context each handler receives (its workspace and a database handle
 * that reaches only that workspace's rows).
 */
import type { ClockView } from "./clock-math.js";
import { z } from "zod";
import type { AccountPermission, AccountRole } from "./account-roles.js";
import { hrefProblem, NOT_PLAIN } from "./landing.js";
import type { Permission as AdminPermission, PlatformRole } from "./admin-roles.js";
import { parseCron } from "./cron.js";
import { AgentWorkspaceSchema, GATEWAY_PLACEHOLDER, placeholders } from "./agent-workspace-config.js";
import { WorkspaceStoreSchema } from "./workspace-store-policy.js";
import { emailPackProblems, type EmailPackSchema } from "./company-email-config.js";
import { documentProblems, type DocumentsSchema } from "./record-files-config.js";
import { PATTERN_LIMITS, patternProblem } from "./safe-pattern.js";
import { templateProblems } from "./text-template.js";
import { configProblems, PackAgentProfileSchema, PROFILE_ID, templateNames, DEFAULT_PROFILE } from "./agent-profile-spec.js";

import { CheckSchema } from "./check-spec.js";
export { z };

/** The workspace (a customer account) a tool call or a route works for. */
export interface Workspace {
  id: number;
  slug: string;
  name: string | null;
  /** The signed-in person (absent for an account API key). */
  userId: string | null;
  /** Their account role (src/account-roles.ts); null for an account API key, which has no role limits. */
  role: AccountRole | null;
}

/** A database handle. In a workspace context its queries run as the tenant role, limited to that workspace's rows. */
export interface PackDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** One record of a record area (mold_v0-047): its key, a title, and the fields the area declares. */
export interface RecordRow {
  area: string;
  key: string;
  title: string | null;
  data: Record<string, unknown>;
  /** mold_v0-262 (flag record_pages, the console's reads): the titles of the records its references name, {field: {key: title}}. */
  ref_titles?: Record<string, Record<string, string>>;
  /** A platform area's version label (the source it was indexed from); null for workspace areas. */
  version: string | null;
  updated_at: string;
  /**
   * Where the stored row no longer fits its area's declaration (mold_v0-057: a field removed, an option dropped, a type
   * changed after the row was written): each such field, named. Present only when there is one; a field no longer
   * declared is left out of `data`, the rest is shown as stored, and the next write must fit the declaration.
   */
  drift?: string[];
  /** mold_v0-259 (flag teams): who sees it, on an area that declares `visibility`. */
  visibility?: RecordVisibility;
  /** A clock area's deadlines (mold_v0-191, src/record-clocks.ts): each clock's due_at, status and whether it is overdue. */
  clocks?: Record<string, ClockView>;
}
export interface RecordPage { records: RecordRow[]; next: string | null }
export interface RecordInput {
  title?: string | null; data: Record<string, unknown>; version?: string | null;
  /**
   * mold_v0-259 (flag teams; an area declaring `visibility`): who sees the record. On a new record, absent: the area's
   * default. On a change, absent: kept as it is; given: changed (by the record's owner, a lead of its team, or an owner
   * of the workspace).
   */
  visibility?: VisibilityInput;
}
/** A record's visibility as a write gives it (mold_v0-259): a mode, its team (id or name) and its collaborators (people's ids). */
export interface VisibilityInput { mode: "workspace" | "team" | "private"; team?: number | string | null; collaborators?: string[] }
/** A record's visibility as a read shows it (mold_v0-259): records written before the flag are open to the workspace. */
export interface RecordVisibility { mode: "workspace" | "team" | "private" | "inherit"; team: { id: number; name: string } | null; owner: string | null; collaborators: string[];
  /** mold_v0-262: the record an inherited one follows (mode inherit). */
  parent?: { area: string; key: string } }
/**
 * A page of an area (mold_v0-059): `limit` (1-200, default 50); `after` (the previous page's `next`); `sort` (a field, or
 * key, title or updated_at; "-" first for descending; default the key); `filter` ({field: value} or {field: {op: value}},
 * op one of eq, ne, in, lt, lte, gt, gte, contains, prefix, exists; every field a declared one, or key, title, updated_at).
 */
export interface RecordQuery { limit?: number; after?: string; sort?: string; filter?: Record<string, unknown> }
/**
 * One write of a batch (mold_v0-066): `put` creates or replaces, `create` only creates (409 when the key exists),
 * `update` only replaces (404 when it does not), `move` follows the lifecycle, `delete` removes. A batch is one
 * transaction: every operation is checked and applied, or none is.
 */
export type RecordOperation =
  | { op: "put" | "create" | "update"; area: string; key: string; title?: string | null; data: Record<string, unknown>; version?: string | null; visibility?: VisibilityInput }
  | { op: "move"; area: string; key: string; to: string }
  | { op: "delete"; area: string; key: string };
export interface RecordOperationResult { op: RecordOperation["op"]; area: string; key: string; record?: RecordRow; deleted?: boolean }

/**
 * Records as one workspace sees them: every platform area (read only) and the workspace's own rows of every
 * workspace area. `put`, `move` and `delete` reach only this pack's own workspace areas, in this workspace; an asset
 * area's title and data are sealed with the workspace's data key at rest. Every call is checked against the area's
 * declaration for the person the call is made for (mold_v0-057): its permissions for their role, each field's type,
 * required fields, references (to records this workspace sees) and the lifecycle (a put never changes the state; a
 * move goes only along a declared transition).
 */
export interface WorkspaceRecords {
  list(area: string, opts?: RecordQuery): Promise<RecordPage>;
  get(area: string, key: string): Promise<RecordRow | null>;
  put(area: string, key: string, value: RecordInput): Promise<RecordRow>;
  /** Move a record of an area with a lifecycle to state `to` (mold_v0-057). Refused (409) off the declared transitions. */
  move(area: string, key: string, to: string): Promise<RecordRow>;
  delete(area: string, key: string): Promise<boolean>;
  /** Several writes as one transaction (mold_v0-066): all of them, or (on any refusal or error) none. */
  batch(ops: RecordOperation[]): Promise<RecordOperationResult[]>;
  /**
   * The values of a record's encrypted fields (mold_v0-194), for the person the call is made for when the fields'
   * reveal_roles allow it; each reveal is recorded in the data trail. `fields` absent: every encrypted field they may.
   */
  reveal?(area: string, key: string, fields?: string[]): Promise<RevealedFields>;
}
/** What a reveal answers (mold_v0-194): the record, and each revealed field's value (null: none stored). */
export interface RevealedFields { area: string; key: string; fields: Record<string, unknown> }
/** Records as platform staff see them: platform areas only; `put` and `delete` reach this pack's own platform areas. */
export interface PlatformRecords {
  list(area: string, opts?: RecordQuery): Promise<RecordPage>;
  get(area: string, key: string): Promise<RecordRow | null>;
  put(area: string, key: string, value: RecordInput): Promise<RecordRow>;
  delete(area: string, key: string): Promise<boolean>;
  /** Several writes (put, create, update, delete) as one transaction (mold_v0-066): all of them, or none. */
  batch(ops: RecordOperation[]): Promise<RecordOperationResult[]>;
}

/** A run of a job kind (mold_v0-041), as its workspace sees it. */
export interface RunView {
  id: string; pack: string; kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number; max_attempts: number;
  scope: Record<string, unknown>; targets: Record<string, unknown>;
  cost_usd: number; budget_usd: number;
  error_kind: string | null; error: string | null;
  cancel_requested: boolean;
  created_at: string; started_at: string | null; ended_at: string | null;
}
/** One finding of a run: a check record x an asset record (x a source record), with its status. */
export interface RunResultRow {
  check: { area: string; key: string }; asset: { area: string; key: string } | null; source: { area: string; key: string } | null;
  status: "pass" | "fail" | "error" | "not_applicable" | "unknown";
  finding_fingerprint: string | null; evidence_ref: string | null; detail: Record<string, unknown>;
}
/** Runs of this pack's job kinds, for the calling workspace only (the workspace comes from the caller, never input). */
export interface WorkspaceRuns {
  /**
   * `approval` (mold_v0-079): for a kind whose write waits for a yes after its preview, the id (apr_…) of the approval of
   * the preview run whose output is to be written; refused without one, and each approval starts one run.
   */
  start(kind: string, input?: { scope?: Record<string, unknown>; targets?: Record<string, unknown>; approval?: string }): Promise<RunView>;
  get(id: string): Promise<RunView | null>;
  list(opts?: { limit?: number }): Promise<RunView[]>;
  results(id: string): Promise<RunResultRow[]>;
  cancel(id: string): Promise<RunView>;
}

/** One file of a committed workspace snapshot (mold_v0-064): its path in the workspace, its bytes, checked against its sha256. */
export interface WorkspaceFile { path: string; size: number; sha256: string; body: Uint8Array }
/**
 * What a pack's onWorkspaceCommit hook (mold_v0-064) receives besides the files: the run's own workspace (from the run
 * row, never from the run's output), its records and database handle (that workspace only, as a tool's), and the run.
 */
export interface WorkspaceCommitContext {
  pack: string;
  workspace: Workspace;
  db: PackDb;
  records: WorkspaceRecords;
  run: { id: string; kind: string; attempt: number; scope: Record<string, unknown>; targets: Record<string, unknown> };
  /** The snapshot's version, and whether this run changed it (false: the run wrote back the version it checked out). */
  snapshot: { version: number; changed: boolean; manifest_sha256: string };
}

export interface PackToolContext { pack: string; workspace: Workspace; db: PackDb; records: WorkspaceRecords; runs: WorkspaceRuns }

/** What a tool may return: any JSON value (shown as structured content and text), or a full MCP tool result. */
export type PackToolResult = unknown;

export interface PackToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface PackTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Shape;
  outputSchema?: z.ZodRawShape;
  annotations?: PackToolAnnotations;
  /** The account permission a call needs. Default: none for a tool marked readOnlyHint, else "edit". */
  needs?: AccountPermission;
  _meta?: Record<string, unknown>;
  /** The calling workspace comes first. Runs under row-level security for that workspace only. */
  handler: (workspace: Workspace, args: z.infer<z.ZodObject<Shape>>, ctx: PackToolContext) => PackToolResult | Promise<PackToolResult>;
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface RouteBase { method: HttpMethod; path: string }
export interface WorkspaceRouteContext {
  pack: string; workspace: Workspace; db: PackDb; records: WorkspaceRecords; runs: WorkspaceRuns;
  params: Record<string, string>; query: Record<string, unknown>; body: unknown;
}
export interface AdminRouteContext {
  pack: string; admin: { actor: string; role: PlatformRole }; db: PackDb; records: PlatformRecords;
  params: Record<string, string>; query: Record<string, unknown>; body: unknown;
}
/** /api/packs/<id><path>: a signed-in person of the workspace. A change (not GET) needs "edit" unless `needs` says otherwise. */
export interface WorkspaceRoute extends RouteBase {
  scope: "workspace";
  needs?: AccountPermission;
  handler: (ctx: WorkspaceRouteContext) => unknown | Promise<unknown>;
}
/** /api/admin/packs/<id><path>: platform admins. A change (not GET) must name the permission it needs (src/admin-roles.ts). */
export interface AdminRoute extends RouteBase {
  scope: "admin";
  needs?: AdminPermission;
  handler: (ctx: AdminRouteContext) => unknown | Promise<unknown>;
}
export type PackRoute = WorkspaceRoute | AdminRoute;

/** A refusal a route or tool returns on purpose: its message and status reach the caller (other errors are a 500). */
export class PackError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// ---------- declared now, wired by later tickets ----------

const name = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lowercase letters, digits and _, starting with a letter");
/** mold_v0-260: a list's columns: 8, up to 12 with the flag wide_lists (WIDE_LIST_MAX); a sections tab's in-page tabs, up to 8. */
export const LIST_COLUMNS_MAX = 8, WIDE_LIST_MAX = 12, SECTIONS_MAX = 8;
/**
 * A record key (mold_v0-047; ( and ) since mold_v0-066): 1-200 of letters, digits and . _ : ( ) -, starting with a letter
 * or digit. Keys are stored and compared as they are; wherever the shell puts one inside a larger string (a paging
 * cursor, a URL), it is encoded there and decoded back (src/record-query.ts).
 */
export const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:()-]{0,199}$/;
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/, "an environment variable name");
/**
 * A host a run may reach: HTTPS on port 443 only. The egress proxy (orchestrator/core/egress.ts, shared with the
 * sandboxes) allows a listed host and every subdomain of it, so "api.example.com" also allows "x.api.example.com";
 * "*.example.com" is accepted and means "example.com" and its subdomains.
 */
const host = z.string().regex(/^(\*\.)?(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "a host name (HTTPS on port 443; a host allows its subdomains too)");
const packFile = z.string().regex(/^[a-z0-9_\-][a-z0-9_\-/.]*\.m?js$/i, "a .js or .mjs file inside the pack").refine((p) => !p.split("/").includes(".."), "a file inside the pack");

// ---------- record fields, lifecycles and permissions (mold_v0-047, typed by mold_v0-057) ----------

/** The account roles (src/account-roles.ts), in order: what a declaration may name in permissions and transitions. */
export const DECLARABLE_ROLES = ["viewer", "member", "billing", "owner"] as const;
/** The roles the platform lets change anything (account permission "edit"): a write permission may name only these. */
export const WRITE_ROLES = ["member", "billing", "owner"] as const;
const role = z.enum(DECLARABLE_ROLES);
/**
 * A choice of an enum field (and so a lifecycle state): the stored value and what a person reads. Values are plain
 * words (letters, digits, space and . _ : / - ( ) &), never markup or quotes: they reach screens, MCP answers and queries
 * only as data, and this keeps them that way wherever they are shown.
 */
const choiceValue = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:/()&-]{0,79}$/, "a choice value: 1-80 letters, digits, spaces and _ . : / ( ) & -, starting with a letter or digit");
const choice = z.union([choiceValue, z.object({ value: choiceValue, label: z.string().min(1).max(80).optional() }).strict()]);
export const FIELD_TYPES = ["text", "number", "date", "boolean", "json", "link", "enum", "person", "reference", "file", "url", "repository", "database"] as const;
/**
 * mold_v0-282 (flag record_resources; src/record-resources.ts): the field types that are a record's own resource, on a
 * shared (platform) area written by staff: `repository` links an existing GitHub repository, `database` is one Postgres
 * database the platform creates for the record (its `provider`).
 */
export const RESOURCE_FIELD_TYPES = ["repository", "database"] as const;
/** The providers a database field may name (mold_v0-282): Neon, through its API v2 with the key vault's `neon` key. */
export const DATABASE_PROVIDERS = ["neon"] as const;
/** A repository field's value (mold_v0-282): a GitHub repository as owner/name (GitHub's own limits on each part). */
export const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/;
/** The longest a url field's address may be (mold_v0-238). */
export const URL_MAX = 2048;
/**
 * Whether `v` is a url field's value (mold_v0-238): an absolute http or https address of at most URL_MAX characters, with
 * a host and no user name or password in it. Pure: the record store, the MCP tools' input and the console read it.
 */
export function isFieldUrl(v: unknown): v is string {
  // Written as an address with its host right after the scheme (a parser would also read "https:///x" or "https:x").
  if (typeof v !== "string" || v.length > URL_MAX || !/^https?:\/\/[^/?#\\\s]/i.test(v) || /[\u0000-\u001f\u007f\s]/.test(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname && !u.username && !u.password;
}
/** The field types an encrypted field may have (mold_v0-194): values the shell never needs to read itself. */
export const ENCRYPTABLE_TYPES = ["text", "number", "date", "boolean", "json", "enum"] as const;
/**
 * A field of a record area (or an argument of a job kind):
 *   text, number, date, boolean, json   as they read; `max_length` (text), `min`/`max` (number)
 *   enum        one of `options` (a list of values or {value, label}); `multiple` takes a list of them
 *   person      a person of the workspace, by their sign-in id; `multiple` takes a list
 *   reference   the key of a record of area `to` (`multiple`: a list of keys); on write the record must exist as the
 *               writer sees it (the same workspace for a workspace area), so a reference never reaches another
 *               workspace's records; a shared (platform) area may refer only to shared areas
 *   file        a file reference {path, name?, sha256?, size?}: a path inside the workspace's store (no "..", no
 *               leading "/"); or a stored file {object, name, size, content_type, sha256} (mold_v0-220,
 *               src/record-files.ts: an object kept for the record, sealed with the workspace's data key); `multiple`
 *               takes a list
 *   link        the 047 form of reference (a key or a list of keys, resolved through the area's `links`)
 *   url         (mold_v0-238) an absolute http or https address of up to 2048 characters, with no user name or password
 *               (isFieldUrl); `preview: "document"` makes the record's card fetch and preview its document
 *   repository  (mold_v0-282, flag record_resources) an existing GitHub repository, owner/name, that staff link to a
 *               shared record: checked on save through the platform's GitHub App, its default branch and last commit
 *               shown on the record's page
 *   database    (mold_v0-282, flag record_resources) one Postgres database of the record's own, created by the platform
 *               when the record is created (`provider: "neon"`) and deleted with it; it takes no value: its connection
 *               string is sealed apart from the record's fields (src/record-resources.ts)
 * `required` refuses a write that leaves it empty.
 */
/**
 * mold_v0-260 (flag record_rules): which records of its target area a reference field may name, a condition on the
 * target's own fields: one test (`equals`, `in`, `not_in`, `empty`) of one field, or `all` of up to 6 such tests. The
 * console's record picker lists only the records it keeps, and every write (the data API, the forms, the MCP tools, an
 * import) refuses a key whose record it does not keep, as the writer reads that record. Evaluated by conditionHolds.
 */
const refScalar = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);
const ReferenceWhereLeafSchema = z.object({
  field: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a field of the area it refers to"),
  equals: refScalar.optional(),
  in: z.array(refScalar).min(1).max(20).optional(),
  not_in: z.array(refScalar).min(1).max(20).optional(),
  empty: z.boolean().optional(),
}).strict().refine((c) => [c.equals, c.in, c.not_in, c.empty].filter((x) => x !== undefined).length === 1, "one test: equals, in, not_in or empty");
export const ReferenceWhereSchema = z.union([ReferenceWhereLeafSchema, z.object({ all: z.array(ReferenceWhereLeafSchema).min(1).max(6) }).strict()]);
export type ReferenceWhere = z.output<typeof ReferenceWhereSchema>;
/** The fields a reference's `where` tests. */
export const referenceWhereFields = (w: ReferenceWhere): string[] => ("all" in w ? w.all.map((c) => c.field) : [w.field]);
/** In words, what a reference's `where` keeps ("whose Status is active"), for a refusal and the picker. */
export function referenceWhereWords(w: ReferenceWhere, label: (field: string) => string = (f) => f): string {
  const one = (c: z.output<typeof ReferenceWhereLeafSchema>) => {
    const l = label(c.field);
    if (c.equals !== undefined) return `whose ${l} is ${String(c.equals)}`;
    if (c.in) return `whose ${l} is ${c.in.map(String).join(" or ")}`;
    if (c.not_in) return `whose ${l} is not ${c.not_in.map(String).join(" or ")}`;
    return c.empty ? `with no ${l}` : `with a ${l}`;
  };
  return "all" in w ? w.all.map(one).join(" and ") : one(w);
}

export const RecordFieldSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPES).default("text"),
  help: z.string().max(300).optional(),
  required: z.boolean().optional(),
  options: z.array(choice).min(1).max(100).optional(),
  to: name.optional(),
  multiple: z.boolean().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  max_length: z.number().int().min(1).max(20_000).optional(),
  /**
   * Encrypted at rest (mold_v0-194; src/encrypted-fields.ts): the value is sealed with the workspace's data key (wrapped
   * by the app's vault key) and bound to its workspace, area, record and field. Every read (lists, a record's page, the
   * MCP tools, exports, the developer API, webhooks) shows ENCRYPTED_MASK in its place; only an explicit reveal returns
   * it, to `reveal_roles`, and each reveal is a `reveal` entry of the data trail. A workspace area's field in the shell's
   * own tables only; types text, number, date, boolean, json and single enum.
   */
  encrypted: z.boolean().optional(),
  /** Who may reveal an encrypted field (default: the roles that may update the area's records). */
  reveal_roles: z.array(role).min(1).max(4).optional(),
  /**
   * "equality": a keyed blind index (HMAC-SHA256 under a key derived from the workspace's data key) is kept beside the
   * value, so a filter `{field: value}` (eq) finds it; no other operator, no sort.
   */
  searchable: z.enum(["equality"]).optional(),
  /**
   * "document" (mold_v0-220; src/record-files.ts, src/document-fetch.ts): a url field (mold_v0-238), or a text field
   * holding a URL, whose record's card previews the document, fetched through the pack's `documents.hosts` only and
   * kept in the object store.
   */
  preview: z.enum(["document"]).optional(),
  /**
   * A copy button beside its value on the record's page (mold_v0-253, flag record_pages): in the layout's sections and
   * facts, with a toast; a value a person copies elsewhere (an address, an identifier, a commit). Never on an encrypted
   * or file field (the page never holds the value) or a json one (no one line to copy).
   */
  copyable: z.boolean().optional(),
  /** mold_v0-260 (flag record_rules): a reference field's condition on the records it may name (ReferenceWhereSchema). */
  where: ReferenceWhereSchema.optional(),
  /**
   * mold_v0-262 (flag record_pages): "chips": a json field holding a list of short strings (tags, hosts, stacks) shown
   * as chips in its list's cells, its record's sections and facts, and the peek (the first four in a cell, then +N).
   */
  display: z.enum(["chips"]).optional(),
  /** mold_v0-282 (flag record_resources): a database field's provider ("neon": a Neon project per record). */
  provider: z.enum(DATABASE_PROVIDERS).optional(),
}).strict().superRefine((f, ctx) => {
  const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
  if (f.reveal_roles && !f.encrypted) bad("reveal_roles is for an encrypted field", "reveal_roles");
  if (f.searchable && !f.encrypted) bad("searchable is for an encrypted field (any other field is filtered as it is)", "searchable");
  if (f.encrypted && !ENCRYPTABLE_TYPES.includes(f.type as (typeof ENCRYPTABLE_TYPES)[number])) bad(`an encrypted field is text, number, date, boolean, json or enum (a ${f.type} field is read by the shell itself)`, "encrypted");
  if (f.encrypted && f.multiple) bad("an encrypted field holds one value (not multiple)", "encrypted");
  if (f.type === "enum" && !f.options) bad("an enum field lists its options", "options");
  if (f.type !== "enum" && f.options) bad("options are for an enum field only", "options");
  if (f.options) {
    const vals = f.options.map((o) => (typeof o === "string" ? o : o.value));
    if (new Set(vals).size !== vals.length) bad("an option is listed twice", "options");
  }
  if (f.type === "reference" && !f.to) bad("a reference field names the area it refers to (to)", "to");
  if (f.type !== "reference" && f.to) bad("to is for a reference field only", "to");
  if (f.where && f.type !== "reference") bad("where is for a reference field only (the records it may name)", "where");
  if (f.multiple && !["enum", "person", "reference", "file"].includes(f.type)) bad("multiple is for enum, person, reference and file fields", "multiple");
  if ((f.min !== undefined || f.max !== undefined) && f.type !== "number") bad("min and max are for a number field", "min");
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) bad("min is above max", "min");
  if (f.max_length !== undefined && f.type !== "text") bad("max_length is for a text field", "max_length");
  if (f.copyable && (f.encrypted || f.type === "file" || f.type === "json")) bad(`copyable is for a value the page shows in full (not an encrypted, file or json field)`, "copyable");
  if (f.display === "chips" && (f.type !== "json" || f.encrypted)) bad("display: \"chips\" is for a json field holding a list of strings (not encrypted)", "display");
  if (f.preview && (!["text", "url"].includes(f.type) || f.encrypted)) bad("preview: \"document\" is for a url field, or a text field holding a URL (not encrypted)", "preview");
  // mold_v0-282: a database field says who creates it; nothing else names a provider.
  if (f.type === "database" && !f.provider) bad("a database field names its provider (provider: \"neon\")", "provider");
  if (f.type !== "database" && f.provider) bad("provider is for a database field only", "provider");
  if (f.type === "database" && f.required) bad("a database field takes no value (the platform creates it): it cannot be required", "required");
});
const field = RecordFieldSchema;
/** The stored values of an enum field's options, in order. */
export const optionValues = (f: { options?: z.output<typeof choice>[] }) => (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));

/**
 * A lifecycle (mold_v0-057): the states of a workspace area's records and the moves between them. `field` names one of
 * the area's enum fields; its options are the states. A new record starts in `initial`; a write never changes the state
 * (it is carried over); only a move does, and only along a transition whose `from` holds the stored state ("*": any)
 * and whose `to` is the new one, by a caller whose role is in the transition's `roles` (any role that may move, when
 * absent) and in the area's `move` permission.
 */
export const LifecycleSchema = z.object({
  field: name,
  initial: choiceValue,
  transitions: z.array(z.object({
    from: z.union([z.literal("*"), z.array(choiceValue).min(1).max(100)]),
    to: choiceValue,
    label: z.string().min(1).max(80).optional(),
    roles: z.array(role).min(1).max(4).optional(),
  }).strict()).min(1).max(200),
}).strict();

/**
 * Who may do what to an area's records (mold_v0-057), as lists of account roles. Defaults: `read` every role; `create`,
 * `update`, `move` the roles that may change anything (member, billing, owner: the platform's "edit"); `delete` as
 * `update`. A declaration can only narrow the platform: a write naming "viewer" (read-only in the platform) is refused
 * at build, and at run time a role must hold both the declaration and the platform's permission. A shared (platform)
 * area declares `read` only: its rows are written by platform staff, never by a workspace.
 */
export const PermissionsSchema = z.object({
  read: z.array(role).min(1).max(4).optional(),
  create: z.array(role).min(1).max(4).optional(),
  update: z.array(role).min(1).max(4).optional(),
  move: z.array(role).min(1).max(4).optional(),
  delete: z.array(role).min(1).max(4).optional(),
}).strict();
export type RecordAction = keyof z.output<typeof PermissionsSchema>;

/**
 * A run kind (wired by mold_v0-041; src/runs.ts, src/run-harness.ts): what runs, for how long, at what cost, reaching
 * which hosts. A run of it gets a gateway token for `providers` that lives `token_lifetime_seconds` (the attempt's
 * deadline: the token never expires before the run is stopped), a lease it renews by heartbeat every
 * `lease_seconds / 3`, up to `max_attempts` attempts when the infrastructure fails, and a spend limit `budget_usd`
 * across all its attempts, enforced by the gateway.
 *   runner     "workspace-harness": the harness checks the workspace out (when `workspace`), runs `entry` with node in
 *              it, then `validator` (exit 0 means valid), and writes the workspace back only then (mold_v0-033)
 *   entry      the run's program, a file inside the pack; exit 0 done, 75 an infrastructure failure (retried), else failed.
 *              Put it under the pack's runner directory (pack.json `runner`, mold_v0-054) when it starts processes or
 *              needs more of node than server code may import: scripts/gen-packs.mjs holds runner code to its own rules
 *   egress     the hosts the run may reach besides the gateway, through the run's egress proxy
 *
 * Or `runner: "agent-workspace"` (mold_v0-061; src/agent-workspace.ts): no program of the pack's own, but an agent
 * repository at a pinned commit, configured by `agent` (src/agent-workspace-config.ts: plain JSON, the same in a
 * pack.json): fetched at exactly that commit, the workspace's files restored into it, run with the declared command as
 * the run's user, validated, and written back only when the validation exits 0. Its runs always use the workspace store.
 *
 * Both take `unresolved_references` (mold_v0-065): what the engine does with a result that names a record that does not
 * exist for the run's workspace. "reject" (the default): the whole run's results are refused and the run fails.
 * "drop": that result is left out. "downgrade": the missing asset or source reference is cleared and kept, as written,
 * in the result's detail (`unresolved`); a missing check cannot be cleared, so that result is left out. Each one is
 * reported in the run's events (`result_unresolved`), with the result's status, and counted in its "succeeded" event;
 * more than `max_unresolved` of them (default 100) and the run's results are refused as with "reject". A reference to
 * an area that is not declared, or not of the role it is used in, is a mistake in the pack: always refused.
 */
/**
 * Price per run (mold_v0-019; src/run-charges.ts): what one run of the kind is charged when it ends, in `currency`
 * (ISO 4217, lower case: the app's billing currency). `fixed` is an amount in major units (2.5 is $2.50);
 * `cost_plus_percent` charges the run's metered model cost (USD, from the gateway, never a figure the run reports) plus
 * that percent, so it needs `currency` usd. Either or both. A succeeded run pays both. `on_failure` says what a failed
 * run pays ("free", the default; "cost": the cost-plus part; "full") and `on_cancel` a cancelled one ("free" or
 * "cost"); a run the platform failed (infrastructure) is never charged. A price does nothing unless the app's profile
 * turns billing on (profile.json `billing`), and the profile's rules bound it: the currency must be the app's, the
 * fixed amount and the percent are clamped to its ceilings, and a failed or cancelled run is charged only when the
 * profile allows it. A pack can price its runs; it can never raise what the platform allows.
 */
export const RunPriceSchema = z.object({
  currency: z.string().regex(/^[a-z]{3}$/, "a currency code in lower case, e.g. usd"),
  fixed: z.number().min(0).max(1_000_000).optional(),
  cost_plus_percent: z.number().min(0).max(10_000).optional(),
  on_failure: z.enum(["free", "cost", "full"]).default("free"),
  on_cancel: z.enum(["free", "cost"]).default("free"),
}).strict()
  .refine((p) => p.fixed !== undefined || p.cost_plus_percent !== undefined, "a price needs fixed, cost_plus_percent or both")
  .refine((p) => p.cost_plus_percent === undefined || p.currency === "usd", { message: "cost_plus_percent charges model cost, which is in usd: the price's currency must be usd", path: ["cost_plus_percent"] })
  .refine((p) => (p.on_failure !== "cost" && p.on_cancel !== "cost") || p.cost_plus_percent !== undefined, { message: "\"cost\" charges the cost-plus part: declare cost_plus_percent", path: ["on_failure"] });

const jobKindBase = {
  name,
  label: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  providers: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/, "a gateway provider slug")).max(8).default([]),
  token_lifetime_seconds: z.number().int().min(60).max(24 * 3600).default(3600),
  lease_seconds: z.number().int().min(15).max(3600).default(120),
  max_attempts: z.number().int().min(1).max(10).default(3),
  budget_usd: z.number().positive().max(10_000).default(5),
  /**
   * Limits per kind (mold_v0-018; src/run-limits.ts): runs of this kind one workspace may have running at once, and this
   * kind's spend per workspace per calendar month. Absent, the platform's; never above the platform's (src/rate-limits.ts
   * `runs`), as `budget_usd` is never above its ceiling.
   */
  concurrency_per_workspace: z.number().int().min(1).max(100).optional(),
  month_budget_usd: z.number().positive().max(100_000).optional(),
  price: RunPriceSchema.optional(),
  egress: z.array(host).max(50).default([]),
  /** The workspace store (mold_v0-033): check the workspace's snapshot out before the run, write it back after. */
  workspace: z.boolean().default(false),
  /**
   * The pack's credential fields a run of this kind receives (mold_v0-034), by name; none by default. Each is delivered
   * as the field declares (deliver_as), and only the value bound to what the run targets (src/credentials.ts).
   */
  credentials: z.array(name).max(20).default([]),
  /**
   * mold_v0-260 (flag record_run_inputs): a run started on a record takes these arguments from that record, each
   * argument -> a field of the record, `$key` or `$title`. Its start tool then takes `record` ({area, key}: one of the
   * workspace's records of an area that has every field named) and a record page's start_run action fills them on the
   * server; an argument given beside a record that disagrees with the record is refused.
   */
  input_from_record: z.record(name, z.string().regex(/^(\$key|\$title|[a-z][a-z0-9_]{1,62})$/, "a field of the record, $key or $title"))
    .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 30, "1 to 30 arguments").optional(),
  /**
   * Credentials the platform's operators hold (mold_v0-075; the pack's `operatorCredentials`, values in the platform's
   * key vault, provider "pack_credentials", label "<pack>.<name>"), by name; none by default. Delivered to the run as the
   * field declares, like a workspace's, and never shown to the workspace: no console lists them, no workspace sets or
   * reads them, and the run's output (events, results, its workspace) is redacted of them and refused when it holds one.
   */
  operator_credentials: z.array(name).max(10).default([]),
  /**
   * Per-company egress (mold_v0-075): the run may also reach the hosts its workspace's owners listed for this pack (the
   * whole workspace's, and those of the asset the run targets: src/egress-hosts.ts), each exactly (never a subdomain),
   * added to the run's allowlist. Off by default.
   */
  company_egress: z.boolean().default(false),
  /**
   * Hosts reached only with a credential (mold_v0-184): each entry's `hosts` (the pack's own, like `egress`: a subdomain
   * is reached too) join the run's allowlist at claim only when the run's own slot holds a value of one of its
   * `credentials` (the kind's workspace credentials). An optional read-only cloud key opens that cloud's API; a run whose
   * workspace never set it reaches only `egress`. None by default.
   */
  credential_egress: z.array(z.object({
    credentials: z.array(name).min(1).max(10),
    hosts: z.array(host).min(1).max(10),
  }).strict()).max(5).default([]),
  /**
   * The run may need the workspace's own private network (mold_v0-036; src/onprem-runners.ts): when the workspace chose
   * to run such runs on premises and has enrolled a runner there, a run of this kind is routed to one of that
   * workspace's own runners (never another workspace's), which carries it out in a run sandbox with the same lockdown,
   * plus the private hosts and networks the runner's owner allows. Otherwise (the default, and with no runner) it runs
   * hosted, as any other kind. Off by default.
   */
  private_network: z.boolean().default(false),
  /**
   * An approval gate (mold_v0-079): a run of this kind (a write) starts only with an approval of a run of its `preview`
   * kind (a dry run of the same pack) that succeeded, for the same scope and targets, given by the workspace's `owner`
   * (default) or the platform's `operator` for exactly that run's output (its sha256), within `expires_minutes`
   * (default 1440), and used once. The workspace must not have changed since the preview.
   */
  approval: z.object({
    preview: name,
    by: z.enum(["owner", "operator"]).default("owner"),
    expires_minutes: z.number().int().min(5).max(7 * 24 * 60).default(24 * 60),
  }).strict().optional(),
  /**
   * The run's arguments (mold_v0-057): typed like a record area's fields (the same types and checks). When declared, a
   * run's `scope` must be exactly these (unknown keys refused, each value of its type, required ones present); checked
   * when a pack's code starts the run (src/packs.ts declaredRuns). Absent: the scope is free, as before.
   */
  args: z.array(field).max(30).optional()
    .refine((a) => !(a ?? []).some((f) => f.encrypted || f.searchable || f.reveal_roles), "encrypted, searchable and reveal_roles are for a record area's fields, not a job kind's arguments")
    // mold_v0-282: a record's own repository or database is a shared record's field, never a run's argument.
    .refine((a) => !(a ?? []).some((f) => f.type === "repository" || f.type === "database"), "repository and database are a shared record area's fields, not a job kind's arguments"),
  unresolved_references: z.enum(["reject", "drop", "downgrade"]).default("reject"),
  max_unresolved: z.number().int().min(0).max(5000).default(100),
  /**
   * The run's report (mold_v0-060): a file the run writes into its workspace (a workspace kind only; for an agent kind,
   * under one of its write-back paths). The generated MCP tools (src/mcp-tools.ts) add get_<kind>_report, which reads it
   * from the snapshot the run committed, for the run's own workspace only.
   */
  report: z.object({
    path: z.string().regex(/^(?!\/)(?!.*\/\/)[A-Za-z0-9._ /-]{1,300}$/, "a path inside the workspace's files")
      .refine((p) => !p.split("/").some((s) => s === "." || s === ".." || s === ""), "a path inside the workspace's files"),
    label: z.string().min(1).max(80).optional(),
    format: z.enum(["markdown", "text", "json"]).default("markdown"),
  }).strict().optional(),
};
/**
 * A kind given the platform's operator credentials never reaches hosts a workspace chose (mold_v0-075 review: the
 * workspace's owner could list a host of their own and have the run send the operator's value there).
 */
const OP_EGRESS = "a kind with operator_credentials cannot take company_egress (a host the workspace chose would reach the operator's credential)";
/** mold_v0-184: a credential_egress entry names the kind's own workspace credentials. */
const CRED_EGRESS = "credential_egress names a credential that is not one of the kind's credentials";
/** mold_v0-260: input_from_record names the kind's own arguments. */
const INPUT_FROM_RECORD = "input_from_record names an argument the kind does not declare (args)";
/** A gated write runs once per approval (mold_v0-079 review: a retried attempt would write again on one yes). */
const ONE_ATTEMPT = "a kind that waits for an approval runs once per approval: max_attempts must be 1";
export const JobKindSchema = z.object({
  ...jobKindBase,
  runner: z.literal("workspace-harness"),
  image: z.string().min(1).optional(),
  entry: packFile,
  validator: packFile.optional(),
}).strict()
  .refine((k) => new Set((k.args ?? []).map((a) => a.name)).size === (k.args ?? []).length, "an argument is declared twice")
  .refine((k) => k.approval?.preview !== k.name, { message: "a kind is not its own preview", path: ["approval", "preview"] })
  .refine((k) => !(k.operator_credentials.length && k.company_egress), { message: OP_EGRESS, path: ["company_egress"] })
  .refine((k) => k.credential_egress.every((r) => r.credentials.every((c) => k.credentials.includes(c))), { message: CRED_EGRESS, path: ["credential_egress"] })
  .refine((k) => !k.approval || k.max_attempts === 1, { message: ONE_ATTEMPT, path: ["max_attempts"] })
  .refine((k) => !k.report || k.workspace, { message: "a report is a file of the run's workspace: the kind needs workspace: true", path: ["report"] })
  .refine((k) => Object.keys(k.input_from_record ?? {}).every((a) => (k.args ?? []).some((x) => x.name === a)), { message: INPUT_FROM_RECORD, path: ["input_from_record"] });

/**
 * A job kind for the built-in agent-workspace runner (mold_v0-061: an agent repository at a pinned commit, a declared
 * command, validation and write-back). Declared and validated here (mold_v0-057) with everything but the runner's own
 * settings, which 061 adds (`agent`, src/agent-workspace-config.ts); a pack.json may declare one with no program of its
 * own. Wired by mold_v0-061: the run engine takes them beside `jobKinds` (src/runs.ts jobKinds) and the harness runs
 * them (src/run-harness.ts, src/agent-workspace.ts).
 */
export const AgentJobKindSchema = z.object({
  ...jobKindBase,
  runner: z.literal("agent-workspace"),
  /** Always true: the agent's write-back paths are the workspace (src/workspace-store.ts). */
  workspace: z.literal(true).default(true),
  agent: AgentWorkspaceSchema,
}).strict().superRefine((k, ctx) => {
  if (new Set((k.args ?? []).map((a) => a.name)).size !== (k.args ?? []).length) ctx.addIssue({ code: "custom", message: "an argument is declared twice", path: ["args"] });
  for (const a of Object.keys(k.input_from_record ?? {})) if (!(k.args ?? []).some((x) => x.name === a)) ctx.addIssue({ code: "custom", message: `${a}: ${INPUT_FROM_RECORD}`, path: ["input_from_record", a] });
  if (k.report && !k.agent.write_back.some((w) => k.report!.path === w || k.report!.path.startsWith(`${w.replace(/\/+$/, "")}/`)))
    ctx.addIssue({ code: "custom", message: "the report must be under one of agent.write_back (only those paths are kept in the workspace)", path: ["report", "path"] });
  if (k.agent.timeout_seconds > k.token_lifetime_seconds)
    ctx.addIssue({ code: "custom", message: "agent.timeout_seconds is longer than token_lifetime_seconds (the run's deadline)", path: ["agent", "timeout_seconds"] });
  for (const [name, v] of Object.entries(k.agent.env)) for (const p of placeholders(v)) {
    const m = GATEWAY_PLACEHOLDER.exec(p);
    if (m && !k.providers.length) ctx.addIssue({ code: "custom", message: `{${p}} needs a gateway provider (providers)`, path: ["agent", "env", name] });
    if (m?.[2] && !k.providers.includes(m[2])) ctx.addIssue({ code: "custom", message: `{${p}}: ${m[2]} is not one of the kind's providers`, path: ["agent", "env", name] });
  }
  for (const name of Object.keys(k.agent.env)) if (RESERVED_ENV.test(name))
    ctx.addIssue({ code: "custom", message: `${name} is set by the shell for every run (PATH, HOME, RUN_*, proxy and loader settings)`, path: ["agent", "env", name] });
  // mold_v0-074: what a step or the command receives is one of the kind's credentials; git hosts are reachable.
  const issue = (message: string, ...p: (string | number)[]) => ctx.addIssue({ code: "custom", message, path: ["agent", ...p] });
  const own = new Set([...k.credentials, ...k.operator_credentials]);
  const onEgress = (h: string) => k.egress.some((e) => { const x = e.replace(/^\*\./, "").toLowerCase(); return h === x || h.endsWith(`.${x}`); });
  for (const n of k.agent.credentials ?? []) if (!own.has(n)) issue(`${n} is not one of the kind's credentials`, "credentials");
  if (k.approval?.preview === k.name) ctx.addIssue({ code: "custom", message: "a kind is not its own preview", path: ["approval", "preview"] });
  if (k.operator_credentials.length && k.company_egress) ctx.addIssue({ code: "custom", message: OP_EGRESS, path: ["company_egress"] });
  for (const [i, r] of k.credential_egress.entries()) for (const c of r.credentials)
    if (!k.credentials.includes(c)) ctx.addIssue({ code: "custom", message: `${c}: ${CRED_EGRESS}`, path: ["credential_egress", i, "credentials"] });
  if (k.approval && k.max_attempts !== 1) ctx.addIssue({ code: "custom", message: ONE_ATTEMPT, path: ["max_attempts"] });
  for (const n of k.operator_credentials) if (k.credentials.includes(n)) ctx.addIssue({ code: "custom", message: `${n} is both a workspace and an operator credential`, path: ["operator_credentials"] });
  for (const [j, g] of k.agent.git_credentials.entries()) {
    if (!own.has(g.credential)) issue(`${g.credential} is not one of the kind's credentials`, "git_credentials", j, "credential");
    if (!onEgress(g.host)) issue(`${g.host} is not in the kind's egress (git could not reach it)`, "git_credentials", j, "host");
  }
  let total = k.agent.timeout_seconds;
  for (const [i, st] of k.agent.steps.entries()) {
    total += st.timeout_seconds;
    for (const n of st.credentials) if (!own.has(n)) issue(`${n} is not one of the kind's credentials`, "steps", i, "credentials");
    for (const [j, g] of st.git_credentials.entries()) {
      if (!own.has(g.credential)) issue(`${g.credential} is not one of the kind's credentials`, "steps", i, "git_credentials", j, "credential");
      if (!onEgress(g.host)) issue(`${g.host} is not in the kind's egress (git could not reach it)`, "steps", i, "git_credentials", j, "host");
    }
    if (st.checkout?.credential && !own.has(st.checkout.credential)) issue(`${st.checkout.credential} is not one of the kind's credentials`, "steps", i, "checkout", "credential");
    for (const h of st.checkout?.hosts ?? []) if (!onEgress(h)) issue(`${h} is not in the kind's egress`, "steps", i, "checkout", "hosts");
  }
  if (total > k.token_lifetime_seconds) issue(`the steps and the command may take ${total} s, longer than token_lifetime_seconds (the run's deadline)`, "steps");
  // mold_v0-166: the hosts an input's repositories are pinned on are reached by git: each in the kind's egress.
  for (const [name, inp] of Object.entries(k.agent.inputs)) for (const h of inp.pin?.hosts ?? []) if (!onEgress(h)) issue(`${h} is not in the kind's egress (git could not reach it)`, "inputs", name, "pin", "hosts");
  // mold_v0-073: an input from the run's scope is one of the kind's declared arguments when it declares them.
  if (k.args) for (const [name, inp] of Object.entries(k.agent.inputs)) {
    const [root, key] = inp.from.split(".");
    if (root === "scope" && !k.args.some((a) => a.name === key)) issue(`input ${name}: ${inp.from} is not one of the kind's arguments (args)`, "inputs", name, "from");
  }
});

// ---------- clocks on a workspace area's records (mold_v0-191; src/clock-math.ts, src/record-clocks.ts) ----------

/**
 * A duration a clock counts: a whole number and a unit, `h` (hours) or `d` (calendar days), or `bd` (business days:
 * Monday to Friday, UTC; a pause or a start on a weekend counts no business time). "90d", "10bd", "48h".
 */
export const CLOCK_DURATION = /^(0|[1-9][0-9]{0,4})(h|d|bd)$/;
const clockDuration = z.string().regex(CLOCK_DURATION, 'a duration: a whole number then h (hours), d (calendar days) or bd (business days, Monday to Friday, UTC): "90d", "10bd", "48h"');
/** Who a clock's reminder or escalation step tells: the record's assignee (the clock's `assignee` person field) or the workspace's people with a role. */
export const CLOCK_AUDIENCE = ["assignee", ...DECLARABLE_ROLES] as const;
const audience = z.array(z.enum(CLOCK_AUDIENCE)).min(1).max(5);
const clockMatch = z.object({ field: name, in: z.array(choiceValue).min(1).max(20) }).strict();
/**
 * A clock (mold_v0-191): a deadline each record of a workspace area runs against, declared in pack.json, evaluated by
 * the shell (src/record-clocks.ts) on reads and by the scheduler's clock check. No pack code.
 *   starts          {field: a date field} (the record's own date), {event: "created"} (when the record was added) or
 *                   {event: "entered", state} (when it last entered a state of the area's lifecycle). No start: no deadline
 *   after           a duration, or {by: a single-choice enum field, values: {option: duration}, default?}: the deadline is
 *                   the start plus it (one clock's durations are all calendar or all business time)
 *   not_later_than  a date field: when the record holds a date there, the deadline is the earlier of the two
 *   stops_when      {field, in, at?}: the clock stops (met, or missed when after the deadline) while the field holds one
 *                   of these values; `at` names the date field that says when (else when the shell first saw it)
 *   pauses_when     {field, in}: the clock does not run while the field holds one of these; the deadline moves out by the
 *                   time paused (business time for a business-day clock)
 *   assignee        a person field: who "assignee" is in `notify`
 *   notify          who reminders and escalations tell by default (owners when absent)
 *   soon            how long before the deadline a record is "due soon" (the first reminder's `before`, else 7d)
 *   remind          steps before the deadline: {before, notify?}
 *   escalate        steps once overdue, in order of `after` (time past the deadline, 0d: as soon as it is overdue): each
 *                   tells `notify`, reassigns (`reassign`: copies the person in `from_field` into `field`) and/or raises
 *                   (`raise`: moves a single-choice enum field to its next option, at most up to `to`)
 * Every step is recorded as an event once per record and deadline (workspace_clock_events); a step tells people only
 * through the shell's in-app notices and its email adapter (src/email.ts, the profile's due_dates group).
 */
export const ClockSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  starts: z.union([
    z.object({ field: name }).strict(),
    z.object({ event: z.literal("created") }).strict(),
    z.object({ event: z.literal("entered"), state: choiceValue }).strict(),
  ]),
  after: z.union([clockDuration, z.object({ by: name, values: z.record(choiceValue, clockDuration), default: clockDuration.optional() }).strict()]),
  not_later_than: name.optional(),
  stops_when: z.object({ field: name, in: z.array(choiceValue).min(1).max(20), at: name.optional() }).strict().optional(),
  pauses_when: clockMatch.optional(),
  assignee: name.optional(),
  notify: audience.optional(),
  soon: clockDuration.optional(),
  remind: z.array(z.object({ before: clockDuration, notify: audience.optional() }).strict()).max(5).optional(),
  escalate: z.array(z.object({
    after: clockDuration.default("0d"),
    label: z.string().min(1).max(80).optional(),
    notify: audience.optional(),
    reassign: z.object({ field: name, from_field: name }).strict().optional(),
    raise: z.object({ field: name, to: choiceValue.optional() }).strict().optional(),
  }).strict()).max(8).optional(),
  $comment: z.string().max(2000).optional(),
}).strict();
export type Clock = z.output<typeof ClockSchema>;

/** What is wrong with an area's clocks against its fields (each problem a message and the path under `clocks`). */
export function clockProblems(a: { scope: string; fields: z.output<typeof field>[]; lifecycle?: z.output<typeof LifecycleSchema> }, clocks: Clock[]): { message: string; path: (string | number)[] }[] {
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path });
  if (clocks.length && a.scope !== "workspace") bad("clocks run on a workspace's own records (workspace scope)");
  if (clocks.length > 5) bad("at most 5 clocks on an area");
  const f = (n: string) => a.fields.find((x) => x.name === n);
  const isDate = (n: string) => f(n)?.type === "date";
  const single = (n: string) => { const x = f(n); return !!x && x.type === "enum" && !x.multiple ? x : null; };
  const unitOf = (d: string) => (d.endsWith("bd") ? "business" : "calendar");
  for (const [i, c] of clocks.entries()) {
    if (clocks.findIndex((x) => x.name === c.name) !== i) bad(`clock ${c.name} is declared twice`, i, "name");
    if (f(c.name)) bad(`clock ${c.name} has the name of one of the area's fields`, i, "name");
    if ("field" in c.starts && !isDate(c.starts.field)) bad("starts.field must name one of the area's date fields", i, "starts", "field");
    if ("state" in c.starts) {
      const lf = a.lifecycle ? single(a.lifecycle.field) : null;
      if (!lf) bad("starts {event: entered} needs the area's lifecycle", i, "starts");
      else if (!optionValues(lf).includes(c.starts.state)) bad(`${c.starts.state} is not a state of the area's lifecycle`, i, "starts", "state");
    }
    const durations = typeof c.after === "string" ? [c.after] : [...Object.values(c.after.values), ...(c.after.default ? [c.after.default] : [])];
    if (typeof c.after !== "string") {
      const by = single(c.after.by);
      if (!by) bad("after.by must name one of the area's single-choice enum fields", i, "after", "by");
      else for (const k of Object.keys(c.after.values)) if (!optionValues(by).includes(k)) bad(`${k} is not one of ${by.name}'s options`, i, "after", "values", k);
      if (!Object.keys(c.after.values).length) bad("after.values names at least one option", i, "after", "values");
    }
    if (new Set(durations.map(unitOf)).size > 1) bad("a clock's durations are all calendar time (h, d) or all business days (bd)", i, "after");
    if ((c.remind ?? []).some((r) => unitOf(r.before) !== unitOf(durations[0] ?? "0d")) || (c.escalate ?? []).some((e) => unitOf(e.after) !== unitOf(durations[0] ?? "0d")) || (c.soon && unitOf(c.soon) !== unitOf(durations[0] ?? "0d")))
      bad("reminders, escalations and soon count the clock's own kind of time (calendar or business days)", i);
    if (c.not_later_than !== undefined && !isDate(c.not_later_than)) bad("not_later_than must name one of the area's date fields", i, "not_later_than");
    for (const k of ["stops_when", "pauses_when"] as const) {
      const m = c[k];
      if (!m) continue;
      const x = f(m.field);
      if (!x || x.multiple || !["enum", "text", "boolean"].includes(x.type)) bad(`${k}.field must name one of the area's single enum, text or boolean fields`, i, k, "field");
      else if (x.type === "enum") for (const v of m.in) if (!optionValues(x).includes(v)) bad(`${v} is not one of ${x.name}'s options`, i, k, "in");
      if (x?.type === "boolean") for (const v of m.in) if (v !== "true" && v !== "false") bad(`a boolean field holds true or false, not ${v}`, i, k, "in");
    }
    if (c.stops_when?.at !== undefined && !isDate(c.stops_when.at)) bad("stops_when.at must name one of the area's date fields", i, "stops_when", "at");
    if (c.stops_when && c.pauses_when && c.stops_when.field === c.pauses_when.field && c.stops_when.in.some((v) => c.pauses_when!.in.includes(v)))
      bad("a value cannot both stop and pause the clock", i, "pauses_when", "in");
    const person = (n: string) => { const x = f(n); return !!x && x.type === "person" && !x.multiple; };
    if (c.assignee !== undefined && !person(c.assignee)) bad("assignee must name one of the area's single person fields", i, "assignee");
    const tells = [c.notify ?? [], ...(c.remind ?? []).map((r) => r.notify ?? []), ...(c.escalate ?? []).map((e) => e.notify ?? [])].flat();
    if (tells.includes("assignee") && c.assignee === undefined) bad("notify names the assignee: declare the clock's assignee field", i, "assignee");
    const befores = (c.remind ?? []).map((r) => r.before);
    if (new Set(befores).size !== befores.length) bad("two reminders at the same time", i, "remind");
    const ms = (d: string) => Number(d.replace(/\D+$/, "")) * (d.endsWith("h") ? 1 : 24);
    for (const [j, e] of (c.escalate ?? []).entries()) {
      if (!e.notify && !e.reassign && !e.raise) bad("an escalation step notifies, reassigns or raises", i, "escalate", j);
      if (j > 0 && ms(e.after) <= ms(c.escalate![j - 1]!.after)) bad("escalation steps are in order of after, each later than the one before", i, "escalate", j, "after");
      if (e.reassign) {
        if (!person(e.reassign.field)) bad("reassign.field must name one of the area's single person fields", i, "escalate", j, "reassign", "field");
        if (!person(e.reassign.from_field)) bad("reassign.from_field must name one of the area's single person fields", i, "escalate", j, "reassign", "from_field");
      }
      if (e.raise) {
        const x = single(e.raise.field);
        if (!x) bad("raise.field must name one of the area's single-choice enum fields", i, "escalate", j, "raise", "field");
        else if (e.raise.to !== undefined && !optionValues(x).includes(e.raise.to)) bad(`${e.raise.to} is not one of ${x.name}'s options`, i, "escalate", j, "raise", "to");
        if (x && a.lifecycle?.field === x.name) bad("raise cannot move the lifecycle's field (only a move does)", i, "escalate", j, "raise", "field");
        if (typeof c.after !== "string" && c.after.by === e.raise.field) bad("raise cannot change the field the clock's duration is chosen by (its deadline would move with every step)", i, "escalate", j, "raise", "field");
      }
    }
  }
  return out;
}

// ---------- the record contract (mold_v0-222; docs/RECORDS.md in the factory) ----------

/**
 * Where an area's rows come from (mold_v0-222):
 *   staff        platform staff by hand: the staff record pages' New, Edit, Override and Import, /api/admin/data, the
 *                admin MCP (a shared area; a workspace area only through a write tool the pack made admin_only)
 *   people       the workspace's own people and their AI clients by hand: the tab's create form, the data API, the
 *                generated create, update and move tools (a workspace area whose writes are not withheld)
 *   repository   the area's `repository`: its index, or its live API
 *   intake       the company email's intake (the pack's `email.intake.area`): one record per message
 *   run          the pack's own code (ctx.records): a run's onWorkspaceCommit hook, the pack's own tools and routes
 * The runtime keeps a shared row's provenance (staff or repository, mold_v0-221) and, since mold_v0-236, a workspace
 * row's (workspace_records.provenance, written_by, updated_by: src/record-areas.ts RecordWriter), so what wrote an area's
 * rows, `run` included, is read from the rows themselves (GET /api/admin/records/_provenance), not only declared.
 */
export const RECORD_PROVENANCES = ["staff", "people", "repository", "intake", "run"] as const;
/** The actions a record contract speaks for (mold_v0-222): the record store's five, plus reveal, export and import. */
export const CONTRACT_ACTIONS = ["read", "create", "update", "move", "delete", "reveal", "export", "import"] as const;
/** The primary actions an area's list tab may have (mold_v0-208, TabActionSchema below; new_schedule is a schedules tab's). */
export const CONTRACT_PRIMARY = ["create_record", "start_run", "link"] as const;
const contractReason = z.string().trim().min(1).max(300).regex(/^[^\n\r{}<>]*$/, "plain text on one line: no braces or angle brackets");
/** Who may do an action: workspace roles, platform staff with a permission (a shared area), or nobody and why. */
const contractGrant = z.union([
  z.array(role).min(1).max(4).describe("The workspace roles that may (as the record store, src/record-areas.ts allowedRoles, resolves them)"),
  z.object({ staff: z.enum(["library", "delete"]).describe("Platform staff with this permission (src/admin-roles.ts)") }).strict(),
  z.object({ none: contractReason.describe("Why nobody may (shown nowhere; for people and the factory's spec check)") }).strict(),
]);
/**
 * A record area's contract (mold_v0-222): what the area promises, said in one place and checked against what the shell
 * does with the rest of the declaration. The build checks what one area can tell alone (below); the factory's `spec
 * check` checks the rest (its permissions' defaults, the pack's mcp settings, its tabs, its email intake) and derives the
 * contract of an area that declares none (docs/RECORDS.md). Three of its actions are read by the runtime too, each with
 * today's behaviour when the contract does not say it (src/record-areas.ts):
 *   import   a workspace area's import (mold_v0-234): the roles that may import a CSV or JSON file into the workspace's
 *            own records (POST /api/data/<area>/_import, src/record-import.ts); none when not said
 *   export   its own permission (mold_v0-235): the roles that may export (Export CSV, export_<area>), within read's;
 *            read's roles when not said
 *   reveal   the area's (mold_v0-235): the roles that may reveal its encrypted fields, a field's reveal_roles narrowing
 *            it; {none} reveals nothing to anyone; each field's reveal_roles, else the update roles, when not said
 *   provenance       where its rows come from (RECORD_PROVENANCES)
 *   actions          each of CONTRACT_ACTIONS: the roles that may, {staff: permission}, or {none: reason}
 *   primary_action   the primary action of every list that shows the area (mold_v0-237: each tab whose own area it is,
 *                    its Settings tab, its Records page): create_record, start_run, link, or {none: reason}
 */
export const RecordContractSchema = z.object({
  provenance: z.array(z.enum(RECORD_PROVENANCES)).min(1).max(RECORD_PROVENANCES.length)
    .describe("Where the area's rows come from: staff, people, repository, intake, run (docs/RECORDS.md)"),
  actions: z.object({
    read: contractGrant, create: contractGrant, update: contractGrant, move: contractGrant,
    delete: contractGrant, reveal: contractGrant, export: contractGrant, import: contractGrant,
  }).strict().describe("Every action, each the roles that may, {staff: permission} or {none: reason}"),
  primary_action: z.union([z.enum(CONTRACT_PRIMARY), z.object({ none: contractReason }).strict()])
    .describe("The primary action of every list that shows the area (each tab whose own area it is, its Settings tab, its Records page), or {none: reason}"),
  $comment: z.string().max(2000).optional(),
}).strict();
export type RecordContract = z.output<typeof RecordContractSchema>;
export type ContractGrant = z.output<typeof contractGrant>;

/** What a record area's contract says that the area's own declaration contradicts (mold_v0-222), each with its path. */
export function contractProblems(a: {
  scope: string; repository?: string; lifecycle?: unknown; append_only?: boolean; fields: { name: string; encrypted?: boolean; reveal_roles?: readonly string[] }[]; contract?: RecordContract;
  action?: false; settings?: unknown;
}): { message: string; path: (string | number)[] }[] {
  const c = a.contract;
  if (!c) return [];
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path });
  const shared = a.scope === "platform";
  if (new Set(c.provenance).size !== c.provenance.length) bad("a provenance is listed twice", "provenance");
  if (a.repository !== undefined && !c.provenance.includes("repository")) bad(`its rows come from repository ${a.repository}: provenance names repository`, "provenance");
  if (a.repository === undefined && c.provenance.includes("repository")) bad("provenance repository needs the area's repository", "provenance");
  for (const p of ["people", "intake", "run"] as const)
    if (shared && c.provenance.includes(p)) bad(`a shared (platform) area's rows come from staff or its repository, not ${p}`, "provenance");
  const g = c.actions;
  const none = (x: ContractGrant) => typeof x === "object" && !Array.isArray(x) && "none" in x;
  const staff = (x: ContractGrant) => typeof x === "object" && !Array.isArray(x) && "staff" in x;
  for (const k of CONTRACT_ACTIONS) {
    const x = g[k];
    if (Array.isArray(x) && new Set(x).size !== x.length) bad("a role is listed twice", "actions", k);
    if (staff(x) && (!shared || ["read", "move", "reveal", "export"].includes(k))) bad(`{staff} is for a shared area's create, update, delete or import (platform staff write it)`, "actions", k);
    if (Array.isArray(x) && shared && !["read", "export"].includes(k)) bad(`a shared (platform) area is written by platform staff only: ${k} is {staff: ...} or {none: reason}`, "actions", k);
    if (Array.isArray(x) && x.includes("viewer") && ["create", "update", "move", "delete", "import"].includes(k)) bad(`viewer is read-only in the platform: a contract cannot let a viewer ${k}`, "actions", k);
  }
  if (!none(g.move) && !a.lifecycle) bad("move is a lifecycle's: an area without one says {none: reason}", "actions", "move");
  if (!none(g.reveal) && !a.fields.some((f) => f.encrypted)) bad("reveal is for encrypted fields: an area without one says {none: reason}", "actions", "reveal");
  if (a.append_only) for (const k of ["update", "move", "delete"] as const) if (!none(g[k])) bad(`an append-only area's records are never changed: ${k} is {none: reason}`, "actions", k);
  // mold_v0-235: export is its own permission, never wider than read (a role exports only what it may read).
  const outside = (x: ContractGrant, of: ContractGrant) => (Array.isArray(x) && Array.isArray(of) ? x.filter((r) => !of.includes(r)) : []);
  if (outside(g.export, g.read).length) bad(`export names ${outside(g.export, g.read).join(", ")}, whom read leaves out: a role exports only what it may read`, "actions", "export");
  // mold_v0-235: reveal is the area's; a field's reveal_roles may narrow it, never widen or reopen it.
  for (const f of a.fields) {
    if (!f.encrypted || !f.reveal_roles) continue;
    if (none(g.reveal)) bad(`field ${f.name} declares reveal_roles, but the contract's reveal is none: nothing of the area is revealed`, "actions", "reveal");
    else if (Array.isArray(g.reveal) && f.reveal_roles.some((r) => !(g.reveal as string[]).includes(r)))
      bad(`field ${f.name}'s reveal_roles name ${f.reveal_roles.filter((r) => !(g.reveal as string[]).includes(r)).join(", ")}, whom the area's reveal leaves out`, "actions", "reveal");
  }
  // mold_v0-234: a workspace's import writes its rows as creates and updates, so its roles must be able to do both.
  if (!shared && Array.isArray(g.import)) {
    if (a.fields.some((f) => f.encrypted)) bad("an area with an encrypted field takes no import (its values never come from a file): import is {none: reason}", "actions", "import");
    for (const k of ["create", "update"] as const) {
      const x = g[k];
      if (none(x)) bad(`import writes new and changed records, and ${k} is none: import is {none: reason}`, "actions", "import");
      else if (outside(g.import, x).length) bad(`import names ${outside(g.import, x).join(", ")}, whom ${k} leaves out: an import ${k === "create" ? "adds" : "changes"} records`, "actions", "import");
    }
  }
  // mold_v0-237: an area that turns its own lists' action off (action: false) has none there.
  if (a.action === false && typeof c.primary_action === "string" && a.settings) bad("its Settings tab has no primary action (action: false): primary_action is {none: reason}", "primary_action");
  return out;
}

// ---------- a record's page, laid out (mold_v0-253; flag record_pages) ----------

/**
 * The colours a badge may take (mold_v0-253): theme tokens, never a raw colour. The five tones (neutral, info, success,
 * warning, danger: the console's status colours) and the eight chart colours (viz-1 .. viz-8, the theme's --viz-N),
 * each drawn as a tinted chip legible in light and dark.
 */
export const BADGE_COLORS = ["neutral", "info", "success", "warning", "danger", "viz-1", "viz-2", "viz-3", "viz-4", "viz-5", "viz-6", "viz-7", "viz-8"] as const;
/** A notice's tones (mold_v0-253): a banner's colour and icon. */
export const NOTICE_TONES = ["info", "success", "warning", "danger"] as const;
/** The most facts a record's header shows (mold_v0-253): two rows of four on a desktop. */
export const DETAIL_FACTS_MAX = 8;
const plainWords = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\n\r{}<>]*$/, "plain text on one line: no braces or angle brackets");
const scalar = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);
/** A field group: a few of the section's fields under an optional heading, laid out in the section's columns. */
const DetailGroupSchema = z.object({ title: plainWords(60).optional(), fields: z.array(name).max(30) }).strict();
// ---------- a record's page, part 2: related lists, its runs, its actions (mold_v0-254; flag record_pages) ----------

/** The most columns a related list shows (as an area's list_columns), and the most rows it shows before Show all. */
export const RELATED_COLUMNS_MAX = 8;
export const RELATED_LIMIT_MAX = 50;
/**
 * A related list (mold_v0-254): a section listing the records of another area (`area`) that point back to this record
 * through one of their link or reference fields to this area (`via`: needed only when it has several), each row in
 * `columns` (up to 8 of its fields, formatted as its list's cells; default its list's columns), sorted by `sort` (one of
 * its fields, or updated_at; default the newest change first), at most `limit` rows (default 5, at most 50) and a Show
 * all link to its list filtered to this record. The section's `empty` is its empty state. Its rows' actions are that
 * area's own page actions this person may take. Shown only to the roles that may read that area, and only ever the
 * workspace's own records (the list reads as the person, in the workspace's scope).
 */
export const DetailRelatedSchema = z.object({
  area: name,
  via: name.optional(),
  /**
   * mold_v0-256: match on a field rather than the record's key: the records of `area` whose `via` holds this record's
   * `match_field` value (findings whose control is this status record's control). `via` then names any plain field of
   * that area, not a link back.
   */
  match_field: name.optional(),
  // mold_v0-256: a column may carry its own heading ({field, label}), so two columns never read alike.
  columns: z.array(z.union([name, z.object({ field: name, label: plainWords(40) }).strict()])).min(1).max(RELATED_COLUMNS_MAX, `at most ${RELATED_COLUMNS_MAX} columns: a related list's row is one line on a desktop`).optional(),
  sort: z.object({ field: name, direction: z.enum(["asc", "desc"]).optional() }).strict().optional(),
  limit: z.number().int().min(1).max(RELATED_LIMIT_MAX).optional(),
}).strict();
/**
 * A record's runs (mold_v0-254): a section listing the runs that ran on this record (started on it from its page, or
 * targeting it: an asset area's record), newest first: each run's kind, status, when it started, how long it took, its
 * cost, who started it and a link to it. `kinds` keeps the runs of these job kinds of the area's pack (default every
 * kind); at most `limit` (default 5, at most 50). The section's `empty` is its empty state.
 */
export const DetailRunsSchema = z.object({
  kinds: z.array(name).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(RELATED_LIMIT_MAX).optional(),
}).strict();

/**
 * When a notice shows (mold_v0-253): one test of one of the record's fields. `equals` a value, `in` one of a list,
 * `not_in` none of a list, or `empty` (true: the field has no value; false: it has one). An enum field's values are its
 * options' values. mold_v0-256: a date field `before` or `after` "today", or `within_days` N (today up to N days ahead);
 * a clock's state (`clock`, `is` "overdue" or "due_soon"); and several tests at once, `all` of them or `any` of them.
 */
/**
 * Whether a condition holds on a record (mold_v0-256; the console's web/src/features/records/detail-layout.ts
 * conditionHolds is the same): a list field by any of its values; a date compared by its UTC day with today's; a clock by
 * its state (`clocks`, the record's clock views); all or any of several tests.
 */
export function conditionHolds(when: DetailCondition, data: Record<string, unknown>, clocks: Record<string, { status?: string; overdue?: boolean }> | null = null, now = Date.now()): boolean {
  if (when.all) return when.all.every((c) => conditionHolds(c, data, clocks, now));
  if (when.any) return when.any.some((c) => conditionHolds(c, data, clocks, now));
  if (when.clock) { const c = clocks?.[when.clock]; return !!c && (when.is === "overdue" ? c.status === "overdue" || c.overdue === true : c.status === "due_soon"); }
  const v = when.field ? data[when.field] : undefined;
  const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
  const values = Array.isArray(v) ? v : [v];
  const same = (a: unknown, b: unknown) => a === b || (typeof a !== "object" && a != null && String(a) === String(b));
  if (when.empty !== undefined) return empty === when.empty;
  if (when.equals !== undefined) return values.some((x) => same(x, when.equals));
  if (when.in) return values.some((x) => when.in!.some((y) => same(x, y)));
  if (when.not_in) return !empty && !values.some((x) => when.not_in!.some((y) => same(x, y)));
  if (when.before || when.after || when.within_days !== undefined) {
    const t = typeof v === "string" ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v) : NaN;
    if (!Number.isFinite(t)) return false;
    const DAY = 86_400_000, day = Math.floor(t / DAY), today = Math.floor(now / DAY);
    if (when.before) return day < today;
    if (when.after) return day > today;
    return day >= today && day <= today + when.within_days!;
  }
  return false;
}
/** The tests a condition may make (one each), and what a clock's state may be tested for. */
export const CONDITION_TESTS = ["equals", "in", "not_in", "empty", "before", "after", "within_days"] as const;
export const CLOCK_TESTS = ["overdue", "due_soon"] as const;
const DetailLeafConditionSchema = z.object({
  field: name.optional(),
  equals: scalar.optional(),
  in: z.array(scalar).min(1).max(20).optional(),
  not_in: z.array(scalar).min(1).max(20).optional(),
  empty: z.boolean().optional(),
  before: z.literal("today").optional(),
  after: z.literal("today").optional(),
  within_days: z.number().int().min(0).max(3650).optional(),
  clock: name.optional(),
  is: z.enum(CLOCK_TESTS).optional(),
}).strict();
export const DetailConditionSchema = DetailLeafConditionSchema.extend({
  all: z.array(DetailLeafConditionSchema).min(1).max(6).optional(),
  any: z.array(DetailLeafConditionSchema).min(1).max(6).optional(),
}).strict();
export type DetailCondition = z.output<typeof DetailConditionSchema>;
type LeafCondition = z.output<typeof DetailLeafConditionSchema>;
/**
 * What is wrong with a condition over an area's fields and clocks (mold_v0-256; notices, an action's unavailable, a log's
 * live_when, a computed fact's where): each test names a field the area has (never an encrypted one; a date test a date
 * field; an enum's values its options) or one of its clocks, and makes one test; all or any lists such tests, alone.
 */
export function conditionIssues(fields: readonly { name: string; type?: string; encrypted?: boolean; options?: unknown }[], clocks: readonly { name: string }[], w: DetailCondition, of = "the area"): string[] {
  const out: string[] = [];
  const leaf = (c: LeafCondition) => {
    if (c.clock !== undefined || c.is !== undefined) {
      const extra = (["field", ...CONDITION_TESTS] as const).filter((k) => c[k] !== undefined);
      if (c.clock === undefined || c.is === undefined) out.push("a clock's test names the clock and what it is (is: overdue or due_soon)");
      else if (!clocks.some((k) => k.name === c.clock)) out.push(`${c.clock} is not one of ${of}'s clocks${clocks.length ? ` (${clocks.map((k) => k.name).join(", ")})` : ""}`);
      if (extra.length) out.push(`a clock's test is alone: it has no ${extra.join(" or ")}`);
      return;
    }
    const ops = CONDITION_TESTS.filter((k) => c[k] !== undefined);
    if (ops.length !== 1) out.push(`a condition is one test: equals, in, not_in, empty, before, after, within_days, or a clock's state (it has ${ops.length ? ops.join(" and ") : "none"})`);
    if (c.field === undefined) { out.push("a condition names the field it tests"); return; }
    const f = fields.find((x) => x.name === c.field);
    if (!f) { out.push(`${c.field} is not one of ${of === "the area" ? "the area's" : `${of}'s`} fields`); return; }
    if (f.encrypted) out.push(`${c.field} is encrypted: the page never reads its value, so no condition can test it`);
    const dated = ops.filter((k) => k === "before" || k === "after" || k === "within_days");
    if (dated.length && f.type !== "date") out.push(`${dated[0]} is for a date field (${c.field} is ${f.type ?? "text"})`);
    if (f.type === "enum") for (const v of [c.equals, ...(c.in ?? []), ...(c.not_in ?? [])]) if (v !== undefined && !optionValues(f as never).includes(String(v))) out.push(`${String(v)} is not one of ${f.name}'s options`);
  };
  const lists = (["all", "any"] as const).filter((k) => w[k] !== undefined);
  if (lists.length) {
    const rest = (["field", "clock", "is", ...CONDITION_TESTS] as const).filter((k) => w[k] !== undefined);
    if (lists.length > 1) out.push("a condition is all of its tests or any of them, not both");
    if (rest.length) out.push(`a condition with ${lists[0]} has its tests inside it: no ${rest.join(" or ")} beside it`);
    for (const k of lists) for (const c of w[k]!) leaf(c);
  } else leaf(w);
  return out;
}
// ---------- a record's page, part 3: logs, history, code, tables, files, computed facts (mold_v0-256; flag record_pages) ----------

/** The most lines of change history a section lists before Show more, and the most it lists at all. */
export const HISTORY_LIMIT_MAX = 100;
/** How a computed fact counts at most (more reads "1,000+"): it reads the related records as the person, a page at a time. */
export const COMPUTED_COUNT_MAX = 1000;
/** The languages a code section highlights. */
export const CODE_LANGUAGES = ["json", "yaml", "text"] as const;
/**
 * A log section (mold_v0-256): a text field's lines (or a json field's list of {at, level, source, message} entries) in
 * the event/log viewer: level and source filters, search, follow-tail while `live_when` holds on the record (the page
 * reads it again every few seconds meanwhile), wrap or no-wrap, copy a line, download, virtualised for long logs. A
 * line's level is read from its words (error, warning, info, debug), its source from a leading [source], and its time
 * from a leading ISO time.
 */
export const DetailLogSchema = z.object({ field: name, live_when: DetailConditionSchema.optional() }).strict();
/**
 * A record's change history (mold_v0-256): each change of its fields, newest first: who, when, what (added, changed,
 * moved, deleted) and each field's value before and after (a long text as a line diff); an encrypted field says only
 * that it changed, never a value. `fields` keeps the changes to those (default every field); at most `limit` (20; at
 * most 100), then Show more. Kept while the flag is on, for an area whose layout has a history section
 * (record_changes: sql/migrations/0049): history starts when the section is declared.
 */
export const DetailHistorySchema = z.object({ fields: z.array(name).min(1).max(60).optional(), limit: z.number().int().min(1).max(HISTORY_LIMIT_MAX).optional() }).strict();
/** A code view (mold_v0-256): a field as syntax-highlighted JSON, YAML or text, with line numbers, copy and download. */
export const DetailCodeSchema = z.object({ field: name, language: z.enum(CODE_LANGUAGES).optional() }).strict();
/** A table view (mold_v0-256): a json field holding a list of objects as a table, its columns its items' keys (or `columns`). */
export const DetailTableSchema = z.object({ field: name, columns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/, "a key of the list's items")).min(1).max(RELATED_COLUMNS_MAX).optional() }).strict();
/** A file browser (mold_v0-256): the record's documents and files as a tree, the open one previewed (the document cards). */
export const DetailFilesSchema = z.object({ fields: z.array(name).min(1).max(20).optional() }).strict();
/**
 * A fact computed from related records (mold_v0-256), in the header beside the record's own: over the records of `area`
 * that point back here (through `via`, as a related list), those `where` keeps: `count` (how many; "Used by" N) or
 * `latest` (`field`'s value on the newest of them by `sort`, default the newest change: the last build's status).
 * Evaluated on the server as the person reading (the area's read permission: a role that may not read it does not see
 * the fact), in the workspace's own scope.
 */
export const DetailComputedSchema = z.object({
  area: name,
  via: name.optional(),
  op: z.enum(["count", "latest"]),
  field: name.optional(),
  sort: z.object({ field: name, direction: z.enum(["asc", "desc"]).optional() }).strict().optional(),
  where: DetailConditionSchema.optional(),
}).strict();
/** The kinds of a section (each in place of fields): mold_v0-254's related and runs, mold_v0-256's log, history, code, table and files. */
export const DETAIL_SECTION_KINDS = ["related", "runs", "log", "history", "code", "table", "files"] as const;

/**
 * A section of a tab: a full-width card titled `title`, its fields in `columns` (1, 2 or 3 on a desktop; one on a
 * phone), given as `fields` (one group) or `groups` (several, each with an optional heading). When every field of it is
 * empty on a record, the card says `empty` (default "Nothing here yet.") in their place.
 */
export const DetailSectionSchema = z.object({
  title: plainWords(60),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  fields: z.array(name).max(30).optional(),
  groups: z.array(DetailGroupSchema).max(6).optional(),
  empty: plainWords(200).optional(),
  /** mold_v0-254: a list of another area's records that point back to this one, in place of fields (DetailRelatedSchema). */
  related: DetailRelatedSchema.optional(),
  /** mold_v0-254: the runs that ran on this record, in place of fields (DetailRunsSchema). */
  runs: DetailRunsSchema.optional(),
  /** mold_v0-256: a field's lines in the log viewer (DetailLogSchema). */
  log: DetailLogSchema.optional(),
  /** mold_v0-256: the record's change history (DetailHistorySchema). */
  history: DetailHistorySchema.optional(),
  /** mold_v0-256: a field as highlighted JSON, YAML or text (DetailCodeSchema). */
  code: DetailCodeSchema.optional(),
  /** mold_v0-256: a json list field as a table (DetailTableSchema). */
  table: DetailTableSchema.optional(),
  /** mold_v0-256: the record's documents and files as a tree with a preview (DetailFilesSchema). */
  files: DetailFilesSchema.optional(),
  /**
   * mold_v0-262: shown only while this condition holds on the record (the notices' condition language; an Error section
   * only when its build failed), else not drawn at all. Its tab stays.
   */
  when: DetailConditionSchema.optional(),
}).strict();
/** A tab of the page: its label in the strip (one tab: no strip) and its sections, in order. */
export const DetailTabSchema = z.object({ label: plainWords(40), sections: z.array(DetailSectionSchema).max(12) }).strict();
/** A banner above the tabs while its condition holds on the record: its tone, an optional title and its words. */
export const DetailNoticeSchema = z.object({
  when: DetailConditionSchema,
  tone: z.enum(NOTICE_TONES, { error: () => `a notice's tone is one of ${NOTICE_TONES.join(", ")}` }),
  title: plainWords(80).optional(),
  text: plainWords(300),
}).strict();
/** The kinds of a page action (mold_v0-254). */
export const PAGE_ACTION_KINDS = ["start_run", "move", "edit", "delete", "link", "copy_link", "create_record", "start_agent", "open_url"] as const;
/** Where a page action sits in the header: the one primary button, an outlined secondary one, or the More menu. */
export const PAGE_ACTION_PLACES = ["primary", "secondary", "more"] as const;
export const PAGE_ACTIONS_MAX = 12;
export const PAGE_SECONDARY_MAX = 3;
/** What a start_run action's input may take from the record besides its fields: its key and its title. */
export const RECORD_INPUT_SPECIAL = ["$key", "$title"] as const;
/** A related list's column: its field (a column is a field's name, or {field, label}: mold_v0-256). */
export const columnField = (c: string | { field: string }) => (typeof c === "string" ? c : c.field);
/** An input's source (mold_v0-256): a field of the record (its name, or "$field:<name>"), its key or its title. */
const inputSource = z.union([name, z.enum(RECORD_INPUT_SPECIAL), z.string().regex(/^\$field:[a-z][a-z0-9_]{1,62}$/, 'a field of the record, "$field:<name>", $key or $title')]);
/** The record field an input's source names, or null for $key and $title. */
export const inputField = (from: string) => ((RECORD_INPUT_SPECIAL as readonly string[]).includes(from) ? null : from.startsWith("$field:") ? from.slice(7) : from);
/**
 * An action of a record's page (mold_v0-254), in its header (`place`: the primary, a secondary button, or the More
 * menu, the default):
 *   start_run  start a run of the area's pack's job kind `job_kind` on this record: its form, a full card in the page's
 *              place, takes the kind's arguments pre-filled from the record (`input`: an argument's name -> a field of
 *              the record, or $key, $title); the run carries the record (its runs section lists it)
 *   move       move the record along its lifecycle: to `to`, or (without it) to any state a transition allows from where
 *              it is, each a choice; only the transitions this person's role may make
 *   edit       the record's edit form (a full card in the page's place)
 *   delete     delete the record, after a confirmation
 *   link       open the record its link or reference field `field` names
 *   copy_link  copy the page's address
 *   start_agent (mold_v0-261, flag agent_harness) start a workspace agent session with the agent profile `profile` (the
 *              pack's own, or "default"), its first message `first_message` filled from the record ({{key}}, {{title}},
 *              {{<field>}}); the session links back to the record and shows in its runs section
 *   open_url   (mold_v0-262) open the web address the record's url field (or text field holding one) `field` holds, in
 *              a new tab ("Open live app", "Open docs"); disabled, with why, while the field holds no http(s) address
 * `label` names it (default from its kind), `roles` narrows who may (never wider than the area's and the kind's own
 * permission), `unavailable` disables it with its reason while a condition on the record holds (shown on hover and
 * focus; the API refuses it too), `confirm` asks before it acts (a delete always asks). Shown only to the roles that may
 * take it; the API enforces the same.
 */
export const DetailActionSchema = z.object({
  kind: z.enum(PAGE_ACTION_KINDS, { error: () => `an action's kind is one of ${PAGE_ACTION_KINDS.join(", ")}` }),
  place: z.enum(PAGE_ACTION_PLACES).optional(),
  label: plainWords(40).optional(),
  job_kind: name.optional(),
  input: z.record(name, inputSource).optional(),
  /** mold_v0-256: a create_record action's area (a new record of it, its fields filled from `input`). */
  area: name.optional(),
  /**
   * mold_v0-256: a start_run's target: the record this record's link or reference field `via` names (an asset area's:
   * a finding's Re-audit runs on the finding's application), in place of this record. The run still carries this record.
   */
  target: z.object({ via: name }).strict().optional(),
  to: choiceValue.optional(),
  field: name.optional(),
  roles: z.array(role).min(1).max(4).optional(),
  unavailable: z.array(z.object({ when: DetailConditionSchema, reason: plainWords(200) }).strict()).max(6).optional(),
  confirm: plainWords(300).optional(),
  /** mold_v0-261: a start_agent action's agent profile (the pack's own agent_profiles, or "default"). */
  profile: z.string().regex(PROFILE_ID, "an agent profile's id").optional(),
  /** mold_v0-261: a start_agent action's first message, a template filled from the record ({{key}}, {{title}}, {{<field>}}). */
  first_message: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type DetailAction = z.output<typeof DetailActionSchema>;
/**
 * A record area's page layout (mold_v0-253), shown while the app's flag record_pages is on (off: the page is the one
 * details card it always was). Every field it names is one of the area's fields (gen-packs refuses any other).
 *   header   `title` (a field shown as the page's title; default the record's own title), `subtitle` (a summary line),
 *            `badges` (single-choice enum fields, each value's colour a theme token: BADGE_COLORS; a value left out
 *            is neutral), `creator` (false hides "Added by", the record's provenance; mold_v0-236), and up to 8 `facts`
 *            (a field, its label, a number's unit), each formatted by its type: a date relative with the exact date on
 *            hover, a number with its unit, a link or address as a link, an enum as its badge
 *   notices  banners shown while a condition on the record's fields holds (tone info, warning or danger)
 *   tabs     the page's tabs, each with its sections (at least one each); one tab draws no strip
 *   unplaced what of the area's fields no section, fact or header names: "show" (the default: an "Other details"
 *            section at the end of the first tab, the fields that have a value) or "hide"
 */
export const RecordDetailSchema = z.object({
  header: z.object({
    title: name.optional(),
    subtitle: name.optional(),
    badges: z.array(z.object({
      field: name,
      colors: z.record(z.string(), z.enum(BADGE_COLORS, { error: (i) => `${String(i.input)} is not a badge colour: one of the theme's tokens ${BADGE_COLORS.join(", ")}` })).optional(),
    }).strict()).max(3).optional(),
    creator: z.boolean().optional(),
    // mold_v0-256: a fact may be computed from related records (DetailComputedSchema) in place of a field of the record.
    facts: z.array(z.object({ field: name.optional(), label: plainWords(40).optional(), unit: plainWords(12).optional(), computed: DetailComputedSchema.optional() }).strict())
      .max(DETAIL_FACTS_MAX, `at most ${DETAIL_FACTS_MAX} facts: the header shows two rows of four`).optional(),
  }).strict().optional(),
  notices: z.array(DetailNoticeSchema).max(6).optional(),
  tabs: z.array(DetailTabSchema).min(1, "a layout has at least one tab").max(8),
  unplaced: z.enum(["show", "hide"]).optional(),
  /** mold_v0-254: the header's actions (DetailActionSchema): one primary, up to 3 secondary, the rest in its More menu. */
  actions: z.array(DetailActionSchema).max(PAGE_ACTIONS_MAX, `at most ${PAGE_ACTIONS_MAX} actions on a record's page`).optional(),
  /**
   * mold_v0-262: the automatic "Linked records" card at the first tab's end (the records its links and references name).
   * false hides it; left out, it shows the links the page does not show already (a link or reference field placed as a
   * fact or in a section is left out of it, being shown there by its title).
   */
  linked: z.boolean().optional(),
}).strict();
export type RecordDetailLayout = z.output<typeof RecordDetailSchema>;

/** An action's id on its page and in the API (POST /api/records/_page/<area>/<key>/actions/<id>): its kind, then what it names. */
export const pageActionId = (a: Pick<DetailAction, "kind" | "job_kind" | "to" | "field"> & { area?: string; profile?: string }) =>
  [a.kind, a.job_kind ?? a.to ?? a.field ?? a.area ?? a.profile].filter((x) => x !== undefined && x !== "").join(".").replace(/[^A-Za-z0-9_.-]+/g, "-");

/** A layout's id for each tab (its label, lowercased, words joined by -): the page's ?tab= value. */
export const detailTabId = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tab";

/** What keeps an area's layout from being drawn (mold_v0-253): fields it names that the area lacks, empty tabs, and so on. */
export function detailProblems(a: { name?: string; scope?: string; fields: z.output<typeof RecordFieldSchema>[]; links?: { field: string; area: string }[]; lifecycle?: z.output<typeof LifecycleSchema>;
  append_only?: boolean; repository?: string; detail?: RecordDetailLayout }): { message: string; path: (string | number)[] }[] {
  const d = a.detail;
  if (!d) return [];
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path });
  const fieldOf = (n: string) => a.fields.find((f) => f.name === n);
  const known = (n: string, ...path: (string | number)[]) => { const f = fieldOf(n); if (!f) bad(`${n} is not one of the area's fields`, ...path); return f; };
  const shown = (n: string, what: string, ...path: (string | number)[]) => {
    const f = known(n, ...path);
    if (f && (f.encrypted || f.type === "file")) bad(`${n} is ${f.encrypted ? "encrypted" : "a file field"}: ${what} shows a value, so it names a field the page reads`, ...path);
    return f;
  };
  /** A condition on this area's fields and clocks (mold_v0-256: conditionIssues), each problem with its path. */
  const clocksOf = (a as { clocks?: { name: string }[] }).clocks ?? [];
  const condition = (w: DetailCondition, ...path: (string | number)[]) => {
    for (const m of conditionIssues(a.fields, clocksOf, w)) bad(m, ...path, ...(/^\S+ is (not one of the area's fields|encrypted)/.test(m) && !w.all && !w.any ? ["field"] : []));
  };
  const h = d.header;
  if (h?.title) shown(h.title, "the title", "header", "title");
  if (h?.subtitle) shown(h.subtitle, "the subtitle", "header", "subtitle");
  for (const [i, b] of (h?.badges ?? []).entries()) {
    const f = shown(b.field, "a badge", "header", "badges", i, "field");
    if (f && (f.type !== "enum" || f.multiple)) bad(`${b.field} is not a single-choice enum field: a badge shows one of its options`, "header", "badges", i, "field");
    else if (f) for (const v of Object.keys(b.colors ?? {})) if (!optionValues(f).includes(v)) bad(`${v} is not one of ${f.name}'s options`, "header", "badges", i, "colors", v);
    if ((h?.badges ?? []).findIndex((x) => x.field === b.field) !== i) bad(`${b.field} has two badges`, "header", "badges", i, "field");
  }
  for (const [i, x] of (h?.facts ?? []).entries()) {
    // mold_v0-256: a fact computed from related records (its area's fields are checked across the build).
    if (x.computed) {
      const c = x.computed;
      if (x.field !== undefined) bad("a computed fact has no field of its own: it reads the related records' (computed.field)", "header", "facts", i, "field");
      if (x.label === undefined) bad("a computed fact names itself (label): the page cannot take it from a field", "header", "facts", i, "label");
      if (c.op === "latest" && !c.field) bad("a latest fact names the field it shows of the newest related record (computed.field)", "header", "facts", i, "computed", "field");
      if (c.op === "count" && c.field !== undefined) bad("a count fact counts records: it names no field", "header", "facts", i, "computed", "field");
      if (c.op === "count" && c.sort !== undefined) bad("a count fact counts records: it has no sort", "header", "facts", i, "computed", "sort");
      // Its where's fields are the related area's: checked across the build (detailBuildProblems).
      continue;
    }
    if (x.field === undefined) { bad("a fact names a field of the record, or is computed from related records (computed)", "header", "facts", i, "field"); continue; }
    const f = shown(x.field, "a fact", "header", "facts", i, "field");
    if (f?.type === "json") bad(`${x.field} is a json field: a fact is one short value`, "header", "facts", i, "field");
    if (x.unit !== undefined && f && f.type !== "number") bad(`a unit is for a number field (${x.field} is ${f.type})`, "header", "facts", i, "unit");
    if ((h?.facts ?? []).findIndex((y) => y.field === x.field) !== i) bad(`${x.field} is a fact twice`, "header", "facts", i, "field");
  }
  for (const [i, n] of (d.notices ?? []).entries()) condition(n.when, "notices", i, "when");
  const ids = d.tabs.map((t) => detailTabId(t.label));
  for (const [ti, t] of d.tabs.entries()) {
    if (ids.indexOf(ids[ti]!) !== ti) bad(`tab ${t.label} has the same address as another (?tab=${ids[ti]}): give it another label`, "tabs", ti, "label");
    if (!t.sections.length) bad(`tab ${t.label} is empty: a tab has at least one section`, "tabs", ti, "sections");
    for (const [si, s] of t.sections.entries()) {
      // mold_v0-262: a section shown only while its condition holds: one over the area's own fields and clocks.
      if (s.when) condition(s.when, "tabs", ti, "sections", si, "when");
      // mold_v0-254: a related list or the record's runs, in place of fields (checked across the build: detailBuildProblems);
      // mold_v0-256: a log, the change history, a code view, a table or a file browser, likewise.
      const kinds = DETAIL_SECTION_KINDS.filter((k) => s[k] !== undefined);
      if (kinds.length) {
        if (kinds.length > 1) bad(kinds.length === 2 && kinds.includes("related") && kinds.includes("runs") ? `section ${s.title} is a related list or the record's runs, not both`
          : `section ${s.title} is one kind of section: ${kinds.join(" or ")}, not ${kinds.length === 2 ? "both" : "several"}`, "tabs", ti, "sections", si);
        const what: Record<(typeof DETAIL_SECTION_KINDS)[number], string> = { related: "lists related records", runs: "lists runs", log: "shows a log", history: "lists the record's changes",
          code: "shows a field as code", table: "shows a list as a table", files: "lists the record's files" };
        for (const k of ["fields", "groups", "columns"] as const) if (s[k] !== undefined) bad(`section ${s.title} ${what[kinds[0]!]}: it has no ${k}`, "tabs", ti, "sections", si, k);
        const at = (...p: (string | number)[]) => ["tabs", ti, "sections", si, ...p];
        const valueOf = (n: string, kind: string, types: readonly string[], ...p: (string | number)[]) => {
          const f = known(n, ...at(...p));
          if (f && (f.encrypted || f.type === "file")) bad(`${n} is ${f.encrypted ? "encrypted" : "a file field"}: ${kind} shows its value, so it names a field the page reads`, ...at(...p));
          else if (f && !types.includes(f.type ?? "text")) bad(`${n} is a ${f.type ?? "text"} field: ${kind} shows a ${types.join(" or ")} field`, ...at(...p));
          return f;
        };
        if (s.log) {
          valueOf(s.log.field, "a log", ["text", "json"], "log", "field");
          if (s.log.live_when) condition(s.log.live_when, ...at("log", "live_when"));
        }
        if (s.code) {
          const f = valueOf(s.code.field, "a code view", ["text", "json"], "code", "field");
          if (f?.multiple) bad(`${s.code.field} is a list of values: a code view shows one`, ...at("code", "field"));
        }
        if (s.table) valueOf(s.table.field, "a table view", ["json"], "table", "field");
        if (s.history) for (const [k, n] of (s.history.fields ?? []).entries()) known(n, ...at("history", "fields", k));
        if (s.files) {
          const docs = a.fields.filter((f) => f.type === "file" || f.preview === "document").map((f) => f.name);
          if (!docs.length) bad(`section ${s.title} lists the record's files: the area has no file field and no field with preview "document"`, ...at("files"));
          for (const [k, n] of (s.files.fields ?? []).entries()) if (known(n, ...at("files", "fields", k)) && !docs.includes(n))
            bad(`${n} is not a file field or a field with preview "document": a file browser lists the record's documents`, ...at("files", "fields", k));
        }
        continue;
      }
      if (s.fields && s.groups) bad(`section ${s.title} gives fields or groups, not both`, "tabs", ti, "sections", si);
      const lists = s.groups ? s.groups.map((g, gi) => ({ names: g.fields, path: ["groups", gi, "fields"] as (string | number)[] })) : [{ names: s.fields ?? [], path: ["fields"] as (string | number)[] }];
      if (!lists.some((l) => l.names.length)) bad(`section ${s.title} lists no fields`, "tabs", ti, "sections", si);
      for (const [gi, g] of (s.groups ?? []).entries()) if (!g.fields.length) bad(`a group of section ${s.title} lists no fields`, "tabs", ti, "sections", si, "groups", gi, "fields");
      const seen = new Set<string>();
      for (const l of lists) for (const [k, n] of l.names.entries()) {
        known(n, "tabs", ti, "sections", si, ...l.path, k);
        if (seen.has(n)) bad(`${n} is in section ${s.title} twice`, "tabs", ti, "sections", si, ...l.path, k);
        seen.add(n);
      }
    }
  }
  out.push(...actionProblems(a, d.actions ?? []));
  return out;
}

const lastAt = (actions: DetailAction[], place: string) => actions.map((x) => x.place).lastIndexOf(place as DetailAction["place"]);
/** What one area can tell alone of its page's actions (mold_v0-254); detailBuildProblems checks what they name elsewhere. */
function actionProblems(a: Parameters<typeof detailProblems>[0], actions: DetailAction[]): { message: string; path: (string | number)[] }[] {
  const out: { message: string; path: (string | number)[] }[] = [];
  const bad = (message: string, ...path: (string | number)[]) => out.push({ message, path: ["actions", ...path] });
  const primaries = actions.filter((x) => x.place === "primary").length;
  if (primaries > 1) bad(`${primaries} actions are primary: a record's page has one primary action (the others are secondary or in More)`, lastAt(actions, "primary"), "place");
  const secondary = actions.filter((x) => x.place === "secondary").length;
  if (secondary > PAGE_SECONDARY_MAX) bad(`${secondary} actions are secondary: at most ${PAGE_SECONDARY_MAX} sit beside the primary (put the rest in More)`, lastAt(actions, "secondary"), "place");
  const fieldOf = (n: string) => a.fields.find((f) => f.name === n);
  const shared = a.scope === "platform", readOnly = a.repository !== undefined;
  const ids = actions.map(pageActionId);
  for (const [i, x] of actions.entries()) {
    const only = (k: "job_kind" | "input" | "to" | "field", kinds: readonly string[]) => { if (x[k] !== undefined && !kinds.includes(x.kind)) bad(`${k} is for a ${kinds.join(" or ")} action, not ${x.kind}`, i, k); };
    only("job_kind", ["start_run"]); only("input", ["start_run", "create_record"]); only("to", ["move"]); only("field", ["link", "open_url"]);
    if (x.area !== undefined && x.kind !== "create_record") bad(`area is for a create_record action, not ${x.kind}`, i, "area");
    if (x.kind === "create_record" && !x.area) bad("a create_record action names the area it adds a record to", i, "area");
    if (x.target !== undefined && x.kind !== "start_run") bad(`target is for a start_run action, not ${x.kind}`, i, "target");
    if (x.target && !areaLinks({ fields: a.fields, links: a.links }).some((l) => l.field === x.target!.via)) bad(`${x.target.via} is not a link or reference field of the area: a run's target is the record one names`, i, "target", "via");
    if (x.kind === "create_record" && (x.roles ?? []).includes("viewer")) bad("viewer is read-only in the platform: a create_record action cannot be a viewer's", i, "roles");
    // A run's and an edit's form is the question; a link or a copy changes nothing: only a move or a delete asks first.
    if (x.confirm !== undefined && x.kind !== "move" && x.kind !== "delete") bad(`confirm is for a move or a delete (a ${x.kind} ${x.kind === "start_run" || x.kind === "edit" ? "opens its form first" : "changes nothing"})`, i, "confirm");
    if (ids.indexOf(ids[i]!) !== i) bad(`two actions are ${ids[i]}: give each its own kind, job kind, state or field`, i);
    const writes = x.kind === "move" || x.kind === "edit" || x.kind === "delete";
    if (writes && shared) bad(`a shared (platform) area's records are written by platform staff, never from a workspace's page: no ${x.kind} action`, i, "kind");
    if (writes && !shared && readOnly && x.kind !== "delete") bad(`${a.name ?? "the area"}'s records come from its repository: no ${x.kind} action`, i, "kind");
    if (writes && a.append_only) bad(`an append-only area's records are never changed: no ${x.kind} action`, i, "kind");
    if (x.kind === "start_run" && !x.job_kind) bad("a start_run action names its job_kind", i, "job_kind");
    // mold_v0-261: a start_agent action names its profile and its first message, which names only the record's own fields.
    if (x.kind !== "start_agent") { if (x.profile !== undefined) bad(`profile is for a start_agent action, not ${x.kind}`, i, "profile"); if (x.first_message !== undefined) bad(`first_message is for a start_agent action, not ${x.kind}`, i, "first_message"); }
    else {
      if (!x.profile) bad("a start_agent action names the agent profile it starts (profile)", i, "profile");
      if (!x.first_message) bad("a start_agent action says its first message (first_message, filled from the record)", i, "first_message");
      if ((x.roles ?? []).includes("viewer")) bad("viewer is read-only in the platform: a start_agent action cannot be a viewer's", i, "roles");
      for (const n of templateNames(x.first_message ?? "")) {
        if (n === "key" || n === "title") continue;
        const f = fieldOf(n);
        if (!f) bad(`{{${n}}} is not one of the area's fields (a first message takes {{key}}, {{title}} or a field)`, i, "first_message");
        else if (f.encrypted || f.type === "file") bad(`{{${n}}} is ${f.encrypted ? "encrypted" : "a file field"}: a first message never carries it`, i, "first_message");
      }
    }
    for (const [arg, raw] of Object.entries(x.input ?? {})) {
      const from = inputField(raw);
      if (from === null) continue;
      const f = fieldOf(from);
      if (!f) bad(`${from} is not one of the area's fields (input ${arg} takes a field, $key or $title)`, i, "input", arg);
      else if (f.encrypted || f.type === "file") bad(`${from} is ${f.encrypted ? "encrypted" : "a file field"}: ${x.kind === "create_record" ? "a new record's" : "a run's"} input never takes it from the page`, i, "input", arg);
    }
    if (x.kind === "move") {
      const lc = a.lifecycle;
      if (!lc) bad("a move action is for an area with a lifecycle: this one's records do not move", i, "kind");
      else if (x.to !== undefined && !lc.transitions.some((t) => t.to === x.to))
        bad(`no transition of the lifecycle goes to ${x.to}: a move action names a state a transition reaches (${[...new Set(lc.transitions.map((t) => t.to))].join(", ")})`, i, "to");
      if (lc && x.roles) for (const r of x.roles) if (!lc.transitions.some((t) => (x.to === undefined || t.to === x.to) && (!t.roles || t.roles.includes(r))))
        bad(`${r} makes none of the moves this action offers: its roles narrow the transitions' own`, i, "roles");
    }
    if (x.kind === "link") {
      if (!x.field) bad("a link action names the field whose record it opens", i, "field");
      else if (!areaLinks({ fields: a.fields, links: a.links }).some((l) => l.field === x.field)) bad(`${x.field} is not a link or reference field of the area: a link action opens the record one names`, i, "field");
    }
    if (x.kind === "open_url") {
      const f = x.field ? fieldOf(x.field) : undefined;
      if (!x.field) bad("an open_url action names the field holding the web address it opens", i, "field");
      else if (!f) bad(`${x.field} is not one of the area's fields`, i, "field");
      else if ((f.type !== "url" && f.type !== "text") || f.encrypted) bad(`${x.field} is ${f.encrypted ? "encrypted" : `a ${f.type} field`}: an open_url action opens a url field's address (or a text field holding one)`, i, "field");
    }
    if (x.kind === "edit" && a.fields.some((f) => f.encrypted)) bad("the edit form never holds an encrypted value: an area with an encrypted field has no edit action", i, "kind");
    if ((x.roles ?? []).includes("viewer") && x.kind !== "link" && x.kind !== "copy_link" && x.kind !== "open_url") bad(`viewer is read-only in the platform: a ${x.kind} action cannot be a viewer's`, i, "roles");
    for (const [j, u] of (x.unavailable ?? []).entries())
      for (const m of conditionIssues(a.fields, (a as { clocks?: { name: string }[] }).clocks ?? [], u.when)) bad(m, i, "unavailable", j, "when", ...(/^\S+ is not one of the area's fields/.test(m) && !u.when.all && !u.when.any ? ["field"] : []));
  }
  return out;
}

/** A build's areas and job kinds as detailBuildProblems reads them (src/metric-spec.ts checkViews passes them). */
export interface DetailBuildArea {
  pack: string; name: string; scope: string; fields: z.output<typeof RecordFieldSchema>[]; links?: { field: string; area: string }[]; detail?: RecordDetailLayout;
}
export interface DetailBuildKind { pack: string; name: string; args?: readonly string[]; approval?: boolean }
/** The fields of `target` that point at area `to`: its reference fields to it and its links to it. */
export const linksBack = (target: Pick<DetailBuildArea, "fields" | "links">, to: string) => areaLinks(target).filter((l) => l.area === to).map((l) => l.field);
/**
 * What a record page's layout names across the build (mold_v0-254), each problem naming its pack and area: a related
 * list's area, the field it points back through, its columns and sort; a runs section's kinds; a start_run action's job
 * kind and its input's arguments. Run by src/metric-spec.ts checkViews, so gen-packs and the server's install refuse the
 * same, with the flag on or off (a layout is declared and checked either way).
 */
export function detailBuildProblems(areas: readonly DetailBuildArea[], kinds: readonly DetailBuildKind[]): string[] {
  const out: string[] = [];
  for (const a of areas) {
    const d = a.detail;
    if (!d) continue;
    const at = (where: string, what: string) => out.push(`pack ${a.pack}: record area ${a.name}'s page: ${where}: ${what}`);
    const kindOf = (k: string) => kinds.find((x) => x.pack === a.pack && x.name === k);
    for (const t of d.tabs) for (const s of t.sections) {
      const where = `section ${s.title}`;
      if (s.related) {
        const r = s.related, target = areas.find((x) => x.name === r.area);
        if (!target) { at(where, `${r.area} is not a record area of this build`); continue; }
        const back = linksBack(target, a.name);
        if (r.match_field !== undefined) {
          // mold_v0-256: matched on a field: via is a plain field of that area, match_field one of this area's.
          const mine = a.fields.find((f) => f.name === r.match_field), theirs = r.via ? target.fields.find((f) => f.name === r.via) : undefined;
          if (!r.via) at(where, "a related list matched on a field names the field of theirs it matches (via)");
          else if (!theirs) at(where, `via ${r.via} is not one of ${r.area}'s fields`);
          else if (theirs.encrypted || theirs.type === "json" || theirs.type === "file") at(where, `via ${r.via} is ${theirs.encrypted ? "encrypted" : `a ${theirs.type} field`}: a match is on one plain value`);
          if (!mine) at(where, `match_field ${r.match_field} is not one of ${a.name}'s fields`);
          else if (mine.encrypted || mine.type === "json" || mine.type === "file") at(where, `match_field ${r.match_field} is ${mine.encrypted ? "encrypted" : `a ${mine.type} field`}: a match is on one plain value`);
        } else if (r.via !== undefined) {
          if (!target.fields.some((f) => f.name === r.via)) at(where, `via ${r.via} is not one of ${r.area}'s fields`);
          else if (!back.includes(r.via)) at(where, `${r.area}'s field ${r.via} does not point at ${a.name}: a related list shows the records that point back here (${back.length ? `its fields that do: ${back.join(", ")}` : `${r.area} has no reference or link field to ${a.name}`})`);
        } else if (!back.length) at(where, `${r.area} has no link back to ${a.name}: a related list shows the records that point here, through a reference or link field of theirs to ${a.name}`);
        else if (back.length > 1) at(where, `${r.area} points at ${a.name} through ${back.join(" and ")}: say which with via`);
        for (const c of (r.columns ?? []).map(columnField)) {
          const f = target.fields.find((x) => x.name === c);
          if (!f) at(where, `column ${c} is not one of ${r.area}'s fields`);
          else if (f.encrypted || f.type === "file") at(where, `column ${c} is ${f.encrypted ? "encrypted" : "a file field"}: a related list's cell shows a value`);
        }
        if ((r.columns ?? []).length !== new Set((r.columns ?? []).map(columnField)).size) at(where, "a column is listed twice");
        if (r.sort) {
          const f = target.fields.find((x) => x.name === r.sort!.field);
          if (!f && !["updated_at", "title", "key"].includes(r.sort.field)) at(where, `sort ${r.sort.field} is not one of ${r.area}'s fields (or updated_at, title, key)`);
          else if (f && (f.encrypted || f.type === "json" || f.type === "file" || f.multiple)) at(where, `sort ${r.sort.field} is ${f.encrypted ? "encrypted" : f.multiple ? "a list" : `a ${f.type} field`}: sort by a field with one plain value`);
        }
      }
      if (s.runs) for (const k of s.runs.kinds ?? []) if (!kindOf(k)) at(where, `${k} is not a job kind of pack ${a.pack}`);
    }
    // mold_v0-256: a computed fact's related records: their area, the field pointing back here, what it reads of them.
    for (const [i, x] of (d.header?.facts ?? []).entries()) {
      const c = x.computed;
      if (!c) continue;
      const where = `fact ${i + 1} (${x.label ?? c.op})`;
      const target = areas.find((y) => y.name === c.area);
      if (!target) { at(where, `${c.area} is not a record area of this build`); continue; }
      const back = linksBack(target, a.name);
      if (c.via !== undefined) {
        if (!target.fields.some((f) => f.name === c.via)) at(where, `via ${c.via} is not one of ${c.area}'s fields`);
        else if (!back.includes(c.via)) at(where, `${c.area}'s field ${c.via} does not point at ${a.name}: a computed fact reads the records that point back here (${back.length ? `its fields that do: ${back.join(", ")}` : `${c.area} has no reference or link field to ${a.name}`})`);
      } else if (!back.length) at(where, `${c.area} has no link back to ${a.name}: a computed fact reads the records that point here, through a reference or link field of theirs to ${a.name}`);
      else if (back.length > 1) at(where, `${c.area} points at ${a.name} through ${back.join(" and ")}: say which with via`);
      const plainField = (n: string, what: string) => {
        const f = target.fields.find((y) => y.name === n);
        if (!f) { if (!["updated_at", "title", "key"].includes(n) || what !== "sort") at(where, `${what} ${n} is not one of ${c.area}'s fields`); return null; }
        if (f.encrypted || f.type === "file" || f.type === "json") at(where, `${what} ${n} is ${f.encrypted ? "encrypted" : `a ${f.type} field`}: a computed fact ${what === "sort" ? "sorts by" : "shows"} one plain value`);
        return f;
      };
      const f = c.field ? plainField(c.field, "field") : null;
      if (c.sort) plainField(c.sort.field, "sort");
      if (x.unit !== undefined && c.op === "latest" && f && f.type !== "number") at(where, `a unit is for a count or a number field (${c.field} is ${f.type ?? "text"})`);
      if (c.where) for (const m of conditionIssues(target.fields, (target as { clocks?: { name: string }[] }).clocks ?? [], c.where, c.area)) at(where, `where: ${m}`);
    }
    // mold_v0-256: a create_record action's area: a workspace area of the build, each input a field it has.
    for (const x of d.actions ?? []) {
      if (x.kind !== "create_record" || !x.area) continue;
      const where = `action ${pageActionId(x)}`, target = areas.find((y) => y.name === x.area);
      if (!target) { at(where, `${x.area} is not a record area of this build`); continue; }
      if (target.scope !== "workspace") at(where, `${x.area} is shared (platform): a workspace's page adds none of its records`);
      for (const k of Object.keys(x.input ?? {})) {
        const f = target.fields.find((y) => y.name === k);
        if (!f) at(where, `input ${k} is not one of ${x.area}'s fields`);
        else if (f.encrypted || f.type === "file") at(where, `input ${k} is ${f.encrypted ? "encrypted" : "a file field"}: a new record's form never takes it from a page`);
      }
    }
    for (const x of d.actions ?? []) {
      if (x.kind !== "start_run" || !x.job_kind) continue;
      const where = `action ${pageActionId(x)}`, k = kindOf(x.job_kind);
      if (!k) { at(where, `${x.job_kind} is not a job kind of pack ${a.pack}`); continue; }
      if (k.approval) at(where, `${x.job_kind} writes only after its preview is approved: start it from its own list, not a record's page`);
      // mold_v0-256: a run on a linked record: each area the field may name is an asset area (a run's target is an asset).
      if (x.target) for (const l of areaLinks(a).filter((y) => y.field === x.target!.via)) {
        const t = areas.find((y) => y.name === l.area);
        if (t && (t as { role?: string }).role !== "asset") at(where, `target via ${x.target.via}: ${l.area} is not an asset area: a run targets an asset area's record`);
      }
      for (const arg of Object.keys(x.input ?? {})) if (!(k.args ?? []).includes(arg)) at(where, `input ${arg} is not an argument of ${x.job_kind}${k.args?.length ? ` (${k.args.join(", ")})` : " (it takes none)"}`);
    }
  }
  return out;
}

/**
 * The icons a tab, a record area (mold_v0-242) or a host pack's sidebar entry may use: names of the console's icon set
 * (web/src/components/icons.tsx).
 */
export const TAB_ICONS = ["dashboard", "chartBar", "chartLine", "trendingUp", "gauge", "health", "kanban", "inbox", "building", "route", "rocket", "book",
  "plug", "user", "teams", "page", "post", "settings", "clock", "calendar", "search", "check", "circleCheck", "warning", "alertCircle", "shield", "lock",
  "notification", "billing", "account", "code", "product", "workspace", "forms", "play", "refresh", "media", "adjustments", "userPen"] as const;

/**
 * A record area (wired by mold_v0-047; molds/mold_v0/MOLD.md "Pack and record-area contract"). Area names are unique
 * across every pack in a build (they are the `area` of the MCP tools and the path of the console pages). A `link`
 * names a field whose value is the key (or a list of keys) of records in another area; a `reference` field does the
 * same and is checked on write (mold_v0-057). `lifecycle` and `permissions` (mold_v0-057) are enforced by the shell's
 * record store (src/record-areas.ts) on every write and move through it (ctx.records, the record tools and routes); a
 * pack's code may not name the record tables in its own queries (scripts/gen-packs.mjs refuses it).
 */
/** The visibility modes of a record (mold_v0-259), in their order on screen. */
export const VISIBILITY_MODES = ["workspace", "team", "private"] as const;
/** The levels a team role stands for (mold_v0-262): a lead also changes who sees the team's records; a member sees them. */
export const TEAM_ROLE_LEVELS = ["lead", "member"] as const;
/**
 * A workspace's team roles in the app's words (mold_v0-262; src/teams.ts): pack.json or profile.json `team_roles`, 2 to 6
 * roles (lead, dev, viewer), each mapped onto a level. Absent: Lead and Member, as before.
 */
export const TeamRolesSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "a role's id: lowercase letters, digits and _, up to 24"),
  label: z.string().trim().min(1).max(40).regex(/^[^\n\r{}<>]*$/, "plain text on one line"),
  level: z.enum(TEAM_ROLE_LEVELS),
  $comment: z.string().max(2000).optional(),
}).strict()).min(2).max(6).superRefine((v, ctx) => {
  if (new Set(v.map((r) => r.id)).size !== v.length) ctx.addIssue({ code: "custom", message: "a role id is listed twice" });
  if (new Set(v.map((r) => r.label.toLowerCase())).size !== v.length) ctx.addIssue({ code: "custom", message: "two roles have one label" });
  if (!v.some((r) => r.level === "lead") || !v.some((r) => r.level === "member")) ctx.addIssue({ code: "custom", message: "at least one role of each level (lead and member)" });
});
/** An area's `visibility` (mold_v0-259; RecordAreaSchema.visibility). */
/**
 * mold_v0-262: a child area's records seen by whoever sees the record its reference field `inherit` names (a task by
 * whoever sees its project), enforced by the same policy (sql/migrations/0053_inherited_visibility.sql). The field is a
 * single reference to a workspace area that declares its own modes; a record whose reference is empty is open to the
 * workspace. Its records have no visibility of their own to choose or share.
 */
export const InheritVisibilitySchema = z.object({ inherit: name, $comment: z.string().max(2000).optional() }).strict();
const ModesVisibilitySchema = z.object({
  modes: z.array(z.enum(VISIBILITY_MODES)).min(1).max(3),
  default: z.enum(VISIBILITY_MODES),
  /** People may be named on a record (each sees it whatever its mode). Default false. */
  collaborators: z.boolean().optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.modes).size !== v.modes.length) ctx.addIssue({ code: "custom", message: "a mode is listed twice", path: ["modes"] });
  if (!v.modes.includes(v.default)) ctx.addIssue({ code: "custom", message: `default ${v.default} is not one of modes (${v.modes.join(", ")})`, path: ["default"] });
});
export const VisibilitySchema = z.union([ModesVisibilitySchema, InheritVisibilitySchema]);
/** Whether an area's visibility follows a parent's (mold_v0-262). */
export const inheritsVisibility = (v: unknown): v is z.output<typeof InheritVisibilitySchema> => !!v && typeof v === "object" && typeof (v as { inherit?: unknown }).inherit === "string";

export const RecordAreaSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  /**
   * Its icon wherever it shows (mold_v0-242): its entry in the staff console's Records group (a shared area) and in the
   * customer console's. Absent, the icon of the customer tab that shows it, else one the build picks from the area's name
   * so that no two Records entries share one (src/record-icons.ts). Two areas naming one icon is a build warning.
   */
  icon: z.enum(TAB_ICONS).optional(),
  role: z.enum(["source", "check", "asset"]),
  scope: z.enum(["platform", "workspace"]),
  fields: z.array(field).min(1).max(60),
  /** Up to 8 fields the list shows; up to 12 with the flag wide_lists (mold_v0-260; refused past 8 while it is off). */
  list_columns: z.array(name).max(WIDE_LIST_MAX).optional(),
  links: z.array(z.object({ field: name, area: name }).strict()).optional(),
  lifecycle: LifecycleSchema.optional(),
  /**
   * mold_v0-256 (flag record_pages): the console's create form fills a new record's Key from its Title as it is typed
   * (lowercase words joined by -, until the person types a key of their own). Off (the default) the Key is typed.
   */
  key_from_title: z.boolean().optional(),
  /**
   * mold_v0-260 (flag credential_sets): the area's records are the workspace's tenants (its customers, sites or
   * accounts): a credential may be bound to one of them (`bound_to: "tenant"`), shown and set on that record's page and
   * delivered to a run that targets it (its start tool's target_tenant, or a run started on the record). Workspace
   * scope, the shell's own tables; at most one tenant area in a build.
   */
  tenant: z.boolean().optional(),
  /**
   * mold_v0-260 (flag record_rules): checks run when a record is saved: each names one of the build's declarative checks
   * (mold_v0-196, pack.json checks), its inputs taken from the record being saved (`@<field>`, `$key`, `$title` or a
   * literal), and the words a refusal says. A create or change for which the check answers no is refused (409) with
   * `message`, through every door (the data API, the console's forms, the MCP tools, an import). `on` narrows it to
   * creates or changes (default both).
   */
  on_save: z.array(z.object({
    check: name,
    inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()])).default({}),
    message: z.string().trim().min(1).max(300).regex(/^[^\n\r{}<>]*$/, "plain text on one line: no braces or angle brackets"),
    on: z.array(z.enum(["create", "update"])).min(1).max(2).optional(),
  }).strict()).min(1).max(10).optional(),
  permissions: PermissionsSchema.optional(),
  /**
   * Where the area's rows come from (mold_v0-059; src/data-repositories.ts): one of the pack's `repositories`. Absent,
   * the shell's own tables, written through the record store. An area fed by the workspace store's files or an external
   * API is read only (its rows come from there).
   */
  repository: name.optional(),
  /**
   * Sealed at rest (mold_v0-066): the title and data of every record are encrypted with the workspace's data key, as an
   * asset area's always are. Workspace scope only (a shared row has no workspace key). Writes are refused while the key
   * vault is locked; a filter or sort over a sealed area runs on the opened rows, never in the database.
   */
  sealed: z.boolean().optional(),
  /**
   * Append-only (mold_v0-195): a record is added once and never changed, moved or deleted through any door (the record
   * store refuses). With `chain: true` the database enforces it too and hash-chains the area's records per workspace
   * (sql/migrations/0035_ledger_chain.sql; src/ledger.ts), signed in checkpoints when the profile's audit.sign is on.
   * Workspace areas of the shell's own tables only: no lifecycle (a move changes a record), no repository.
   */
  append_only: z.boolean().optional(),
  chain: z.boolean().optional(),
  /**
   * A Settings tab (mold_v0-219): the area's table shows in the customer console's Settings, in `group` (access,
   * connections, automation or data_trust) under `label` (default the area's label), instead of in the Records group.
   * Workspace areas only (a workspace's own settings), and never also a declared sidebar tab.
   */
  settings: z.object({ group: z.enum(["access", "connections", "automation", "data_trust"]), label: z.string().min(1).max(40).optional() }).strict().optional(),
  /**
   * The primary action of the area's own lists (mold_v0-237): its Settings tab (`settings`) and its Records page
   * (/app/records/<name>). Absent, the shell's default (src/metric-spec.ts areaListAction: Add <its singular>, a new
   * record, for a workspace area of the shell's tables a workspace may add to; none, with the reason, otherwise).
   * `false` is none, with `action_reason` (required; shown nowhere, read by people and the factory's spec check). A tab
   * over the area keeps its own `action` (TabSchema).
   */
  action: z.literal(false).optional(),
  action_reason: z.string().trim().min(1).max(300).regex(/^[^\n\r{}<>]*$/, "plain text on one line: no braces or angle brackets").optional(),
  /** In words, what one row is and how it is keyed (for people and intake; never read by code). */
  rows: z.string().max(500).optional(),
  /** In words, where a shared row's version comes from (an edition, a date). */
  version: z.string().max(200).optional(),
  /**
   * Due dates (wired by mold_v0-035; src/schedules.ts): a check area of workspace scope may name one of its date fields.
   * Once a day the shell posts an in-app notice for each record whose date falls within `within_days` (today included),
   * and emails the workspace's people with the `notify` roles (owners by default) a list of them. A sealed area may
   * declare it too (mold_v0-076): its rows are opened with each workspace's own key in the daily check, never read in
   * the database; its notices keep the title sealed and its emails name the record by key, never by title.
   */
  due: z.object({
    field: name,
    within_days: z.number().int().min(0).max(365).default(7),
    notify: z.array(z.enum(["owner", "billing", "member", "viewer"])).min(1).max(4).default(["owner"]),
  }).strict().optional(),
  /** Deadlines its records run against, with reminders and escalation (mold_v0-191; ClockSchema above). */
  clocks: z.array(ClockSchema).max(5).optional(),
  /**
   * The area's contract (mold_v0-222; RecordContractSchema above): its provenance, who may do each action, its primary
   * action. The runtime reads its import, export and reveal (mold_v0-234, mold_v0-235); the rest is declarative.
   * contractProblems refuses one its own declaration contradicts.
   */
  contract: RecordContractSchema.optional(),
  /**
   * The record's page, laid out (mold_v0-253; RecordDetailSchema above): a header with badges and facts, notices, tabs
   * of sections. Drawn while the app's flag record_pages is on; absent (or the flag off), the page is one details card.
   */
  detail: RecordDetailSchema.optional(),
  /**
   * Who sees each record (mold_v0-259; src/visibility.ts), while the app's flag `teams` is on: the modes a record may
   * take (workspace: everyone in the workspace; team: one team's members and leads; private: its owner), the mode a new
   * record takes when its writer does not say, and whether people may be named on a record as collaborators (each sees
   * it whatever its mode). The workspace's owners always see every record. Workspace areas of the shell's own tables only.
   * Off (the default), or not declared: every record is open to the whole workspace, as before.
   */
  visibility: VisibilitySchema.optional(),
  /**
   * Example records of a shared (platform) area (mold_v0-170), for the test lanes only: the lane world
   * (molds/mold_v0/testing/console/world.mts) writes them into its throwaway database, so the area's console pages are
   * graded with rows as well as empty. A deployed build never writes them; the lane checks each against the area's
   * fields as any write is.
   */
  samples: z.array(z.object({
    key: z.string().regex(RECORD_KEY, "a record key: letters, digits and . _ : ( ) -, starting with a letter or digit"),
    title: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(120).optional(),
    data: z.record(z.string(), z.unknown()),
  }).strict()).max(20).optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((a, ctx) => {
  const bad = (message: string, ...path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  if (a.samples?.length && a.scope !== "platform") bad("samples are for a shared (platform) area: a workspace's own records come from its own use", "samples");
  for (const [i, x] of (a.samples ?? []).entries()) {
    if ((a.samples ?? []).findIndex((y) => y.key === x.key) !== i) bad(`sample ${x.key} is declared twice`, "samples", i, "key");
    for (const k of Object.keys(x.data)) if (!a.fields.some((f) => f.name === k)) bad(`${k} is not one of the area's fields`, "samples", i, "data", k);
  }
  if (a.name === "areas") bad("areas is reserved (the list of areas at /api/records/areas)", "name");
  if (a.role === "asset" && a.scope === "platform") bad("an asset area holds a workspace's private data: workspace scope only", "scope");
  if (a.sealed && a.scope === "platform") bad("a shared (platform) area has no workspace key to seal it with: sealed is for workspace areas", "sealed");
  if (a.sealed === false && a.role === "asset") bad("an asset area is always sealed", "sealed");
  if (a.chain && !a.append_only) bad("chain needs append_only: true (a chained record is never changed)", "chain");
  // mold_v0-260: a tenant area is a workspace's own records in the shell's tables; checks on save are for areas written through the record store.
  if (a.tenant && (a.scope !== "workspace" || a.repository)) bad("a tenant area is a workspace's own records in the shell's tables (workspace scope, no repository)", "tenant");
  if (a.on_save && a.repository) bad("checks on save are for an area written through the record store (no repository)", "on_save");
  for (const [i, r] of (a.on_save ?? []).entries()) for (const [k, v] of Object.entries(r.inputs)) {
    if (typeof v === "string" && v.startsWith("@") && !a.fields.some((f) => f.name === v.slice(1))) bad(`${v.slice(1)} is not one of the area's fields`, "on_save", i, "inputs", k);
    if (typeof v === "string" && v.startsWith("@") && a.fields.some((f) => f.name === v.slice(1) && f.encrypted)) bad(`${v.slice(1)} is encrypted: a check never reads it`, "on_save", i, "inputs", k);
  }
  if (a.append_only && a.scope !== "workspace") bad("append_only is for a workspace's own records (a shared area is written by staff)", "append_only");
  if (a.append_only && a.lifecycle) bad("an append-only area has no lifecycle: a move changes a record", "append_only");
  if (a.append_only && a.repository) bad("an append-only area keeps its records in the shell's own tables, not a repository's", "append_only");
  if (new Set(a.fields.map((f) => f.name)).size !== a.fields.length) bad("a field is declared twice", "fields");
  // mold_v0-282 (flag record_resources): a record's own repository or database is a shared record's, written by staff
  // through the record store (never a workspace's own row, never a repository's index).
  for (const [i, f] of a.fields.entries()) if ((RESOURCE_FIELD_TYPES as readonly string[]).includes(f.type)) {
    if (a.scope !== "platform") bad(`a ${f.type} field is for a shared (platform) area's records, which staff write`, "fields", i, "type");
    if (a.repository) bad(`a ${f.type} field is for an area written through the record store (no repository)`, "fields", i, "type");
    if (a.list_columns?.includes(f.name) && f.type === "database") bad(`${f.name} is a database field: it has no value to show in a list`, "list_columns");
  }
  // mold_v0-194: an encrypted field's value is never read by the shell itself, so nothing may be computed from it.
  for (const [i, f] of a.fields.entries()) if (f.encrypted) {
    if (a.scope !== "workspace") bad("a shared (platform) area has no workspace key: encrypted is for a workspace area's fields", "fields", i, "encrypted");
    if (a.lifecycle?.field === f.name) bad(`${f.name} is the lifecycle's field: it cannot be encrypted`, "fields", i, "encrypted");
    if (a.due?.field === f.name) bad(`${f.name} is the due date's field: it cannot be encrypted`, "fields", i, "encrypted");
    if ((a.links ?? []).some((l) => l.field === f.name)) bad(`${f.name} is a link's field: it cannot be encrypted`, "fields", i, "encrypted");
    if (JSON.stringify(a.clocks ?? []).includes(JSON.stringify(f.name))) bad(`${f.name} is named by a clock: it cannot be encrypted`, "fields", i, "encrypted");
  }
  if (!(a.list_columns ?? []).every((c) => a.fields.some((f) => f.name === c))) bad("list_columns must name declared fields", "list_columns");
  if (!(a.links ?? []).every((l) => a.fields.some((f) => f.name === l.field))) bad("a link's field must be a declared field", "links");
  for (const [i, l] of (a.links ?? []).entries()) {
    const f = a.fields.find((x) => x.name === l.field);
    if (f?.type === "reference" && f.to !== l.area) bad(`field ${f.name} refers to ${f.to}; its link names ${l.area}`, "links", i);
  }
  if (a.due && !(a.role === "check" && a.scope === "workspace")) bad("due is for a check area of workspace scope (each workspace's own dates)", "due");
  if (a.due && !a.fields.some((f) => f.name === a.due!.field && f.type === "date")) bad("due.field must name one of the area's date fields", "due", "field");
  for (const p of clockProblems(a, a.clocks ?? [])) bad(p.message, "clocks", ...p.path);
  for (const p of contractProblems(a)) bad(p.message, "contract", ...p.path);
  for (const p of detailProblems(a)) bad(p.message, "detail", ...p.path);
  // mold_v0-259: a record's visibility is a workspace's own row's, written through the record store's doors.
  if (a.visibility && a.scope !== "workspace") bad("`visibility` is for a workspace's own records (a shared area is every workspace's)", "visibility");
  if (a.visibility && a.repository) bad("`visibility` is for records written through the record store: an area fed by a repository has no person who owns its rows", "visibility");
  if (inheritsVisibility(a.visibility)) {
    const f = a.fields.find((x) => x.name === (a.visibility as { inherit: string }).inherit);
    if (!f) bad(`visibility.inherit names ${(a.visibility as { inherit: string }).inherit}, which is not one of the area's fields`, "visibility", "inherit");
    else if (f.type !== "reference" || f.multiple) bad(`visibility.inherit names ${f.name}: a single reference field (whoever sees its record sees this one)`, "visibility", "inherit");
  }
  if (a.action === false && !a.action_reason) bad("action: false says why its lists have no primary action (action_reason)", "action_reason");
  if (a.action_reason !== undefined && a.action !== false) bad("action_reason is for action: false", "action_reason");
  const p = a.permissions;
  if (p) for (const k of ["create", "update", "move", "delete"] as const) {
    if (a.scope === "platform" && p[k]) bad(`a shared (platform) area is written by platform staff only: declare read alone`, "permissions", k);
    if ((p[k] ?? []).includes("viewer")) bad(`viewer is read-only in the platform: a declaration cannot let a viewer ${k}`, "permissions", k);
  }
  const lc = a.lifecycle;
  if (lc) {
    if (a.scope !== "workspace") bad("a lifecycle is for a workspace's own records (a shared area is written by staff)", "lifecycle");
    const f = a.fields.find((x) => x.name === lc.field);
    if (!f || f.type !== "enum" || f.multiple) bad(`lifecycle.field must name one of the area's single-choice enum fields`, "lifecycle", "field");
    else {
      const states = new Set(optionValues(f));
      if (!states.has(lc.initial)) bad(`initial ${lc.initial} is not one of ${f.name}'s options`, "lifecycle", "initial");
      for (const [i, t] of lc.transitions.entries()) {
        for (const s of t.from === "*" ? [] : t.from) if (!states.has(s)) bad(`from ${s} is not one of ${f.name}'s options`, "lifecycle", "transitions", i, "from");
        if (!states.has(t.to)) bad(`to ${t.to} is not one of ${f.name}'s options`, "lifecycle", "transitions", i, "to");
        if ((t.roles ?? []).includes("viewer")) bad("viewer is read-only in the platform: a transition cannot be a viewer's", "lifecycle", "transitions", i, "roles");
      }
    }
  }
});

/** The links of an area: its declared `links` and one per reference field (mold_v0-057), each field once. */
export const areaLinks = (a: { fields: { name: string; type?: string; to?: string }[]; links?: { field: string; area: string }[] }) => {
  const out = [...(a.links ?? [])];
  for (const f of a.fields) if (f.type === "reference" && f.to && !out.some((l) => l.field === f.name)) out.push({ field: f.name, area: f.to });
  return out;
};

// ---------- data repositories (mold_v0-059; src/data-repositories.ts) ----------

/** The repository kinds: where an area's rows come from. */
export const REPOSITORY_KINDS = ["shell_tables", "workspace_files", "http_api"] as const;
/**
 * mold_v0-283 (operator, 2026-11-08): the upstream_catalog kind (a shared list copied from one GitHub repository at a
 * pinned commit) is gone for good. A list tied to one shared repository could not be edited by the people who keep it,
 * and one bad commit there changed every deployment's records. Shared lists are platform records staff keep with New,
 * Edit and Import. A pack that still declares one is refused with this sentence.
 */
export const UPSTREAM_CATALOG_GONE = "the upstream_catalog repository kind was removed (mold_v0-283): a shared list copied from a GitHub repository cannot be edited and changes with every commit there. Make the areas it fed platform records (scope platform, no repository), which staff keep with New, Edit and Import (a one-time import file of the rows it held), and remove this repository";
/** The repositories of a declaration that are upstream catalogs (refused: UPSTREAM_CATALOG_GONE). */
export const upstreamCatalogNames = (repos: unknown): string[] => (repos && typeof repos === "object" && !Array.isArray(repos)
  ? Object.entries(repos as Record<string, unknown>).filter(([, r]) => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "upstream_catalog").map(([n]) => n) : []);
/** Kinds whose areas are read only through every door (their rows come from the repository). */
export const READ_ONLY_KINDS = ["workspace_files", "http_api"] as const;
const comment = z.string().max(2000).optional();
const fileKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "a file name in the declaration: lowercase letters, digits and _");
/** A path inside a repository or a workspace's files: no "..", no leading "/"; {name} placeholders and * in the last part. */
const repoPath = z.string().regex(/^(?!\/)[A-Za-z0-9._/{}*-]{1,300}$/, "a relative path (letters, digits, . _ - / { } *)")
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "." || s === ""), "a relative path with no . or .. part");
/**
 * A value inside a document: a dotted path of properties ("a.b"), each property optionally followed by list indexes
 * ("controls[0]", "refs[0].id": the item at that position, counted from 0, at most 999), "$." for the document's root,
 * "@<name>" a path placeholder, "@file" the file's path. A plain grammar (no expressions, no negative or computed
 * indexes, no quotes), parsed by src/data-repositories.ts valueAt; __proto__, constructor and prototype are never a part.
 */
export const VALUE_PATH = /^(?!.*(^|[.@$])(__proto__|constructor|prototype)([.[]|$))(@[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*|(\$\.)?[A-Za-z_][A-Za-z0-9_]*(\[(0|[1-9][0-9]{0,2})\])*(\.[A-Za-z_][A-Za-z0-9_]*(\[(0|[1-9][0-9]{0,2})\])*)*)$/;
const valuePath = z.string().max(300).regex(VALUE_PATH, "a value path: a.b, a list's item a[0] or a[0].b, $.a (the document's root), @name (a path placeholder) or @file");
/** Text with {value path} parts: a record's key or title made from a document's values. */
const template = z.string().min(1).max(300).refine((t) => /\{[^{}]+\}/.test(t) && [...t.matchAll(/\{([^{}]*)\}/g)].every((m) => VALUE_PATH.test(m[1]!)) && !/[\u0000-\u001f]/.test(t),
  "a template: text with {value path} parts, e.g. {id} or {$.instrument}:{id}");
/**
 * A value path that may also take EVERY item of a list (mold_v0-123): "a[]" (each item of a), "a[].b" (b of each item),
 * beside "a[0]". Only a field's computed value (FieldValueSchema `value`) takes one: it gives the list of the values found.
 */
export const LIST_PATH = /^(?!.*(^|[.@$])(__proto__|constructor|prototype)([.[]|$))(@[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*|(\$\.)?[A-Za-z_][A-Za-z0-9_]*(\[(0|[1-9][0-9]{0,2})?\])*(\.[A-Za-z_][A-Za-z0-9_]*(\[(0|[1-9][0-9]{0,2})?\])*)*)$/;
const listPath = z.string().max(300).regex(LIST_PATH, "a value path: a.b, a[0], a[] (every item of the list a) or a[].b");
/** A bounded pattern (src/safe-pattern.ts): limited syntax and size, so testing one never takes long. */
const pattern = z.string().max(PATTERN_LIMITS.chars).superRefine((p, ctx) => {
  const e = patternProblem(p);
  if (e) ctx.addIssue({ code: "custom", message: `a bounded pattern: ${e}` });
});
/** What a value must be to count (mold_v0-123): text (not empty), a number, a record key, a list or true/false. */
export const VALUE_KINDS = ["text", "number", "key", "list", "boolean"] as const;
/** One test of the values at a path: `only` a kind of value, `matches` a bounded pattern (text only). */
const ValueTestSchema = z.object({ value: listPath, only: z.enum(VALUE_KINDS).optional(), matches: pattern.optional() }).strict();
/**
 * A field's value (mold_v0-123): a value path, or a computed value with no code:
 *   {value, only?, matches?, max_length?, as?}  the values at `value` that are of kind `only` and match `matches`, text cut
 *                                               to `max_length` characters; `as` "first" (the first of them: the default
 *                                               for a path with no []) or "list" (all of them, none when there are none:
 *                                               the default for a path with [])
 *   {any: [{value, only?, matches?}, ...]}      true when any test finds a value, else false
 */
export const FieldValueSchema = z.union([
  valuePath,
  z.object({ value: listPath, only: z.enum(VALUE_KINDS).optional(), matches: pattern.optional(), max_length: z.number().int().min(1).max(20_000).optional(), as: z.enum(["first", "list"]).optional() }).strict(),
  z.object({ any: z.array(ValueTestSchema).min(1).max(10) }).strict(),
]);
/** A `where` value: equal to this text, number or true/false, or a test ({only?, matches?}: at least one). */
const WhereValueSchema = z.union([z.string().max(200), z.number(), z.boolean(),
  z.object({ only: z.enum(VALUE_KINDS).optional(), matches: pattern.optional() }).strict().refine((t) => t.only !== undefined || t.matches !== undefined, "a test names only or matches")]);
const whereSchema = z.record(z.string().max(300).regex(VALUE_PATH, "a value path"), WhereValueSchema);
/**
 * How a repository's documents become one area's rows (no code): `from` names one of the repository's `files` (a file, a
 * directory or a glob: every JSON document under it), `each` the list inside a document that holds one row per item
 * ("groups.controls": every control of every group), `key` and `title` templates, and `fields` each field's value
 * (FieldValueSchema; absent: the item's property of the same name, or its camelCase form).
 *
 * For a file of lines (a workspace_files `path`, mold_v0-123): `retires` a value path naming the key of an EARLIER row
 * a line ends (an append-only file's "this supersedes that": a line naming its own key is just its new version), and
 * `only_latest` {by, among?}: only the lines whose `by` value is the greatest of the lines that match `among` (a `where`),
 * e.g. the points of the latest measurement; no line matches `among`: no rows.
 */
export const RowMapSchema = z.object({
  from: fileKey.optional(),
  each: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, "a dotted path to a list (each list on the way is walked)").optional(),
  key: template,
  title: template.optional(),
  fields: z.record(name, FieldValueSchema).optional(),
  /** Only the items whose values are these (e.g. {"kind": "control"} in a ledger that holds several kinds of lines), or pass these tests. */
  where: whereSchema.optional(),
  retires: valuePath.optional(),
  only_latest: z.object({ by: valuePath, among: whereSchema.optional() }).strict().optional(),
}).strict();
export type RowMap = z.output<typeof RowMapSchema>;
export type FieldValue = z.output<typeof FieldValueSchema>;
/** An upstream project pinned by commit: a full commit id, never a branch or a tag. */
export const UpstreamSchema = z.object({
  repo: z.string().regex(/^(https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+|file:\/\/\/[A-Za-z0-9._~/-]+)$/, "an https:// repository address (file:// only in tests)"),
  commit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit id (40 or 64 hex characters): never a branch or a tag"),
  /** Its licence, as an SPDX id or expression ("AGPL-3.0-only", "MIT OR Apache-2.0"): shown in the build's source offer. */
  license: z.string().regex(/^(?=.{1,80}$)\(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?( (AND|OR|WITH) \(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?)*$/, "an SPDX licence id or expression (letters, digits, . + - ( ) and spaces)").optional(),
}).strict();
/** A repository's name as staff read it on the Data repositories page (mold_v0-169); absent: its id in words ("company_ledger": "Company ledger"). */
const repoLabel = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/, "plain text on one line").optional();
const ShellTablesSchema = z.object({ kind: z.literal("shell_tables"), $comment: comment, label: repoLabel }).strict();
/**
 * The workspace store's files (mold_v0-033): read only, indexed into the workspace's rows after a commit. Either `path`
 * (a file template: one row per `identity` value of a JSON-lines or JSON-list file, the last one winning when
 * `append_only`) or `dir` (a directory template: one row per matching directory, its `files` read into the fields of the
 * same name). `{name}` parts match one path segment and are values (@name); `store` is the pack's own store (its id).
 * `never_read` names what is never kept: "<file> <a.b[].c>" drops that value of that file, "any ENC[...] value" drops
 * every sealed (sops) value.
 */
const WorkspaceFilesSchema = z.object({
  kind: z.literal("workspace_files"), $comment: comment, label: repoLabel,
  store: name.optional(),
  path: repoPath.optional(),
  dir: repoPath.optional(),
  files: z.record(fileKey, repoPath).optional(),
  format: z.enum(["json", "jsonl", "text"]).optional(),
  identity: valuePath.optional(),
  append_only: z.boolean().optional(),
  latest: z.string().max(200).optional(),
  never_read: z.array(z.string().max(200).refine((r) => !/(__proto__|constructor|prototype)/.test(r), "no __proto__, constructor or prototype").regex(/^(any ENC\[\.\.\.\] value|\S+ [A-Za-z_][A-Za-z0-9_]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\])?)*)$/, "\"<file> <a.b[].c>\" or \"any ENC[...] value\"")).max(50).optional(),
  map: z.record(name, RowMapSchema).optional(),
}).strict()
  .refine((r) => (r.path === undefined) !== (r.dir === undefined), "a workspace_files repository names a path (one file template) or a dir (a directory template), not both")
  .refine((r) => r.files === undefined || r.dir !== undefined, "files are read inside each dir: declare dir");
/**
 * An external HTTP API, read live and read only: `base_url` (its host among `egress`, the only hosts it may reach; a
 * redirect is refused), the workspace's `credential` field (mold_v0-034, bound to the workspace) sent in `auth.header`,
 * `list.path` (the list of items at `list.items`), `get.path` (with {key}) and a `map` per area.
 */
const HttpApiSchema = z.object({
  kind: z.literal("http_api"), $comment: comment, label: repoLabel,
  base_url: z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/i, "an https:// address"),
  egress: z.array(host).min(1).max(10),
  credential: name.optional(),
  auth: z.object({ header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/, "a header name").optional(), scheme: z.string().regex(/^[A-Za-z]{1,20}$/, "a word").optional() }).strict().optional(),
  list: z.object({ path: z.string().regex(/^\/[A-Za-z0-9._~/-]*(\?[A-Za-z0-9._~=&-]*)?$/, "a path under base_url"), items: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/).optional() }).strict(),
  get: z.object({ path: z.string().regex(/^\/[A-Za-z0-9._~/{}-]*\{key\}[A-Za-z0-9._~/{}-]*$/, "a path under base_url with {key}") }).strict().optional(),
  map: z.record(name, RowMapSchema.omit({ from: true, each: true, where: true, retires: true, only_latest: true })).optional(),
  max_items: z.number().int().min(1).max(5000).optional(),
}).strict();
/**
 * A data repository (mold_v0-059; src/data-repositories.ts): a `kind` and its settings. An area names one with
 * `repository`; an area that names none reads the shell's tables.
 */
export const RepositorySchema = z.discriminatedUnion("kind", [ShellTablesSchema, WorkspaceFilesSchema, HttpApiSchema]);
export type Repository = z.output<typeof RepositorySchema>;

/** What a pack's loader reads: one repository's documents, never a workspace id or a database. */
export interface RepositoryInput {
  repository: string;
  kind: "workspace_files";
  settings: Record<string, unknown>;
  /** The files' version, when their source has one; null for a workspace's files. */
  version: string | null;
  /** The areas this repository feeds: their names, roles and fields (rows name these). */
  areas: { name: string; role: "source" | "check" | "asset"; fields: string[] }[];
  /** A file's text (null when absent): a path inside the repository or the workspace's files. */
  read(path: string): Promise<string | null>;
  /** The files under a directory (every file when absent), sorted. */
  list(dir?: string): Promise<string[]>;
}
/** A loader's rows, by area: each a key, a title and the area's fields (checked like any write). */
export type RepositoryRows = Record<string, { key: string; title?: string | null; data: Record<string, unknown> }[]>;
/** A pack's code that turns a repository's documents into rows (when the declared `map` is not enough). */
export type RepositoryLoader = (input: RepositoryInput) => RepositoryRows | Promise<RepositoryRows>;

/**
 * How a run's output becomes run_results rows (mold_v0-061 with the agent-workspace runner; 063's metrics read the rows):
 * declared here so a pack.json can carry it today. `check`, when given, names the record areas a result's check is in
 * (checked against the build); 061 defines and checks the rest.
 */
export const RunResultsSchema = z.object({
  check: z.array(name).max(20).optional(),
  $comment: z.string().max(2000).optional(),
}).catchall(z.unknown());

// ---------- metrics, charts and console tabs (mold_v0-063, mold_v0-058) ----------

/**
 * What a metric or a tab may name besides an area's own fields: a field name, or a column the shell keeps for the rows
 * it is over (`created`, `updated` for records; `status`, `check`, `asset`, `source`, `check_area`, `created` and
 * `detail.<word>` for run_results; `status`, `kind`, `error_kind`, `cost_usd`, `created`, `started`, `ended` for runs).
 * Plain words only: they reach SQL as bound values, never as text of the query (src/metrics.ts).
 */
const fieldRef = z.string().regex(/^([a-z][a-z0-9_]{1,62}|detail\.[a-z][a-z0-9_]{0,62})$/, "a field name (lowercase letters, digits and _), or detail.<word> over run_results");
/**
 * A point in time: one of the area's date fields; `created` or `updated` (the row's own times); `state:<value>` (when the
 * record last entered that state of its lifecycle: the shell records it on every write and move since mold_v0-063);
 * `started` or `ended` (runs).
 */
export const METRIC_POINT = /^(state:[A-Za-z0-9][A-Za-z0-9 _.:/()&-]{0,79}|[a-z][a-z0-9_]{1,62})$/;
const point = z.string().regex(METRIC_POINT, "a date field, created, updated, started, ended or state:<value>");
/** A value a condition compares with: a choice value or word, a number, true/false, a date (YYYY-MM-DD), today or now (optionally +/- days: today-30). */
const condValue = z.union([choiceValue, z.number().finite(), z.boolean()]);
export const METRIC_OPS = ["eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte", "empty", "not_empty"] as const;
/**
 * One condition of a metric's `where` (all must hold) or of a rate's numerator: a field, an operator and a value.
 *   eq ne          equal / not equal (ne also takes rows with no value)
 *   in not_in      one of / none of a list (not_in also takes rows with no value)
 *   lt lte gt gte  numbers, or dates against a date (YYYY-MM-DD), "today" or "now", optionally +/- days ("today-30")
 *   empty not_empty  no value / a value
 */
export const MetricConditionSchema = z.object({
  field: fieldRef,
  op: z.enum(METRIC_OPS),
  value: z.union([condValue, z.array(condValue).min(1).max(50)]).optional(),
}).strict().superRefine((c, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message, path: ["value"] });
  if (c.op === "empty" || c.op === "not_empty") { if (c.value !== undefined) bad(`${c.op} takes no value`); return; }
  if (c.value === undefined) return bad(`${c.op} needs a value`);
  if ((c.op === "in" || c.op === "not_in") !== Array.isArray(c.value)) bad(c.op === "in" || c.op === "not_in" ? `${c.op} takes a list of values` : `${c.op} takes one value`);
  if (["lt", "lte", "gt", "gte"].includes(c.op) && typeof c.value !== "number" && !(typeof c.value === "string" && RELATIVE_DATE.test(c.value)))
    bad(`${c.op} compares with a number, a date (YYYY-MM-DD), today or now (optionally +/- days, as today-30)`);
});
/** A date a condition may compare with: YYYY-MM-DD, or today/now with an optional +/- number of days. */
export const RELATIVE_DATE = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])|(today|now)([+-]\d{1,4})?)$/;

export const METRIC_MEASURES = ["count", "sum", "average", "rate", "duration"] as const;
/**
 * A metric (mold_v0-063; src/metrics.ts computes it): a number, or numbers by group or over time, computed on the server
 * for one workspace under its row-level security, over a record area of the build (its shared rows, or the workspace's
 * own) or over the workspace's runs or run_results.
 *   measure   count (the default) | sum or average of a number `field` | rate (the share of rows meeting `rate.where`,
 *             0 to 1) | duration (the time from `duration.from` to `duration.to`, as its average, median, p90 or max, in
 *             days or hours; rows without both are left out)
 *   where     conditions every row must meet (open findings: state in open, triaged)
 *   group_by  a field (one bar per value; an enum's options in their declared order), or {due: a date field, soon_days}:
 *             overdue / due soon / later / no date, against today
 *   group_by_list  for a group_by field that holds a list (a link, or an enum, person or reference with `multiple`;
 *             mold_v0-076): "first" groups each row by the list's first item (a link holding one key is that key),
 *             "each" counts a row in the group of every item it lists (once per distinct item; a row's measure counts
 *             in each of its groups, so the groups may add up to more than the rows; `rows` is still the rows read)
 *   by_time   a series: rows by `at` (a point in time), one bucket per day, week (from Monday) or month, the `last` N
 *             buckets up to now (UTC). With group_by, one series per group (an enum or a status: at most 8 groups)
 *   limit     groups shown (largest first; an enum's options in order), at most 50; the answer says when there are more
 *   roles     who may read it (narrows: an area metric also needs the area's read permission)
 *   unit      how the console shows it (count, number, usd, percent, percent_100, days, hours); from the measure when
 *             absent. "percent" is a share from 0 to 1 (a rate), shown times 100; "percent_100" (mold_v0-079) a value
 *             that is already 0 to 100 (an average of percentages a run measured), shown as it is
 */
/** The units a metric is shown in (src/metric-spec.ts metricUnit; the console's formatValue). */
export const METRIC_UNITS = ["count", "number", "usd", "percent", "percent_100", "days", "hours"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];
export const MetricSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  over: name,
  measure: z.enum(METRIC_MEASURES).default("count"),
  field: fieldRef.optional(),
  rate: z.object({ where: z.array(MetricConditionSchema).min(1).max(10) }).strict().optional(),
  duration: z.object({
    from: point, to: point,
    stat: z.enum(["average", "median", "p90", "max"]).default("average"),
    unit: z.enum(["days", "hours"]).default("days"),
  }).strict().optional(),
  where: z.array(MetricConditionSchema).max(10).optional(),
  /** Only the records whose clock (mold_v0-191) is in one of these states: overdue, due_soon, on_track, paused, met, missed, not_started. */
  clock: z.object({ name, is: z.array(z.enum(["overdue", "due_soon", "on_track", "paused", "met", "missed", "not_started"])).min(1).max(7) }).strict().optional(),
  group_by: z.union([fieldRef, z.object({ due: name, soon_days: z.number().int().min(1).max(365).default(7) }).strict()]).optional(),
  group_by_list: z.enum(["first", "each"]).optional(),
  by_time: z.object({
    at: point,
    every: z.enum(["day", "week", "month"]),
    last: z.number().int().min(2).max(400).default(12),
  }).strict().optional(),
  limit: z.number().int().min(1).max(50).default(12),
  roles: z.array(role).min(1).max(4).optional(),
  unit: z.enum(METRIC_UNITS).optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((m, ctx) => {
  const bad = (message: string, ...path: string[]) => ctx.addIssue({ code: "custom", message, path });
  const needs = { sum: "field", average: "field", rate: "rate", duration: "duration" } as const;
  for (const [measure, key] of Object.entries(needs)) {
    if (m.measure === measure && m[key] === undefined) bad(`a ${measure} metric names its ${key}`, key);
    if (m.measure !== measure && key !== "field" && m[key] !== undefined) bad(`${key} is for a ${measure} metric`, key);
  }
  if (m.field !== undefined && m.measure !== "sum" && m.measure !== "average") bad("field is for a sum or average metric", "field");
  const max = { day: 400, week: 260, month: 120 } as const;
  if (m.by_time && m.by_time.last > max[m.by_time.every]) bad(`by_time.last is at most ${max[m.by_time.every]} for every ${m.by_time.every}`, "by_time", "last");
  if (m.by_time && m.group_by && typeof m.group_by === "object") bad("a series groups by a field, not by due dates", "group_by");
  if (m.group_by_list !== undefined && typeof m.group_by !== "string") bad("group_by_list says how to group by a field that holds a list: declare that field as group_by", "group_by_list");
  if (m.name === "metrics") bad("metrics is reserved", "name");
});
export type Metric = z.output<typeof MetricSchema>;

/**
 * The chart forms the console draws (web/src/features/tabs/charts.tsx), chosen by the data's job:
 *   number        stat tiles: one per metric, each a single value (no group_by, no by_time)
 *   bar           magnitude by group (one metric with group_by), or by time (one metric with by_time)
 *   stacked_bar   part-to-whole: one metric with group_by and by_time (a column per bucket, a segment per group), or
 *                 2-6 metrics with the same group_by (a bar per group, a segment per metric)
 *   line, area    trends: 1-4 metrics with by_time (the same buckets), or one with by_time and group_by
 *   table         any metrics with the same grouping: a row per group or bucket, a column per metric
 * No donut or pie (the console's chart rules: part-to-whole is a stacked bar, close values a bar), and never two y-axes.
 * `palette` "ordinal" colours an ordered enum (low to critical) with one hue, light to dark; "categorical" (default) gives
 * each group or metric its own hue, in a fixed order that follows the entity, never its rank.
 */
export const CHART_TYPES = ["bar", "stacked_bar", "line", "area", "number", "table"] as const;
export const ChartSchema = z.object({
  name,
  title: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  type: z.string().superRefine((t, ctx) => {
    if (t === "donut" || t === "pie") ctx.addIssue({ code: "custom", message: `${t} charts are not offered: show part-to-whole as a stacked_bar and close values as a bar` });
    else if (!(CHART_TYPES as readonly string[]).includes(t)) ctx.addIssue({ code: "custom", message: `type is one of ${CHART_TYPES.join(", ")}` });
  }).transform((t) => t as (typeof CHART_TYPES)[number]),
  metrics: z.array(name).min(1).max(6),
  palette: z.enum(["categorical", "ordinal"]).default("categorical"),
  $comment: z.string().max(2000).optional(),
}).strict();
export type Chart = z.output<typeof ChartSchema>;

/**
 * A console tab (mold_v0-058): an entry of the /app sidebar and the page it opens. When any pack declares tabs, the
 * sidebar is exactly the declared tabs, in order (grouped by `group`); with none it is the shell's own.
 *   overview      the tab's `charts` (mold_v0-063); `include` makes it a home page (mold_v0-134): with `setup` it is
 *                 drawn as the Setup page (mold_v0-172: the checklist of the setup steps and the packs' onboarding
 *                 steps, each with its prompt, the connection card and the `rail` cards beside it); `notices` the
 *                 records due soon (a `rail` card; mold_v0-216: never a section below the checklist). A tab that
 *                 includes setup is drawn at /app itself (mold_v0-175; its /app/<id> redirects there); /app/notices
 *                 then redirects to the tab when its rail shows the notices card (else it stays its own page),
 *                 and a build refuses a setup or a notices tab beside it (its page would only redirect here). Since
 *                 mold_v0-207 a home tab's `charts` (and `charts_title`) are accepted and not drawn: the home page has
 *                 no charts grid (its headline row, the Due soon card and the rail's number cards stay)
 *   area          a record area's records: `views` table (rows and list columns), board (a column per state of
 *                 `board_by`, the lifecycle's field by default), timeline (by `timeline_by`: one of its date fields, or
 *                 updated, the default), detail (rows open the record's page); `charts` above them. `columns` (any area
 *                 tab) names the table's columns, the area's list columns by default. `areas` in place of `area`
 *                 (mold_v0-135): several areas as one list, rows merged by record key (TabAreaSchema below)
 *   runs          the workspace's runs; reports: finished runs and their results
 *   credentials, usage, schedules, notices, setup, billing, profile   the shell's own page
 *   page          one of the pack's own pages (pack.json pages, `page`)
 *   sections      one page of several of the pack's tabs (mold_v0-175): `sections` names them in order (area, runs,
 *                 reports or schedules tabs), each an in-page tab under its own label (above its charts, views and
 *                 table; ?tab=<id> picks one). They leave the sidebar, their own address of before (/app/<id>, or the
 *                 shell's page: /app/schedules) redirects to /app/<this tab>?tab=<id>, and this tab is shown to the
 *                 roles that may read one of them (each in-page tab to the roles its own tab is)
 * An area tab over one area may narrow its rows with `filter` (mold_v0-175): a list filter as the record tools take it
 * ({field: value} or {field: {op: value}}), applied by the server (/api/records/tabs/<pack>/<tab>), never by the page.
 *   files         the pack's workspace store in the console's file viewer (mold_v0-056; /app/files): versions, files,
 *                 diffs, for the roles that may read every one of the pack's record areas
 * A list tab (area, runs, reports, schedules; mold_v0-181) shows four cards between its toolbar and its table, each a
 * metric's label, value and a sparkline of its last weeks: `sparklines` names exactly 4 of the pack's metrics (a single
 * number or a series, never grouped); without it the shell's four for the kind (src/metric-spec.ts sparkPlan). A home
 * tab (an overview that includes setup; mold_v0-203) may name 1 to 4 of them: the same cards, as a row above its
 * columns (the checklist or journey, the connection card and the journey picker); without it, no row.
 * `label` is the tab's name in the app's words (default: the area's label, else the shell's word), `icon` one of
 * TAB_ICONS, `roles` who sees it (narrowing what its data allows: an area tab is never shown to a role that may not read
 * the area, an overview never to one that may read none of its metrics).
 */
// team and keys (mold_v0-133): the shell's Team page (part of Billing) and the person's own API keys, so a declared sidebar reaches every shell page.
// agent: the workspace agent's page (/app/agent, its sessions), a sidebar entry where the build puts it; only with agent_harness on.
// sections (mold_v0-175): one page of several of the pack's area tabs, as in-page tabs.
/** The kinds of tab a sections tab shows as its in-page tabs (mold_v0-175). */
export const SECTION_KINDS = ["area", "runs", "reports", "schedules"] as const;
/** The kinds of tab drawn as a list with four sparkline cards below its toolbar (mold_v0-181: `sparklines`). */
export const SPARK_KINDS = ["area", "runs", "reports", "schedules"] as const;
/** Where a tab may sit instead of the sidebar (mold_v0-280): inside the Settings page, as one of its tabs. */
export const TAB_INSIDE = ["settings"] as const;
/** The tab kinds that may sit inside Settings (mold_v0-280): the shell's Team page and the person's API keys. */
export const INSIDE_KINDS = ["team", "keys"] as const;
export const TAB_KINDS = ["overview", "area", "runs", "reports", "credentials", "usage", "schedules", "notices", "setup", "billing", "profile", "team", "keys", "page", "files", "sections", "agent"] as const;
// TAB_ICONS: declared above RecordAreaSchema (a record area takes one too, mold_v0-242).
export const TAB_VIEWS = ["table", "board", "timeline", "detail"] as const;
/** The shell's sections an overview tab may show above its charts (mold_v0-134): the Setup page's checklist, the notices. */
export const TAB_INCLUDES = ["setup", "notices"] as const;
/**
 * The cards of a home tab's right column (mold_v0-172), below the "Connect your AI client" card, in order:
 *   journeys       the journey picker: "Get set up" (the setup steps, every build's) and the build's journeys
 *                  (mold_v0-175: pack.json journeys adds its own; with none the picker has Get set up alone)
 *   notices        the records due soon, as a short list (needs a due-date area; the tab then also includes notices)
 *   chart:<name>   one of the pack's number charts as a card of its tiles, with a link to the tab that shows it beside
 *                  the other charts (another overview tab of the pack listing it), when there is one
 * Left out: the journey picker (the Setup page's own layout: every build has Get set up, mold_v0-175).
 */
export const TAB_RAIL = /^(journeys|notices|recent_runs|attention|chart:[a-z][a-z0-9_]{1,62})$/;
/** mold_v0-260 (flag overview_cards): the home tab's own cards: the workspace's latest runs, the records that need attention. */
export const HOME_CARDS = ["recent_runs", "attention"] as const;
/** A home tab's rail past this many cards, a fifth headline number or one of HOME_CARDS asks for overview_cards (mold_v0-260). */
export const RAIL_MAX = 2, HOME_HEADLINE_MAX = 4;
/**
 * What an area, runs or reports tab says while it has nothing to show (mold_v0-107): `text`, and a call to action `cta`
 * with a `label` and either an `href` (a path of this site, an https:// or a mailto: address: the landing block's rules,
 * src/landing.ts) or an `action`:
 *   setup               the Setup page (/app), where the person connects an AI client and follows the onboarding steps
 *   onboarding:<step>   one of this pack's onboarding steps, on the Setup page
 *   run:<kind>          one of this pack's job kinds: started from an AI client, so the action leads to the Setup page
 * Plain text, shown as text, on one line; no braces (the build's word placeholders are the shell's: a pack writes its own
 * words). Anything left out gets the shell's default, made from the area's label, the build's words and its onboarding
 * (src/metric-spec.ts tabEmpty).
 */
export const TAB_EMPTY_ACTION = /^(setup|onboarding:[a-z][a-z0-9_]{1,62}|run:[a-z][a-z0-9_]{1,62})$/;
const emptyText = (max: number) => z.string().min(1, "text is required").max(max, `at most ${max} characters`)
  .refine((s) => s.trim().length > 0, "text is required")
  .refine((s) => !NOT_PLAIN.test(s), "plain text on one line: no line breaks, control or invisible characters")
  .refine((s) => !/[{}]/.test(s), "no braces: placeholders are the shell's own words; write the pack's words as they are");
export const TabEmptySchema = z.object({
  text: emptyText(300).optional(),
  cta: z.object({
    label: emptyText(40).optional(),
    href: z.string().min(1).max(500).superRefine((h, ctx) => { const p = hrefProblem(h); if (p) ctx.addIssue({ code: "custom", message: p }); }).optional(),
    action: z.string().regex(TAB_EMPTY_ACTION, "setup, onboarding:<one of the pack's onboarding steps> or run:<one of the pack's job kinds>").optional(),
  }).strict().superRefine((c, ctx) => {
    if ((c.href === undefined) === (c.action === undefined)) ctx.addIssue({ code: "custom", message: "a call to action has either an href or an action" });
    if (c.href !== undefined && c.label === undefined) ctx.addIssue({ code: "custom", message: "a link names its label", path: ["label"] });
  }).optional(),
  $comment: z.string().max(2000).optional(),
}).strict();
export type TabEmpty = z.output<typeof TabEmptySchema>;
/**
 * One area of a merged tab (mold_v0-135): an area tab with `areas` in place of `area` shows several record areas as one
 * list, one row per record key. A row's fields are the union of its areas' fields; where two areas hold a field of the
 * same name, the first area of the list that has a value gives it (so does the title). Rows come area by area, in the
 * list's order, each by key: the first area's rows, then the next area's rows that no earlier area holds, and so on.
 *   rows: all       (the default) the area's rows join the list
 *   rows: matched   the area only adds its fields to rows another area brings (a lookup by key): a shared catalog's
 *                   entries beside the workspace's own status of the ones it tracks, never the whole catalog
 *   source          the area's word in the tab's `source` column (a row shows the first of its areas, in the list's
 *                   order, that has one): plain text on one line, at most 40 characters
 * The first area is the tab's own (its label, its empty state, its onboarding); it brings rows. A row opens the record
 * of the first of its areas (the detail view). Who sees the tab: the roles that may read every one of its areas.
 */
export const TAB_SOURCE_COLUMN = "source";
export const TabAreaSchema = z.object({
  area: name,
  rows: z.enum(["all", "matched"]).optional(),
  source: emptyText(40).optional(),
  $comment: z.string().max(2000).optional(),
}).strict();
export type TabArea = z.output<typeof TabAreaSchema>;
/**
 * A list tab's primary action (mold_v0-208): one button at the right end of the list's search row (mold_v0-217), in the brand's
 * primary colour, that opens an existing form of the shell, never one of the pack's own:
 *   start_run       start a run of one of the pack's job kinds (`job_kind`), or of one picked from `job_kinds` (2 to
 *                   20, in that order), or from every kind of the pack when neither is given: the kind's arguments
 *                   (args) as a form, then the record it runs over and its environment when the kind takes them; the
 *                   run starts as the generated start_<kind> tool starts it (src/tab-actions.ts). On an area, runs or
 *                   reports tab
 *   new_schedule    the schedules page's Add a schedule form, its run kind preset to `job_kind` (one the pack itself
 *                   schedules) when given. On a schedules tab
 *   create_record   a new record of `area` (one of the pack's own workspace areas, not read from a repository): its
 *                   key, title and fields, through the data API's create (POST /api/data/<area>). On an area tab
 *   link            (mold_v0-213) a plain link, `label` and `href` both required: an /app page of the build, an
 *                   https:// or mailto: address (the empty state's rules), for a list nobody adds to by hand but whose
 *                   rows a setting brings (a mailbox connected on Settings › Email). On any list tab
 * `label` is the button's words (a phone shows the icon alone, the label its accessible name); absent, the shell's
 * ("Start {run}", "Generate <report>", "New schedule", "Add <record>"). The button is shown only to a role that may do
 * the action (the start tool's permission, manage for a schedule, the area's create roles), and the server refuses the
 * rest anyway; a link is everyone's who sees the tab.
 *
 * Every list tab has one by default (mold_v0-213; src/metric-spec.ts tabAction): `action` absent is the shell's own,
 * from what the tab shows; `action: false` (with `reason`, required, documented and shown nowhere) is none.
 */
export const TAB_ACTION_KINDS = ["start_run", "new_schedule", "create_record", "link", "start_agent"] as const;
/** The tab kinds that are lists (mold_v0-213): each has a primary action, its own, the shell's default, or none with a reason. */
export const LIST_TAB_KINDS = ["area", "runs", "reports", "schedules"] as const;
/** The tab kinds each action is for (mold_v0-208). */
export const TAB_ACTION_TABS: Record<(typeof TAB_ACTION_KINDS)[number], readonly string[]> = {
  start_run: ["area", "runs", "reports"], new_schedule: ["schedules"], create_record: ["area"], link: LIST_TAB_KINDS, start_agent: LIST_TAB_KINDS,
};
export const TabActionSchema = z.object({
  kind: z.enum(TAB_ACTION_KINDS, { error: () => `an action is one of ${TAB_ACTION_KINDS.join(", ")}` }),
  label: emptyText(40).optional(),
  job_kind: name.optional(),
  job_kinds: z.array(name).min(2, "2 to 20 job kinds (one: job_kind)").max(20).optional(),
  area: name.optional(),
  href: z.string().min(1).max(500).superRefine((h, ctx) => { const p = hrefProblem(h); if (p) ctx.addIssue({ code: "custom", message: p }); }).optional(),
  /** mold_v0-261: a start_agent action's agent profile (the pack's own agent_profiles, or "default"). */
  profile: z.string().regex(PROFILE_ID, "an agent profile's id").optional(),
  /** mold_v0-261: a start_agent action's first message, offered in the Start a session dialog (a list has no record: no {{field}}). */
  first_message: z.string().trim().min(1).max(4000).optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((a, ctx) => {
  const bad = (message: string, ...path: string[]) => ctx.addIssue({ code: "custom", message, path });
  if (a.kind !== "start_agent") { for (const k of ["profile", "first_message"] as const) if (a[k] !== undefined) bad(`${k} is for a start_agent action`, k); }
  else {
    if (a.profile === undefined) bad("a start_agent action names the agent profile it starts (profile)", "profile");
    if (a.first_message !== undefined && templateNames(a.first_message).length) bad("a list's action has no record to fill a first message from: write it without {{...}}", "first_message");
    for (const k of ["job_kind", "job_kinds", "area", "href"] as const) if (a[k] !== undefined) bad(`${k} is not for a start_agent action`, k);
    return;
  }
  if (a.kind === "link") {
    if (a.label === undefined) bad("a link action names its label", "label");
    if (a.href === undefined) bad("a link action names where it goes (href)", "href");
    for (const k of ["job_kind", "job_kinds", "area"] as const) if (a[k] !== undefined) bad(`${k} is not for a link action`, k);
    return;
  }
  if (a.href !== undefined) bad("href is for a link action", "href");
  if (a.job_kind !== undefined && a.job_kinds !== undefined) bad("one job kind (job_kind) or a picker of several (job_kinds), not both", "job_kinds");
  if (a.job_kinds && new Set(a.job_kinds).size !== a.job_kinds.length) bad("a job kind is listed twice", "job_kinds");
  if (a.kind !== "start_run" && a.job_kinds !== undefined) bad("job_kinds is for a start_run action", "job_kinds");
  if (a.kind === "create_record" && a.job_kind !== undefined) bad("job_kind is for a start_run or new_schedule action", "job_kind");
  if (a.kind === "create_record" && a.area === undefined) bad("a create_record action names its record area (area)", "area");
  if (a.kind !== "create_record" && a.area !== undefined) bad("area is for a create_record action", "area");
});
export type TabAction = z.output<typeof TabActionSchema>;
/**
 * A list column computed from the records that point back to each row (mold_v0-256, flag record_pages): of `related.area`
 * (through `related.via`, its link or reference field to the tab's area; needed only when it has several), `show`
 * "count" (how many) or "latest:<field>" (that field on the newest of them, by its last change), headed `label`
 * (default the area's label, or "Latest <field>"). Computed on the server as the person reading (the related area's read
 * permission: a role that may not read it sees an empty column), in the workspace's own scope; formatted as the
 * related area's cells. Off, the column is left out.
 */
export const TabRelatedColumnSchema = z.object({
  related: z.object({ area: name, via: name.optional() }).strict(),
  show: z.string().regex(/^(count|latest:[a-z][a-z0-9_]{1,62})$/, 'show is "count" or "latest:<a field of the related area>"'),
  label: plainWords(40).optional(),
}).strict();
export type TabRelatedColumn = z.output<typeof TabRelatedColumnSchema>;
/** Whether a tab column is computed from related records (else it is a field's name). */
export const isRelatedColumn = (c: unknown): c is TabRelatedColumn => !!c && typeof c === "object" && "related" in (c as object);
/** A related column's id in the console's table and the API: rel_<area>_<count|latest_field>. */
export const relatedColumnId = (c: TabRelatedColumn) => `rel_${c.related.area}_${c.show.replace(":", "_")}`;

export const TabSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "lowercase letters, digits and -, starting with a letter"),
  kind: z.enum(TAB_KINDS),
  label: z.string().trim().min(1).max(40).optional(),
  description: z.string().max(300).optional(),
  icon: z.enum(TAB_ICONS).optional(),
  group: z.string().trim().min(1).max(40).optional(),
  area: name.optional(),
  areas: z.array(TabAreaSchema).min(2).max(4).optional(),
  // mold_v0-256 (flag record_pages): a column may be computed from the records that point back to each row (TabRelatedColumnSchema).
  // mold_v0-260: up to 12 with the flag wide_lists (refused past 8 while it is off).
  columns: z.array(z.union([name, TabRelatedColumnSchema])).min(1).max(WIDE_LIST_MAX).optional(),
  views: z.array(z.enum(TAB_VIEWS)).min(1).max(4).optional(),
  board_by: name.optional(),
  timeline_by: point.optional(),
  charts: z.array(name).max(12).optional(),
  include: z.array(z.enum(TAB_INCLUDES)).min(1).max(TAB_INCLUDES.length).optional(),
  // mold_v0-260 (flag overview_cards): also recent_runs and attention, up to 4 cards.
  rail: z.array(z.string().regex(TAB_RAIL, "one of the shell's cards (TAB_RAIL) or chart:<one of the pack's number charts>")).min(1).max(4).optional(),
  /** An area tab's own narrowing of its one area's rows (mold_v0-175): a list filter, {field: value} or {field: {op: value}}. */
  filter: z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "a field of the area (or key, title, updated_at)"), z.unknown())
    .refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 10, "1 to 10 conditions").optional(),
  /** A sections tab's in-page tabs (mold_v0-175): the ids of the pack's tabs it shows, in order. */
  /** mold_v0-260: up to 8 (6 before). */
  sections: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "a tab id of this pack")).min(2).max(SECTIONS_MAX).optional(),
  /**
   * The four cards below a list's toolbar (mold_v0-181): exactly 4 of the pack's metrics, each a label, its value and a
   * sparkline of its last SPARK_WEEKS weeks (src/sparklines.ts). Absent: the shell's four for the tab's kind.
   * On a home tab (mold_v0-203): 1 to 4 of them, the headline row above its columns. Absent there: no row.
   */
  // mold_v0-260 (flag overview_cards): a home tab may name a fifth, its headline row's fifth number.
  sparklines: z.array(name).min(1, "1 to 4 metric names").max(5, "exactly 4 metric names on a list tab (its four cards), up to 4 on a home tab (5 with overview_cards)").optional(),
  /** A home tab's heading above its charts (mold_v0-175); accepted, not drawn since mold_v0-207 (no charts on the home page). */
  charts_title: z.string().trim().min(1).max(60).regex(/^[^{}<>\n]*$/, "plain text on one line: no braces or angle brackets").optional(),
  page: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/).optional(),
  roles: z.array(role).min(1).max(4).optional(),
  empty: TabEmptySchema.optional(),
  /** The tab's primary action (mold_v0-208): TabActionSchema; false for none (mold_v0-213), with `reason`. */
  action: z.union([TabActionSchema, z.literal(false)]).optional(),
  /** Why a list tab has no primary action (`action: false`, mold_v0-213): required with it, documented and shown nowhere. */
  reason: z.string().trim().min(1).max(300).optional(),
  /**
   * mold_v0-280: a team or keys tab shown inside the Settings page (its Access group, under the tab's label) rather than
   * as a sidebar entry of its own: it takes no group, and its page of before (/app/team, /app/keys) leads to that tab.
   */
  inside: z.enum(TAB_INSIDE).optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((t, ctx) => {
  const bad = (message: string, ...path: string[]) => ctx.addIssue({ code: "custom", message, path });
  if (t.inside !== undefined && !(INSIDE_KINDS as readonly string[]).includes(t.kind)) bad(`inside is for a ${INSIDE_KINDS.join(" or ")} tab: the shell's page that Settings can hold`, "inside");
  if (t.inside !== undefined && t.group !== undefined) bad(`a tab inside ${t.inside} is not a sidebar entry: it takes no group`, "group");
  if (t.kind === "area" && !t.area && !t.areas) bad("an area tab names its record area (area), or the areas it merges (areas)", "area");
  if (t.area && t.areas) bad("an area tab shows one area (area) or merges several (areas), not both", "areas");
  if (t.kind !== "area") for (const k of ["area", "areas", "columns", "views", "board_by", "timeline_by"] as const) if (t[k] !== undefined) bad(`${k} is for an area tab`, k);
  if (t.areas) {
    const names = t.areas.map((a) => a.area);
    if (new Set(names).size !== names.length) bad("an area is listed twice", "areas");
    if (t.areas[0]!.rows === "matched") bad("the first area brings the rows (rows: all): a matched area only adds fields to them", "areas", "0", "rows");
  }
  const colIds = (t.columns ?? []).map((c) => (typeof c === "string" ? c : relatedColumnId(c)));
  if (new Set(colIds).size !== colIds.length) bad("a column is listed twice", "columns");
  if (t.areas && (t.columns ?? []).some((c) => typeof c !== "string")) bad("a merged tab's columns are fields: a column computed from related records is for a tab of one area", "columns");
  if (t.kind === "overview" && !t.charts?.length && !t.include?.length) bad("an overview tab lists its charts (or includes a section of the shell's)", "charts");
  if (t.include && t.kind !== "overview") bad("include is for an overview tab", "include");
  if (t.include && new Set(t.include).size !== t.include.length) bad("a section is included twice", "include");
  if (t.rail && !(t.include ?? []).includes("setup")) bad("rail is for a home tab: an overview tab that includes setup", "rail");
  if (t.rail && new Set(t.rail).size !== t.rail.length) bad("a card is listed twice", "rail");
  if (t.rail?.includes("notices") && !(t.include ?? []).includes("notices")) bad("the notices card is for a tab that includes notices (/app/notices leads there)", "rail");
  if (t.filter && (t.kind !== "area" || !t.area || t.areas)) bad("filter is for an area tab over one area (area)", "filter");
  if (t.kind === "sections" && !t.sections) bad("a sections tab names the tabs it shows (sections)", "sections");
  if (t.sections && t.kind !== "sections") bad("sections is for a sections tab", "sections");
  if (t.sections && new Set(t.sections).size !== t.sections.length) bad("a tab is listed twice", "sections");
  if (t.charts_title !== undefined && (!(t.include ?? []).includes("setup") || !t.charts?.length)) bad("charts_title is for a home tab with charts: an overview tab that includes setup and lists charts", "charts_title");
  if (t.include && t.roles) bad("a tab that includes a section of the shell's is every member's home page (/app leads there): it takes no roles", "roles");
  if (t.charts?.length && t.kind !== "overview" && t.kind !== "area") bad("charts are for an overview or an area tab", "charts");
  const home = t.kind === "overview" && (t.include ?? []).includes("setup");
  if (t.sparklines && !home && !(SPARK_KINDS as readonly string[]).includes(t.kind)) bad(`sparklines are for a list tab: ${SPARK_KINDS.join(", ")}, or a home tab (an overview that includes setup)`, "sparklines");
  else if (t.sparklines && !home && t.sparklines.length !== 4) bad("exactly 4 metric names: the tab's four cards", "sparklines");
  if (t.rail?.some((x) => (HOME_CARDS as readonly string[]).includes(x)) && !home) bad("recent_runs and attention are a home tab's cards", "rail");
  if (t.sparklines && new Set(t.sparklines).size !== t.sparklines.length) bad("a metric is listed twice", "sparklines");
  if (t.kind === "page" && !t.page) bad("a page tab names one of the pack's pages", "page");
  if (t.kind !== "page" && t.page !== undefined) bad("page is for a page tab", "page");
  if (t.empty && t.kind !== "area" && t.kind !== "runs" && t.kind !== "reports") bad("empty is for an area, runs or reports tab", "empty");
  if (t.action && TAB_ACTION_TABS[t.action.kind] && !TAB_ACTION_TABS[t.action.kind].includes(t.kind))
    bad(`a ${t.action.kind} action is for ${TAB_ACTION_TABS[t.action.kind].join(", ")} tabs`, "action", "kind");
  // mold_v0-213: no action on a list tab is said with its reason; a reason is only for that.
  if (t.action === false && !(LIST_TAB_KINDS as readonly string[]).includes(t.kind)) bad(`action: false is for a list tab (${LIST_TAB_KINDS.join(", ")}): other tabs have no action`, "action");
  if (t.action === false && t.reason === undefined) bad("action: false says why the tab has no primary action (reason)", "reason");
  if (t.reason !== undefined && t.action !== false) bad("reason is for action: false (why a list tab has no primary action)", "reason");
  if (t.views && new Set(t.views).size !== t.views.length) bad("a view is listed twice", "views");
  if (t.board_by && !(t.views ?? []).includes("board")) bad("board_by is for a tab with the board view", "board_by");
  if (t.timeline_by && !(t.views ?? []).includes("timeline")) bad("timeline_by is for a tab with the timeline view", "timeline_by");
});
export type Tab = z.output<typeof TabSchema>;

/**
 * Environment names a credential may not take: the ones the harness sets for every run (src/run-harness.ts), the proxy
 * settings, and the loader's. A gateway provider's variables (ANTHROPIC_API_KEY, ...) are set by the shell too: a
 * credential named like one is not delivered (the run's "credentials" event lists it as shadowed).
 */
export const RESERVED_ENV = /^(PATH|HOME|LANG|LC_[A-Z_]+|RUN_[A-Z0-9_]*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_OPTIONS|NPM_CONFIG_[A-Z0-9_]*|LD_[A-Z0-9_]*)$/;
const envNameField = envName.refine((n) => !RESERVED_ENV.test(n), "an environment name the shell sets for every run (PATH, HOME, RUN_*, proxy and loader settings): choose another");
const envLabel = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "an environment name: lowercase letters, digits, _ and -");
/**
 * A credential field a workspace gives (wired by mold_v0-034; src/credentials.ts): a key, a token, a password the
 * pack's runs need to reach the workspace's own systems. Bound to:
 *   workspace    one value for the whole workspace
 *   asset        one value per asset record of `area` (one of this pack's asset areas), e.g. one per application
 *   environment  one value per asset and environment (`environments` lists the allowed names; any when absent)
 * A run receives it only when its kind lists the field in `credentials`, only the value bound to the asset
 * (targets.asset, its key) and environment (targets.environment) the run targets, as an environment variable
 * (deliver_as {env}) or a file in a private directory named by RUN_CREDENTIALS_DIR (deliver_as {file}). Values never
 * reach the pack's server code, the run's events or results, the MCP output or any log.
 *
 * `optional` (mold_v0-186, default false): the runs go ahead without a value and do less (a run never waits for a
 * credential: src/runs.ts records which were delivered and which were missing). The console shows the field as
 * Optional; `adds` says in one line what a value adds (shown beside an optional field that is not set; the field's
 * help is used when absent).
 *
 * mold_v0-239: where the console shows it follows the binding (a workspace's on Settings › Credentials, a record's and a
 * record environment's on that record's own page), in the words of `purpose`, `steps` and `without`; `group` makes
 * fields one credential; `environments_from` reads a record's environments from the record (credentialGroupProblems).
 */
/**
 * How a run receives a credential: an environment variable (`env`), or a file (`file`, 0400, the run user's, in a
 * private directory on tmpfs named by RUN_CREDENTIALS_DIR) whose full path is also given in `path_env` when declared
 * (mold_v0-075: a locator a tool reads, KUBECONFIG, or a pack's own name such as PROD_RO_KUBECONFIG).
 */
const deliverAs = z.union([
  z.object({ env: envNameField }).strict(),
  z.object({
    file: z.string().regex(/^[a-z0-9_][a-z0-9_.-]{0,99}$/i, "a file name (letters, digits, _ . -), no directories"),
    path_env: envNameField.optional(),
  }).strict(),
]);
/** mold_v0-186: a credential the runs go ahead without (default false: a run kind that names it needs it). */
const optionalFlag = z.boolean().default(false);
/** mold_v0-186: what a value of an optional credential adds, for the console and operator:vault-status. */
const addsText = z.string().min(1).max(200).optional();
/** mold_v0-239: a credential's words for a customer: plain text on one line, no markup. */
const credentialText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f<>`]*$/, "plain text: one line, no control characters, no < > or `");
export const CredentialSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  help: z.string().max(500).optional(),
  /** mold_v0-260 (flag credential_sets): also `tenant`, a record of the build's tenant area (`tenant: true`). */
  bound_to: z.enum(["workspace", "asset", "environment", "tenant"]),
  /** The asset area (asset and environment bindings): one of this pack's own areas with role "asset"; the tenant area (a tenant binding). */
  area: name.optional(),
  environments: z.array(envLabel).min(1).max(20).optional(),
  deliver_as: deliverAs,
  /**
   * mold_v0-014: a GitHub repository token. When the platform holds a GitHub App (key vault provider github_app) and the
   * workspace has connected an installation of it, a run receiving this field gets a short-lived installation token
   * (read-only contents, the installation's repositories, narrowed per asset by the workspace's owners) instead of a
   * pasted value; with no app or no installation the pasted value is delivered as before.
   */
  github_app: z.boolean().optional(),
  /**
   * mold_v0-014: the name of one of this pack's OAuth providers (oauthProviders). A workspace's owner connects the field
   * from the console (the provider's sign-in, then back); runs get the connection's access token, refreshed before it
   * expires; with no connection the pasted value is delivered as before.
   */
  oauth: name.optional(),
  /** mold_v0-186: the runs go ahead without a value (they do less); the console tags the field Optional. */
  optional: optionalFlag,
  /** mold_v0-186: what a value adds, one line (an optional field only). */
  adds: addsText,
  /**
   * mold_v0-239: the customer's own words for it, shown on Settings › Credentials (a workspace binding) or on the
   * record's own page (an asset or environment binding), never the binding, the delivery or a variable's name:
   *   purpose   what it is for, in one sentence (the field's help is shown when absent)
   *   steps     how to get it: numbered steps, the first naming the web address to open (https://...)
   *   without   what still works without it (an optional field only; built from `adds` when absent)
   */
  purpose: credentialText(300).optional(),
  steps: z.array(credentialText(400)).min(1).max(12).optional()
    .refine((s) => !s || /https:\/\/[A-Za-z0-9.-]+/.test(s[0]!), "steps: the first step names the web address to open (https://...)"),
  without: credentialText(300).optional(),
  /**
   * mold_v0-239: fields that belong together (an access key id and its secret) share a `group`: the console sets,
   * replaces, clears and shows them as one credential with one input each (its `label`). The group's first field
   * names it (`group_label`) and carries its words (purpose, steps, without); every member has the same binding, area,
   * environments and optional flag. A pair is set and cleared together, in one request.
   */
  group: name.optional(),
  group_label: z.string().min(1).max(80).optional(),
  /**
   * mold_v0-239: where a record's environments come from (an environment binding): `field`, a field of the area whose
   * value is a list of environment names, or of objects whose `key` holds one (an environment document's id). The console
   * offers exactly these (one group per environment on the record's page; a value is set by picking one, never by
   * typing) and a value is accepted only for one of them. Not with `environments`, the fixed list.
   */
  environments_from: z.object({ field: name, key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, "a key of the field's objects").optional() }).strict().optional(),
  /**
   * mold_v0-260 (flag credential_sets): several labelled values in one credential (a list of hosts, each with its token):
   * `label` names what each value's label is ("Host"), `max` how many (default 20, at most 50), `pattern` what a label
   * may be (default: letters, digits and . _ : / @ -). Each value is sealed on its own; the run receives them as one JSON
   * object, {"<label>": "<value>", ...}, as the field delivers it (a variable or a file).
   */
  entries: z.object({
    label: z.string().trim().min(1).max(40),
    max: z.number().int().min(1).max(50).default(20),
  }).strict().optional(),
}).strict()
  .refine((c) => !(c.github_app && c.oauth), "a field is either github_app or oauth, not both")
  .refine((c) => c.without === undefined || c.optional, "without is for an optional field only (optional: true)")
  .refine((c) => c.group_label === undefined || c.group !== undefined, "group_label names a group: give the field a group")
  .refine((c) => c.group === undefined || !(c.github_app || c.oauth), "a GitHub App or OAuth field is one credential on its own: no group")
  .refine((c) => c.environments_from === undefined || c.bound_to === "environment", "environments_from is for an environment binding only")
  .refine((c) => !(c.environments_from && c.environments), "environments_from or environments, not both")
  .refine((c) => c.adds === undefined || c.optional, "adds is for an optional field only (optional: true)")
  .refine((c) => (c.bound_to === "workspace") === (c.area === undefined), "area names the asset area for an asset or environment binding, the tenant area for a tenant binding (and only then)")
  .refine((c) => !c.entries || !(c.group || c.github_app || c.oauth), "a credential with entries is one credential of its own: no group, GitHub App or OAuth")
  .refine((c) => c.environments === undefined || c.bound_to === "environment", "environments is for an environment binding only");

/**
 * mold_v0-239: what makes a pack's credentials one credential each in the console. A group (fields sharing `group`)
 * has 2 to 4 fields with the same binding, area, environments, environments_from and optional flag; its first field
 * names it (group_label) and alone carries its words (purpose, steps, without), and a group is not also a field's name.
 * An `environments_from` field is a field of the credential's area.
 */
export function credentialGroupProblems(creds: readonly unknown[], areas: readonly { name?: string; fields?: { name?: string }[] }[]): string[] {
  const out: string[] = [];
  type C = { name?: string; group?: string; group_label?: string; bound_to?: string; area?: string; environments?: string[]; environments_from?: { field?: string; key?: string }; optional?: boolean; purpose?: string; steps?: string[]; without?: string };
  const list = creds.filter((c): c is C => !!c && typeof c === "object");
  const groups = new Map<string, C[]>();
  for (const c of list) if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [g, members] of groups) {
    if (members.length < 2 || members.length > 4) out.push(`credential group ${g}: 2 to 4 fields belong together (it has ${members.length})`);
    if (list.some((c) => c.name === g && c.group !== g)) out.push(`credential group ${g}: a group is not also the name of another field`);
    const [lead, ...rest] = members;
    if (!lead!.group_label) out.push(`credential group ${g}: its first field (${lead!.name}) names the credential (group_label)`);
    for (const c of rest) {
      if (c.group_label !== undefined || c.purpose !== undefined || c.steps !== undefined || c.without !== undefined)
        out.push(`credential ${c.name}: group_label, purpose, steps and without go on the group's first field (${lead!.name})`);
      for (const k of ["bound_to", "area", "environments", "environments_from", "optional"] as const)
        if (!same(c[k] ?? (k === "optional" ? false : undefined), lead![k] ?? (k === "optional" ? false : undefined))) out.push(`credential ${c.name}: every field of group ${g} has the same ${k} as ${lead!.name}`);
    }
  }
  for (const c of list) {
    if (!c.environments_from?.field || !c.area) continue;
    const a = areas.find((x) => x?.name === c.area);
    if (a && !(a.fields ?? []).some((f) => f?.name === c.environments_from!.field))
      out.push(`credential ${c.name}: environments_from names field ${c.environments_from.field}, which area ${c.area} does not have`);
  }
  return out;
}

/**
 * A generic OAuth 2.0 provider a credential field connects to (mold_v0-014; src/oauth-connections.ts). The authorization
 * code flow, with PKCE (S256) unless `pkce: false`, the state signed, one-time and bound to the person and workspace.
 *   authorize_url, token_url, revoke_url   https addresses of the provider (revoke_url: RFC 7009, optional)
 *   scopes                                  asked for at sign-in, joined by scope_separator (a space by default)
 *   client_id, client_secret                by name: labels in the platform's key vault (provider "oauth_clients"), set
 *                                           by an owner of the platform on /admin Key vault; never in the pack
 *   token_auth                              how the client authenticates at the token address: "body" (default) or "basic"
 *   authorize_params                        extra fixed parameters of the sign-in address (access_type=offline, prompt=...)
 */
const httpsUrl = z.string().max(500).regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@\/-]*)?$/, "an https:// address with no query or fragment");
const vaultLabel = z.object({ vault: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/, "a key vault label: lowercase letters, digits, _ . -") }).strict();
export const OAuthProviderSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  authorize_url: httpsUrl,
  token_url: httpsUrl,
  revoke_url: httpsUrl.optional(),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/, "a scope: printable, no spaces, quotes or backslashes")).max(50).default([]),
  scope_separator: z.enum([" ", ","]).default(" "),
  client_id: vaultLabel,
  client_secret: vaultLabel,
  pkce: z.boolean().default(true),
  token_auth: z.enum(["body", "basic"]).default("body"),
  authorize_params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.string().max(200)).optional()
    .refine((o) => !o || !Object.keys(o).some((k) => ["client_id", "redirect_uri", "state", "scope", "response_type", "code_challenge", "code_challenge_method"].includes(k)),
      "authorize_params may not set the flow's own parameters"),
}).strict();

/**
 * A credential the platform's operators hold for a pack (mold_v0-075): a login to a catalogue every workspace's runs
 * read, say. Its value is in the platform's key vault (provider "pack_credentials", label "<pack>.<name>"), set by an
 * owner of the platform (/admin key vault); a kind that names it in `operator_credentials` receives it as declared. A
 * workspace never sees it: not in its console, its runs' events or results, nor its workspace's files. `optional`
 * and `adds` as for a workspace's credential field (above).
 */
export const OperatorCredentialSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  help: z.string().max(500).optional(),
  deliver_as: deliverAs,
  /**
   * mold_v0-186: the runs go ahead without it (they do less). operator:vault-status then lists it as "optional, not set
   * (<adds>)" outside what the runs need, never as MISSING; the admin Key vault tags it Optional.
   */
  optional: optionalFlag,
  /** mold_v0-186: what a value adds, one line (an optional credential only; its help is used when absent). */
  adds: addsText,
}).strict()
  .refine((c) => c.adds === undefined || c.optional, "adds is for an optional credential only (optional: true)");

/**
 * A default schedule (wired by mold_v0-035; src/schedules.ts). Every workspace gets its own copy (per workspace: its own
 * on/off, time and assets, its own runs), which its owners may change in the console; the pack's later changes reach a
 * copy no owner has changed.
 *   job_kind     one of this pack's job kinds: each due time starts runs of it through the run engine
 *   cron         five fields, UTC (src/cron.ts): at most every 5 minutes
 *   assets       which asset records of the workspace it runs over: one run per record (targets.asset {area, key}, the
 *                credentials bound to that asset reach the run); `keys` absent means every record of the area. Without
 *                `assets`, one run for the workspace
 *   environment  targets.environment of each run (an environment-bound credential)
 *   scope        the run's scope (what is checked: source and check record keys), as given to ctx.runs.start
 *   enabled      false: offered to each workspace but off until an owner turns it on
 */
export const ScheduleSchema = z.object({
  name,
  label: z.string().min(1).max(80).optional(),
  job_kind: name,
  cron: z.string().max(120).refine((c) => { try { parseCron(c); return true; } catch { return false; } }, "a cron expression: five fields (minute hour day-of-month month day-of-week, UTC), at most every 5 minutes"),
  assets: z.object({ area: name, keys: z.array(z.string().regex(RECORD_KEY, "a record key")).min(1).max(50).optional() }).strict().optional(),
  environment: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "an environment name: lowercase letters, digits, _ and -").optional(),
  scope: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
}).strict();

/**
 * When an onboarding step is done (mold_v0-011; src/onboarding.ts), read for one workspace from what really happened
 * in it: "workspace" (it exists), "connected" (an MCP client connected), "first_call" (any tool call succeeded),
 * "tool:<name>" (that tool's call succeeded: a shell tool, list_records/get_record, or any pack's), "credential:<name>"
 * (a value of this pack's credential field is set), "record:<area>" (a record of this pack's workspace-scope area
 * exists), "run:<kind>" (a run of this pack's job kind succeeded).
 */
export const ONBOARDING_CONDITION = /^(workspace|connected|first_call|(tool|credential|record|run):[a-z][a-z0-9_]{0,63})$/;
/** An onboarding step's `how` (mold_v0-166): an action, never one of the shell's own stages. */
export const ONBOARDING_HOW = /^(tool|credential|record|run):[a-z][a-z0-9_]{0,63}$/;
/**
 * An onboarding checklist step (wired by mold_v0-011): the /app Setup page's pack checklist, ticked from real events,
 * and the pack's generated `<prefix>_get_started` MCP tool (mold_v0-105, src/mcp-tools.ts): the next step not done,
 * how to do it, and `prompt`, the words the person can type in their AI client to do it (default: built from the label).
 */
export const OnboardingStepSchema = z.object({
  id: name, label: z.string().min(1).max(120), help: z.string().max(500).optional(),
  prompt: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>`]*$/, "plain text: one line, no control or direction characters, no < > or `").optional(),
  done_when: z.string().regex(ONBOARDING_CONDITION, "done_when: workspace, connected, first_call, tool:<name>, credential:<name>, record:<area> or run:<kind>"),
  /**
   * (mold_v0-166) How the step is done, when that is not what `done_when` measures: a record area whose rows a run
   * writes (files of the workspace) is done by that run, not by adding a record. `tool:<name>`, `credential:<name>`,
   * `record:<area>` or `run:<kind>`, checked as `done_when` is; the get_started tool's "how" follows it.
   */
  how: z.string().regex(ONBOARDING_HOW, "how: tool:<name>, credential:<name>, record:<area> or run:<kind>").optional(),
}).strict();

/**
 * The pack's MCP settings (mold_v0-060; pack.json `mcp`, or definePack({ mcp })). Every pack gets MCP tools generated
 * from its declarations (src/mcp-tools.ts): list_/get_ for each record area, create_/update_/move_ where the area takes
 * writes, start_<kind> per job kind with the run tools, a report tool per kind with a report file, and on the admin MCP
 * the shared areas' staff tools. This block shapes them; every name in it is a generated tool's name before `rename`:
 *   prefix      the tools' prefix (default: the pack's id), so `<prefix>_list_<area>`
 *   include     only these generated tools (default: all of them)
 *   exclude     none of these
 *   rename      generated name -> the name clients see (lowercase letters, digits and _, at most 64)
 *   describe    generated name -> the description clients see (plain text, one paragraph)
 *   admin_only  customer tools moved to the admin MCP (platform staff with "accounts", naming the workspace); never on
 *               the customer MCP (only the MCP tool moves: the data API and the console still serve the workspace)
 *   instructions  (mold_v0-105) the customer MCP server's instructions: what the app is and how to work with it, plain
 *               text, up to 4000 characters, used when the profile has no `mcp_instructions` and no host pack has its
 *               own (several packs' are joined, in pack order); the shell adds the generated tools' paragraph after it.
 *               A host pack's (mold_v0-137) stands where its host entry's own instructions did: it wins over the other
 *               packs' and the profile's still wins over it
 *   prompts     (mold_v0-137) slash commands (MCP prompts): each a name, a title, a description, its arguments (each a
 *               name, a description, required or not, a string or an integer: a positive number, rounded) and its text,
 *               a template (src/text-template.ts) filled with the arguments the person gives; on the customer MCP after
 *               every tool, in pack order (McpPromptSchema)
 * A pack that declares onboarding steps also gets `<prefix>_get_started` (mold_v0-105): the caller's workspace's progress
 * through them, the next step and the prompt to type; the instructions tell clients to call it first.
 */
const mcpToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "a tool name: lowercase letters, digits and _, starting with a letter, at most 64");
/** One line of plain text: no control, zero-width or direction characters. */
const promptLine = (max: number) => z.string().trim().min(1).max(max)
  .regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text: one line, no control or direction characters");
/** A prompt's text: plain text, line breaks and tabs allowed. */
const PROMPT_TEXT = /^[^\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/;
/** One argument of a declared slash command (mold_v0-137). Clients send every argument as text. */
export const McpPromptArgSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "an argument name: lowercase letters, digits and _, starting with a letter"),
  description: promptLine(500).optional(),
  /** Whether the person must give it (default false). */
  required: z.boolean().optional(),
  /** `integer`: given only when it is a positive number, then rounded to a whole one ({days} 14, {days|json} 14). */
  type: z.enum(["string", "integer"]).optional(),
}).strict();
/**
 * A declared slash command (mold_v0-137; pack.json `mcp.prompts[]`): the message a client puts in the conversation when
 * the person picks it. `text` is a template (src/text-template.ts: {arg}, {arg|json}, {a,b|json}, {?arg}…{/arg},
 * {!arg}…{/arg}) of its own arguments, one string or a list of lines (joined with line breaks).
 */
export const McpPromptSchema = z.object({
  $comment: z.string().max(2000).optional(),
  name: mcpToolName,
  title: promptLine(200).optional(),
  description: promptLine(1000).optional(),
  arguments: z.array(McpPromptArgSchema).max(20).optional(),
  text: z.union([z.string().min(1).max(20000), z.array(z.string().max(4000)).min(1).max(200)]),
}).strict().superRefine((p, ctx) => {
  const text = promptText(p);
  if (!text.trim()) ctx.addIssue({ code: "custom", path: ["text"], message: "the text is empty" });
  if (text.length > 20000) ctx.addIssue({ code: "custom", path: ["text"], message: "at most 20000 characters" });
  if (!PROMPT_TEXT.test(text)) ctx.addIssue({ code: "custom", path: ["text"], message: "plain text: no control or direction characters (line breaks are fine)" });
  const names = (p.arguments ?? []).map((a) => a.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) ctx.addIssue({ code: "custom", path: ["arguments"], message: `argument ${twice} is declared twice` });
  for (const pr of templateProblems(text, names)) ctx.addIssue({ code: "custom", path: ["text"], message: pr });
});
export type McpPrompt = z.output<typeof McpPromptSchema>;
/** A declared prompt's text as one string (a list of lines joined with line breaks). */
export const promptText = (p: Pick<McpPrompt, "text">): string => (Array.isArray(p.text) ? p.text.join("\n") : p.text);
export const McpSettingsSchema = z.object({
  $comment: z.string().max(2000).optional(),
  prefix: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "1-31 lowercase letters, digits or _, starting with a letter").optional(),
  include: z.array(mcpToolName).max(500).optional(),
  exclude: z.array(mcpToolName).max(500).optional(),
  rename: z.record(mcpToolName, mcpToolName).optional(),
  describe: z.record(mcpToolName, z.string().trim().min(1).max(1000)
    .regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]*$/, "plain text: no control or direction characters, no < or >")).optional(),
  admin_only: z.array(mcpToolName).max(500).optional(),
  instructions: z.string().trim().min(1).max(4000)
    .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text: no control or direction characters (line breaks are fine)").optional(),
  prompts: z.array(McpPromptSchema).max(50).refine((l) => new Set(l.map((p) => p.name)).size === l.length, "each prompt name once").optional(),
  /**
   * Plain-language fixes for the tool errors people hit (mold_v0-140; the Setup page's recent problems, src/app.ts):
   * `match`, a pattern of the error's text (a regular expression, any case), and `text`, what to do. The first that
   * matches, in pack order, is shown under the error.
   */
  error_hints: z.array(z.object({
    match: z.string().min(1).max(200).refine((m) => { try { new RegExp(m, "i"); return true; } catch { return false; } }, "a regular expression that compiles"),
    text: z.string().trim().min(1).max(400).regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text on one line"),
  }).strict()).max(30).optional(),
}).strict();
export type McpSettings = z.output<typeof McpSettingsSchema>;

export interface PackDefinition {
  id: string;
  tools?: PackTool<any>[];
  routes?: PackRoute[];
  jobKinds?: z.input<typeof JobKindSchema>[];
  /** Job kinds for the agent-workspace runner (mold_v0-061 wires them; declared and validated since mold_v0-057). */
  agentJobKinds?: z.input<typeof AgentJobKindSchema>[];
  recordAreas?: z.input<typeof RecordAreaSchema>[];
  credentials?: z.input<typeof CredentialSchema>[];
  /** OAuth providers its credential fields connect to (mold_v0-014). */
  oauthProviders?: z.input<typeof OAuthProviderSchema>[];
  /** Credentials the platform's operators hold for the pack's runs (mold_v0-075), never a workspace's to see. */
  operatorCredentials?: z.input<typeof OperatorCredentialSchema>[];
  schedules?: z.input<typeof ScheduleSchema>[];
  onboarding?: z.input<typeof OnboardingStepSchema>[];
  /** Metrics over the records and the runs' results (mold_v0-063; src/metrics.ts computes them for one workspace). */
  metrics?: z.input<typeof MetricSchema>[];
  /** Charts of the pack's metrics (mold_v0-063), shown on its overview and area tabs. */
  charts?: z.input<typeof ChartSchema>[];
  /** The console's sidebar and tabs (mold_v0-058): when any pack declares them, the /app sidebar is exactly these. */
  tabs?: z.input<typeof TabSchema>[];
  /** The pack's data repositories, by name (mold_v0-059; src/data-repositories.ts). */
  repositories?: Record<string, z.input<typeof RepositorySchema>>;
  /** Code that turns a repository's documents into rows, by repository name (mold_v0-059; code only, never pack.json). */
  loaders?: Record<string, RepositoryLoader>;
  /** How a run's output becomes run_results rows (mold_v0-061; declared and validated since 057). */
  runResults?: z.input<typeof RunResultsSchema>;
  /** The generated MCP tools' settings (mold_v0-060; src/mcp-tools.ts): prefix, include, exclude, rename, describe, admin_only. */
  mcp?: z.input<typeof McpSettingsSchema>;
  /**
   * Declarative yes/no checks answered from the records (mold_v0-196; src/check-spec.ts CheckSchema, src/checks.ts): each
   * on the API (POST /api/checks/<name>) and as an MCP tool (check_<name>), for the caller's own workspace. No code.
   */
  checks?: z.input<typeof CheckSchema>[];
  /**
   * The workspace store's settings (mold_v0-056; src/workspace-store-policy.ts): how long old versions are kept
   * (retention: keep_last, keep_days, under the platform's ceiling) and the files the console's viewer never shows
   * (secret_paths). Needs a job kind with workspace: true (or an agent-workspace kind).
   */
  workspaceStore?: z.input<typeof WorkspaceStoreSchema>;
  /**
   * The company's own email (mold_v0-192; src/company-email-config.ts): `sender.allow` lets a workspace's admins send
   * the app's notifications through their own mail system; `intake` turns a mailbox's new messages into records of one
   * of the pack's own workspace areas.
   */
  email?: z.input<typeof EmailPackSchema>;
  /**
   * Document previews (mold_v0-220; src/record-files-config.ts, src/document-fetch.ts): the hosts a field with `preview:
   * "document"` may fetch its URL's document from, the largest kept, and how long a copy is kept.
   */
  documents?: z.input<typeof DocumentsSchema>;
  /**
   * The workspace agent's profiles this pack brings (mold_v0-261, pack.json `agent_profiles`; src/agent-profiles.ts): each
   * written once into the platform's profiles (version 1) the first time the app runs with it, then staff's to edit,
   * version and archive in Admin › Agent profiles. Its page and tab actions `start_agent` name one of them (or "default").
   */
  agentProfiles?: z.input<typeof PackAgentProfileSchema>[];
  /**
   * After a run of one of this pack's job kinds with `workspace: true` succeeds and its write-back is committed
   * (mold_v0-064; src/runs.ts complete), before its results are checked: the pack indexes the workspace it just wrote
   * (its records, through ctx.records), so the results may name what the index made. Called with every file of the
   * committed snapshot, also when the run changed nothing (an index can always catch up). Runs for the run's own
   * workspace only, under row-level security, within APP_WORKSPACE_HOOK_SECONDS (120). If it throws or runs out
   * of time the run fails ("run") and its results are not written; the snapshot stays committed (it passed the run's
   * validation), and the next run's commit calls the hook again. Writes it made before failing are not undone.
   */
  onWorkspaceCommit?: (ctx: WorkspaceCommitContext, files: WorkspaceFile[]) => void | Promise<void>;
  /**
   * Migrations are declared in pack.json (`migrations`, a directory of NNNN_name.sql inside the pack) so the build can
   * check them without running the pack: this field, when given, must name the same directory.
   */
  migrations?: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ROUTE_PATH = /^\/[a-z0-9_\-/:]*$/i;
const METHODS = new Set<HttpMethod>(["get", "post", "put", "patch", "delete"]);

export class PackDefinitionError extends Error {}

/** Check a pack's definition: names, paths, permissions and the declared-only fields. Throws on the first problem list. */
export function validatePack(p: PackDefinition, partial = false): PackDefinition {
  const problems: string[] = [];
  const at = (what: string) => `pack ${JSON.stringify(p?.id)}: ${what}`;
  if (!p || typeof p !== "object") throw new PackDefinitionError("definePack: expected an object");
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(p.id)) problems.push(at("id must be 2-31 lowercase letters, digits or _, starting with a letter"));
  if (p.onWorkspaceCommit !== undefined && typeof p.onWorkspaceCommit !== "function") problems.push(at("onWorkspaceCommit must be a function (ctx, files)"));
  if (p.onWorkspaceCommit && !(p.agentJobKinds ?? []).length && !(p.jobKinds ?? []).some((k) => (k as { workspace?: boolean })?.workspace))
    problems.push(at("onWorkspaceCommit is called after a workspace run commits: declare a job kind with workspace: true (or agent-workspace)"));
  const tools = p.tools ?? [], routes = p.routes ?? [];
  const seenTools = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t.name !== "string" || !TOOL_NAME.test(t.name)) { problems.push(at(`tool name ${JSON.stringify(t?.name)} must be lowercase letters, digits and _`)); continue; }
    if (seenTools.has(t.name)) problems.push(at(`tool ${t.name} is declared twice`));
    seenTools.add(t.name);
    if (typeof t.description !== "string" || !t.description.trim()) problems.push(at(`tool ${t.name} needs a description`));
    if (typeof t.handler !== "function") problems.push(at(`tool ${t.name} needs a handler`));
    for (const [k, v] of Object.entries(t.inputSchema ?? {})) if (!(v instanceof z.ZodType)) problems.push(at(`tool ${t.name}: input ${k} is not a zod schema`));
  }
  const seenRoutes = new Set<string>();
  for (const r of routes) {
    const label = `${String(r?.method).toUpperCase()} ${r?.path}`;
    if (!r || !METHODS.has(r.method)) { problems.push(at(`route ${label}: method must be get, post, put, patch or delete`)); continue; }
    if (typeof r.path !== "string" || !ROUTE_PATH.test(r.path) || r.path.includes("//") || r.path.includes("..")) problems.push(at(`route ${label}: path must start with / and use letters, digits, -, _, : and /`));
    if (r.scope !== "workspace" && r.scope !== "admin") problems.push(at(`route ${label}: scope must be "workspace" or "admin"`));
    // Every admin change names its permission (as src/admin-roles.ts assertGuarded requires of the shell's own routes).
    if (r.scope === "admin" && r.method !== "get" && !r.needs) problems.push(at(`route ${label}: an admin change must name the permission it needs (needs)`));
    if (typeof r.handler !== "function") problems.push(at(`route ${label} needs a handler`));
    const key = `${r.scope} ${r.method} ${r.path}`;
    if (seenRoutes.has(key)) problems.push(at(`route ${label} (${r.scope}) is declared twice`));
    seenRoutes.add(key);
  }
  const each = <S extends z.ZodType>(list: unknown[] | undefined, schema: S, what: string) => {
    const names = new Set<string>();
    for (const [i, x] of (list ?? []).entries()) {
      const r = schema.safeParse(x);
      if (!r.success) problems.push(at(`${what}[${i}]: ${r.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
      const n = (x as { name?: string; id?: string })?.name ?? (x as { id?: string })?.id;
      if (n && names.has(n)) problems.push(at(`${what} ${n} is declared twice`));
      if (n) names.add(n);
    }
  };
  each(p.jobKinds, JobKindSchema, "jobKinds");
  each(p.agentJobKinds, AgentJobKindSchema, "agentJobKinds");
  each(p.metrics, MetricSchema, "metrics");
  each(p.charts, ChartSchema, "charts");
  each(p.tabs, TabSchema, "tabs");
  // A chart shows this pack's own metrics; a tab shows this pack's own charts (mold_v0-063, 058). What each metric reads
  // (fields, states, areas of the whole build) is checked with the build (src/metric-spec.ts).
  const metricNames = new Set((p.metrics ?? []).map((m) => m?.name));
  for (const c of p.charts ?? []) for (const m of c?.metrics ?? []) if (!metricNames.has(m)) problems.push(at(`chart ${c.name} shows metric ${m}, which this pack does not declare`));
  const chartNames = new Set((p.charts ?? []).map((c) => c?.name));
  for (const t of p.tabs ?? []) for (const c of t?.charts ?? []) if (!chartNames.has(c)) problems.push(at(`tab ${t.id} shows chart ${c}, which this pack does not declare`));
  // A home tab's chart card (mold_v0-172): one of this pack's number charts (tiles), drawn small in the right column.
  for (const t of p.tabs ?? []) for (const r of t?.rail ?? []) {
    if (typeof r !== "string" || !r.startsWith("chart:")) continue;
    const c = (p.charts ?? []).find((x) => x?.name === r.slice(6));
    if (!c) problems.push(at(`tab ${t.id}: rail ${r}: this pack declares no chart ${r.slice(6)}`));
    else if (c.type !== "number") problems.push(at(`tab ${t.id}: rail ${r}: a card shows a number chart (its tiles); ${c.name} is a ${c.type} chart`));
  }
  // A sections tab's in-page tabs (mold_v0-175): this pack's own area tabs, each in one sections tab at most.
  const inSections = new Map<string, string>();
  for (const t of p.tabs ?? []) for (const id of t?.sections ?? []) {
    const x = (p.tabs ?? []).find((y) => y?.id === id);
    if (!x) problems.push(at(`tab ${t.id}: sections ${id}: this pack declares no tab ${id}`));
    else if (!SECTION_KINDS.includes(x.kind as never)) problems.push(at(`tab ${t.id}: sections ${id}: an in-page tab is an area, runs, reports or schedules tab; ${id} is a ${x.kind} tab`));
    else if (inSections.has(id) && inSections.get(id) !== t.id) problems.push(at(`tab ${t.id}: sections ${id}: tab ${inSections.get(id)} shows it already`));
    inSections.set(id, t.id);
  }
  // A tab's primary action (mold_v0-208): this pack's own job kinds (none gated by an approval: the console's form has
  // no preview to approve), a kind the pack itself schedules for a new schedule, this pack's own writable workspace area.
  const ownKinds = [...(p.jobKinds ?? []), ...(p.agentJobKinds ?? [])] as { name?: string; approval?: unknown }[];
  for (const t of p.tabs ?? []) {
    const a = t?.action as { kind?: string; job_kind?: string; job_kinds?: string[]; area?: string } | false | undefined;
    if (!a || typeof a !== "object") continue;
    const where = `tab ${t.id}: action ${a.kind}`;
    if (a.kind === "start_run" || a.kind === "new_schedule") {
      if (!ownKinds.length) problems.push(at(`${where}: this pack declares no job kind to start`));
      for (const k of [...(a.job_kind ? [a.job_kind] : []), ...(a.job_kinds ?? [])]) {
        const kind = ownKinds.find((x) => x?.name === k);
        if (!kind) problems.push(at(`${where}: job kind ${k} is not one this pack declares`));
        else if (a.kind === "start_run" && kind.approval) problems.push(at(`${where}: job kind ${k} waits for an approval of its preview: start it from an AI client with that approval`));
      }
    }
    if (a.kind === "new_schedule") {
      const scheduled = new Set((p.schedules ?? []).map((s) => s?.job_kind));
      if (!scheduled.size) problems.push(at(`${where}: this pack schedules no job kind (schedules), so a workspace adds no schedule of its own`));
      else if (a.job_kind && !scheduled.has(a.job_kind)) problems.push(at(`${where}: job kind ${a.job_kind} is not one this pack schedules (a workspace adds schedules of the kinds its pack schedules)`));
    }
    if (a.kind === "create_record" && a.area) {
      const ar = (p.recordAreas ?? []).find((x) => x?.name === a.area) as { scope?: string; repository?: string } | undefined;
      if (!ar) problems.push(at(`${where}: this pack declares no record area ${a.area}`));
      else if (ar.scope !== "workspace") problems.push(at(`${where}: ${a.area} is a shared area: a workspace adds records only to its own areas`));
      else if (ar.repository !== undefined) problems.push(at(`${where}: ${a.area} is read from repository ${ar.repository}: its records are not added by hand`));
    }
  }
  each(p.recordAreas, RecordAreaSchema, "recordAreas");
  // mold_v0-261: the agent profiles it brings (each id once), and the start_agent actions naming one of them (or default).
  const profileIds = new Set<string>();
  for (const [i, x] of (p.agentProfiles ?? []).entries()) {
    const r = PackAgentProfileSchema.safeParse(x);
    if (!r.success) { problems.push(at(`agentProfiles[${i}]: ${r.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`)); continue; }
    for (const m of configProblems(r.data)) problems.push(at(`agent profile ${r.data.id}: ${m}`));
    if (profileIds.has(r.data.id)) problems.push(at(`agent profile ${r.data.id} is declared twice`));
    profileIds.add(r.data.id);
  }
  const knownProfile = (id: string | undefined) => !id || id === DEFAULT_PROFILE || profileIds.has(id);
  for (const t of p.tabs ?? []) {
    const a = t?.action as { kind?: string; profile?: string } | false | undefined;
    if (a && typeof a === "object" && a.kind === "start_agent" && !knownProfile(a.profile))
      problems.push(at(`tab ${t.id}: action start_agent: agent profile ${a.profile} is not one this pack declares (agent_profiles) or default`));
  }
  for (const ar of p.recordAreas ?? []) for (const x of ((ar as { detail?: { actions?: { kind?: string; profile?: string }[] } })?.detail?.actions ?? []))
    if (x?.kind === "start_agent" && !knownProfile(x.profile))
      problems.push(at(`record area ${(ar as { name?: string }).name}'s page: action start_agent: agent profile ${x.profile} is not one this pack declares (agent_profiles) or default`));
  each(p.checks, CheckSchema, "checks");
  each(p.credentials, CredentialSchema, "credentials");
  each(p.oauthProviders, OAuthProviderSchema, "oauthProviders");
  each(p.operatorCredentials, OperatorCredentialSchema, "operatorCredentials");
  each(p.schedules, ScheduleSchema, "schedules");
  each(p.onboarding, OnboardingStepSchema, "onboarding");
  // Repositories (mold_v0-059) and the run-results mapping (061): declared shapes; an area names a declared repository.
  const repos = p.repositories ?? {};
  if (typeof repos !== "object" || Array.isArray(repos)) problems.push(at("repositories must be an object of name -> repository"));
  else for (const [rn, r] of Object.entries(repos)) {
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(rn)) problems.push(at(`repository name ${JSON.stringify(rn.slice(0, 64))}: lowercase letters, digits and _`));
    if (upstreamCatalogNames({ [rn]: r }).length) { problems.push(at(`repositories.${rn}: ${UPSTREAM_CATALOG_GONE}`)); continue; }
    const v = RepositorySchema.safeParse(r);
    if (!v.success) problems.push(at(`repositories.${rn}: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
  }
  for (const a of p.recordAreas ?? []) if (a?.repository !== undefined && !Object.hasOwn(repos, a.repository))
    problems.push(at(`record area ${a.name} reads from repository ${a.repository}, which this pack does not declare`));
  problems.push(...repositoryProblems(p, partial).map(at));
  if (p.mcp !== undefined) {
    const v = McpSettingsSchema.safeParse(p.mcp);
    if (!v.success) problems.push(at(`mcp: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
  }
  if (p.runResults !== undefined) {
    const v = RunResultsSchema.safeParse(p.runResults);
    if (!v.success) problems.push(at(`runResults: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
  }
  if (p.workspaceStore !== undefined) {
    const v = WorkspaceStoreSchema.safeParse(p.workspaceStore);
    if (!v.success) problems.push(at(`workspaceStore: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
    if (!(p.agentJobKinds ?? []).length && !(p.jobKinds ?? []).some((k) => (k as { workspace?: boolean })?.workspace))
      problems.push(at("workspaceStore settles the workspace store's retention and viewer: declare a job kind with workspace: true (or agent-workspace)"));
  }
  // The company's own email (mold_v0-192): its intake writes one of this pack's own workspace areas.
  if (p.email !== undefined) problems.push(...emailPackProblems(String(p.id), p.email, (p.recordAreas ?? []) as never));
  // Document previews (mold_v0-220): a field that previews its URL's document needs the hosts it may come from.
  problems.push(...documentProblems(String(p.id), p.documents, (p.recordAreas ?? []).filter(Boolean) as never));
  const kinds = new Set((p.jobKinds ?? []).map((k) => k.name));
  for (const k of p.agentJobKinds ?? []) if (k?.name && kinds.has(k.name)) problems.push(at(`job kind ${k.name} is declared twice`)); else if (k?.name) kinds.add(k.name);
  for (const s of p.schedules ?? []) if (s?.job_kind && !kinds.has(s.job_kind)) problems.push(at(`schedule ${s.name} names job kind ${s.job_kind}, which this pack does not declare`));
  // A schedule runs over this pack's own asset records (mold_v0-035), as a credential binds to them.
  for (const s of p.schedules ?? []) if (s?.assets?.area && !(p.recordAreas ?? []).some((a) => a?.name === s.assets!.area && a.role === "asset"))
    problems.push(at(`schedule ${s.name} runs over area ${s.assets.area}, which is not one of this pack's asset areas`));
  // A schedule's scope gives only arguments its kind declares (mold_v0-057; what a schedule's run gets is the scheduler's, 035).
  for (const s of p.schedules ?? []) {
    const k = [...(p.jobKinds ?? []), ...(p.agentJobKinds ?? [])].find((x) => x?.name === s?.job_kind);
    if (!k?.args) continue;
    for (const key of Object.keys(s.scope ?? {})) if (!k.args.some((a) => a?.name === key)) problems.push(at(`schedule ${s.name}: ${k.name} has no argument ${key}`));
  }
  // Credentials (mold_v0-034): an asset binding names this pack's own asset area; a kind names this pack's own fields;
  // two fields never deliver to the same environment variable or file.
  const creds = new Map((p.credentials ?? []).map((c) => [c?.name, c]));
  for (const c of p.credentials ?? []) {
    // mold_v0-260: a tenant binding names this pack's own tenant area.
    if (c?.area !== undefined && c.bound_to === "tenant" && !(p.recordAreas ?? []).some((a) => a?.name === c.area && (a as { tenant?: boolean }).tenant === true))
      problems.push(at(`credential ${c.name} is bound to area ${c.area}, which is not one of this pack's tenant areas (tenant: true)`));
    else if (c?.area !== undefined && c.bound_to !== "tenant" && !(p.recordAreas ?? []).some((a) => a?.name === c.area && a.role === "asset"))
      problems.push(at(`credential ${c.name} is bound to area ${c.area}, which is not one of this pack's asset areas`));
    // mold_v0-014: an OAuth field names one of this pack's own providers.
    if (c?.oauth !== undefined && !(p.oauthProviders ?? []).some((o) => o?.name === c.oauth))
      problems.push(at(`credential ${c.name} connects to OAuth provider ${c.oauth}, which this pack does not declare (oauthProviders)`));
  }
  problems.push(...credentialGroupProblems(p.credentials ?? [], (p.recordAreas ?? []).filter(Boolean) as never).map(at));
  const oauthNames = (p.oauthProviders ?? []).map((o) => o?.name);
  if (new Set(oauthNames).size !== oauthNames.length) problems.push(at("each OAuth provider name once"));
  // Workspace and operator credentials (mold_v0-075) share the targets: two never deliver to the same variable or file
  // (a file's path_env is a variable too), and a name is one or the other.
  const targets = new Map<string, string>();
  const opCreds = new Map((p.operatorCredentials ?? []).map((c) => [c?.name, c]));
  for (const c of [...(p.credentials ?? []), ...(p.operatorCredentials ?? [])]) {
    const d = c?.deliver_as as { env?: string; file?: string; path_env?: string } | undefined;
    for (const where of [d?.env ? `env ${d.env}` : null, d?.file ? `file ${d.file}` : null, d?.path_env ? `env ${d.path_env}` : null]) {
      if (!where) continue;
      if (targets.has(where)) problems.push(at(`credentials ${targets.get(where)} and ${c.name} both deliver to ${where}`));
      else targets.set(where, c.name);
    }
  }
  for (const n of opCreds.keys()) if (n && creds.has(n)) problems.push(at(`credential ${n} is declared both as a workspace's and as an operator's`));
  for (const k of [...(p.jobKinds ?? []), ...(p.agentJobKinds ?? [])]) {
    for (const n of (k as { credentials?: unknown[] })?.credentials ?? [])
      if (typeof n === "string" && !creds.has(n)) problems.push(at(`job kind ${k.name} names credential ${n}, which this pack does not declare`));
    for (const n of (k as { operator_credentials?: unknown[] })?.operator_credentials ?? [])
      if (typeof n === "string" && !opCreds.has(n)) problems.push(at(`job kind ${k.name} names operator credential ${n}, which this pack does not declare (operatorCredentials)`));
  }
  // Approval gates (mold_v0-079): the preview is a kind of this pack, itself not gated; no schedule starts a gated kind
  // (a schedule has no one to approve its preview).
  const allKinds = [...(p.jobKinds ?? []), ...(p.agentJobKinds ?? [])] as { name?: string; approval?: { preview?: string } }[];
  for (const k of allKinds) if (k?.approval?.preview) {
    const pv = allKinds.find((x) => x?.name === k.approval!.preview);
    if (!pv) problems.push(at(`job kind ${k.name}: its preview ${k.approval.preview} is not a kind of this pack`));
    else if (pv.approval) problems.push(at(`job kind ${k.name}: its preview ${pv.name} waits for an approval itself`));
  }
  for (const s of p.schedules ?? []) if (allKinds.find((k) => k?.name === s?.job_kind)?.approval)
    problems.push(at(`schedule ${s.name} starts ${s.job_kind}, which waits for an approval of its preview: a schedule cannot start it`));
  // Onboarding (mold_v0-011): a step's condition names this pack's own kind, credential or workspace-scope area. (A tool
  // may be any pack's or the shell's: src/packs.ts installPacks checks it against the whole build.)
  for (const st of p.onboarding ?? []) for (const cond of [st?.done_when, st?.how]) {
    const [what, arg] = String(cond ?? "").split(":", 2);
    if (!arg) continue;
    if (what === "run" && !kinds.has(arg)) problems.push(at(`onboarding step ${st.id} names job kind ${arg}, which this pack does not declare`));
    if (what === "credential" && !creds.has(arg)) problems.push(at(`onboarding step ${st.id} names credential ${arg}, which this pack does not declare`));
    if (what === "record") {
      const a = (p.recordAreas ?? []).find((x) => x?.name === arg);
      if (!a) problems.push(at(`onboarding step ${st.id} names record area ${arg}, which this pack does not declare`));
      else if (a.scope !== "workspace") problems.push(at(`onboarding step ${st.id}: record:${arg} must name a workspace-scope area (a shared area says nothing about one workspace)`));
    }
  }
  if (problems.length) throw new PackDefinitionError(problems.join("\n"));
  return p;
}

/**
 * What a pack's repositories must agree on with its areas and credentials (mold_v0-059): the scope each kind feeds, no
 * writes declared on a read-only area, the store, the credential and the egress of an API, maps and loaders naming
 * what exists.
 */
function repositoryProblems(p: PackDefinition, partial: boolean): string[] {
  const out: string[] = [];
  const repos = (p.repositories ?? {}) as Record<string, z.input<typeof RepositorySchema>>;
  if (typeof repos !== "object" || Array.isArray(repos)) return out;
  const areas = (p.recordAreas ?? []).filter((a) => a && typeof a === "object");
  for (const [rn, raw] of Object.entries(repos)) {
    const v = RepositorySchema.safeParse(raw);
    if (!v.success) continue; // its shape is reported above
    const r = v.data;
    const fed = areas.filter((a) => a.repository === rn);
    for (const a of fed) {
      if (r.kind === "workspace_files" && a.scope !== "workspace") out.push(`record area ${a.name}: a workspace_files repository feeds a workspace's own areas (scope workspace)`);
      if (r.kind === "http_api" && r.credential && a.scope !== "workspace") out.push(`record area ${a.name}: an API read with a workspace's credential feeds a workspace's own areas`);
      if (r.kind === "http_api" && ((a as { clocks?: unknown[] }).clocks ?? []).length) out.push(`record area ${a.name} is read live from an API: its rows are not kept, so it cannot have clocks`);
      if ((READ_ONLY_KINDS as readonly string[]).includes(r.kind)) {
        if (a.lifecycle) out.push(`record area ${a.name} reads from ${r.kind} repository ${rn} (read only): it cannot have a lifecycle`);
        // mold_v0-191: a clock's escalation writes the record (reassign, raise): not on a read-only area.
        for (const c of ((a as { clocks?: Clock[] }).clocks ?? [])) if ((c.escalate ?? []).some((e) => e.reassign || e.raise))
          out.push(`record area ${a.name} reads from ${r.kind} repository ${rn} (read only): clock ${c.name} cannot reassign or raise (it would write the record)`);
        for (const k of ["create", "update", "move", "delete"] as const) if (a.permissions?.[k]) out.push(`record area ${a.name} reads from ${r.kind} repository ${rn} (read only): it cannot declare ${k}`);
      }
    }
    if (r.kind === "workspace_files" && r.store !== undefined && r.store !== p.id) out.push(`repository ${rn}: store ${r.store} is not this pack's own store (${p.id})`);
    if (r.kind === "http_api") {
      const h = (() => { try { return new URL(r.base_url).hostname.toLowerCase(); } catch { return ""; } })();
      const allowed = r.egress.some((e) => { const x = e.toLowerCase().replace(/^\*\./, ""); return h === x || h.endsWith(`.${x}`); });
      if (!allowed) out.push(`repository ${rn}: base_url's host ${h} is not in its egress list`);
      if (r.credential !== undefined) {
        const c = (p.credentials ?? []).find((x) => x?.name === r.credential);
        if (!c) out.push(`repository ${rn} names credential ${r.credential}, which this pack does not declare`);
        else if (c.bound_to !== "workspace") out.push(`repository ${rn}: credential ${r.credential} must be bound to the workspace (one value per workspace)`);
      }
    }
    const map = (r as { map?: Record<string, z.input<typeof RowMapSchema>> }).map ?? {};
    for (const [an, m] of Object.entries(map)) {
      const a = fed.find((x) => x.name === an);
      if (!a) { out.push(`repository ${rn} maps area ${an}, which does not read from it`); continue; }
      for (const f of Object.keys(m.fields ?? {})) if (!a.fields.some((x) => x.name === f)) out.push(`repository ${rn}: its map of ${an} names field ${f}, which ${an} does not declare`);
      const files = (r as { files?: Record<string, string> }).files;
      if (m.from !== undefined && !Object.hasOwn(files ?? {}, m.from)) out.push(`repository ${rn}: its map of ${an} reads ${m.from}, which is not one of its files`);
      // mold_v0-123: retires and only_latest read the lines of one file template; retires only where the last line wins.
      const lines = r.kind === "workspace_files" && r.path !== undefined;
      if (m.only_latest !== undefined && !lines) out.push(`repository ${rn}: its map of ${an} declares only_latest, which reads the lines of a workspace_files path`);
      if (m.retires !== undefined && !(lines && r.kind === "workspace_files" && r.append_only)) out.push(`repository ${rn}: its map of ${an} declares retires, which needs a workspace_files path with append_only: true (the last line of a key wins)`);
    }
  }
  for (const [rn, fn] of Object.entries(p.loaders ?? {})) {
    const r = repos[rn];
    // A code entry alone may not carry the repositories its pack.json declares: checked once merged (src/packs.ts).
    if (!r) { if (!partial) out.push(`loader ${rn} names no repository of this pack`); }
    else if (r.kind !== "workspace_files") out.push(`loader ${rn}: only a workspace_files repository takes a loader`);
    if (typeof fn !== "function") out.push(`loader ${rn} must be a function`);
  }
  return out;
}

/** A pack's one export: `export default definePack({ id, tools, routes, ... })`. Checked when the module loads. */
export function definePack<const P extends PackDefinition>(p: P): P {
  validatePack(p, true);
  return p;
}

/** A typed tool definition (infers the handler's arguments from inputSchema). */
export const defineTool = <Shape extends z.ZodRawShape>(t: PackTool<Shape>): PackTool<Shape> => t;
