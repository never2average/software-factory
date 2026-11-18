/**
 * Workspace agent profiles (mold_v0-261, redesigned by mold_v0-267; molds/mold_v0/docs/agent-harness.md "Agent
 * profiles"): what a profile is, as staff edit it in Admin › Agent profiles (src/agent-profiles.ts keeps it, versioned
 * and audited) and as a pack declares its defaults (pack.json `agent_profiles`), and the pure helpers both sides use. No
 * database and no settings here: pack-api.ts and pack-manifest.ts import it.
 *
 * A profile is exactly five things, each optional (unset: the platform setting in force, src/settings.ts group "agent"):
 *   1. harness     which agent CLI runs it (a flavour pinned in the run tools' catalogue; today Claude Code)
 *   2. (no model field: the model is the primary inference provider's, item 3)
 *   3. keys        the key vault entries injected into its sessions (a workspace's credential "<pack>/<field>", or a
 *                  platform key by provider and label, in an environment variable), delivered and redacted as a run's;
 *                  and `inference`, the primary inference provider: its model (a priced one) and its key (a key vault
 *                  entry of that provider, the one the gateway uses for the session's requests)
 *   4. uploads     files and folders written into the session's workspace (runtime binaries too: kept in the object
 *                  store, made executable in its scratch), up to the platform's size limit (AGENT_UPLOAD_MAX_MB)
 *   5. governance  its governance policy (src/agent-governance.ts: web tools, egress approvals, a tool allowlist,
 *                  exceptions, retention), ported from the reference product's
 * Budgets, turns and every other limit are the platform settings, never a profile's. Beside the five, a label: its `purpose`
 * (mold_v0-295, src/agent-purpose.ts), the icon the console draws beside its agent's name; it sets nothing a session runs with.
 */
import { z } from "zod";
import { AGENT_PURPOSES } from "./agent-purpose.js";
import { ConnectionEnvListSchema } from "./connection-env-config.js";
import { ALLOW_ALL_DOMAINS, GOVERNANCE_LIMITS, normalizeDomains, webPolicyProblems, type Governance } from "./agent-governance.js";

/** The profile every session uses unless another is chosen: the platform settings, as they are. Never archived. */
export const DEFAULT_PROFILE = "default";
/** A profile's id: lowercase words joined by -. */
export const PROFILE_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** A workspace credential a profile names (mold_v0-262): its pack's id and its field's name. */
export const PROFILE_CREDENTIAL = /^[a-z][a-z0-9_]{1,30}\/[a-z][a-z0-9_]{1,62}$/;
/** A key vault provider's slug and a key's label (src/keyvault.ts). */
export const VAULT_PROVIDER = /^[a-z][a-z0-9_-]{1,40}$/;
export const VAULT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,79}$/;
/** An environment variable a platform key is delivered in. */
export const KEY_ENV = /^[A-Z][A-Z0-9_]{1,63}$/;
/** An upload's id (src/agent-profiles.ts makes them). */
export const UPLOAD_ID = /^upl_[A-Za-z0-9]{20,40}$/;
export const PROFILE_LIMITS = { name: 80, description: 500, keys: 30, uploads: 2000 } as const;

/** A tool name as the app's MCP server lists it. */
const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/, "a tool name (letters, digits, _ . -)");
/** A model id as a provider names it. */
const modelId = z.string().regex(/^[A-Za-z0-9@._/:-]{1,100}$/, "a model id (letters, digits, @ . _ / : -)");
/**
 * A path inside the session's working directory (relative, no `..`, no leading slash; `.claude/skills/<name>/SKILL.md`
 * is a skill): an uploaded file's place, a folder's files keeping theirs.
 */
export const PROFILE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+){0,15}$/;

// ---------------------------------------------------------------- 3. keys

export const ProfileKeySchema = z.discriminatedUnion("kind", [
  /** A workspace's own credential (mold_v0-262): delivered only to a session a workspace owner starts. */
  z.object({ kind: z.literal("workspace"), name: z.string().regex(PROFILE_CREDENTIAL, "a workspace credential, <pack>/<field>") }).strict(),
  /** A platform key from the key vault, in an environment variable of the session's. */
  z.object({
    kind: z.literal("platform"),
    provider: z.string().regex(VAULT_PROVIDER, "a key vault provider"),
    label: z.string().regex(VAULT_LABEL, "a key's label"),
    env: z.string().regex(KEY_ENV, "an environment variable (A-Z, digits, _)"),
  }).strict(),
], { error: () => "a key: {kind: workspace, name} or {kind: platform, provider, label, env}" });
export type ProfileKey = z.output<typeof ProfileKeySchema>;
export const keyName = (k: ProfileKey) => (k.kind === "workspace" ? k.name : `${k.provider}/${k.label}`);

/** The primary inference provider: its model (priced) and its key (unset: the provider's key the gateway picks). */
export const InferenceSchema = z.object({
  provider: z.string().regex(VAULT_PROVIDER, "a provider"),
  model: modelId,
  key: z.string().regex(VAULT_LABEL, "a key's label").nullable().optional(),
}).strict();

// ---------------------------------------------------------------- 4. uploads
// One storage layer for every file (agent_profile_uploads, src/agent-profiles.ts): a session freezes a flat list of
// these entries and nothing downstream reads anything else. Workspace recipes (mold_v0-271) plug in by expanding a
// named recipe version into the same entries when a session starts (docs/agent-harness.md "Agent profiles").

export const ProfileUploadSchema = z.object({
  id: z.string().regex(UPLOAD_ID, "an upload's id"),
  path: z.string().max(400).regex(PROFILE_FILE_PATH, "a path inside the session's working directory (relative, no ..)"),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Made executable in the session's scratch (a runtime binary, a script). */
  executable: z.boolean(),
}).strict();
export type ProfileUpload = z.output<typeof ProfileUploadSchema>;

/**
 * 4. A workspace recipe the profile's sessions receive beside its own uploads (mold_v0-271, flag workspace_recipes;
 * src/recipes.ts): its id and version (null: its latest when a session starts). A session freezes the version.
 */
export const RECIPE_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const ProfileRecipeSchema = z.object({
  id: z.string().regex(RECIPE_ID, "a recipe's id (lowercase letters, digits and -)"),
  /** mold_v0-303: absent reads as null (its latest), as a pack's profile names one. */
  version: z.number().int().min(1).nullable().default(null),
}).strict();
export type ProfileRecipe = z.output<typeof ProfileRecipeSchema>;

// ---------------------------------------------------------------- 5. governance

const hostEntry = z.string().max(300);
export const WebPolicySchema = z.object({
  enabled: z.boolean(),
  web_search_enabled: z.boolean(),
  web_fetch_enabled: z.boolean(),
  web_fetch_allowed_domains: z.array(hostEntry).max(GOVERNANCE_LIMITS.domains, `at most ${GOVERNANCE_LIMITS.domains} domains`),
  max_calls: z.number().int().min(0).max(GOVERNANCE_LIMITS.max_calls),
}).strict();
export const ExceptionSchema = z.object({
  domain: z.string().max(260),
  reason: z.string().trim().min(1, "say why (it is kept with the exception)").max(GOVERNANCE_LIMITS.reason),
  expires_at: z.string().refine((s) => Number.isFinite(Date.parse(s)), "a date and time"),
  /** Who saved it (the server writes it; anything sent is replaced). */
  approved_by: z.string().max(200).optional(),
}).strict();
export const GovernanceSchema = z.object({
  web: WebPolicySchema.optional(),
  egress_approvals: z.boolean().optional(),
  tools: z.object({
    allowed: z.array(toolName).min(1, "an allowlist names at least one tool").max(GOVERNANCE_LIMITS.tools),
    max_calls: z.number().int().min(1, "a tool allowlist needs a call limit of at least 1").max(GOVERNANCE_LIMITS.tool_calls),
  }).strict().nullable().optional(),
  exceptions: z.array(ExceptionSchema).max(GOVERNANCE_LIMITS.exceptions).optional(),
  retention_days: z.number().int().min(1).max(GOVERNANCE_LIMITS.retention_days).nullable().optional(),
}).strict();

// ---------------------------------------------------------------- the profile

/** What a profile sets (each unset: the platform setting). The stored config and pack.json's body share it. */
export const ProfileConfigSchema = z.object({
  /** 1. Which agent CLI runs it (a pinned flavour, src/agent-harness-config.ts). */
  harness: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).nullable().optional(),
  /** 3. The primary inference provider: model and key. */
  inference: InferenceSchema.nullable().optional(),
  /** 3. The keys injected into its sessions. */
  keys: z.array(ProfileKeySchema).max(PROFILE_LIMITS.keys, `at most ${PROFILE_LIMITS.keys} keys`).optional(),
  /** 4. What is uploaded into its sessions' workspace. */
  uploads: z.array(ProfileUploadSchema).max(PROFILE_LIMITS.uploads, `at most ${PROFILE_LIMITS.uploads} files`).optional(),
  /** 4. mold_v0-271: workspace recipes its sessions receive with the uploads (the profile's own file wins a path both name). */
  recipes: z.array(ProfileRecipeSchema).max(10, "at most 10 recipes").optional(),
  /** 5. Its governance policy. */
  governance: GovernanceSchema.nullable().optional(),
  /** mold_v0-295: what its agent is for (src/agent-purpose.ts), a label the console draws as an icon beside its name; no setting. */
  purpose: z.enum(AGENT_PURPOSES).optional(),
}).strict();
export type ProfileConfig = z.output<typeof ProfileConfigSchema>;
export const PROFILE_KEYS = ["harness", "inference", "keys", "uploads", "governance"] as const;

/**
 * A profile a pack declares (pack.json `agent_profiles`): its id, name and description, and what it sets. A pack names
 * no platform key and uploads nothing (staff do, in the console): its keys are workspace credentials only.
 */
export const PackAgentProfileSchema = z.object({
  id: z.string().regex(PROFILE_ID, "an id: lowercase letters, digits and -, 2 to 40, starting with a letter").refine((x) => x !== DEFAULT_PROFILE, "default is the platform's own profile"),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  harness: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).optional(),
  inference: InferenceSchema.omit({ key: true }).optional(),
  keys: z.array(z.object({ kind: z.literal("workspace"), name: z.string().regex(PROFILE_CREDENTIAL, "a workspace credential, <pack>/<field>") }).strict()).max(PROFILE_LIMITS.keys).optional(),
  governance: GovernanceSchema.omit({ exceptions: true }).optional(),
  purpose: z.enum(AGENT_PURPOSES).optional(),
  /**
   * 4. mold_v0-303: workspace recipes its sessions get in their working directory (a pack's own `recipes`, or one staff
   * keep), each its id and optionally a version (absent: its latest when a session starts).
   */
  recipes: z.array(ProfileRecipeSchema).max(10, "at most 10 recipes").optional(),
  /**
   * mold_v0-312: the workspace's own connection records its sessions receive as environment variables of their sandbox
   * (src/connection-env-config.ts; checked against this pack's areas by validatePack), never in a prompt or a message.
   */
  connection_env: ConnectionEnvListSchema.optional(),
  $comment: z.string().max(2000).optional(),
}).strict();
export type PackAgentProfile = z.output<typeof PackAgentProfileSchema>;

// ---------------------------------------------------------------- recipes a pack declares (mold_v0-303)

/** A file's place in a recipe a pack declares: as a version's (src/recipes.ts RECIPE_FILE_PATH), never under .recipe-proposal. */
export const PACK_RECIPE_PATH = /^(?!\/)(?!\.recipe-proposal(?:\/|$))(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+){0,15}$/;
export const PACK_RECIPE_LIMITS = { files: 200, file_bytes: 512 * 1024, bytes: 4 * 1024 * 1024 } as const;
/**
 * One file of a recipe a pack declares (mold_v0-303): its path in the session's working directory and its text, inline
 * in pack.json: `content` (a SKILL.md, a script, any text) or `json` (a JSON Schema, a config: written as indented JSON).
 * `executable` makes it a program in the session's scratch (a script). Exactly one of content or json.
 */
export const PackRecipeFileSchema = z.object({
  path: z.string().max(400).regex(PACK_RECIPE_PATH, "a path inside the session's working directory (relative, no . or .. segment, not under .recipe-proposal)"),
  content: z.string().max(PACK_RECIPE_LIMITS.file_bytes).optional(),
  json: z.unknown().optional(),
  executable: z.boolean().optional(),
}).strict().refine((f) => (f.content !== undefined) !== (f.json !== undefined), "a file gives its text as content (a string) or json (a value), exactly one");
/**
 * A workspace recipe a pack declares (pack.json `recipes`, mold_v0-303; src/recipes.ts syncDeclaredRecipes): an id, a
 * name, a description and its files. Brought in as staff's are kept: version 1 the first time, the next version when the
 * pack's files or words change, never over a change staff made to it (theirs stands).
 */
export const PackRecipeSchema = z.object({
  id: z.string().regex(RECIPE_ID, "an id: lowercase letters, digits and -, 2 to 40, starting with a letter"),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  files: z.array(PackRecipeFileSchema).min(1, "a recipe holds at least one file").max(PACK_RECIPE_LIMITS.files),
  $comment: z.string().max(2000).optional(),
}).strict();
export type PackRecipe = z.output<typeof PackRecipeSchema>;
/** A declared file's bytes: its content as UTF-8, or its json indented (with a final newline). */
export const packRecipeText = (f: { content?: string; json?: unknown }): string => (f.content !== undefined ? f.content : `${JSON.stringify(f.json, null, 2)}\n`);
/** What a declared recipe says wrongly that its shape cannot: a path twice, a file and a folder, too many bytes. */
export function packRecipeProblems(r: PackRecipe): string[] {
  const out: string[] = [];
  const paths = r.files.map((f) => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) out.push("files: two files have one path");
  const folder = paths.find((p) => paths.some((q) => q !== p && q.startsWith(`${p}/`)));
  if (folder) out.push(`files: ${folder} is a file and a folder`);
  let total = 0;
  for (const f of r.files) {
    if (f.json !== undefined && (() => { try { return JSON.stringify(f.json) === undefined; } catch { return true; } })()) { out.push(`files ${f.path}: json is not a JSON value`); continue; }
    const n = Buffer.byteLength(packRecipeText(f));
    if (n > PACK_RECIPE_LIMITS.file_bytes) out.push(`files ${f.path}: ${n} bytes, at most ${PACK_RECIPE_LIMITS.file_bytes} inline`);
    total += n;
  }
  if (total > PACK_RECIPE_LIMITS.bytes) out.push(`files: ${total} bytes in all, at most ${PACK_RECIPE_LIMITS.bytes} inline (staff upload larger files)`);
  return out;
}

/** A governance policy as stored: its web policy's domains normalized (each read as its host, once, sorted). */
export function normalizeGovernance(g: Governance | null | undefined): { governance: Governance | null; problems: string[] } {
  if (!g) return { governance: null, problems: [] };
  const problems: string[] = [];
  const out: Governance = { ...g };
  if (g.web) {
    const n = normalizeDomains(g.web.web_fetch_allowed_domains);
    problems.push(...n.problems.map((p) => `governance.web: ${p}`));
    out.web = { ...g.web, web_fetch_allowed_domains: n.domains };
    problems.push(...webPolicyProblems(out.web).map((p) => `governance.${p}`));
  }
  if (g.tools) {
    if (new Set(g.tools.allowed).size !== g.tools.allowed.length) problems.push("governance.tools: a tool is listed twice");
    if (g.tools.allowed.some((t) => t.includes("*"))) problems.push("governance.tools: name each tool (no wildcard)");
  }
  const seen = new Set<string>();
  out.exceptions = (g.exceptions ?? []).map((e) => {
    const n = normalizeDomains([e.domain]);
    const d = n.domains[0] ?? e.domain;
    if (n.problems.length || d === ALLOW_ALL_DOMAINS) problems.push(`governance.exceptions: ${e.domain.slice(0, 100)} is not a host an exception can name (a host name, or *.domain)`);
    if (seen.has(d)) problems.push(`governance.exceptions: ${d} has two exceptions`);
    seen.add(d);
    return { ...e, domain: d };
  });
  if (!out.exceptions.length) delete out.exceptions;
  if (out.exceptions?.length && !out.web?.web_fetch_enabled) problems.push("governance.exceptions: an exception allows a host for WebFetch: turn WebFetch on");
  return { governance: out, problems };
}

/** What a config says wrongly that its shape cannot: a key twice, an environment variable twice, two uploads at one path. */
export function configProblems(c: ProfileConfig): string[] {
  const out: string[] = [];
  const names = (c.keys ?? []).map(keyName);
  if (new Set(names).size !== names.length) out.push("keys: a key is listed twice");
  const envs = (c.keys ?? []).flatMap((k) => (k.kind === "platform" ? [k.env] : []));
  if (new Set(envs).size !== envs.length) out.push("keys: two keys go into one environment variable");
  const paths = (c.uploads ?? []).map((f) => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) out.push("uploads: two files have one path");
  for (const p of paths) if (paths.some((q) => q !== p && q.startsWith(`${p}/`))) { out.push(`uploads: ${p} is a file and a folder`); break; }
  const recipes = (c.recipes ?? []).map((r) => r.id);
  if (new Set(recipes).size !== recipes.length) out.push("recipes: a recipe is listed twice");
  out.push(...normalizeGovernance(c.governance).problems);
  return out;
}

// ---------------------------------------------------------------- a first message from a record (start_agent actions)

/** The names a template fills: {{key}}, {{title}}, {{<a field>}}. */
export const TEMPLATE_NAME = /\{\{\s*([a-z$][a-z0-9_]{0,62})\s*\}\}/g;
export const templateNames = (t: string): string[] => [...new Set([...t.matchAll(TEMPLATE_NAME)].map((m) => m[1]!))];
/** A value as words in a message: a list joined, an object as JSON, nothing as empty. */
const asWords = (v: unknown): string => (v == null ? "" : Array.isArray(v) ? v.map(asWords).filter(Boolean).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));
/**
 * A start_agent action's first message with the record filled in: {{key}} its key, {{title}} its title, {{<field>}} a
 * field's value (an empty one: nothing). Filled on the server from the record as the person reads it. mold_v0-322: a
 * line whose every name is empty on the record is left out ("Network: {{network}}." with no network says nothing,
 * never "Network: ."); a line with one value or none to fill stays.
 */
export function fillTemplate(t: string, r: { key: string; title: string | null; data: Record<string, unknown> }): string {
  const value = (n: string) => asWords(n === "key" ? r.key : n === "title" ? (r.title ?? r.key) : r.data[n]);
  const lines = t.split("\n").flatMap((line) => {
    const names = [...line.matchAll(TEMPLATE_NAME)].map((m) => m[1]!);
    if (names.length && names.every((n) => !value(n).trim())) return [];
    return [line.replace(TEMPLATE_NAME, (_m, n: string) => value(n))];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20_000);
}
/** The first message an on_start template makes of the person's words: {{message}} replaced, else they follow it. */
export function applyOnStart(template: string | null | undefined, message: string): string {
  const t = template?.trim();
  if (!t) return message;
  return /\{\{\s*message\s*\}\}/.test(t) ? t.replace(/\{\{\s*message\s*\}\}/g, () => message) : `${t}\n\n${message}`;
}
