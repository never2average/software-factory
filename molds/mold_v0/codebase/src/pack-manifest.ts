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
 * (src/mcp-tools.ts): prefix, include, exclude, rename, describe, admin_only. No key is reserved now.
 * `repositories` (mold_v0-059: each a `kind` and its settings, read by src/data-repositories.ts; an area names one with
 * `repository`; "pack.json#upstream" is resolved here to the pack.json's own `upstream` pin). Declared and checked for
 * their shape today, read by the ticket that builds it: `run_results` (how a run's output becomes run_results rows:
 * mold_v0-061). `metrics` and `charts` are wired by mold_v0-063 (src/metrics.ts), `tabs` by mold_v0-058 (the console's
 * sidebar and tab pages); what they name across the build is checked by src/metric-spec.ts.
 * The agent-workspace runner's own settings (repository, commit, command, validation, write-back) are mold_v0-061's: a
 * job kind with runner "agent-workspace" is declared today with its limits, arguments and credentials only.
 */
import { WorkspaceStoreSchema } from "./workspace-store-policy.js";
import { AgentJobKindSchema, ChartSchema, CredentialSchema, JobKindSchema, McpSettingsSchema, MetricSchema, OnboardingStepSchema, RecordAreaSchema, RepositorySchema, RunResultsSchema, ScheduleSchema, TabSchema, UpstreamSchema, z, type PackDefinition } from "./pack-api.js";

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
   * the console's About page and footer, the install pages and the MCP server's instructions); an agent repository a job
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
  }).strict().optional(),
  pages: z.array(PageSchema).optional(),
  words: z.record(z.string().regex(/^[a-z][a-z_]{1,30}$/, "a lowercase shell word"), z.string().trim().min(1).max(40)).optional(),
  record_areas: z.array(RecordAreaSchema).max(100).optional(),
  job_kinds: z.array(JobKindJson).max(50).optional(),
  credentials: z.array(CredentialSchema).max(50).optional(),
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
}).strict();
export type PackJson = z.input<typeof PackJsonSchema>;

/** What a pack.json declares, compiled: the definePack fields it stands for (defaults filled in). */
export type DeclaredPack = Pick<PackDefinition, "recordAreas" | "jobKinds" | "agentJobKinds" | "credentials" | "schedules" | "onboarding" | "metrics" | "charts" | "tabs" | "repositories" | "runResults" | "mcp" | "workspaceStore">;
export const DECLARED_KEYS = ["recordAreas", "jobKinds", "agentJobKinds", "credentials", "schedules", "onboarding", "metrics", "charts", "tabs"] as const;

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
  return {
    $id: "pack.schema.json",
    title: "mold_v0 pack.json",
    description: "A mold_v0 pack (molds/mold_v0/MOLD.md, 'Pack and record-area contract'). Generated from src/pack-manifest.ts by npm run gen:pack-schema; do not edit.",
    ...s,
  };
}
