import { getDb } from "./db.js";
import { defaultSender } from "./profile.js";
import { packConfigs } from "./host.js";
import { currentEnvName, persistedKey, readEnv } from "./env-names.js";

/**
 * Global platform settings (/admin/compute): knobs that used to be environment variables only. Each setting is keyed
 * by the variable it overrides; the value in force is
 *   platform_settings row (set on /admin)  ->  the environment  ->  the code default below.
 * The session engine's four keys (ENGINE_SETTINGS) keep the spelling they were stored under before the shell's names
 * became APP_ (mold_v0-045): rows on live databases and a host pack's reads use them. The environment is read under
 * the new name first (APP_ and the rest), the stored spelling as a fallback (src/env-names.ts).
 * Readers stay synchronous: they read an in-process cache, loaded on the first request (and the first autoscaler
 * tick) and refreshed when older than 30s, so another replica's change (or a serverless instance's) lands within ~30s.
 * setSetting() updates this process's cache at once.
 */

/** The session engine's setting keys (stored as written before mold_v0-045; see above). */
export const ENGINE_SETTINGS = {
  maxSessionsPerRun: persistedKey("MAX_SESSIONS_PER_RUN"),
  maxOrchestrators: persistedKey("MAX_ORCHESTRATORS"),
  maxJobOrchestrators: persistedKey("MAX_JOB_ORCHESTRATORS"),
  jobPodCapacity: persistedKey("JOB_POD_CAPACITY"),
} as const;

/** The shell's groups (models, runs, capacity, docs, email) and any a pack adds (pack.json settings, mold_v0-140; a host pack's since mold_v0-039). */
export type SettingGroup = string;
export interface SettingDef {
  key: string; group: SettingGroup; label: string; help: string;
  kind: "text" | "int" | "number" | "choice";
  default: string | number;
  options?: string[]; min?: number; max?: number;
  /** What a text setting holds (default: a model id). sender = "Name <address>" or an address; emails = addresses, comma-separated, or empty. */
  format?: "model" | "sender" | "emails";
}

/** The shell's own groups, in order; a pack's groups go after the group each names (settingGroups). */
export const SETTING_GROUPS: { id: SettingGroup; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "runs", label: "Runs" },
  { id: "capacity", label: "Capacity" },
  { id: "docs", label: "Docs answers" },
  { id: "email", label: "Email" },
];

export const SETTINGS: SettingDef[] = [
  { key: "ORCHESTRATOR_MODEL", group: "models", label: "Orchestrator model", kind: "text", default: "gpt-6.1-sol",
    help: "The model each orchestrator thinks with (it plays the developer and drives the agents). Applies to orchestrators started after the change." },
  { key: "CLOUDFLARE_AI_MODEL", group: "models", label: "Research quick-pass model", kind: "text", default: "@cf/zai-org/glm-5.3-flash",
    help: "Cloudflare Workers AI model for the first, quick brief on an access request's company." },
  { key: "VERTEX_REGION", group: "models", label: "Vertex AI region", kind: "text", default: "us-east5",
    help: "Google Cloud region for Claude (and Gemini) on Vertex AI, e.g. us-east5, europe-west1, global. The project comes from the Vertex AI service-account key in Key vault." },
  { key: ENGINE_SETTINGS.maxSessionsPerRun, group: "runs", label: "Most sessions per run", kind: "int", default: 100, min: 1, max: 100000,
    help: "A run that would start more sessions than this is refused." },
  { key: ENGINE_SETTINGS.maxOrchestrators, group: "capacity", label: "Shared orchestrators", kind: "int", default: 4, min: 0, max: 1000,
    help: "Most shared orchestrators the autoscaler keeps running at once." },
  { key: ENGINE_SETTINGS.maxJobOrchestrators, group: "capacity", label: "Per-job orchestrators", kind: "int", default: 12, min: 1, max: 1000,
    help: "Most one-job orchestrators (one per simulation or research job) running at once." },
  { key: ENGINE_SETTINGS.jobPodCapacity, group: "capacity", label: "Worker sandboxes per job", kind: "int", default: 40, min: 1, max: 50,
    help: "Worker sandboxes one per-job orchestrator runs at once." },
  { key: "BOAT_SANDBOX_SIZE", group: "capacity", label: "Sandbox size", kind: "choice", default: "default", options: ["small", "default", "large", "xlarge"],
    help: "boat.dev machine size for orchestrators started after the change and their worker sandboxes." },
  { key: "DOCS_ANSWERS_DAILY_MAX", group: "docs", label: "Docs answers a day", kind: "int", default: 500, min: 0, max: 100000,
    help: "Most model calls for \"Ask AI\" answers in the Cmd+K bar a UTC day, across all accounts and admins. Past it, people still get the matching docs sections, without the summary." },
  { key: "DOCS_ANSWERS_PER_MINUTE", group: "docs", label: "Docs answers a minute per person", kind: "int", default: 6, min: 0, max: 1000,
    help: "Most \"Ask AI\" answers one person gets a minute; past it, the matching sections only." },
  { key: "EMAILS_ENABLED", group: "email", label: "Send emails", kind: "choice", default: "on", options: ["on", "off"],
    help: "Off: nothing is sent (each email is logged as skipped). The Resend key is in Key vault; the log is on Emails." },
  { key: "EMAIL_FROM", group: "email", label: "From", kind: "text", format: "sender", default: defaultSender(), // the profile's sender (src/profile.ts)
    help: "The sender of every email, as Name <address>. The address's domain must be verified in Resend." },
  { key: "EMAIL_REPLY_TO", group: "email", label: "Reply-to", kind: "text", format: "emails", default: "",
    help: "Where replies go. Empty: to the From address." },
  { key: "EMAIL_ADMIN_TO", group: "email", label: "Operator alerts to", kind: "text", format: "emails", default: "",
    help: "Who gets new access requests and library submissions, comma-separated. Empty: the platform owners (Admins)." },
];
/**
 * Every group of this build, in order: the shell's, then each pack's (its pack.json `settings.groups`, mold_v0-140) after
 * the group it names (at the end when it names none, or one the build lacks).
 */
export function settingGroups(): { id: SettingGroup; label: string }[] {
  const out = [...SETTING_GROUPS];
  for (const c of packConfigs()) for (const g of c.settings?.groups ?? []) {
    const at = g.after ? out.findIndex((x) => x.id === g.after) : out.length - 1;
    out.splice(at < 0 ? out.length : at + 1, 0, { id: g.id, label: g.label });
  }
  return out;
}
/**
 * Every setting of this build: the shell's and the packs' (pack.json `settings.defs`, mold_v0-140: pure data), grouped in
 * group order. A pack's setting goes before the one it names (`before`), else at the end of its group. A key the shell or
 * another pack already has is refused (the build refuses two packs' own; this catches one the shell has).
 */
export function allSettings(): SettingDef[] {
  const order = new Map(settingGroups().map((g, i) => [g.id, i]));
  const all: SettingDef[] = [...SETTINGS];
  for (const c of packConfigs()) for (const { before, ...d } of c.settings?.defs ?? []) {
    if (all.some((x) => x.key === d.key)) throw new Error(`pack ${c.pack}: pack.json settings.defs ${d.key} is a setting the build already has`);
    const at = before ? all.findIndex((x) => x.key === before) : -1;
    if (at >= 0) all.splice(at, 0, d); else all.push(d);
  }
  return all.map((d, i) => [d, i] as const).sort(([a, i], [b, j]) => (order.get(a.group) ?? 999) - (order.get(b.group) ?? 999) || i - j).map(([d]) => d);
}
let defsFor: { packs: unknown; defs: Map<string, SettingDef> } | null = null;
const defOf = (key: string) => {
  if (defsFor?.packs !== packConfigs()) defsFor = { packs: packConfigs(), defs: new Map(allSettings().map((d) => [d.key, d])) };
  return defsFor.defs.get(key);
};

const TTL_MS = 30_000;
let cache = new Map<string, { value: unknown; updated_at: string; updated_by: string | null }>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Reload the cache from Postgres (deduplicated). A failed load keeps the old values. */
export function refreshSettings(): Promise<void> {
  loading ??= (async () => {
    const rows = await (await getDb()).query<{ key: string; value: unknown; updated_at: Date; updated_by: string | null }>(
      "SELECT key, value, updated_at, updated_by FROM platform_settings");
    cache = new Map(rows.map((r) => [r.key, { value: r.value, updated_at: new Date(r.updated_at).toISOString(), updated_by: r.updated_by }]));
    loadedAt = Date.now();
  })().catch((e) => { console.error("settings: load failed:", (e as Error).message); }).finally(() => { loading = null; });
  return loading;
}

/** Resolve once the cache is at most 30s old (no-op when it is). Called per request and per autoscaler tick. */
export const freshSettings = (): Promise<void> => (Date.now() - loadedAt < TTL_MS ? Promise.resolve() : refreshSettings());

/** The value set on /admin, if any (from the cache). */
export const setting = (key: string): unknown => cache.get(key)?.value;

/** A setting's environment value: a key stored under the old prefix is read as APP_ and the rest first (mold_v0-045). */
const envOf = (key: string) => {
  const name = currentEnvName(key);
  const v = name ? readEnv(name) : process.env[key];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
};

/** The value in force: set here, else the environment, else the default. Numbers stay numbers. */
export function settingValue(key: string): string | number {
  const d = defOf(key);
  if (!d) throw new Error(`Unknown setting ${key}`);
  const raw = setting(key) ?? envOf(key);
  if (raw === undefined) return d.default;
  if (d.kind === "int" || d.kind === "number") { const n = Number(raw); return Number.isFinite(n) ? n : d.default; }
  return String(raw);
}
export const settingNumber = (key: string) => Number(settingValue(key));
export const settingText = (key: string) => String(settingValue(key));

/** Checked and normalised, or an error message. */
function clean(d: SettingDef, v: unknown): { value: string | number } | { error: string } {
  if (d.kind === "int" || d.kind === "number") {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n)) return { error: `${d.label} must be a number` };
    if (d.kind === "int" && !Number.isInteger(n)) return { error: `${d.label} must be a whole number` };
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return { error: `${d.label} must be between ${d.min} and ${d.max}` };
    return { value: n };
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (d.kind === "choice") return d.options!.includes(s) ? { value: s } : { error: `${d.label} must be one of ${d.options!.join(", ")}` };
  const address = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
  if (d.format === "emails") {
    const list = s.split(",").map((x) => x.trim()).filter(Boolean);
    if (list.length > 20 || list.some((x) => !address.test(x))) return { error: `${d.label} must be email addresses, comma-separated` };
    return { value: list.join(", ") };
  }
  if (d.format === "sender") {
    const m = /^(?:([^<>"\r\n]{1,80}?)\s*<([^<>]+)>|([^<>]+))$/.exec(s);
    const addr = (m?.[2] ?? m?.[3] ?? "").trim();
    if (!m || !address.test(addr)) return { error: `${d.label} must be Name <address> or an address` };
    return { value: m[1] ? `${m[1].trim()} <${addr}>` : addr };
  }
  // Model ids only: they go into orchestrator env files and provider requests.
  return /^[A-Za-z0-9@._\/:-]{1,100}$/.test(s) ? { value: s } : { error: `${d.label} must be a model id (letters, digits, @ . _ / : -)` };
}

export class SettingError extends Error { status = 400; }

/** Set (or, with null, reset to the environment / default) several settings at once. Returns what changed. */
export async function setSettings(actor: string, values: Record<string, unknown>) {
  const entries = Object.entries(values ?? {});
  if (!entries.length) throw new SettingError("Nothing to save");
  const changes: { key: string; from: unknown; to: unknown }[] = [];
  const checked: [SettingDef, string | number | null][] = [];
  for (const [key, v] of entries) {
    const d = defOf(key);
    if (!d) throw new SettingError(`Unknown setting ${key}`);
    if (v === null) { checked.push([d, null]); continue; }
    const c = clean(d, v);
    if ("error" in c) throw new SettingError(c.error);
    checked.push([d, c.value]);
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const [d, v] of checked) {
      const before = setting(d.key) ?? null;
      if (v === null) await tx.query("DELETE FROM platform_settings WHERE key = $1", [d.key]);
      else await tx.query(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [d.key, JSON.stringify(v), actor]);
      if (JSON.stringify(before) !== JSON.stringify(v)) changes.push({ key: d.key, from: before, to: v });
    }
  });
  await refreshSettings();
  return changes;
}

/** Every setting with the value in force and where it comes from (for /admin/compute). */
export async function listSettings() {
  await freshSettings();
  return allSettings().map((d) => {
    const row = cache.get(d.key), env = envOf(d.key);
    return {
      ...d, value: settingValue(d.key), source: row ? "set" as const : env !== undefined ? "env" as const : "default" as const,
      env: env ?? null, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null,
    };
  });
}
