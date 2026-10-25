/**
 * Declarative packs (mold_v0-057; molds/mold_v0/MOLD.md "Pack and record-area contract"): a pack may be a pack.json and
 * nothing else. This module is the one definition of pack.json: the zod schema the build validates every pack.json
 * with (scripts/gen-packs.mjs, through tsx), the JSON Schema written from it for editors and intake
 * (packs/pack.schema.json, `npm run gen:pack-schema`), and the compiler that turns a pack.json's declarations into the
 * definition `definePack` would have produced (record areas with typed fields, lifecycles and permissions; job kinds;
 * credential fields; schedules; onboarding; metrics, charts and console tabs). A code entry stays possible and extends it
 * (mergePack).
 *
 * `workspace_store` (mold_v0-056, src/workspace-store-policy.ts): the store's retention and the file viewer's secret paths.
 * `mcp` (mold_v0-060, McpSettingsSchema in src/pack-api.ts) shapes the MCP tools generated from the declarations
 * (src/mcp-tools.ts): prefix, include, exclude, rename, describe, admin_only, the server's instructions and the
 * declared slash commands (`prompts`, mold_v0-137). No key is reserved now.
 * `repositories` (mold_v0-059: each a `kind` and its settings, read by src/data-repositories.ts; an area names one with
 * `repository`; "pack.json#upstream" is resolved here to the pack.json's own `upstream` pin). Declared and checked for
 * their shape today, read by the ticket that builds it: `run_results` (how a run's output becomes run_results rows:
 * mold_v0-061). `metrics` and `charts` are wired by mold_v0-063 (src/metrics.ts), `tabs` by mold_v0-058 (the console's
 * sidebar and tab pages); what they name across the build is checked by src/metric-spec.ts.
 * The agent-workspace runner's own settings (repository, commit, command, validation, write-back) are mold_v0-061's: a
 * job kind with runner "agent-workspace" is declared today with its limits, arguments and credentials only.
 */
import { CONSOLE_COMPONENTS, CONSOLE_PAGES } from "./console-pages.js";
import { ACCESS_FIELD_TYPES, MAX_ACCESS_FIELDS } from "./access-request.js";
import { LandingDocSchema, LandingSchema } from "./landing.js";
import { GuideSchema } from "./pack-guide.js";
import { StaffDocsSchema } from "./staff-docs.js";
import { WorkspaceStoreSchema } from "./workspace-store-policy.js";
import { AgentJobKindSchema, ChartSchema, CredentialSchema, JobKindSchema, OperatorCredentialSchema, McpSettingsSchema, MetricSchema, OnboardingStepSchema, RecordAreaSchema, RepositorySchema, RunResultsSchema, ScheduleSchema, TabSchema, TAB_ICONS, UpstreamSchema, z, type PackDefinition } from "./pack-api.js";

const id = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "2-31 lowercase letters, digits or _, starting with a letter");
const inside = (what: string) => z.string().regex(/^[a-z0-9_\-/]+$/i, `${what}: a path inside the pack`).refine((p) => !p.split("/").includes("..") && !p.startsWith("/"), `${what}: a path inside the pack`);

/** One page of the console (gen-packs checks the same and more: mold_v0-038). */
const PageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "lowercase letters, digits and -"),
  area: z.enum(["app", "admin"]),
  title: z.string().min(1),
  description: z.string().optional(),
  data: z.string().regex(/^\/[a-z0-9_\-/]*$/i, "a path under the pack's own API, starting with /"),
  columns: z.array(z.object({ key: z.string(), label: z.string() }).strict()).optional(),
  nav_group: z.string().optional(),
  icon: z.string().optional(),
}).strict();

const plain = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text on one line: no control or direction characters");
const settingKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/, "an environment variable's name: capitals, digits and _");
/**
 * Global settings a pack adds to /admin (mold_v0-140; src/settings.ts, which reads them from src/hosts.generated.ts
 * PACK_CONFIG): pure data. `groups` go after the group each names (a shell group: models, runs, capacity, docs, email,
 * or one a pack adds before); each of `defs` is a setting keyed by the environment variable it overrides, in a group,
 * before the setting `before` names or at the end of its group. Its value in force: set on /admin, else the environment,
 * else `default`.
 */
const SettingsSchema = z.object({
  $comment: z.string().max(2000).optional(),
  groups: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "2-31 lowercase letters, digits or _"), label: plain(60), after: z.string().max(31).optional() }).strict()).max(20).optional(),
  defs: z.array(z.object({
    key: settingKey, group: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "a group's id"), label: plain(120),
    kind: z.enum(["text", "int", "number", "choice"]), default: z.union([z.string().max(200), z.number()]),
    min: z.number().optional(), max: z.number().optional(), options: z.array(z.string().min(1).max(60)).min(1).max(30).optional(),
    format: z.enum(["model", "sender", "emails"]).optional(), help: plain(600), before: settingKey.optional(),
  }).strict()
    .refine((d) => (d.kind === "choice") === (d.options !== undefined), "options with kind choice (and only then)")
    .refine((d) => d.kind !== "choice" || d.options!.includes(String(d.default)), "a choice's default is one of its options")
    .refine((d) => (d.kind === "int" || d.kind === "number") === (typeof d.default === "number"), "a number's default is a number, text's is text")
    .refine((d) => d.min === undefined || d.max === undefined || d.min <= d.max, "min at most max")
    .refine((d) => d.format === undefined || d.kind === "text", "format is a text setting's")).max(100).optional(),
}).strict();
/**
 * A pack's words for the admin MCP's shell tools and skills (mold_v0-140; src/admin-mcp.ts): `reword`, a shell tool's
 * description and its summary line (`summary_template`, filled with the result's fields: src/text-template.ts
 * summaryValues, {account_name}, {members_count}); `skills`, steps of a shell skill replaced, each one exact passage
 * `from` (the build is refused when the skill no longer reads it: src/admin-skills.ts) by `to`, in order.
 */
const AdminMcpSchema = z.object({
  $comment: z.string().max(2000).optional(),
  reword: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a shell admin tool's name"), z.object({
    description: plain(2000).optional(), summary_template: plain(400).optional(),
  }).strict()).optional(),
  skills: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a shell admin skill's name"), z.array(z.object({
    from: z.string().min(10).max(2000), to: z.string().min(1).max(4000),
  }).strict()).min(1).max(20)).optional(),
}).strict();

const stepId = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "2-31 lowercase letters, digits or _");
/**
 * A host pack's Setup page (mold_v0-140; src/app.ts setup, src/host.ts SetupConfig): its own `steps` among the shell's
 * (each after a step, done when the person read a resource whose address starts with a prefix, `resource:<prefix>`, or
 * the account reached a session-engine stage, `stage:onboarded|simulated|reported`), the shell's steps in its words
 * (`shell_steps`: joined, connected, tools, first_call), the note shown for a step that starts work to someone who may
 * not (`viewer_note`, with `launch` on the step), and the `workflow`: the tool groups that make up using it fully.
 */
const ShellStepWords = z.object({ label: plain(120).optional(), help: plain(600).optional(), prompt: plain(400).optional() }).strict();
const SetupSchema = z.object({
  $comment: z.string().max(2000).optional(),
  steps: z.array(z.object({
    $comment: z.string().max(2000).optional(),
    id: stepId, label: plain(120), help: plain(600), help_text_only: plain(600).optional(), prompt: plain(400).optional(),
    optional: z.boolean().optional(), launch: z.boolean().optional(), after: stepId.optional(),
    done_when: z.string().regex(/^(resource:[a-z][a-z0-9+.-]*:\/\/[^\s]{0,200}|stage:[a-z][a-z0-9_]{1,30})$/, "resource:<address prefix> (ui://...) or stage:<id>"),
  }).strict()).max(12).optional(),
  shell_steps: z.object(Object.fromEntries(["joined", "connected", "tools", "first_call"].map((id) => [id, ShellStepWords.optional()]))).strict().optional(),
  viewer_note: plain(300).optional(),
  workflow: z.array(z.object({
    id: stepId, label: plain(80),
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "an MCP tool's name")).min(1).max(40),
    prompt: plain(400),
  }).strict()).max(20).optional(),
}).strict();

/**
 * The session engine's account stages in the product's words (mold_v0-121; src/admin.ts, src/insights.ts, the console's
 * Accounts pages): the host pack that owns the engine's tables declares them (scripts/gen-packs.mjs requires it). Each of
 * the engine's stages, in order (onboarded, simulated, reported): its label, the next step after it and its Analytics
 * funnel label; the next step after an account's first tool call; and the needs-attention messages (an onboarding that
 * failed, and an account two days at the first call, at onboarded or at simulated). The build's words ({run}) are filled in.
 */
const AccountStagesSchema = z.object({
  $comment: z.string().max(2000).optional(),
  first_next: plain(120),
  stages: z.array(z.object({ id: z.enum(["onboarded", "simulated", "reported"]), label: plain(60), next: plain(120), funnel: plain(60) }).strict()).length(3)
    .refine((l) => l.map((s) => s.id).join() === "onboarded,simulated,reported", "the engine's three stages in order: onboarded, simulated, reported"),
  attention: z.object({ failed: plain(120), first_call: plain(120), onboarded: plain(120), simulated: plain(120) }).strict(),
}).strict();

/** One sidebar entry of a host pack (mold_v0-140): one of its own pages in that console, its icon, an optional shortcut (g then a key). */
const NavItemSchema = (area: "/app" | "/admin") => z.object({
  title: z.string().trim().min(1).max(40).regex(/^[^{}<>]*$/, "plain text: no braces or angle brackets"),
  url: z.string().regex(area === "/app" ? /^\/app(\/[a-z0-9][a-z0-9-]*)+$/ : /^\/admin(\/[a-z0-9][a-z0-9-]*)+$/, `one of the pack's ${area} pages: ${area}/<path>`),
  icon: z.enum(TAB_ICONS),
  shortcut: z.tuple([z.string().regex(/^[a-z]$/, "a lowercase letter"), z.string().regex(/^[a-z0-9]$/, "a lowercase letter or digit")]).optional(),
}).strict();
/** Where a host pack's sidebar entries go (mold_v0-140): a new group by a group's label, or into a group by an entry's url. */
const NavPlacementSchema = (area: "/app" | "/admin") => z.object({
  $comment: z.string().max(2000).optional(),
  label: z.string().trim().min(1).max(40).regex(/^[^{}<>]*$/, "plain text: no braces or angle brackets").optional(),
  into: z.string().trim().min(1).max(40).optional(),
  before: z.string().trim().min(1).max(200).optional(),
  after: z.string().trim().min(1).max(200).optional(),
  items: z.array(NavItemSchema(area)).min(1).max(20),
}).strict()
  .refine((p) => (p.label === undefined) !== (p.into === undefined), "either label (a new group) or into (entries put into a group), not both")
  .refine((p) => p.before === undefined || p.after === undefined, "before or after, not both")
  .refine((p) => p.into === undefined || [p.before, p.after].every((u) => u === undefined || u.startsWith(`${area}`)), `into a group, before and after name an entry by its url (${area}...)`);

/**
 * The access-request form's own fields (mold_v0-102; src/access-request.ts, which gen-packs runs for the rules this shape
 * cannot say: options only on a select, a key once across the build, never one of the shell's own fields).
 */
const AccessFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "1-40 lowercase letters, digits or _, starting with a letter"),
  label: z.string().trim().min(1).max(80),
  type: z.enum(ACCESS_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(80) }).strict()).min(1).max(30).optional(),
  max_length: z.number().int().min(1).max(4000).optional(),
  help: z.string().trim().min(1).max(200).optional(),
  placeholder: z.string().trim().min(1).max(120).optional(),
}).strict();
const AccessRequestSchema = z.object({
  $comment: z.string().max(2000).optional(),
  fields: z.array(AccessFieldSchema).min(1).max(MAX_ACCESS_FIELDS),
}).strict();

/** A job kind in pack.json: a program of the pack's (runner "workspace-harness", entry) or the agent-workspace runner's. */
const JobKindJson = z.discriminatedUnion("runner", [JobKindSchema, AgentJobKindSchema]);

/** pack.json, whole: the manifest (mold_v0-038) and the declarations (mold_v0-057). */
export const PackJsonSchema = z.object({
  $schema: z.string().optional(),
  $comment: z.string().max(2000).optional(),
  id,
  name: z.string().trim().min(1, "name is required"),
  version: z.string().trim().min(1, "version is required"),
  description: z.string().max(1000).optional(),
  /** The code entry (a .ts file whose default export is definePack). Optional: a pack.json alone is a whole pack. */
  entry: z.string().regex(/^[a-z0-9_\-/]+\.ts$/i, "a .ts file inside the pack").refine((p) => !p.includes(".."), "a .ts file inside the pack").optional(),
  migrations: inside("migrations").optional(),
  runner: inside("runner").optional(),
  /**
   * The upstream project the pack runs or reads, pinned by a full commit (mold_v0-050): its repository, the commit and its
   * licence (an SPDX id). A copyleft licence makes the build offer that project's source at that commit (src/source-offer.ts:
   * DATA-MAP.md, the root and landing footers, the install pages and the MCP server's instructions); an agent repository a job
   * kind runs from the same repository must be at the same commit, so the offer names what runs.
   */
  upstream: UpstreamSchema.optional(),
  /**
   * A host pack (mold_v0-039; src/host.ts): its server entry (defineHost), its operator scripts' directory and the profile
   * it brings under the build's profile.json. Only a pack the build's profile.json lists in `host_packs` may have one
   * (scripts/gen-packs.mjs checks it and its import boundary).
   */
  host: z.object({
    entry: z.string().regex(/^[a-z0-9_\-/]+\.ts$/i, "a .ts file inside the pack").refine((p) => !p.includes(".."), "a .ts file inside the pack"),
    scripts: inside("scripts").optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
    /**
     * The host pack's own tables when they keep the names they had in the shell's base schema (mold_v0-049; MOLD.md
     * "Host packs"): `tables` (outside the pack's `<id>_` prefix, never a shell table), `functions` its migrations
     * define (never a shell function), and `adopts`: which of its migrations a database that ran the shell's earlier
     * version of a split migration already has (pack migration file name -> shell migration file name, both without
     * .sql), recorded as applied there without running; `platform_read`: those of its tables that are platform
     * libraries every workspace reads, as they were in the shell (no row-level security, no org_id, the tenant role may
     * only SELECT them). src/migrate.ts holds every other pack table to row-level security and every other object of
     * the database to unchanged.
     */
    schema: z.object({
      tables: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a table name")).min(1).max(200),
      platform_read: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a table name")).max(20).optional(),
      /** References from a shell table's column to one of its tables ("gateway_tokens.session_id": "agent_sessions"), the only change it may make to a shell table. */
      references: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}\.[a-z][a-z0-9_]{1,62}$/, "table.column"), z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a table name")).optional(),
      functions: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a function name")).max(50).optional(),
      adopts: z.record(z.string().regex(/^\d{4}_[a-z0-9_]+$/, "a pack migration (NNNN_name)"), z.string().regex(/^\d{4}_[a-z0-9_]+$/, "a shell migration (NNNN_name)")).optional(),
    }).strict().optional(),
  }).strict().optional(),
  /**
   * A host pack's engine settings (mold_v0-137; MOLD.md "MCP words as config"): `config`, the words and settings its own
   * code reads through src/pack-host.ts engineConfig() (its tools' titles and descriptions, its messages), checked when
   * the server starts against the schema its host entry gives (defineHost({ engine: { config } }), src/host.ts). Only a
   * host pack of this build may have one (scripts/gen-packs.mjs); plain JSON, at most 256 kB.
   */
  engine: z.object({
    $comment: z.string().max(2000).optional(),
    config: z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 256 * 1024, "at most 256 kB of JSON"),
  }).strict().optional(),
  pages: z.array(PageSchema).optional(),
  words: z.record(z.string().regex(/^[a-z][a-z_]{1,30}$/, "a lowercase shell word"), z.string().trim().min(1).max(40)).optional(),
  record_areas: z.array(RecordAreaSchema).max(100).optional(),
  job_kinds: z.array(JobKindJson).max(50).optional(),
  credentials: z.array(CredentialSchema).max(50).optional(),
  /** Credentials the platform's operators hold for the pack's runs (mold_v0-075; definePack operatorCredentials). */
  operator_credentials: z.array(OperatorCredentialSchema).max(20).optional(),
  schedules: z.array(ScheduleSchema).max(50).optional(),
  onboarding: z.array(OnboardingStepSchema).max(30).optional(),
  metrics: z.array(MetricSchema).max(100).optional(),
  charts: z.array(ChartSchema).max(100).optional(),
  tabs: z.array(TabSchema).max(40).optional(),
  repositories: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a repository name: lowercase letters, digits and _"), RepositorySchema).optional(),
  run_results: RunResultsSchema.optional(),
  mcp: McpSettingsSchema.optional(),
  /** The workspace store's retention and the viewer's secret paths (mold_v0-056; src/workspace-store-policy.ts). */
  workspace_store: WorkspaceStoreSchema.optional(),
  /**
   * The app's public landing page at / (mold_v0-091, mold_v0-122; src/landing.ts): the sections it picks from the shell's
   * library, in its order (`sections: [{type, ...}]`: hero, problem, concept, how_it_works, proof, where_you_work, faq,
   * cta), a footer and SEO, all plain text; an old-style block (hero, coverage, value_points ...) is converted. The app's
   * own profile.json `landing` comes over it; at most one pack of a build declares one (scripts/gen-packs.mjs).
   */
  landing: LandingSchema.optional(),
  /**
   * The customer guide's own pages (mold_v0-106; src/pack-guide.ts): inline markdown (the only form since mold_v0-124:
   * a pack is its pack.json alone) and their navigation groups, before the pages the console writes from these declarations. Markdown only,
   * checked by scripts/gen-packs.mjs (no raw HTML or images, safe links). A host pack's (mold_v0-139; it was its console
   * code, web/src/packs/<id>/guide.ts) is the whole guide: its pages, nothing generated, the MCP tools page grouped by
   * `tool_groups`.
   */
  guide: GuideSchema.optional(),
  /**
   * Staff docs (mold_v0-139; src/staff-docs.ts): `[{ path, title, markdown }]`, inline, beside the shell's docs/*.md on
   * /admin/docs and in the staff docs answers' corpus (a host pack's packs/<id>/docs files until then).
   */
  staff_docs: StaffDocsSchema.optional(),
  /**
   * The shell pages the customer console hides (mold_v0-130; src/console-pages.ts): `hide`, a list of page ids. Each leaves
   * the /app sidebar and redirects to /app; the app's profile.json `console` adds to it. The staff console is unchanged.
   */
  /**
   * The access-request form's own questions (mold_v0-102; src/access-request.ts): `fields`, each a key, a label and a type
   * (text, long_text, url, email, select, multi_select), optionally required, with options for a select. The public
   * /request-access form asks them after the shell's own (email, name, company, message), the answers are stored as
   * access_requests.answers, and the staff console's Requests page shows them under these labels. The packs' fields are
   * joined in pack order; the app's profile.json `access_request` replaces them.
   */
  access_request: AccessRequestSchema.optional(),
  /** Global settings on /admin (mold_v0-140; src/settings.ts): groups and pure-data settings (SettingsSchema above). */
  settings: SettingsSchema.optional(),
  /** The session engine's account stages in the words of the host pack that owns its tables (mold_v0-121; AccountStagesSchema above). */
  account_stages: AccountStagesSchema.optional(),
  /** A host pack's Setup page: its steps, the shell's steps in its words, its viewer note and workflow (mold_v0-140; SetupSchema above). */
  setup: SetupSchema.optional(),
  /** The admin MCP's shell tools' and skills' words (mold_v0-140; src/admin-mcp.ts): AdminMcpSchema above. */
  admin_mcp: AdminMcpSchema.optional(),
  console: z.object({
    $comment: z.string().max(2000).optional(),
    hide: z.array(z.enum(Object.keys(CONSOLE_PAGES) as [keyof typeof CONSOLE_PAGES, ...(keyof typeof CONSOLE_PAGES)[]])).max(20)
      .refine((h) => new Set(h).size === h.length, "each page once").optional(),
    /**
     * A host pack's sidebar entries among the shell's (mold_v0-140; they were its web/src/packs/<id>/nav.ts): /app's and
     * /admin's, each a list of placements applied in order. A new group: {"label", "before" or "after": a group's label,
     * "items"}; entries put into a group: {"into": its label, "before" or "after": an entry's url, "items"}. Each item
     * names one of the pack's own console pages (its routes.json), with its icon and an optional two-key shortcut.
     */
    nav: z.object({ $comment: z.string().max(2000).optional(), app: z.array(NavPlacementSchema("/app")).max(12).optional(), admin: z.array(NavPlacementSchema("/admin")).max(12).optional() }).strict().optional(),
    /** The shell's console components a host pack's routes serve (mold_v0-140; src/console-pages.ts CONSOLE_COMPONENTS): shown only then. */
    components: z.array(z.enum(CONSOLE_COMPONENTS)).max(CONSOLE_COMPONENTS.length).refine((c) => new Set(c).size === c.length, "each component once").optional(),
    /** Old console addresses kept working (mold_v0-140; they were its routes.json `redirects`): next.config redirects, in order. */
    redirects: z.array(z.object({
      source: z.string().regex(/^\/[A-Za-z0-9_\-/:*.]*$/, "a path on this site, starting with / (:name and :path* allowed)").max(200),
      destination: z.string().regex(/^\/[A-Za-z0-9_\-/:*.?=&]*$/, "a path on this site, starting with /").max(200),
      permanent: z.boolean().optional(),
    }).strict()).max(50).optional(),
  }).strict().optional(),
}).strict();
export type PackJson = z.input<typeof PackJsonSchema>;

/** What a pack.json declares, compiled: the definePack fields it stands for (defaults filled in). */
export type DeclaredPack = Pick<PackDefinition, "recordAreas" | "jobKinds" | "agentJobKinds" | "credentials" | "operatorCredentials" | "schedules" | "onboarding" | "metrics" | "charts" | "tabs" | "repositories" | "runResults" | "mcp" | "workspaceStore">;
export const DECLARED_KEYS = ["recordAreas", "jobKinds", "agentJobKinds", "credentials", "operatorCredentials", "schedules", "onboarding", "metrics", "charts", "tabs"] as const;

/** A zod issue path as a reader writes it: record_areas[0].fields[2].type. */
const where = (path: readonly PropertyKey[]) => path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");

export class PackJsonError extends Error {
  constructor(public problems: string[]) { super(problems.join("\n")); }
}

/** Check a pack.json against the schema; every problem as "path: message". */
export function checkPackJson(json: unknown): PackJson {
  const r = PackJsonSchema.safeParse(json);
  if (!r.success) throw new PackJsonError(r.error.issues.map((i) => `${where(i.path) || "pack.json"}: ${i.message}`));
  return json as PackJson;
}

/** Compile a pack.json's declarations into the definePack fields they stand for. Throws PackJsonError. */
export function compileDeclarations(json: unknown): DeclaredPack {
  checkPackJson(json);
  const p = PackJsonSchema.parse(json);
  const out: DeclaredPack = {};
  if (p.record_areas?.length) out.recordAreas = p.record_areas;
  const harness = (p.job_kinds ?? []).filter((k) => k.runner === "workspace-harness");
  const agent = (p.job_kinds ?? []).filter((k) => k.runner === "agent-workspace");
  if (harness.length) out.jobKinds = harness as DeclaredPack["jobKinds"];
  if (agent.length) out.agentJobKinds = agent as DeclaredPack["agentJobKinds"];
  if (p.credentials?.length) out.credentials = p.credentials;
  if (p.operator_credentials?.length) out.operatorCredentials = p.operator_credentials;
  if (p.schedules?.length) out.schedules = p.schedules;
  if (p.onboarding?.length) out.onboarding = p.onboarding;
  if (p.metrics?.length) out.metrics = p.metrics;
  if (p.charts?.length) out.charts = p.charts;
  if (p.tabs?.length) out.tabs = p.tabs;
  if (p.repositories && Object.keys(p.repositories).length) {
    // An upstream catalog may point at pack.json's own pin: resolved here, so the definition carries the pin itself.
    const problems: string[] = [];
    out.repositories = Object.fromEntries(Object.entries(p.repositories).map(([n, r]) => {
      if (r.kind !== "upstream_catalog" || r.upstream !== "pack.json#upstream") return [n, r];
      const pin = UpstreamSchema.safeParse(p.upstream);
      if (!pin.success) problems.push(`repositories.${n}.upstream: pack.json#upstream needs pack.json upstream {repo, commit}: ${pin.error.issues.map((i) => `${where(i.path) || "upstream"} ${i.message}`).join("; ")}`);
      return [n, { ...r, upstream: pin.success ? pin.data : r.upstream }];
    }));
    if (problems.length) throw new PackJsonError(problems);
  }
  if (p.run_results) out.runResults = p.run_results;
  if (p.mcp) out.mcp = p.mcp;
  if (p.workspace_store) out.workspaceStore = p.workspace_store;
  return out;
}

/**
 * A pack's definition: its pack.json's declarations, extended by its code entry when it has one. Lists are joined
 * (declarations first); a name both declare is refused by validatePack ("declared twice"), so code extends a
 * declarative pack and never silently replaces part of it. Tools, routes and migrations come from the code.
 */
export function mergePack(packId: string, declared: DeclaredPack | null | undefined, code: PackDefinition | null | undefined): PackDefinition {
  if (!code) return { id: packId, ...(declared ?? {}) };
  const out: PackDefinition = { ...code };
  for (const k of DECLARED_KEYS) {
    const d = (declared?.[k] ?? []) as unknown[], c = (code[k] ?? []) as unknown[];
    if (d.length || c.length) (out as unknown as Record<string, unknown[]>)[k] = [...d, ...c];
  }
  // Repositories join by name (one both declare is refused); the run-results mapping is declared once.
  if (declared?.repositories || code.repositories) {
    const both = Object.keys(declared?.repositories ?? {}).filter((k) => Object.hasOwn(code.repositories ?? {}, k));
    if (both.length) throw new PackJsonError([`repository ${both[0]} is declared in pack.json and in the code entry`]);
    out.repositories = { ...declared?.repositories, ...code.repositories };
  }
  if (declared?.runResults && code.runResults) throw new PackJsonError(["run_results is declared in pack.json and in the code entry"]);
  if (declared?.runResults) out.runResults = declared.runResults;
  // The MCP settings (mold_v0-060) are declared once too.
  if (declared?.mcp && code.mcp) throw new PackJsonError(["mcp is declared in pack.json and in the code entry"]);
  if (declared?.mcp) out.mcp = declared.mcp;
  // The workspace store's settings (mold_v0-056) too.
  if (declared?.workspaceStore && code.workspaceStore) throw new PackJsonError(["workspace_store is declared in pack.json and in the code entry"]);
  if (declared?.workspaceStore) out.workspaceStore = declared.workspaceStore;
  return out;
}

/** The JSON Schema of pack.json (packs/pack.schema.json): the same rules, minus the cross-checks only the build makes. */
export function packJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(PackJsonSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  // The landing block is checked by src/landing.ts landingProblems (either shape, counts and anchors); its documented shape is LandingDocSchema.
  const { $schema: _s, ...landing } = z.toJSONSchema(LandingDocSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  s.properties.landing = landing;
  return {
    $id: "pack.schema.json",
    title: "mold_v0 pack.json",
    description: "A mold_v0 pack (molds/mold_v0/MOLD.md, 'Pack and record-area contract'). Generated from src/pack-manifest.ts by npm run gen:pack-schema; do not edit.",
    ...s,
  };
}
