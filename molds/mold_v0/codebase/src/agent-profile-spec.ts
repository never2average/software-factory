/**
 * Workspace agent profiles (mold_v0-261; molds/mold_v0/docs/agent-harness.md "Agent profiles"): what a profile is, as
 * staff edit it in Admin › Agent profiles (src/agent-profiles.ts keeps them, versioned and audited) and as a pack declares
 * its defaults (pack.json `agent_profiles`), and the pure helpers both sides use: the shape, its limits, a first message's
 * template filled from a record. No database and no settings here: pack-api.ts and pack-manifest.ts import it.
 *
 * A profile's every setting may be left unset (null, or absent in pack.json): a session then takes the platform setting
 * in force (src/settings.ts, group "agent"), as every session did before profiles. The Default profile leaves them all
 * unset, so a session started without a profile runs exactly as before.
 */
import { z } from "zod";

/** The profile every session uses unless another is chosen: the platform settings, as they are. Never archived. */
export const DEFAULT_PROFILE = "default";
/** A profile's id: lowercase words joined by -, as its address (/admin/agent-profiles/<id>). */
export const PROFILE_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** The roles that may start a session (a viewer is read only in the platform). */
export const PROFILE_ROLES = ["member", "billing", "owner"] as const;
/** How the app's own tools are used without asking: reads (and the free list), every tool, or none (only the free list). */
export const PROFILE_TOOL_BASES = ["reads", "all", "none"] as const;
export const PROFILE_WEB_TOOLS = ["off", "fetch", "search"] as const;
export const PROFILE_LIMITS = {
  name: 80, description: 500, instruction: 20_000, files: 20, file_bytes: 64 * 1024, files_bytes: 256 * 1024, tools: 200, hosts: 100, overrides: 200,
  budget: { min: 0.5, max: 500 }, ceiling: { min: 1, max: 1000 }, turns: { min: 1, max: 1000 }, wake: { min: 5, max: 720 },
} as const;

/** A tool name as the app's MCP server lists it. */
const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/, "a tool name (letters, digits, _ . -)");
/** A host the web tools may read without asking: exact, or *.domain (the domain and everything under it). */
const hostRule = z.string().regex(/^(\*\.)?(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/, "a host name (example.com, *.example.com)")
  .refine((h) => !/^(\*\.)?\d+(\.\d+)+$/.test(h), "a host name, not an address");
/** A model id as a provider names it. */
const modelId = z.string().regex(/^[A-Za-z0-9@._/:-]{1,100}$/, "a model id (letters, digits, @ . _ / : -)");
/**
 * A file given to a session's workspace (a skill, a guide, a template): its path inside the working directory (relative,
 * no `..`, no leading dot-dot or slash; `.claude/skills/<name>/SKILL.md` is a skill) and its text.
 */
export const PROFILE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,7}$/;
export const ProfileFileSchema = z.object({
  path: z.string().max(200).regex(PROFILE_FILE_PATH, "a path inside the session's working directory (relative, no ..)"),
  content: z.string().max(PROFILE_LIMITS.file_bytes, `at most ${PROFILE_LIMITS.file_bytes / 1024} KB a file`),
}).strict();
/** A named workspace's own budget, ceiling or model (staff only: a pack names no workspace). */
export const ProfileOverrideSchema = z.object({
  workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a workspace's slug"),
  budget_usd: z.number().min(PROFILE_LIMITS.budget.min).max(PROFILE_LIMITS.budget.max).optional(),
  ceiling_usd: z.number().min(PROFILE_LIMITS.ceiling.min).max(PROFILE_LIMITS.ceiling.max).optional(),
  model: modelId.optional(),
}).strict();
const text = (max: number) => z.string().max(max, `at most ${max.toLocaleString("en")} characters`);

/** What a profile sets (each unset: the platform setting). The stored config and pack.json's body share it. */
export const ProfileConfigSchema = z.object({
  instructions: z.object({
    /** Added to the harness's system prompt on every wake (the append_system hook). */
    append_system: text(PROFILE_LIMITS.instruction).nullable().optional(),
    /** The first message's template: {{message}} is the person's own words (absent: they follow it). */
    on_start: text(PROFILE_LIMITS.instruction).nullable().optional(),
    /** Said when the session is continued without a message (after a pause, a park, a crash). */
    on_resume: text(PROFILE_LIMITS.instruction).nullable().optional(),
  }).strict().optional(),
  model: modelId.nullable().optional(),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).nullable().optional(),
  budget_usd: z.number().min(PROFILE_LIMITS.budget.min).max(PROFILE_LIMITS.budget.max).nullable().optional(),
  ceiling_usd: z.number().min(PROFILE_LIMITS.ceiling.min).max(PROFILE_LIMITS.ceiling.max).nullable().optional(),
  max_turns: z.number().int().min(PROFILE_LIMITS.turns.min).max(PROFILE_LIMITS.turns.max).nullable().optional(),
  wake_max_minutes: z.number().int().min(PROFILE_LIMITS.wake.min).max(PROFILE_LIMITS.wake.max).nullable().optional(),
  tools: z.object({
    base: z.enum(PROFILE_TOOL_BASES).nullable().optional(),
    free: z.array(toolName).max(PROFILE_LIMITS.tools).optional(),
    ask: z.array(toolName).max(PROFILE_LIMITS.tools).optional(),
    hidden: z.array(toolName).max(PROFILE_LIMITS.tools).optional(),
  }).strict().optional(),
  web: z.object({
    tools: z.enum(PROFILE_WEB_TOOLS).nullable().optional(),
    hosts: z.array(hostRule).max(PROFILE_LIMITS.hosts).nullable().optional(),
  }).strict().optional(),
  files: z.array(ProfileFileSchema).max(PROFILE_LIMITS.files, `at most ${PROFILE_LIMITS.files} files`).optional(),
  roles: z.array(z.enum(PROFILE_ROLES, { error: () => "a role that may start sessions: member, billing or owner (a viewer is read only)" })).min(1).max(3).nullable().optional(),
  overrides: z.array(ProfileOverrideSchema).max(PROFILE_LIMITS.overrides).optional(),
}).strict();
export type ProfileConfig = z.output<typeof ProfileConfigSchema>;

/** A profile a pack declares (pack.json `agent_profiles`): its id, name and description, and what it sets. Staff may edit it. */
export const PackAgentProfileSchema = ProfileConfigSchema.omit({ overrides: true }).extend({
  id: z.string().regex(PROFILE_ID, "an id: lowercase letters, digits and -, 2 to 40, starting with a letter").refine((x) => x !== DEFAULT_PROFILE, "default is the platform's own profile"),
  name: z.string().trim().min(1).max(PROFILE_LIMITS.name),
  description: z.string().max(PROFILE_LIMITS.description).optional(),
  $comment: z.string().max(2000).optional(),
}).strict();
export type PackAgentProfile = z.output<typeof PackAgentProfileSchema>;

/** What a config says wrongly that its shape cannot: a tool in two lists, two files at one path, too many bytes, a budget over its ceiling. */
export function configProblems(c: ProfileConfig): string[] {
  const out: string[] = [];
  const lists = { free: c.tools?.free ?? [], ask: c.tools?.ask ?? [], hidden: c.tools?.hidden ?? [] };
  for (const [a, b] of [["free", "ask"], ["free", "hidden"], ["ask", "hidden"]] as const)
    for (const t of lists[a]) if (lists[b].includes(t)) out.push(`tools: ${t} is in ${a} and in ${b}: a tool runs freely, asks first or is hidden`);
  for (const [k, l] of Object.entries(lists)) if (new Set(l).size !== l.length) out.push(`tools.${k}: a tool is listed twice`);
  const paths = (c.files ?? []).map((f) => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) out.push("files: two files have one path");
  const bytes = (c.files ?? []).reduce((t, f) => t + Buffer.byteLength(f.content, "utf8"), 0);
  if (bytes > PROFILE_LIMITS.files_bytes) out.push(`files: ${Math.ceil(bytes / 1024)} KB in all: at most ${PROFILE_LIMITS.files_bytes / 1024} KB`);
  if (c.budget_usd != null && c.ceiling_usd != null && c.budget_usd > c.ceiling_usd) out.push(`budget_usd: $${c.budget_usd} is over its ceiling ($${c.ceiling_usd})`);
  if (c.roles && new Set(c.roles).size !== c.roles.length) out.push("roles: a role is listed twice");
  const ws = (c.overrides ?? []).map((o) => o.workspace);
  if (new Set(ws).size !== ws.length) out.push("overrides: a workspace is named twice");
  for (const o of c.overrides ?? []) {
    if (o.budget_usd === undefined && o.ceiling_usd === undefined && o.model === undefined) out.push(`overrides: ${o.workspace} changes nothing (a budget, a ceiling or a model)`);
    if (o.budget_usd !== undefined && o.ceiling_usd !== undefined && o.budget_usd > o.ceiling_usd) out.push(`overrides: ${o.workspace}'s budget is over its ceiling`);
  }
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
/** The first message a profile's on_start template makes of the person's words: {{message}} replaced, else they follow it. */
export function applyOnStart(template: string | null | undefined, message: string): string {
  const t = template?.trim();
  if (!t) return message;
  return /\{\{\s*message\s*\}\}/.test(t) ? t.replace(/\{\{\s*message\s*\}\}/g, () => message) : `${t}\n\n${message}`;
}
