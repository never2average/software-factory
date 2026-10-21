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
 *                each value in the console (/app/credentials; only its last 4 characters are ever shown again); it is
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
 *   metrics      declared and validated (mold_v0-057); wired by the metrics and charts (063)
 *   repositories wired (mold_v0-059; src/data-repositories.ts): where an area's rows come from, through one adapter
 *                interface: the shell's tables (the default), the workspace store's files (indexed after a commit), an
 *                upstream catalog at a pinned commit (indexed by platform staff), an external HTTP API (read live).
 *                `loaders` (code only) turn a repository's files into rows when the declared mapping is not enough
 *   the data API wired (mold_v0-059; src/data-api.ts, src/data-routes.ts): list (filter, sort, paging), get, create,
 *                update, move, delete and batch for every area, at /api/data and /api/admin/data, through the same
 *                record store as ctx.records
 *
 * Declarative packs (mold_v0-057): everything above but tools and routes can be written in pack.json instead
 * (src/pack-manifest.ts, the schema at packs/pack.schema.json), with no entry at all. gen-packs compiles it into this
 * same definition; a code entry, when there is one, extends it (src/packs.ts mergePack).
 *
 * A pack never imports another shell module (the build refuses it: scripts/gen-packs.mjs), so everything it may use
 * is here: the definition helpers, zod, and the context each handler receives (its workspace and a database handle
 * that reaches only that workspace's rows).
 */
import { z } from "zod";
import type { AccountPermission, AccountRole } from "./account-roles.js";
import type { Permission as AdminPermission, PlatformRole } from "./admin-roles.js";
import { parseCron } from "./cron.js";
import { AgentWorkspaceSchema, GATEWAY_PLACEHOLDER, placeholders } from "./agent-workspace-config.js";

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
  /** A platform area's version label (the source it was indexed from); null for workspace areas. */
  version: string | null;
  updated_at: string;
  /**
   * Where the stored row no longer fits its area's declaration (mold_v0-057: a field removed, an option dropped, a type
   * changed after the row was written): each such field, named. Present only when there is one; a field no longer
   * declared is left out of `data`, the rest is shown as stored, and the next write must fit the declaration.
   */
  drift?: string[];
}
export interface RecordPage { records: RecordRow[]; next: string | null }
export interface RecordInput { title?: string | null; data: Record<string, unknown>; version?: string | null }
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
  | { op: "put" | "create" | "update"; area: string; key: string; title?: string | null; data: Record<string, unknown>; version?: string | null }
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
}
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
  start(kind: string, input?: { scope?: Record<string, unknown>; targets?: Record<string, unknown> }): Promise<RunView>;
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
export const FIELD_TYPES = ["text", "number", "date", "boolean", "json", "link", "enum", "person", "reference", "file"] as const;
/**
 * A field of a record area (or an argument of a job kind):
 *   text, number, date, boolean, json   as they read; `max_length` (text), `min`/`max` (number)
 *   enum        one of `options` (a list of values or {value, label}); `multiple` takes a list of them
 *   person      a person of the workspace, by their sign-in id; `multiple` takes a list
 *   reference   the key of a record of area `to` (`multiple`: a list of keys); on write the record must exist as the
 *               writer sees it (the same workspace for a workspace area), so a reference never reaches another
 *               workspace's records; a shared (platform) area may refer only to shared areas
 *   file        a file reference {path, name?, sha256?, size?}: a path inside the workspace's store (no "..", no
 *               leading "/"); `multiple` takes a list
 *   link        the 047 form of reference (a key or a list of keys, resolved through the area's `links`)
 * `required` refuses a write that leaves it empty.
 */
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
}).strict().superRefine((f, ctx) => {
  const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
  if (f.type === "enum" && !f.options) bad("an enum field lists its options", "options");
  if (f.type !== "enum" && f.options) bad("options are for an enum field only", "options");
  if (f.options) {
    const vals = f.options.map((o) => (typeof o === "string" ? o : o.value));
    if (new Set(vals).size !== vals.length) bad("an option is listed twice", "options");
  }
  if (f.type === "reference" && !f.to) bad("a reference field names the area it refers to (to)", "to");
  if (f.type !== "reference" && f.to) bad("to is for a reference field only", "to");
  if (f.multiple && !["enum", "person", "reference", "file"].includes(f.type)) bad("multiple is for enum, person, reference and file fields", "multiple");
  if ((f.min !== undefined || f.max !== undefined) && f.type !== "number") bad("min and max are for a number field", "min");
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) bad("min is above max", "min");
  if (f.max_length !== undefined && f.type !== "text") bad("max_length is for a text field", "max_length");
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
  egress: z.array(host).max(50).default([]),
  /** The workspace store (mold_v0-033): check the workspace's snapshot out before the run, write it back after. */
  workspace: z.boolean().default(false),
  /**
   * The pack's credential fields a run of this kind receives (mold_v0-034), by name; none by default. Each is delivered
   * as the field declares (deliver_as), and only the value bound to what the run targets (src/credentials.ts).
   */
  credentials: z.array(name).max(20).default([]),
  /**
   * The run's arguments (mold_v0-057): typed like a record area's fields (the same types and checks). When declared, a
   * run's `scope` must be exactly these (unknown keys refused, each value of its type, required ones present); checked
   * when a pack's code starts the run (src/packs.ts declaredRuns). Absent: the scope is free, as before.
   */
  args: z.array(field).max(30).optional(),
  unresolved_references: z.enum(["reject", "drop", "downgrade"]).default("reject"),
  max_unresolved: z.number().int().min(0).max(5000).default(100),
};
export const JobKindSchema = z.object({
  ...jobKindBase,
  runner: z.literal("workspace-harness"),
  image: z.string().min(1).optional(),
  entry: packFile,
  validator: packFile.optional(),
}).strict()
  .refine((k) => new Set((k.args ?? []).map((a) => a.name)).size === (k.args ?? []).length, "an argument is declared twice");

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
  if (k.agent.timeout_seconds > k.token_lifetime_seconds)
    ctx.addIssue({ code: "custom", message: "agent.timeout_seconds is longer than token_lifetime_seconds (the run's deadline)", path: ["agent", "timeout_seconds"] });
  for (const [name, v] of Object.entries(k.agent.env)) for (const p of placeholders(v)) {
    const m = GATEWAY_PLACEHOLDER.exec(p);
    if (m && !k.providers.length) ctx.addIssue({ code: "custom", message: `{${p}} needs a gateway provider (providers)`, path: ["agent", "env", name] });
    if (m?.[2] && !k.providers.includes(m[2])) ctx.addIssue({ code: "custom", message: `{${p}}: ${m[2]} is not one of the kind's providers`, path: ["agent", "env", name] });
  }
  for (const name of Object.keys(k.agent.env)) if (RESERVED_ENV.test(name))
    ctx.addIssue({ code: "custom", message: `${name} is set by the shell for every run (PATH, HOME, RUN_*, proxy and loader settings)`, path: ["agent", "env", name] });
});

/**
 * A record area (wired by mold_v0-047; molds/mold_v0/MOLD.md "Pack and record-area contract"). Area names are unique
 * across every pack in a build (they are the `area` of the MCP tools and the path of the console pages). A `link`
 * names a field whose value is the key (or a list of keys) of records in another area; a `reference` field does the
 * same and is checked on write (mold_v0-057). `lifecycle` and `permissions` (mold_v0-057) are enforced by the shell's
 * record store (src/record-areas.ts) on every write and move through it (ctx.records, the record tools and routes); a
 * pack's code may not name the record tables in its own queries (scripts/gen-packs.mjs refuses it).
 */
export const RecordAreaSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  role: z.enum(["source", "check", "asset"]),
  scope: z.enum(["platform", "workspace"]),
  fields: z.array(field).min(1).max(60),
  list_columns: z.array(name).max(8).optional(),
  links: z.array(z.object({ field: name, area: name }).strict()).optional(),
  lifecycle: LifecycleSchema.optional(),
  permissions: PermissionsSchema.optional(),
  /**
   * Where the area's rows come from (mold_v0-059; src/data-repositories.ts): one of the pack's `repositories`. Absent,
   * the shell's own tables, written through the record store. An area fed by the workspace store's files or an external
   * API is read only (its rows come from there); one fed by an upstream catalog is indexed by platform staff.
   */
  repository: name.optional(),
  /**
   * Sealed at rest (mold_v0-066): the title and data of every record are encrypted with the workspace's data key, as an
   * asset area's always are. Workspace scope only (a shared row has no workspace key). Writes are refused while the key
   * vault is locked; a filter or sort over a sealed area runs on the opened rows, never in the database.
   */
  sealed: z.boolean().optional(),
  /** In words, what one row is and how it is keyed (for people and intake; never read by code). */
  rows: z.string().max(500).optional(),
  /** In words, where a shared row's version comes from (an upstream commit, a date). */
  version: z.string().max(200).optional(),
  /**
   * Due dates (wired by mold_v0-035; src/schedules.ts): a check area of workspace scope may name one of its date fields.
   * Once a day the shell posts an in-app notice for each record whose date falls within `within_days` (today included),
   * and emails the workspace's people with the `notify` roles (owners by default) a list of them.
   */
  due: z.object({
    field: name,
    within_days: z.number().int().min(0).max(365).default(7),
    notify: z.array(z.enum(["owner", "billing", "member", "viewer"])).min(1).max(4).default(["owner"]),
  }).strict().optional(),
  $comment: z.string().max(2000).optional(),
}).strict().superRefine((a, ctx) => {
  const bad = (message: string, ...path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  if (a.name === "areas") bad("areas is reserved (the list of areas at /api/records/areas)", "name");
  if (a.role === "asset" && a.scope === "platform") bad("an asset area holds a workspace's private data: workspace scope only", "scope");
  if (a.sealed && a.scope === "platform") bad("a shared (platform) area has no workspace key to seal it with: sealed is for workspace areas", "sealed");
  if (a.sealed === false && a.role === "asset") bad("an asset area is always sealed", "sealed");
  if (a.due && (a.sealed || a.role === "asset")) bad("due dates are read in the database: a sealed area's dates are not readable there", "due");
  if (new Set(a.fields.map((f) => f.name)).size !== a.fields.length) bad("a field is declared twice", "fields");
  if (!(a.list_columns ?? []).every((c) => a.fields.some((f) => f.name === c))) bad("list_columns must name declared fields", "list_columns");
  if (!(a.links ?? []).every((l) => a.fields.some((f) => f.name === l.field))) bad("a link's field must be a declared field", "links");
  for (const [i, l] of (a.links ?? []).entries()) {
    const f = a.fields.find((x) => x.name === l.field);
    if (f?.type === "reference" && f.to !== l.area) bad(`field ${f.name} refers to ${f.to}; its link names ${l.area}`, "links", i);
  }
  if (a.due && !(a.role === "check" && a.scope === "workspace")) bad("due is for a check area of workspace scope (each workspace's own dates)", "due");
  if (a.due && !a.fields.some((f) => f.name === a.due!.field && f.type === "date")) bad("due.field must name one of the area's date fields", "due", "field");
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
export const REPOSITORY_KINDS = ["shell_tables", "workspace_files", "upstream_catalog", "http_api"] as const;
/** Kinds whose areas are read only through every door (their rows come from the repository). */
export const READ_ONLY_KINDS = ["workspace_files", "http_api"] as const;
const comment = z.string().max(2000).optional();
const fileKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "a file name in the declaration: lowercase letters, digits and _");
/** A path inside a repository or a workspace's files: no "..", no leading "/"; {name} placeholders and * in the last part. */
const repoPath = z.string().regex(/^(?!\/)[A-Za-z0-9._/{}*-]{1,300}$/, "a relative path (letters, digits, . _ - / { } *)")
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "." || s === ""), "a relative path with no . or .. part");
/** A value inside a document: a dotted path of properties ("a.b"), "$." for the document's root, "@<name>" a path placeholder, "@file" the file's path. */
export const VALUE_PATH = /^(?!.*(^|[.@$])(__proto__|constructor|prototype)(\.|$))(\$\.|@)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const valuePath = z.string().regex(VALUE_PATH, "a value path: a.b, $.a (the document's root), @name (a path placeholder) or @file");
/** Text with {value path} parts: a record's key or title made from a document's values. */
const template = z.string().min(1).max(300).refine((t) => /\{[^{}]+\}/.test(t) && [...t.matchAll(/\{([^{}]*)\}/g)].every((m) => VALUE_PATH.test(m[1]!)) && !/[\u0000-\u001f]/.test(t),
  "a template: text with {value path} parts, e.g. {id} or {$.instrument}:{id}");
/**
 * How a repository's documents become one area's rows (no code): `from` names one of the repository's `files` (a file, a
 * directory or a glob: every JSON document under it), `each` the list inside a document that holds one row per item
 * ("groups.controls": every control of every group), `key` and `title` templates, and `fields` each field's value path
 * (absent: the item's property of the same name, or its camelCase form).
 */
export const RowMapSchema = z.object({
  from: fileKey.optional(),
  each: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, "a dotted path to a list (each list on the way is walked)").optional(),
  key: template,
  title: template.optional(),
  fields: z.record(name, valuePath).optional(),
  /** Only the items whose values are these (e.g. {"kind": "control"} in a ledger that holds several kinds of lines). */
  where: z.record(z.string().regex(VALUE_PATH, "a value path"), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
}).strict();
/** An upstream project pinned by commit: a full commit id, never a branch or a tag. */
export const UpstreamSchema = z.object({
  repo: z.string().regex(/^(https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+|file:\/\/\/[A-Za-z0-9._~/-]+)$/, "an https:// repository address (file:// only in tests)"),
  commit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit id (40 or 64 hex characters): never a branch or a tag"),
  license: z.string().max(80).optional(),
}).strict();
const ShellTablesSchema = z.object({ kind: z.literal("shell_tables"), $comment: comment }).strict();
/**
 * The workspace store's files (mold_v0-033): read only, indexed into the workspace's rows after a commit. Either `path`
 * (a file template: one row per `identity` value of a JSON-lines or JSON-list file, the last one winning when
 * `append_only`) or `dir` (a directory template: one row per matching directory, its `files` read into the fields of the
 * same name). `{name}` parts match one path segment and are values (@name); `store` is the pack's own store (its id).
 * `never_read` names what is never kept: "<file> <a.b[].c>" drops that value of that file, "any ENC[...] value" drops
 * every sealed (sops) value.
 */
const WorkspaceFilesSchema = z.object({
  kind: z.literal("workspace_files"), $comment: comment,
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
 * An upstream catalog at a pinned commit: `upstream` (pack.json#upstream, or {repo, commit}) is fetched at the pin only
 * (any other commit or a redirect is refused), its `files` read there and indexed into platform areas by staff,
 * idempotently (by fingerprint), pruning only rows it wrote (and refusing to empty an area or prune more than
 * `prune.max_fraction` of it). Other keys are the pack's loader's own settings.
 */
const UpstreamCatalogSchema = z.object({
  kind: z.literal("upstream_catalog"), $comment: comment,
  upstream: z.union([z.literal("pack.json#upstream"), UpstreamSchema]),
  transport: z.enum(["git", "github"]).optional(),
  files: z.record(fileKey, repoPath).optional(),
  map: z.record(name, RowMapSchema).optional(),
  prune: z.object({ max_fraction: z.number().min(0).max(1).optional(), allow_empty: z.boolean().optional() }).strict().optional(),
}).catchall(z.unknown());
/**
 * An external HTTP API, read live and read only: `base_url` (its host among `egress`, the only hosts it may reach; a
 * redirect is refused), the workspace's `credential` field (mold_v0-034, bound to the workspace) sent in `auth.header`,
 * `list.path` (the list of items at `list.items`), `get.path` (with {key}) and a `map` per area.
 */
const HttpApiSchema = z.object({
  kind: z.literal("http_api"), $comment: comment,
  base_url: z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/i, "an https:// address"),
  egress: z.array(host).min(1).max(10),
  credential: name.optional(),
  auth: z.object({ header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/, "a header name").optional(), scheme: z.string().regex(/^[A-Za-z]{1,20}$/, "a word").optional() }).strict().optional(),
  list: z.object({ path: z.string().regex(/^\/[A-Za-z0-9._~/-]*(\?[A-Za-z0-9._~=&-]*)?$/, "a path under base_url"), items: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/).optional() }).strict(),
  get: z.object({ path: z.string().regex(/^\/[A-Za-z0-9._~/{}-]*\{key\}[A-Za-z0-9._~/{}-]*$/, "a path under base_url with {key}") }).strict().optional(),
  map: z.record(name, RowMapSchema.omit({ from: true, each: true, where: true })).optional(),
  max_items: z.number().int().min(1).max(5000).optional(),
}).strict();
/**
 * A data repository (mold_v0-059; src/data-repositories.ts): a `kind` and its settings. An area names one with
 * `repository`; an area that names none reads the shell's tables.
 */
export const RepositorySchema = z.discriminatedUnion("kind", [ShellTablesSchema, WorkspaceFilesSchema, UpstreamCatalogSchema, HttpApiSchema]);
export type Repository = z.output<typeof RepositorySchema>;

/** What a pack's loader reads: one repository's documents, never a workspace id or a database. */
export interface RepositoryInput {
  repository: string;
  kind: "workspace_files" | "upstream_catalog";
  settings: Record<string, unknown>;
  /** The upstream commit (an upstream catalog), or null. */
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

/**
 * A metric over a pack's records or its runs' results (mold_v0-063 builds it, with the charts that show it). Declared
 * here so 063 slots in without reshaping pack.json: a name, a label and what it is `over` (a record area of the build, or
 * "run_results"); 063 defines and checks the rest of each metric, which until then is kept but not read.
 */
export const MetricSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  over: name,
}).catchall(z.unknown());

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
 */
export const CredentialSchema = z.object({
  name,
  label: z.string().min(1).max(80),
  help: z.string().max(500).optional(),
  bound_to: z.enum(["workspace", "asset", "environment"]),
  /** The asset area (asset and environment bindings): one of this pack's own areas with role "asset". */
  area: name.optional(),
  environments: z.array(envLabel).min(1).max(20).optional(),
  deliver_as: z.union([
    z.object({ env: envNameField }).strict(),
    z.object({ file: z.string().regex(/^[a-z0-9_][a-z0-9_.-]{0,99}$/i, "a file name (letters, digits, _ . -), no directories") }).strict(),
  ]),
}).strict()
  .refine((c) => (c.bound_to === "workspace") === (c.area === undefined), "area names the asset area for an asset or environment binding (and only then)")
  .refine((c) => c.environments === undefined || c.bound_to === "environment", "environments is for an environment binding only");

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
/** An onboarding checklist step (wired by mold_v0-011): the /app Setup page's pack checklist, ticked from real events. */
export const OnboardingStepSchema = z.object({
  id: name, label: z.string().min(1).max(120), help: z.string().max(500).optional(),
  done_when: z.string().regex(ONBOARDING_CONDITION, "done_when: workspace, connected, first_call, tool:<name>, credential:<name>, record:<area> or run:<kind>"),
}).strict();

export interface PackDefinition {
  id: string;
  tools?: PackTool<any>[];
  routes?: PackRoute[];
  jobKinds?: z.input<typeof JobKindSchema>[];
  /** Job kinds for the agent-workspace runner (mold_v0-061 wires them; declared and validated since mold_v0-057). */
  agentJobKinds?: z.input<typeof AgentJobKindSchema>[];
  recordAreas?: z.input<typeof RecordAreaSchema>[];
  credentials?: z.input<typeof CredentialSchema>[];
  schedules?: z.input<typeof ScheduleSchema>[];
  onboarding?: z.input<typeof OnboardingStepSchema>[];
  /** Metrics over the pack's records and run results (mold_v0-063 builds them; declared and validated since 057). */
  metrics?: z.input<typeof MetricSchema>[];
  /** The pack's data repositories, by name (mold_v0-059; src/data-repositories.ts). */
  repositories?: Record<string, z.input<typeof RepositorySchema>>;
  /** Code that turns a repository's documents into rows, by repository name (mold_v0-059; code only, never pack.json). */
  loaders?: Record<string, RepositoryLoader>;
  /** How a run's output becomes run_results rows (mold_v0-061; declared and validated since 057). */
  runResults?: z.input<typeof RunResultsSchema>;
  /**
   * After a run of one of this pack's job kinds with `workspace: true` succeeds and its write-back is committed
   * (mold_v0-064; src/runs.ts complete), before its results are checked: the pack indexes the workspace it just wrote
   * (its records, through ctx.records), so the results may name what the index made. Called with every file of the
   * committed snapshot, also when the run changed nothing (an index can always catch up). Runs for the run's own
   * workspace only, under row-level security, within OCTILLION_WORKSPACE_HOOK_SECONDS (120). If it throws or runs out
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
  each(p.recordAreas, RecordAreaSchema, "recordAreas");
  each(p.credentials, CredentialSchema, "credentials");
  each(p.schedules, ScheduleSchema, "schedules");
  each(p.onboarding, OnboardingStepSchema, "onboarding");
  // Repositories (mold_v0-059) and the run-results mapping (061): declared shapes; an area names a declared repository.
  const repos = p.repositories ?? {};
  if (typeof repos !== "object" || Array.isArray(repos)) problems.push(at("repositories must be an object of name -> repository"));
  else for (const [rn, r] of Object.entries(repos)) {
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(rn)) problems.push(at(`repository name ${JSON.stringify(rn.slice(0, 64))}: lowercase letters, digits and _`));
    const v = RepositorySchema.safeParse(r);
    if (!v.success) problems.push(at(`repositories.${rn}: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
  }
  for (const a of p.recordAreas ?? []) if (a?.repository !== undefined && !Object.hasOwn(repos, a.repository))
    problems.push(at(`record area ${a.name} reads from repository ${a.repository}, which this pack does not declare`));
  problems.push(...repositoryProblems(p, partial).map(at));
  if (p.runResults !== undefined) {
    const v = RunResultsSchema.safeParse(p.runResults);
    if (!v.success) problems.push(at(`runResults: ${v.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; ")}`));
  }
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
    if (c?.area !== undefined && !(p.recordAreas ?? []).some((a) => a?.name === c.area && a.role === "asset"))
      problems.push(at(`credential ${c.name} is bound to area ${c.area}, which is not one of this pack's asset areas`));
  }
  const targets = new Map<string, string>();
  for (const c of p.credentials ?? []) {
    const d = c?.deliver_as as { env?: string; file?: string } | undefined;
    const where = d?.env ? `env ${d.env}` : d?.file ? `file ${d.file}` : null;
    if (!where) continue;
    if (targets.has(where)) problems.push(at(`credentials ${targets.get(where)} and ${c.name} both deliver to ${where}`));
    else targets.set(where, c.name);
  }
  for (const k of [...(p.jobKinds ?? []), ...(p.agentJobKinds ?? [])]) for (const n of (k as { credentials?: unknown[] })?.credentials ?? [])
    if (typeof n === "string" && !creds.has(n)) problems.push(at(`job kind ${k.name} names credential ${n}, which this pack does not declare`));
  // Onboarding (mold_v0-011): a step's condition names this pack's own kind, credential or workspace-scope area. (A tool
  // may be any pack's or the shell's: src/packs.ts installPacks checks it against the whole build.)
  for (const st of p.onboarding ?? []) {
    const [what, arg] = String(st?.done_when ?? "").split(":", 2);
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
      if (r.kind === "upstream_catalog" && a.scope !== "platform") out.push(`record area ${a.name}: an upstream catalog feeds shared areas (scope platform)`);
      if (r.kind === "http_api" && r.credential && a.scope !== "workspace") out.push(`record area ${a.name}: an API read with a workspace's credential feeds a workspace's own areas`);
      if ((READ_ONLY_KINDS as readonly string[]).includes(r.kind)) {
        if (a.lifecycle) out.push(`record area ${a.name} reads from ${r.kind} repository ${rn} (read only): it cannot have a lifecycle`);
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
    }
  }
  for (const [rn, fn] of Object.entries(p.loaders ?? {})) {
    const r = repos[rn];
    // A code entry alone may not carry the repositories its pack.json declares: checked once merged (src/packs.ts).
    if (!r) { if (!partial) out.push(`loader ${rn} names no repository of this pack`); }
    else if (r.kind !== "workspace_files" && r.kind !== "upstream_catalog") out.push(`loader ${rn}: only a workspace_files or upstream_catalog repository takes a loader`);
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
