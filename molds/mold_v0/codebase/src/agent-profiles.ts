/**
 * Workspace agent profiles (mold_v0-261, redesigned by mold_v0-267; molds/mold_v0/docs/agent-harness.md "Agent
 * profiles"): named sets of what a session runs with, edited by platform staff in Admin › Agent profiles (one modal),
 * every change versioned and audited. The only writer of agent_profiles, agent_profile_versions, agent_profile_changes
 * (sql/migrations/0052_agent_profiles.sql) and agent_profile_uploads (0056_agent_profile_redesign.sql). Nothing here
 * answers unless the app's profile turns `agent_harness` on.
 *
 *   what      exactly five things (src/agent-profile-spec.ts): the harness; no model of its own (the model is the
 *             primary inference provider's); the key vault (keys injected into its sessions, and the primary inference
 *             provider's model and key); uploads into its sessions' workspace (files, folders, runtime binaries); and its
 *             governance policy (src/agent-governance.ts). Everything it leaves unset is the platform setting; budgets,
 *             turns and limits are always the platform's.
 *   default   the Default profile ("default") leaves everything unset. A session started without a profile uses it.
 *   packs     a pack's pack.json `agent_profiles` are written once (version 1) the first time the app runs with them.
 *   versions  each save is a new version; a session freezes the version it started with. A save names the version it
 *             edited: one saved meanwhile is refused (409), never overwritten.
 *   audit     each change (created, edited, archived, restored, migrated) is kept with who made it and the profile
 *             before and after (agent_profile_changes), beside the staff log line the routes write.
 *   uploads   a file's bytes go to the object store in parts of at most 4 MiB (under a hosted API's request limit), under
 *             agent-profiles/uploads/<id>/; a profile names the finished ones (id, path, size, sha256, executable), up
 *             to AGENT_UPLOAD_MAX_MB in all. A wake fetches them with its lease and writes them into its scratch.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { settingNumber, settingText } from "./settings.js";
import { canAccount, type AccountRole } from "./account-roles.js";
import { AGENT_FLAVOURS, agentHarnessOn, flavourOf, pinnedFlavours } from "./agent-harness-config.js";
import { activeExceptions, GOVERNANCE_LIMITS, type Governance } from "./agent-governance.js";
import {
  configProblems, DEFAULT_PROFILE, keyName, normalizeGovernance, PROFILE_ID, PROFILE_LIMITS, ProfileConfigSchema, UPLOAD_ID,
  type PackAgentProfile, type ProfileConfig, type ProfileKey, type ProfileRecipe, type ProfileUpload,
} from "./agent-profile-spec.js";

export { DEFAULT_PROFILE } from "./agent-profile-spec.js";
export type ProfileStatus = "active" | "archived";
export interface ProfileRow {
  id: string; name: string; description: string; version: number; status: ProfileStatus; source: string; config: ProfileConfig;
  created_by: string; created_at: Date; updated_by: string; updated_at: Date; archived_at: Date | null;
}
/** Who changes a profile: a staff member (their address or id), or the platform / a pack seeding one. */
export type ProfileActor = string;

const read = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => fn(await getDb()));
const tx = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => (await getDb()).transaction(fn));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const COLS = "id, name, description, version, status, source, config, created_by, created_at, updated_by, updated_at, archived_at";

function off(): never { throw new PackError("The workspace agent is not on in this app", 404); }
const needOn = () => { if (!agentHarnessOn()) off(); };

/**
 * Key vault providers whose keys no session is given: the object store's settings and the OAuth app clients reach every
 * workspace's data (a session holding them would step out of its own), so injecting them would break its isolation.
 */
export const KEYS_NEVER_INJECTED = ["object_storage", "oauth_clients"] as const;
/** Variables a wake sets itself (src/agent-harness.ts): a key is never delivered in one of them. */
const RESERVED_ENV = /^(PATH|HOME|LANG|SHELL|USER|TMPDIR|RUN_[A-Z0-9_]*|DISABLE_[A-Z0-9_]*|ENABLE_TOOL_SEARCH|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_[A-Z0-9_]*|NPM_CONFIG_[A-Z0-9_]*|ANTHROPIC_[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|CODEX_[A-Z0-9_]*|CLAUDE_[A-Z0-9_]*)$/;

// ---------------------------------------------------------------- what a profile resolves to

export interface Effective {
  /** 1. The harness (flavour id) and 3. the primary inference provider: its provider, model and key (null: the gateway's pick). */
  harness: string; provider: string; model: string; key: string | null;
  keys: ProfileKey[];
  uploads: ProfileUpload[];
  /** mold_v0-271: the workspace recipes its sessions receive (src/recipes.ts), each expanded into uploads at a start. */
  recipes: ProfileRecipe[];
  governance: Governance | null;
  from: { harness: "profile" | "setting"; model: "profile" | "setting" };
}

/** What a profile's config resolves to, each unset item the platform's in force. */
export function effectiveOf(c: ProfileConfig): Effective {
  const settingFlavour = flavourOf(settingText("AGENT_HARNESS")) ?? AGENT_FLAVOURS[0]!;
  const flavour = (c.harness ? flavourOf(c.harness) : null) ?? settingFlavour;
  const settingProvider = flavour.providers.includes(settingText("AGENT_PROVIDER")) ? settingText("AGENT_PROVIDER") : flavour.providers[0]!;
  const inf = c.inference ?? null;
  return {
    harness: flavour.id, provider: inf?.provider ?? settingProvider, model: inf?.model ?? settingText("AGENT_MODEL"), key: inf?.key ?? null,
    keys: [...(c.keys ?? [])], uploads: [...(c.uploads ?? [])], recipes: [...(c.recipes ?? [])], governance: c.governance ?? null,
    from: { harness: c.harness ? "profile" : "setting", model: inf ? "profile" : "setting" },
  };
}

/** Whether this person (or an account key) may start a session: the role's own right to launch one. */
export function mayStart(actor: { kind: string; role: AccountRole | null }): boolean {
  if (actor.kind === "key") return true;
  return actor.kind === "person" && !!actor.role && canAccount(actor.role, "launch");
}

// ---------------------------------------------------------------- seeding: the Default profile and the packs'

const DEFAULT_ROW = { name: "Default", description: "The platform's agent settings as they are (Admin › Agent configuration): a session started without a profile runs with these." };
let seeded: unknown = null;
async function packProfiles(): Promise<{ pack: string; p: PackAgentProfile }[]> {
  const { packs } = await import("./packs.js");
  return packs().flatMap((x) => (x.definition.agentProfiles ?? []).map((p) => ({ pack: x.id, p: p as PackAgentProfile })));
}
/** A pack's declared profile as a stored config (its governance's domains normalized). */
export function packConfig(p: PackAgentProfile): ProfileConfig {
  const { id: _i, name: _n, description: _d, $comment: _c, ...rest } = p;
  const c = ProfileConfigSchema.parse(rest);
  if (c.governance) c.governance = normalizeGovernance(c.governance).governance;
  return c;
}
/** Write the Default profile and each pack's that is not there yet (once per set of packs; idempotent). */
export async function ensureProfiles(): Promise<void> {
  const { packs } = await import("./packs.js");
  const key = packs();
  if (seeded === key) return;
  const wanted = [{ id: DEFAULT_PROFILE, name: DEFAULT_ROW.name, description: DEFAULT_ROW.description, source: "platform", config: {} as ProfileConfig, by: "the platform" },
    ...(await packProfiles()).map(({ pack, p }) => ({ id: p.id, name: p.name, description: p.description ?? "", source: `pack:${pack}`, config: packConfig(p), by: `pack ${pack}` }))];
  await tx(async (q) => {
    for (const w of wanted) {
      const [made] = await q.query<{ id: string }>(
        `INSERT INTO agent_profiles (id, name, description, source, config, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id) DO NOTHING RETURNING id`, [w.id, w.name, w.description, w.source, JSON.stringify(w.config), w.by]);
      if (!made) continue;
      await q.query("INSERT INTO agent_profile_versions (profile_id, version, name, description, config, created_by) VALUES ($1, 1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [w.id, w.name, w.description, JSON.stringify(w.config), w.by]);
      await q.query("INSERT INTO agent_profile_changes (profile_id, version, action, changed_by, before, after) VALUES ($1, 1, 'created', $2, NULL, $3)",
        [w.id, w.by, JSON.stringify(snapshot({ name: w.name, description: w.description, status: "active", config: w.config }))]);
    }
  });
  seeded = key;
}
/** Forget what was seeded (tests that change the packs, or drop the rows). */
export const resetProfileSeedForTest = () => { seeded = null; };

// ---------------------------------------------------------------- reading

const snapshot = (p: Pick<ProfileRow, "name" | "description" | "status" | "config">) => ({ name: p.name, description: p.description, status: p.status, config: p.config ?? {} });
async function rowOf(q: Queryable, id: string, lock = false): Promise<ProfileRow> {
  if (!PROFILE_ID.test(String(id))) throw new PackError("no such agent profile", 404);
  const [r] = await q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [String(id)]);
  if (!r) throw new PackError("no such agent profile", 404);
  return r;
}

/** The governance policy in a few words (the list's column). */
export function governanceWords(g: Governance | null | undefined): string {
  if (!g) return "Platform settings";
  const parts: string[] = [];
  const w = g.web;
  parts.push(!w?.enabled ? "Web off" : `${[w.web_search_enabled && "search", w.web_fetch_enabled && `fetch ${w.web_fetch_allowed_domains.includes("*") ? "any public host" : `${w.web_fetch_allowed_domains.length} host${w.web_fetch_allowed_domains.length === 1 ? "" : "s"}`}`].filter(Boolean).join(" and ")}, ${w.max_calls} calls`);
  if (g.tools) parts.push(`${g.tools.allowed.length} tool${g.tools.allowed.length === 1 ? "" : "s"}`);
  if (g.exceptions?.length) parts.push(`${g.exceptions.length} exception${g.exceptions.length === 1 ? "" : "s"}`);
  if (g.retention_days) parts.push(`kept ${g.retention_days} days`);
  return parts.join(" · ");
}

export interface ProfileSummary {
  id: string; name: string; description: string; version: number; status: ProfileStatus; source: "platform" | "pack"; pack: string | null; is_default: boolean;
  harness: string; model: string; provider: string; keys: number; uploads: number; upload_bytes: number; governance: string;
  sessions: number; updated_at: string; updated_by: string;
}
const sourceOf = (s: string) => (s.startsWith("pack:") ? { source: "pack" as const, pack: s.slice(5) } : { source: "platform" as const, pack: null });
function summary(r: ProfileRow, sessions = 0): ProfileSummary {
  const e = effectiveOf(r.config ?? {});
  return { id: r.id, name: r.name, description: r.description, version: r.version, status: r.status, ...sourceOf(r.source), is_default: r.id === DEFAULT_PROFILE,
    harness: flavourOf(e.harness)?.label ?? e.harness, model: e.model, provider: e.provider, keys: e.keys.length, uploads: e.uploads.length,
    upload_bytes: e.uploads.reduce((t, u) => t + u.bytes, 0), governance: governanceWords(e.governance), sessions, updated_at: iso(r.updated_at)!, updated_by: r.updated_by };
}

/** Staff: every profile (archived ones too), the Default first, then by name. */
export async function listProfiles(): Promise<ProfileSummary[]> {
  needOn();
  await ensureProfiles();
  return read(async (q) => {
    const rows = await q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles ORDER BY (id = 'default') DESC, lower(name), id`);
    const counts = await q.query<{ profile_id: string; n: number }>(
      "/* tenant: platform staff, every workspace's sessions counted by profile (no row read) */ SELECT profile_id, count(*)::int AS n FROM harness_sessions WHERE profile_id IS NOT NULL GROUP BY profile_id");
    const by = new Map(counts.map((c) => [c.profile_id, c.n]));
    return rows.map((r) => summary(r, by.get(r.id) ?? 0));
  });
}

export interface ProfileChange { id: number; version: number; action: string; by: string; at: string; before: unknown; after: unknown; changed: string[] }
export interface ProfileDetail extends ProfileSummary {
  config: ProfileConfig; effective: Effective; created_at: string; created_by: string; archived_at: string | null;
  versions: { version: number; name: string; by: string; at: string }[]; changes: ProfileChange[];
}
/** JSON with each object's keys sorted (a stored jsonb value keeps its own key order). */
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
/** What changed between two snapshots, by the profile's own words (name, description, status, then each config key). */
export function changedKeys(before: unknown, after: unknown): string[] {
  const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["name", "description", "status"]) if (canon(b[k]) !== canon(a[k])) out.push(k);
  const bc = (b.config ?? {}) as Record<string, unknown>, ac = (a.config ?? {}) as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(bc), ...Object.keys(ac)])].sort()) if (canon(bc[k]) !== canon(ac[k])) out.push(k);
  return out;
}

/** Staff: one profile, what it resolves to, its versions and its changes (newest first). */
export async function readProfile(id: string): Promise<ProfileDetail> {
  needOn();
  await ensureProfiles();
  return read(async (q) => {
    const r = await rowOf(q, id);
    const [n] = await q.query<{ n: number }>("/* tenant: platform staff, sessions counted by profile (no row read) */ SELECT count(*)::int AS n FROM harness_sessions WHERE profile_id = $1", [r.id]);
    const versions = await q.query<{ version: number; name: string; created_by: string; created_at: Date }>(
      "SELECT version, name, created_by, created_at FROM agent_profile_versions WHERE profile_id = $1 ORDER BY version DESC LIMIT 200", [r.id]);
    const changes = await q.query<{ id: string; version: number; action: string; changed_by: string; changed_at: Date; before: unknown; after: unknown }>(
      "SELECT id, version, action, changed_by, changed_at, before, after FROM agent_profile_changes WHERE profile_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 200", [r.id]);
    return { ...summary(r, n?.n ?? 0), config: r.config ?? {}, effective: effectiveOf(r.config ?? {}), created_at: iso(r.created_at)!, created_by: r.created_by, archived_at: iso(r.archived_at),
      versions: versions.map((v) => ({ version: v.version, name: v.name, by: v.created_by, at: iso(v.created_at)! })),
      changes: changes.map((c) => ({ id: Number(c.id), version: c.version, action: c.action, by: c.changed_by, at: iso(c.changed_at)!, before: c.before, after: c.after, changed: changedKeys(c.before, c.after) })) };
  });
}

/** One version of a profile as it was saved (a session's frozen version). */
export async function profileVersion(id: string, version: number): Promise<{ id: string; version: number; name: string; description: string; config: ProfileConfig; by: string; at: string }> {
  needOn();
  const [v] = await read((q) => q.query<{ name: string; description: string; config: ProfileConfig; created_by: string; created_at: Date }>(
    "SELECT name, description, config, created_by, created_at FROM agent_profile_versions WHERE profile_id = $1 AND version = $2", [String(id), Math.trunc(Number(version))]));
  if (!v) throw new PackError("no such version of this agent profile", 404);
  return { id: String(id), version: Math.trunc(Number(version)), name: v.name, description: v.description, config: v.config, by: v.created_by, at: iso(v.created_at)! };
}

// ---------------------------------------------------------------- writing (staff)

/**
 * mold_v0-262: what is wrong with a profile's workspace credentials: each "<pack>/<field>" is a credential a pack of this
 * build declares, bound to the workspace, a value pasted in Settings (not a credential set, a GitHub App's or an OAuth
 * connection's).
 */
export async function sessionCredentialProblems(names: readonly string[]): Promise<string[]> {
  const { credentialSpecs, findCredential } = await import("./credentials.js");
  const out: string[] = [];
  for (const n of names) {
    const [p, f] = n.split("/");
    const declared = credentialSpecs().find((x) => x.pack === p && x.name === f);
    if (!declared) out.push(`keys: ${n} is not a credential a pack of this build declares`);
    else if (!findCredential("_agent", n)) out.push(`keys: ${n} is ${declared.bound_to !== "workspace" ? `bound to ${declared.bound_to === "asset" ? "a record" : `its ${declared.bound_to}`}` : "not a value pasted in Settings"}: a session receives a workspace's own value`);
  }
  return out;
}

/** The key vault's entries (no secret read): provider, label, its hint, whether it is on. */
async function vaultEntries(): Promise<{ provider: string; label: string; hint: string; enabled: boolean }[]> {
  return read((q) => q.query<{ provider: string; label: string; hint: string; enabled: boolean }>(
    "/* tenant: platform: the vault's own rows, no secret read */ SELECT provider, label, hint, enabled FROM vault_credentials ORDER BY provider, priority DESC, label"));
}

export interface ProfileInput { id?: unknown; name?: unknown; description?: unknown; config?: unknown; version?: unknown; copy_of?: unknown }

/**
 * A config as staff send it, checked: its shape, what its shape cannot say, a pinned harness, a provider it speaks to, a
 * priced model, keys that are in the vault (and may be given to a session), uploads that are stored and within the size
 * limit, a governance policy that holds (its exceptions dated within 90 days and stamped with who saved them).
 */
export async function checkConfig(raw: unknown, by = "staff", previous: ProfileConfig = {}): Promise<ProfileConfig> {
  const r = ProfileConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new PackError(r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ").slice(0, 2000), 400);
  const c = r.data;
  const problems = configProblems(c);
  // 1. The harness: a flavour pinned in the run tools' catalogue.
  const pinned = pinnedFlavours();
  if (c.harness && !pinned.some((f) => f.id === c.harness)) problems.push(`harness: ${c.harness} is not a harness this platform runs (${pinned.map((f) => f.id).join(", ")})`);
  const flavour = (c.harness ? flavourOf(c.harness) : null) ?? flavourOf(settingText("AGENT_HARNESS")) ?? AGENT_FLAVOURS[0]!;
  // 3. The primary inference provider: one the harness speaks to, a priced model, a key of that provider in the vault.
  const vault = await vaultEntries();
  if (c.inference) {
    if (!flavour.providers.includes(c.inference.provider)) problems.push(`inference.provider: ${flavour.label} speaks to ${flavour.providers.join(", ")}, not ${c.inference.provider}`);
    const { hasPrice } = await import("./usage.js");
    if (!(await hasPrice(c.inference.model))) { const { unpricedModel } = await import("./gateway.js"); problems.push(`inference.model: ${unpricedModel(c.inference.model)}`); }
    const k = c.inference.key ? vault.find((v) => v.provider === c.inference!.provider && v.label === c.inference!.key) : null;
    if (c.inference.key && !k) problems.push(`inference.key: the key vault holds no ${c.inference.provider} key labelled ${c.inference.key}`);
    else if (k && !k.enabled) problems.push(`inference.key: the ${c.inference.provider} key ${k.label} is turned off in the key vault`);
  }
  // 3. The keys injected.
  problems.push(...(await sessionCredentialProblems((c.keys ?? []).flatMap((k) => (k.kind === "workspace" ? [k.name] : [])))));
  for (const k of c.keys ?? []) {
    if (k.kind !== "platform") continue;
    if ((KEYS_NEVER_INJECTED as readonly string[]).includes(k.provider)) problems.push(`keys: ${k.provider} keys reach every workspace's data: a session is never given one`);
    else if (!vault.some((v) => v.provider === k.provider && v.label === k.label)) problems.push(`keys: the key vault holds no ${k.provider} key labelled ${k.label}`);
    if (RESERVED_ENV.test(k.env)) problems.push(`keys: ${k.env} is a variable the session sets itself: deliver ${keyName(k)} in another`);
  }
  // 4. The uploads: stored and finished, as they were sent, within the platform's limit.
  const uploads = c.uploads ?? [];
  if (uploads.length) {
    const found = await read((q) => q.query<{ id: string; bytes: string; sha256: string | null; completed_at: Date | null }>(
      "SELECT id, bytes, sha256, completed_at FROM agent_profile_uploads WHERE id = ANY ($1::text[])", [uploads.map((u) => u.id)]));
    const byId = new Map(found.map((f) => [f.id, f]));
    for (const u of uploads) {
      const f = byId.get(u.id);
      if (!f || !f.completed_at) problems.push(`uploads: ${u.path} was not uploaded (or not finished): add it again`);
      else if (f.sha256 !== u.sha256 || Number(f.bytes) !== u.bytes) problems.push(`uploads: ${u.path} is not the file that was uploaded`);
    }
  }
  // 4. mold_v0-271: the workspace recipes: each one there, active, with that version; the total within the limit too.
  let recipeBytes = 0;
  if (c.recipes?.length) {
    const R = await import("./recipes.js");
    for (const x of c.recipes) {
      const bad = await R.pickProblem(x);
      if (bad) problems.push(bad);
      else recipeBytes += (await R.recipeUploads(x)).uploads.filter((u) => !uploads.some((o) => o.path.toLowerCase() === u.path.toLowerCase())).reduce((t, u) => t + u.bytes, 0);
    }
  }
  {
    const max = uploadLimitBytes();
    const total = uploads.reduce((t, u) => t + u.bytes, 0) + recipeBytes;
    if (total > max) problems.push(`uploads: ${mb(total)} in all${recipeBytes ? " with its recipes" : ""}: at most ${mb(max)} (the platform's AGENT_UPLOAD_MAX_MB)`);
  }
  // 5. The governance policy: as normalized; a retention no longer than the platform's; each exception dated.
  if (c.governance) {
    const g = normalizeGovernance(c.governance).governance!;
    if (g.retention_days && g.retention_days > settingNumber("AGENT_RETENTION_DAYS"))
      problems.push(`governance.retention_days: at most the platform's ${settingNumber("AGENT_RETENTION_DAYS")} days (a profile may keep a conversation for less, never longer)`);
    const now = Date.now();
    const before = new Map((previous.governance?.exceptions ?? []).map((e) => [`${e.domain}|${e.expires_at}|${e.reason}`, e]));
    g.exceptions = (g.exceptions ?? []).map((e) => {
      const same = before.get(`${e.domain}|${new Date(e.expires_at).toISOString()}|${e.reason}`) ?? before.get(`${e.domain}|${e.expires_at}|${e.reason}`);
      const at = new Date(e.expires_at).toISOString();
      if (same) return { ...e, expires_at: at, approved_by: same.approved_by ?? by };
      const t = Date.parse(at);
      if (t <= now) problems.push(`governance.exceptions: ${e.domain}'s exception would end before it starts: give it a date ahead`);
      else if (t > now + GOVERNANCE_LIMITS.exception_days * 86_400_000) problems.push(`governance.exceptions: ${e.domain}'s exception runs past ${GOVERNANCE_LIMITS.exception_days} days: exceptions are time-bounded (renew it then)`);
      return { ...e, expires_at: at, approved_by: by };
    });
    if (!g.exceptions.length) delete g.exceptions;
    c.governance = g;
  }
  if (problems.length) throw new PackError([...new Set(problems)].join("; ").slice(0, 2000), 400);
  return prune(c);
}
/** Unset items are left out, so a profile stores only what it sets. */
function prune(c: ProfileConfig): ProfileConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    if (k === "inference" && v && typeof v === "object") { const i = v as Record<string, unknown>; out[k] = Object.fromEntries(Object.entries(i).filter(([, x]) => x !== null && x !== undefined && x !== "")); continue; }
    out[k] = v;
  }
  return out as ProfileConfig;
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const nameOf = (v: unknown) => {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n) throw new PackError("name: give the profile a name", 400);
  if (n.length > PROFILE_LIMITS.name) throw new PackError(`name: at most ${PROFILE_LIMITS.name} characters`, 400);
  return n;
};
const descOf = (v: unknown) => {
  const d = typeof v === "string" ? v.trim() : "";
  if (d.length > PROFILE_LIMITS.description) throw new PackError(`description: at most ${PROFILE_LIMITS.description} characters`, 400);
  return d;
};
/** An id from a name: lowercase words joined by -. */
export const idFromName = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "p-$1").slice(0, 40).replace(/-+$/, "");

async function record(q: Queryable, id: string, version: number, action: "created" | "edited" | "archived" | "restored", by: string, before: unknown, after: unknown) {
  await q.query("INSERT INTO agent_profile_changes (profile_id, version, action, changed_by, before, after) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, version, action, by, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
}

/** Staff: a new profile (its id from its name unless given; or a copy of another's config), version 1. */
export async function createProfile(by: ProfileActor, input: ProfileInput): Promise<ProfileDetail> {
  needOn();
  await ensureProfiles();
  const name = nameOf(input.name);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : idFromName(name);
  if (!PROFILE_ID.test(id)) throw new PackError("id: lowercase letters, digits and -, 2 to 40, starting with a letter", 400);
  let raw = input.config, previous: ProfileConfig = {};
  if (raw === undefined && typeof input.copy_of === "string") raw = previous = (await read((q) => rowOf(q, String(input.copy_of)))).config;
  const config = await checkConfig(raw ?? {}, by, previous);
  const description = descOf(input.description);
  await tx(async (q) => {
    const [made] = await q.query<{ id: string }>(
      `INSERT INTO agent_profiles (id, name, description, source, config, created_by, updated_by) VALUES ($1, $2, $3, 'platform', $4, $5, $5) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, name, description, JSON.stringify(config), by]);
    if (!made) throw new PackError(`A profile called ${id} already exists: give this one another name or id`, 409);
    await q.query("INSERT INTO agent_profile_versions (profile_id, version, name, description, config, created_by) VALUES ($1, 1, $2, $3, $4, $5)", [id, name, description, JSON.stringify(config), by]);
    await record(q, id, 1, "created", by, null, snapshot({ name, description, status: "active", config }));
  });
  return readProfile(id);
}

/** Staff: save a profile as a new version (name, description, config). `version` is the one edited: a newer one refuses. */
export async function updateProfile(by: ProfileActor, id: string, input: ProfileInput): Promise<ProfileDetail> {
  needOn();
  await ensureProfiles();
  const expected = Number(input.version);
  if (!Number.isSafeInteger(expected) || expected < 1) throw new PackError("version: the version you edited (it is refused when someone saved a newer one meanwhile)", 400);
  const current = await read((q) => rowOf(q, id));
  const config = await checkConfig(input.config, by, current.config ?? {});
  await tx(async (q) => {
    const r = await rowOf(q, id, true);
    if (r.version !== expected) throw new PackError(`Someone saved version ${r.version} of ${r.name} while you edited version ${expected}: open it again and redo your change`, 409);
    if (r.status === "archived") throw new PackError(`${r.name} is archived: restore it before you change it`, 409);
    const name = input.name === undefined ? r.name : nameOf(input.name);
    const description = input.description === undefined ? r.description : descOf(input.description);
    const before = snapshot(r), after = snapshot({ name, description, status: r.status, config });
    if (!changedKeys(before, after).length) throw new PackError("Nothing changed: this would save the same profile again", 400);
    const v = r.version + 1;
    await q.query("UPDATE agent_profiles SET name = $2, description = $3, config = $4, version = $5, updated_by = $6, updated_at = now() WHERE id = $1",
      [r.id, name, description, JSON.stringify(config), v, by]);
    await q.query("INSERT INTO agent_profile_versions (profile_id, version, name, description, config, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [r.id, v, name, description, JSON.stringify(config), by]);
    await record(q, r.id, v, "edited", by, before, after);
  });
  return readProfile(id);
}

/** Staff: archive (no new session may start with it; running ones keep their frozen version) or restore a profile. */
export async function setProfileArchived(by: ProfileActor, id: string, archived: boolean): Promise<ProfileDetail> {
  needOn();
  await ensureProfiles();
  await tx(async (q) => {
    const r = await rowOf(q, id, true);
    if (archived && r.id === DEFAULT_PROFILE) throw new PackError("The Default profile is never archived: a session started without a profile uses it", 409);
    const status: ProfileStatus = archived ? "archived" : "active";
    if (r.status === status) throw new PackError(`${r.name} is already ${status}`, 409);
    await q.query(`UPDATE agent_profiles SET status = $2, archived_at = ${archived ? "now()" : "NULL"}, updated_by = $3, updated_at = now() WHERE id = $1`, [r.id, status, by]);
    await record(q, r.id, r.version, archived ? "archived" : "restored", by, snapshot(r), snapshot({ ...r, status }));
  });
  return readProfile(id);
}

// ---------------------------------------------------------------- uploads (staff; parts to the object store)

/** A part's most: under the API's one-request size (src/run-harness.ts INLINE_MAX_BYTES, 4 MiB). */
export const UPLOAD_PART_BYTES = 4 * 1024 * 1024;
export const uploadLimitBytes = () => settingNumber("AGENT_UPLOAD_MAX_MB") * 1024 * 1024;
const partKey = (id: string, n: number) => `agent-profiles/uploads/${id}/${Math.trunc(n)}.part`;
const partsOf = (bytes: number) => Math.max(1, Math.ceil(bytes / UPLOAD_PART_BYTES));
/** What a file's first bytes say it is: a program (ELF, Mach-O, PE) or a script (#!), made executable by default. */
export function looksExecutable(head: Buffer): boolean {
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true; // ELF
  const m = head.length >= 4 ? head.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true; // Mach-O (and fat)
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // PE
  return head.length >= 2 && head[0] === 0x23 && head[1] === 0x21; // #!
}
export interface UploadStarted { id: string; parts: number; part_bytes: number }
/** Start an upload of `bytes` (at most the platform's limit): its parts are sent one by one, then it is finished. */
export async function startUpload(by: ProfileActor, input: { bytes?: unknown }): Promise<UploadStarted> {
  needOn();
  const bytes = Number(input.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new PackError("bytes: the file's size", 400);
  if (bytes > uploadLimitBytes()) throw new PackError(`That file is ${mb(bytes)}: a profile's uploads are at most ${mb(uploadLimitBytes())} in all (the platform's AGENT_UPLOAD_MAX_MB)`, 413);
  const id = `upl_${randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
  await tx((q) => q.query("INSERT INTO agent_profile_uploads (id, bytes, parts, created_by) VALUES ($1, $2, $3, $4)", [id, bytes, partsOf(bytes), by]));
  return { id, parts: partsOf(bytes), part_bytes: UPLOAD_PART_BYTES };
}
async function uploadRow(id: string) {
  if (!UPLOAD_ID.test(String(id))) throw new PackError("no such upload", 404);
  const [u] = await read((q) => q.query<{ id: string; bytes: string; parts: number; sha256: string | null; completed_at: Date | null }>(
    "SELECT id, bytes, parts, sha256, completed_at FROM agent_profile_uploads WHERE id = $1", [String(id)]));
  if (!u) throw new PackError("no such upload", 404);
  return { ...u, bytes: Number(u.bytes) };
}
/** One part's bytes (every part but the last is exactly UPLOAD_PART_BYTES). */
export async function putUploadPart(id: string, n: number, body: Buffer): Promise<{ part: number; bytes: number }> {
  needOn();
  const u = await uploadRow(id);
  if (u.completed_at) throw new PackError("This upload is finished: start another to change it", 409);
  if (!Number.isSafeInteger(n) || n < 0 || n >= u.parts) throw new PackError(`part: 0 to ${u.parts - 1}`, 400);
  const want = n < u.parts - 1 ? UPLOAD_PART_BYTES : u.bytes - UPLOAD_PART_BYTES * (u.parts - 1);
  if (body.length !== want) throw new PackError(`part ${n} is ${want} bytes, not ${body.length}`, 400);
  const { objectStore } = await import("./storage.js");
  await (await objectStore()).put(partKey(u.id, n), body, "application/octet-stream");
  return { part: n, bytes: body.length };
}
/** Finish an upload: every part read back and hashed; its sha256 (when sent) must match. */
export async function completeUpload(id: string, input: { sha256?: unknown }): Promise<{ id: string; bytes: number; sha256: string; executable: boolean }> {
  needOn();
  const u = await uploadRow(id);
  const store = await (await import("./storage.js")).objectStore();
  const h = createHash("sha256");
  let head: Buffer = Buffer.alloc(0);
  for (let n = 0; n < u.parts; n++) {
    const b = await store.get(partKey(u.id, n));
    if (!b) throw new PackError(`part ${n} of this upload was never sent`, 409);
    if (n === 0) head = b.subarray(0, 8);
    h.update(b);
  }
  const sha = h.digest("hex");
  if (typeof input.sha256 === "string" && input.sha256 && input.sha256.toLowerCase() !== sha) throw new PackError("The file that arrived is not the one sent (its sha256 differs): add it again", 400);
  await tx((q) => q.query("UPDATE agent_profile_uploads SET sha256 = $2, completed_at = coalesce(completed_at, now()) WHERE id = $1", [u.id, sha]));
  return { id: u.id, bytes: u.bytes, sha256: sha, executable: looksExecutable(head) };
}
/** One part of a finished upload (a wake fetching what its session froze: src/harness-sessions.ts wakeUploadPart). */
export async function readUploadPart(id: string, n: number): Promise<Buffer> {
  const u = await uploadRow(id);
  if (!u.completed_at) throw new PackError("this upload is not finished", 409);
  if (!Number.isSafeInteger(n) || n < 0 || n >= u.parts) throw new PackError(`part: 0 to ${u.parts - 1}`, 400);
  const b = await (await (await import("./storage.js")).objectStore()).get(partKey(u.id, n));
  if (!b) throw new PackError("this upload's bytes are gone from the object store", 410);
  return b;
}
export const uploadParts = (bytes: number) => partsOf(bytes);
/**
 * mold_v0-271: bytes already in hand kept as one finished upload (a file of an agent's recipe proposal, src/recipes.ts),
 * stored exactly as a staff upload's parts are.
 */
export async function storeUploadBytes(by: ProfileActor, data: Buffer): Promise<{ id: string; bytes: number; sha256: string; executable: boolean }> {
  if (data.length > uploadLimitBytes()) throw new PackError(`That file is ${mb(data.length)}: at most ${mb(uploadLimitBytes())} (the platform's AGENT_UPLOAD_MAX_MB)`, 413);
  const id = `upl_${randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`, parts = partsOf(data.length);
  await tx((q) => q.query("INSERT INTO agent_profile_uploads (id, bytes, parts, created_by) VALUES ($1, $2, $3, $4)", [id, data.length, parts, by]));
  const store = await (await import("./storage.js")).objectStore();
  for (let n = 0; n < parts; n++) await store.put(partKey(id, n), data.subarray(n * UPLOAD_PART_BYTES, (n + 1) * UPLOAD_PART_BYTES), "application/octet-stream");
  const sha256 = createHash("sha256").update(data).digest("hex");
  await tx((q) => q.query("UPDATE agent_profile_uploads SET sha256 = $2, completed_at = now() WHERE id = $1", [id, sha256]));
  return { id, bytes: data.length, sha256, executable: looksExecutable(data.subarray(0, 8)) };
}
/** mold_v0-271: a finished upload's bytes, whole and checked against its sha256 (staff downloading a recipe's file). */
export async function readUploadBytes(id: string): Promise<Buffer> {
  const u = await uploadRow(id);
  if (!u.completed_at || !u.sha256) throw new PackError("this upload is not finished", 409);
  const parts: Buffer[] = [];
  for (let n = 0; n < u.parts; n++) parts.push(await readUploadPart(id, n));
  const data = Buffer.concat(parts);
  if (createHash("sha256").update(data).digest("hex") !== u.sha256) throw new PackError("this upload's bytes do not match its sha256", 410);
  return data;
}

// ---------------------------------------------------------------- starting a session with one

/** A profile resolved for a session about to start: its row and what it resolves to. Refused with why. */
export async function profileForStart(id: string | null | undefined, actor: { kind: string; role: AccountRole | null }): Promise<{ row: ProfileRow; eff: Effective }> {
  needOn();
  await ensureProfiles();
  const row = await read((q) => rowOf(q, id && String(id).trim() ? String(id).trim() : DEFAULT_PROFILE));
  if (row.status === "archived") throw new PackError(`The ${row.name} profile is archived: no new session starts with it`, 409);
  if (!mayStart(actor)) throw new PackError("Your role cannot start agent sessions. Ask an account owner to change it on the Team page.", 403);
  const eff = effectiveOf(row.config ?? {});
  if (eff.from.harness === "profile" && !pinnedFlavours().some((f) => f.id === eff.harness)) throw new PackError(`The ${row.name} profile runs a harness this platform no longer runs (${eff.harness})`, 409);
  // A model the profile names was priced when it was saved; a price removed since refuses the start here. The platform
  // setting's model is the gateway's to refuse, as before profiles.
  const { hasPrice } = await import("./usage.js");
  if (eff.from.model !== "setting" && !(await hasPrice(eff.model))) { const { unpricedModel } = await import("./gateway.js"); throw new PackError(unpricedModel(eff.model), 409); }
  return { row, eff };
}

/** What the Start a session dialog offers a person: the active profiles they may start, each with its terms for them. */
export interface StartableProfile {
  id: string; name: string; description: string; version: number; is_default: boolean; harness: string; model: string;
  budget: { default_usd: number; max_usd: number; ceiling_usd: number }; keys: number; uploads: number; governance: string;
}
export async function startableProfiles(actor: { kind: string; role: AccountRole | null }, ceilingOf: () => Promise<{ default_usd: number; max_usd: number; ceiling_usd: number }>): Promise<StartableProfile[]> {
  needOn();
  await ensureProfiles();
  if (!mayStart(actor)) return [];
  const rows = await read((q) => q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles WHERE status = 'active' ORDER BY (id = 'default') DESC, lower(name), id`));
  const budget = await ceilingOf();
  return rows.map((r) => {
    const eff = effectiveOf(r.config ?? {});
    return { id: r.id, name: r.name, description: r.description, version: r.version, is_default: r.id === DEFAULT_PROFILE, harness: flavourOf(eff.harness)?.label ?? eff.harness,
      model: eff.model, budget, keys: eff.keys.length, uploads: eff.uploads.length, governance: governanceWords(eff.governance) };
  });
}

/**
 * A record page's start_agent action as this person may take it (mold_v0-261; src/record-page-routes.ts): null when the
 * profile is unknown or the person may not start sessions (the action is not shown), else the profile and why it is
 * disabled, if it is (archived, or its model has no price).
 */
export async function profileOffer(id: string, _orgId: number, actor: { kind: string; role: AccountRole | null }): Promise<{ id: string; name: string; version: number; disabled: string | null } | null> {
  if (!agentHarnessOn()) return null;
  await ensureProfiles();
  const [row] = await read((q) => q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles WHERE id = $1`, [String(id)]));
  if (!row || !mayStart(actor)) return null;
  const eff = effectiveOf(row.config ?? {});
  const { hasPrice } = await import("./usage.js");
  const disabled = row.status === "archived" ? `The ${row.name} profile is archived: no new session starts with it.`
    : eff.from.model !== "setting" && !(await hasPrice(eff.model)) ? `The ${row.name} profile's model (${eff.model}) has no price yet, so no session can start with it.` : null;
  return { id: row.id, name: row.name, version: row.version, disabled };
}

// ---------------------------------------------------------------- what the editor offers

/**
 * The editor's choices (src/agent-routes.ts GET /agent-profiles): the harnesses this platform runs, each provider a
 * harness speaks to with its key vault entries, the priced models, the keys a session may be given (the workspace
 * credentials of this build, the platform's vault entries), the upload limit and the longest retention.
 */
export async function editorChoices() {
  needOn();
  const { credentialSpecs, findCredential } = await import("./credentials.js");
  const { providerName } = await import("./vault-providers.js");
  const vault = await vaultEntries();
  const models = (await read((q) => q.query<{ model: string }>("SELECT model FROM model_prices ORDER BY model"))).map((m) => m.model);
  const harnesses = pinnedFlavours().map((f) => ({ id: f.id, label: f.label, providers: f.providers }));
  const providers = [...new Set(AGENT_FLAVOURS.flatMap((f) => f.providers))].map((p) => ({ id: p, name: providerName(p),
    keys: vault.filter((v) => v.provider === p).map((v) => ({ label: v.label, hint: v.hint, enabled: v.enabled })) }));
  const workspace = credentialSpecs().filter((s) => findCredential("_agent", `${s.pack}/${s.name}`)).map((s) => ({ name: `${s.pack}/${s.name}`, label: s.label }));
  const platform = vault.filter((v) => !(KEYS_NEVER_INJECTED as readonly string[]).includes(v.provider))
    .map((v) => ({ provider: v.provider, provider_name: providerName(v.provider), label: v.label, hint: v.hint, enabled: v.enabled }));
  const s = effectiveOf({});
  // mold_v0-271: the workspace recipes a profile may name (active ones, with their latest version), only while they are on.
  const R = await import("./recipes.js");
  const recipes = R.recipesOn() ? (await R.listRecipes()).filter((r) => r.status === "active" && r.version > 0).map((r) => ({ id: r.id, name: r.name, version: r.version, files: r.files, bytes: r.bytes })) : null;
  return { harnesses, providers, models, keys: { workspace, platform }, upload_max_bytes: uploadLimitBytes(), part_bytes: UPLOAD_PART_BYTES, ...(recipes ? { recipes } : {}),
    retention_days_max: settingNumber("AGENT_RETENTION_DAYS"), exception_days_max: GOVERNANCE_LIMITS.exception_days,
    settings: { harness: s.harness, provider: s.provider, model: s.model, web_tools: settingText("AGENT_WEB_TOOLS"), web_calls_max: settingNumber("AGENT_WEB_CALLS_MAX") } };
}

/** Whether an exception of a frozen policy is still in force (the session card's words). */
export const exceptionsInForce = (g: Governance | null | undefined) => activeExceptions(g).length;
