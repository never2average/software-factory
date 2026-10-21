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
 *   schedules    declared and validated here, listed by packRegistry(); wired by the scheduler (035)
 *
 * A pack never imports another shell module (the build refuses it: scripts/gen-packs.mjs), so everything it may use
 * is here: the definition helpers, zod, and the context each handler receives (its workspace and a database handle
 * that reaches only that workspace's rows).
 */
import { z } from "zod";
import type { AccountPermission, AccountRole } from "./account-roles.js";
import type { Permission as AdminPermission, PlatformRole } from "./admin-roles.js";

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
}
export interface RecordPage { records: RecordRow[]; next: string | null }
export interface RecordInput { title?: string | null; data: Record<string, unknown>; version?: string | null }

/**
 * Records as one workspace sees them: every platform area (read only) and the workspace's own rows of every
 * workspace area. `put` and `delete` reach only this pack's own workspace areas, in this workspace; an asset area's
 * title and data are sealed with the workspace's data key at rest.
 */
export interface WorkspaceRecords {
  list(area: string, opts?: { limit?: number; after?: string }): Promise<RecordPage>;
  get(area: string, key: string): Promise<RecordRow | null>;
  put(area: string, key: string, value: RecordInput): Promise<RecordRow>;
  delete(area: string, key: string): Promise<boolean>;
}
/** Records as platform staff see them: platform areas only; `put` and `delete` reach this pack's own platform areas. */
export interface PlatformRecords {
  list(area: string, opts?: { limit?: number; after?: string }): Promise<RecordPage>;
  get(area: string, key: string): Promise<RecordRow | null>;
  put(area: string, key: string, value: RecordInput): Promise<RecordRow>;
  delete(area: string, key: string): Promise<boolean>;
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
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/, "an environment variable name");
/**
 * A host a run may reach: HTTPS on port 443 only. The egress proxy (orchestrator/core/egress.ts, shared with the
 * sandboxes) allows a listed host and every subdomain of it, so "api.example.com" also allows "x.api.example.com";
 * "*.example.com" is accepted and means "example.com" and its subdomains.
 */
const host = z.string().regex(/^(\*\.)?(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "a host name (HTTPS on port 443; a host allows its subdomains too)");
const packFile = z.string().regex(/^[a-z0-9_\-][a-z0-9_\-/.]*\.m?js$/i, "a .js or .mjs file inside the pack").refine((p) => !p.split("/").includes(".."), "a file inside the pack");

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
 */
export const JobKindSchema = z.object({
  name,
  runner: z.literal("workspace-harness"),
  image: z.string().min(1).optional(),
  entry: packFile,
  validator: packFile.optional(),
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
}).strict();

const field = z.object({ name, label: z.string().min(1).max(80), type: z.enum(["text", "number", "date", "boolean", "json", "link"]).default("text") }).strict();
/**
 * A record area (wired by mold_v0-047; molds/mold_v0/MOLD.md "Pack and record-area contract"). Area names are unique
 * across every pack in a build (they are the `area` of the MCP tools and the path of the console pages). A `link`
 * names a field whose value is the key (or a list of keys) of records in another area.
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
}).strict()
  .refine((a) => a.name !== "areas", "areas is reserved (the list of areas at /api/records/areas)")
  .refine((a) => !(a.role === "asset" && a.scope === "platform"), "an asset area holds a workspace's private data: workspace scope only")
  .refine((a) => new Set(a.fields.map((f) => f.name)).size === a.fields.length, "a field is declared twice")
  .refine((a) => (a.list_columns ?? []).every((c) => a.fields.some((f) => f.name === c)), "list_columns must name declared fields")
  .refine((a) => (a.links ?? []).every((l) => a.fields.some((f) => f.name === l.field)), "a link's field must be a declared field");

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

/** A default schedule per workspace (wired by mold_v0-035). */
export const ScheduleSchema = z.object({
  name,
  job_kind: name,
  cron: z.string().regex(/^(\S+\s+){4}\S+$/, "five cron fields"),
  scope: z.record(z.string(), z.unknown()).optional(),
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
  recordAreas?: z.input<typeof RecordAreaSchema>[];
  credentials?: z.input<typeof CredentialSchema>[];
  schedules?: z.input<typeof ScheduleSchema>[];
  onboarding?: z.input<typeof OnboardingStepSchema>[];
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
export function validatePack(p: PackDefinition): PackDefinition {
  const problems: string[] = [];
  const at = (what: string) => `pack ${JSON.stringify(p?.id)}: ${what}`;
  if (!p || typeof p !== "object") throw new PackDefinitionError("definePack: expected an object");
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(p.id)) problems.push(at("id must be 2-31 lowercase letters, digits or _, starting with a letter"));
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
  each(p.recordAreas, RecordAreaSchema, "recordAreas");
  each(p.credentials, CredentialSchema, "credentials");
  each(p.schedules, ScheduleSchema, "schedules");
  each(p.onboarding, OnboardingStepSchema, "onboarding");
  const kinds = new Set((p.jobKinds ?? []).map((k) => k.name));
  for (const s of p.schedules ?? []) if (s?.job_kind && !kinds.has(s.job_kind)) problems.push(at(`schedule ${s.name} names job kind ${s.job_kind}, which this pack does not declare`));
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
  for (const k of p.jobKinds ?? []) for (const n of (k as { credentials?: unknown[] })?.credentials ?? [])
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

/** A pack's one export: `export default definePack({ id, tools, routes, ... })`. Checked when the module loads. */
export function definePack<const P extends PackDefinition>(p: P): P {
  validatePack(p);
  return p;
}

/** A typed tool definition (infers the handler's arguments from inputSchema). */
export const defineTool = <Shape extends z.ZodRawShape>(t: PackTool<Shape>): PackTool<Shape> => t;
