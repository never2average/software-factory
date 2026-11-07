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
 * Budgets, turns and every other limit are the platform settings, never a profile's.
 */
import { z } from "zod";
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

export const ProfileUploadSchema = z.object({
  id: z.string().regex(UPLOAD_ID, "an upload's id"),
  path: z.string().max(400).regex(PROFILE_FILE_PATH, "a path inside the session's working directory (relative, no ..)"),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Made executable in the session's scratch (a runtime binary, a script). */
  executable: z.boolean(),
}).strict();
export type ProfileUpload = z.output<typeof ProfileUploadSchema>;

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
  /** 5. Its governance policy. */
  governance: GovernanceSchema.nullable().optional(),
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
  $comment: z.string().max(2000).optional(),
}).strict();
export type PackAgentProfile = z.output<typeof PackAgentProfileSchema>;

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
 * field's value (an empty one: nothing). Filled on the server from the record as the person reads it.
 */
export function fillTemplate(t: string, r: { key: string; title: string | null; data: Record<string, unknown> }): string {
  return t.replace(TEMPLATE_NAME, (_m, n: string) => asWords(n === "key" ? r.key : n === "title" ? (r.title ?? r.key) : r.data[n])).slice(0, 20_000);
}
/** The first message an on_start template makes of the person's words: {{message}} replaced, else they follow it. */
export function applyOnStart(template: string | null | undefined, message: string): string {
  const t = template?.trim();
  if (!t) return message;
  return /\{\{\s*message\s*\}\}/.test(t) ? t.replace(/\{\{\s*message\s*\}\}/g, () => message) : `${t}\n\n${message}`;
}
