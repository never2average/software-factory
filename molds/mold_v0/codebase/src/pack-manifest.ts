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
import { ANSWER_STYLES, MEMORY_SCOPES, MEMORY_WORDS, type MemoryWord } from "./account-context-words.js";
import { JOURNEY_TABLES, JOURNEY_WEB_WORDS, JOURNEY_WORDS, MAX_STAGES, TIP_TABLES, TIP_WEB_WORDS, TIP_WORDS } from "./journeys-words.js";
import { ACCESS_FIELD_TYPES, MAX_ACCESS_FIELDS } from "./access-request.js";
import { LandingDocSchema, LandingSchema } from "./landing.js";
import { CLIENT_SKILL_WORDS, MAX_TEXT as MAX_SKILL_TEXT, type ClientSkillWord } from "./client-skill-config.js";
import { GuideSchema } from "./pack-guide.js";
import { StaffDocsSchema } from "./staff-docs.js";
import { SHELL_TEXTS, SHELL_TEXT_IDS } from "./shell-texts.js";
import { WorkspaceStoreSchema } from "./workspace-store-policy.js";
import { AgentJobKindSchema, ChartSchema, CredentialSchema, JobKindSchema, OAuthProviderSchema, OperatorCredentialSchema, McpSettingsSchema, MetricSchema, OnboardingStepSchema, RecordAreaSchema, RepositorySchema, RunResultsSchema, ScheduleSchema, TabSchema, TAB_ICONS, UpstreamSchema, z, type PackDefinition } from "./pack-api.js";

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

/**
 * The account context and memory component (mold_v0-142; src/account-context.ts, src/host.ts MemoryConfig): on in a
 * build where one pack declares it. `scopes` (company, user, product: whose memory there is, each a page of
 * /app/context), `tools` (the names of its save and search MCP tools; none without), `tool_words` (their title,
 * description, status lines and argument descriptions), `tool_meta` (the _meta both carry: a widget that shows them),
 * `words` (MEMORY_WORDS: what it shows and tells the AI client), `answer_styles` (what the AI client is told for each),
 * `pages` (each page's title, and old page addresses under /app/context kept working: `aliases`).
 */
const memoryTool = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "an MCP tool's name: lowercase letters, digits and _");
const MemoryToolWordsSchema = z.object({
  title: plain(80).optional(), description: z.string().trim().min(1).max(2000).optional(),
  status: z.tuple([plain(64), plain(64)]).optional(),
  args: z.partialRecord(z.enum(["body", "kind", "scope", "product", "query", "limit"]), z.string().trim().min(1).max(600)).optional(),
}).strict();
const SECTION = z.enum(["company", "users", "products"]);
const MemorySchema = z.object({
  $comment: z.string().max(2000).optional(),
  scopes: z.array(z.enum(MEMORY_SCOPES)).min(1).max(MEMORY_SCOPES.length).refine((s) => new Set(s).size === s.length, "each scope once"),
  tools: z.object({ save: memoryTool, search: memoryTool }).strict().refine((t) => t.save !== t.search, "two names").optional(),
  tool_words: z.object({ save: MemoryToolWordsSchema.optional(), search: MemoryToolWordsSchema.optional() }).strict().optional(),
  tool_meta: z.record(z.string(), z.unknown()).refine((m) => JSON.stringify(m).length <= 8 * 1024, "at most 8 kB of JSON").optional(),
  words: z.partialRecord(z.enum(Object.keys(MEMORY_WORDS) as [MemoryWord, ...MemoryWord[]]), z.string().trim().min(1).max(600)
    .regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text on one line")).optional(),
  answer_styles: z.object(Object.fromEntries(ANSWER_STYLES.map((k) => [k, plain(400).optional()])) as Record<(typeof ANSWER_STYLES)[number], z.ZodOptional<z.ZodString>>).strict().optional(),
  pages: z.object({
    titles: z.object({ company: plain(60).optional(), users: plain(60).optional(), products: plain(60).optional() }).strict().optional(),
    aliases: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "a page name under /app/context"), SECTION).optional(),
  }).strict().optional(),
}).strict();

/**
 * The journeys component (mold_v0-143; src/journeys.ts, src/host.ts JourneysConfig): on in a build where one pack
 * declares it. `templates` (the built-in journeys, seeded once each: their stages' tools must be the product's, which
 * scripts/gen-packs.mjs cannot see, so src/journeys.ts checks them as an admin's edit is), `seeded_before_ledger`,
 * `launch` (the tools and Setup workflow groups that start work), `words` (JOURNEY_WORDS and JOURNEY_WEB_WORDS), `labels`
 * (its tables' names on the Storage page).
 */
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "an MCP tool's name: lowercase letters, digits and _");
const journeyId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "a slug: lowercase letters, digits and -, at most 48");
const JourneyStageSchema = z.object({
  id: journeyId, title: plain(120), why: z.string().trim().max(500), prompt: plain(600), tools: z.array(toolName).max(20), expect: plain(500),
  manual: z.boolean().optional(),
  link: z.object({ href: z.string().regex(/^\/app(\/[a-z0-9/-]*)?$/, "an /app page"), label: plain(60) }).strict().optional(),
}).strict().refine((st) => st.manual === true || st.tools.length > 0, "a stage with no tool is marked by hand: manual true");
const JourneyTemplateSchema = z.object({
  id: journeyId, name: plain(80), outcome: plain(300), who: z.string().trim().max(200), time: z.string().trim().max(80),
  example: z.object({ title: z.string().trim().max(120), result: z.string().trim().max(600) }).strict(),
  stages: z.array(JourneyStageSchema).min(1).max(MAX_STAGES).refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, "each stage id once"),
}).strict();
const wordText = z.string().trim().min(1).max(600).regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*$/, "plain text on one line");
const JourneysSchema = z.object({
  $comment: z.string().max(2000).optional(),
  templates: z.array(JourneyTemplateSchema).max(50).refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, "each template id once").optional(),
  seeded_before_ledger: z.array(journeyId).max(50).optional(),
  launch: z.object({ tools: z.array(toolName).max(20).optional(), groups: z.array(stepId).max(20).optional() }).strict().optional(),
  words: z.partialRecord(z.enum([...Object.keys(JOURNEY_WORDS), ...Object.keys(JOURNEY_WEB_WORDS)] as [string, ...string[]]), wordText).optional(),
  labels: z.partialRecord(z.enum(JOURNEY_TABLES), plain(60)).optional(),
}).strict();
/**
 * The in-chat tips component (mold_v0-143; src/tips.ts, src/host.ts TipsConfig): on in a build where one pack declares
 * it. `always_after` (tools whose answer always carries the waiting tip), `interval_hours`, `recipes` (the sequences to
 * build in the workflow tool, with the steps it sends here), `words` (TIP_WORDS and TIP_WEB_WORDS), `labels`.
 */
const TipsSchema = z.object({
  $comment: z.string().max(2000).optional(),
  always_after: z.array(toolName).max(20).optional(),
  interval_hours: z.number().min(0).max(24 * 30).optional(),
  recipes: z.array(z.object({
    id: journeyId, name: plain(80), goal: plain(200), trigger: plain(300),
    steps: z.array(z.object({
      step: journeyId, when: plain(300), channels: z.array(z.enum(["chat", "app", "email", "slack"])).min(1).max(4),
      message: plain(280), prompt: plain(300).optional(), link: z.string().regex(/^(https:\/\/|\/app)\S{0,490}$/, "https:// or an /app path").optional(),
    }).strict()).min(1).max(10),
  }).strict()).max(30).optional(),
  words: z.partialRecord(z.enum([...Object.keys(TIP_WORDS), ...Object.keys(TIP_WEB_WORDS)] as [string, ...string[]]), wordText).optional(),
  labels: z.partialRecord(z.enum(TIP_TABLES), plain(60)).optional(),
}).strict();

/**
 * The shell's texts in the product's words (mold_v0-141; src/shell-texts.ts): by id, each one sentence or label on one
 * line, its word placeholders the shell's (scripts/gen-packs.mjs checks those, and that one pack writes each text).
 */
const TextsSchema = z.object({
  $comment: z.string().max(2000).optional(),
  ...Object.fromEntries(SHELL_TEXT_IDS.map((t) => [t, plain(400).describe(`${SHELL_TEXTS[t].where}. The shell's own: ${SHELL_TEXTS[t].text}`).optional()])),
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
/** An earlier migration file's checksum (host.schema.split). */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "the earlier file's sha256 (64 hex)");
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
      /**
       * Its migrations rewritten because tables they made became the shell's (mold_v0-142: the account context and
       * memory tables, src/account-context.ts; mold_v0-143: the journeys and tips tables): each file name -> the sha256
       * of the file as it was, or of each earlier version (a list), which a database that ran it keeps and
       * src/migrate.ts accepts for that file only (the shell's own migration adopts the tables there).
       */
      split: z.record(z.string().regex(/^\d{4}_[a-z0-9_]+$/, "a pack migration (NNNN_name)"), z.union([sha256, z.array(sha256).min(1).max(20)
        .refine((xs) => new Set(xs).size === xs.length, "each checksum once")])).optional(),
      /** Each table's label in the product's words (mold_v0-141): the Storage page's name for it (src/host-tables.ts hostTableLabel); else its name, capitalised. */
      labels: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a table name"), plain(60)).optional(),
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
    config: z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 256 * 1024, "at most 256 kB of JSON").optional(),
    /**
     * A config pack's engine (mold_v0-145; MOLD.md "Engine packs"): the id of the engine pack (a host pack of this build,
     * code and migrations only) this pack.json configures. Such a pack is a pack.json alone: scripts/gen-packs.mjs folds
     * it into the engine, its `config` the engine's engine.config, `profile` its host.profile, `labels` its
     * host.schema.labels, every other declaration the engine's, its name, version and description the build's pack's.
     */
    pack: id.optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
    labels: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "a table name"), plain(60)).optional(),
    /** The pack id (or ids) a database recorded the engine's migrations under before (the product's own host pack, whose files they were): read as the engine's (src/migrate.ts). */
    migrations_recorded_as: z.union([id, z.array(id).min(1).max(5)]).optional(),
  }).strict().superRefine((e, ctx) => {
    if (e.pack === undefined) {
      if (e.config === undefined) ctx.addIssue({ code: "custom", path: ["config"], message: "a host pack's engine.config (or engine.pack: the engine a config pack configures)" });
      for (const k of ["profile", "labels", "migrations_recorded_as"] as const)
        if (e[k] !== undefined) ctx.addIssue({ code: "custom", path: [k], message: "only a config pack (engine.pack) says it" });
    }
  }).optional(),
  pages: z.array(PageSchema).optional(),
  words: z.record(z.string().regex(/^[a-z][a-z_]{1,30}$/, "a lowercase shell word"), z.string().trim().min(1).max(40)).optional(),
  record_areas: z.array(RecordAreaSchema).max(100).optional(),
  job_kinds: z.array(JobKindJson).max(50).optional(),
  credentials: z.array(CredentialSchema).max(50).optional(),
  /** OAuth providers the pack's credential fields connect to (mold_v0-014; definePack oauthProviders). */
  oauth_providers: z.array(OAuthProviderSchema).max(20).optional(),
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
  /** The shell's texts in the product's words (mold_v0-141; TextsSchema above). */
  texts: TextsSchema.optional(),
  /** A host pack's Setup page: its steps, the shell's steps in its words, its viewer note and workflow (mold_v0-140; SetupSchema above). */
  setup: SetupSchema.optional(),
  /** The account context and memory component, turned on (mold_v0-142; src/account-context.ts): MemorySchema above. */
  memory: MemorySchema.optional(),
  /** The journeys component, turned on (mold_v0-143; src/journeys.ts): JourneysSchema above. */
  journeys: JourneysSchema.optional(),
  /** The in-chat tips component, turned on (mold_v0-143; src/tips.ts): TipsSchema above. */
  tips: TipsSchema.optional(),
  /** The admin MCP's shell tools' and skills' words (mold_v0-140; src/admin-mcp.ts): AdminMcpSchema above. */
  admin_mcp: AdminMcpSchema.optional(),
  /**
   * The client skill's own words and files (mold_v0-144; src/client-skill-config.ts, which scripts/gen-packs.mjs runs for
   * the rules this shape cannot say: name, one-line texts, paths, sizes). Absent, the skill is generated from the profile.
   */
  client_skill: z.object({
    $comment: z.string().max(2000).optional(),
    name: z.string().max(64).optional(),
    description: z.string().max(1024).optional(),
    body: z.string().max(MAX_SKILL_TEXT).optional(),
    files: z.record(z.string().max(160), z.string().max(MAX_SKILL_TEXT)).optional(),
    words: z.partialRecord(z.enum(Object.keys(CLIENT_SKILL_WORDS) as [ClientSkillWord, ...ClientSkillWord[]]), z.string().max(600)).optional(),
  }).strict().optional(),
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
export type DeclaredPack = Pick<PackDefinition, "recordAreas" | "jobKinds" | "agentJobKinds" | "credentials" | "oauthProviders" | "operatorCredentials" | "schedules" | "onboarding" | "metrics" | "charts" | "tabs" | "repositories" | "runResults" | "mcp" | "workspaceStore">;
export const DECLARED_KEYS = ["recordAreas", "jobKinds", "agentJobKinds", "credentials", "oauthProviders", "operatorCredentials", "schedules", "onboarding", "metrics", "charts", "tabs"] as const;

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
  if (p.oauth_providers?.length) out.oauthProviders = p.oauth_providers;
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
