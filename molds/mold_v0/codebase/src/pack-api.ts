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
 *   credentials, schedules, onboarding
 *                declared and validated here, listed by packRegistry(); wired by later tickets (credential vault 034,
 *                scheduler 035, onboarding checklist 011)
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

export interface PackToolContext { pack: string; workspace: Workspace; db: PackDb; records: WorkspaceRecords }

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
  pack: string; workspace: Workspace; db: PackDb; records: WorkspaceRecords;
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
const host = z.string().regex(/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i, "a host name");

/** A run kind (wired by mold_v0-041): what runs, in which image, for how long, reaching which hosts. */
export const JobKindSchema = z.object({
  name,
  runner: z.string().min(1),
  image: z.string().min(1).optional(),
  token_lifetime_seconds: z.number().int().min(60).max(24 * 3600).optional(),
  budget_usd: z.number().positive().optional(),
  egress: z.array(host).default([]),
  /** The result validator: a module path inside the pack (run by the engine once it exists). */
  validator: z.string().min(1).optional(),
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
  .refine((a) => !(a.role === "asset" && a.scope === "platform"), "an asset area holds a workspace's private data: workspace scope only")
  .refine((a) => new Set(a.fields.map((f) => f.name)).size === a.fields.length, "a field is declared twice")
  .refine((a) => (a.list_columns ?? []).every((c) => a.fields.some((f) => f.name === c)), "list_columns must name declared fields")
  .refine((a) => (a.links ?? []).every((l) => a.fields.some((f) => f.name === l.field)), "a link's field must be a declared field");

/** A credential field a workspace gives (wired by mold_v0-034): only its name ever reaches a run's definition. */
export const CredentialSchema = z.object({
  name,
  label: z.string().min(1),
  help: z.string().optional(),
  bound_to: z.enum(["workspace", "asset", "environment"]),
  deliver_as: z.union([z.object({ env: envName }).strict(), z.object({ file: z.string().regex(/^[a-z0-9_.-]+$/i) }).strict()]),
}).strict();

/** A default schedule per workspace (wired by mold_v0-035). */
export const ScheduleSchema = z.object({
  name,
  job_kind: name,
  cron: z.string().regex(/^(\S+\s+){4}\S+$/, "five cron fields"),
  scope: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** An onboarding checklist step (wired by mold_v0-011): ticked off by an event the shell records. */
export const OnboardingStepSchema = z.object({ id: name, label: z.string().min(1), help: z.string().optional(), done_when: z.string().min(1) }).strict();

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
