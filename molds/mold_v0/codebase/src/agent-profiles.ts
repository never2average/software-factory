/**
 * Workspace agent profiles (mold_v0-261; molds/mold_v0/docs/agent-harness.md "Agent profiles"): named sets of what a
 * session runs with, edited by platform staff in Admin › Agent profiles, every change versioned and audited. The only
 * writer of agent_profiles, agent_profile_versions and agent_profile_changes (sql/migrations/0051_agent_profiles.sql).
 * Nothing here answers unless the app's profile turns `agent_harness` on.
 *
 *   what      a profile's instructions (the standing prompt, the on-start template, the on-resume prompt), its model and
 *             provider (a priced model only: the gateway refuses an unpriced one, mold_v0-246), budget and ceiling, turns
 *             per wake and longest wake, which of the app's tools run freely, ask first or are hidden, web access and its
 *             hosts, files given to the session's workspace (written into its scratch at the start), who may start it
 *             (roles), and per-workspace overrides (a named workspace's own budget, ceiling or model). Every setting it
 *             leaves unset is the platform setting in force (src/settings.ts, group "agent").
 *   default   the Default profile ("default") leaves every setting unset: the existing global settings, as they are. A
 *             session started without a profile uses it. It is never archived.
 *   packs     a pack's pack.json `agent_profiles` are written once (version 1, by "pack <id>") the first time the app
 *             runs with them; staff edit them like any other from then on (the pack's later changes are not written over
 *             theirs).
 *   versions  each save is a new version (agent_profile_versions); a session freezes the version it started with
 *             (harness_sessions.profile_id, profile_version, and its policy). A save names the version it edited: one
 *             made meanwhile is refused (409), never overwritten.
 *   audit     each change (created, edited, archived, restored) is kept with who made it and the profile before and after
 *             (agent_profile_changes), beside the staff log line (src/admin.ts log) the routes write.
 *   start     src/harness-sessions.ts startSession resolves the profile for the workspace (profileForStart): refused
 *             when it is unknown, archived, not for the person's role, or its model has no price; the session freezes
 *             what it resolved.
 */
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { settingNumber, settingText } from "./settings.js";
import { ACCOUNT_ROLE_LABELS, canAccount, type AccountRole } from "./account-roles.js";
import { AGENT_FLAVOURS, agentHarnessOn, flavourOf, type WebTools } from "./agent-harness-config.js";
import { configProblems, DEFAULT_PROFILE, PROFILE_ID, PROFILE_LIMITS, PROFILE_ROLES, ProfileConfigSchema, type PackAgentProfile, type ProfileConfig } from "./agent-profile-spec.js";

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

// ---------------------------------------------------------------- what a profile resolves to

export type ToolsBase = "reads" | "reads_and_named" | "all" | "none";
/** Where a resolved value came from: the profile, the workspace's override, or the platform setting. */
export type From = "profile" | "workspace" | "setting";
export interface Effective {
  model: string; provider: string; budget_usd: number; ceiling_usd: number; max_turns: number; wake_max_minutes: number;
  web: { tools: WebTools; hosts: string[] };
  /** How the app's own tools are used: the base (reads, every tool, none), then free (without asking), ask (first), hidden (never listed). */
  tools: { base: ToolsBase; free: string[]; ask: string[]; hidden: string[] };
  roles: AccountRole[];
  instructions: { append_system: string | null; on_start: string | null; on_resume: string | null };
  files: { path: string; content: string }[];
  from: Record<"model" | "provider" | "budget_usd" | "ceiling_usd" | "max_turns" | "wake_max_minutes" | "web" | "tools" | "roles", From>;
  /** The workspace whose override applied, or null. */
  workspace: string | null;
}
const hostList = (s: string) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const money = (v: number) => Math.round(v * 100) / 100;

/** What a profile's config resolves to for workspace `slug` (null: none), each unset setting the platform's in force. */
export function effectiveOf(c: ProfileConfig, slug: string | null = null): Effective {
  const o = slug ? (c.overrides ?? []).find((x) => x.workspace === slug) ?? null : null;
  const pick = <T>(own: T | null | undefined, over: T | undefined, setting: () => T): [T, From] =>
    over !== undefined ? [over, "workspace"] : own !== null && own !== undefined ? [own, "profile"] : [setting(), "setting"];
  const [model, mf] = pick(c.model, o?.model, () => settingText("AGENT_MODEL"));
  const flavour = flavourOf(settingText("AGENT_HARNESS")) ?? AGENT_FLAVOURS[0]!;
  const [provider0, pf] = pick(c.provider, undefined, () => settingText("AGENT_PROVIDER"));
  const provider = flavour.providers.includes(provider0) ? provider0 : flavour.providers[0]!;
  const [ceiling, cf] = pick(c.ceiling_usd, o?.ceiling_usd, () => settingNumber("AGENT_BUDGET_CEILING_USD"));
  const [budget0, bf] = pick(c.budget_usd, o?.budget_usd, () => settingNumber("AGENT_SESSION_BUDGET_USD"));
  const [turns, tf] = pick(c.max_turns, undefined, () => settingNumber("AGENT_MAX_TURNS"));
  const [wake, wf] = pick(c.wake_max_minutes, undefined, () => settingNumber("AGENT_WAKE_MAX_MINUTES"));
  const webOwn = c.web?.tools ?? null, hostsOwn = c.web?.hosts ?? null;
  const webSetting = settingText("AGENT_WEB_TOOLS") as WebTools;
  const web = { tools: (webOwn ?? (["fetch", "search"].includes(webSetting) ? webSetting : "off")) as WebTools, hosts: hostsOwn ?? hostList(settingText("AGENT_WEB_HOSTS")) };
  const settingBase = settingText("AGENT_WORKSPACE_TOOLS");
  const base: ToolsBase = c.tools?.base ?? (settingBase === "all" || settingBase === "reads_and_named" ? settingBase : "reads");
  const named = !c.tools?.base && base === "reads_and_named" ? settingText("AGENT_WORKSPACE_TOOLS_NAMED").split(",").map((x) => x.trim()).filter(Boolean) : [];
  const hidden = [...new Set(c.tools?.hidden ?? [])], ask = [...new Set(c.tools?.ask ?? [])].filter((t) => !hidden.includes(t));
  const free = [...new Set([...named, ...(c.tools?.free ?? [])])].filter((t) => !hidden.includes(t) && !ask.includes(t));
  return {
    model, provider, ceiling_usd: ceiling, budget_usd: money(Math.min(budget0, ceiling)), max_turns: turns, wake_max_minutes: wake, web,
    tools: { base, free, ask, hidden },
    roles: (c.roles?.length ? c.roles : [...PROFILE_ROLES]) as AccountRole[],
    instructions: { append_system: c.instructions?.append_system?.trim() || null, on_start: c.instructions?.on_start?.trim() || null, on_resume: c.instructions?.on_resume?.trim() || null },
    files: (c.files ?? []).map((f) => ({ path: f.path, content: f.content })),
    from: { model: mf, provider: pf, budget_usd: bf, ceiling_usd: cf, max_turns: tf, wake_max_minutes: wf, web: webOwn || hostsOwn ? "profile" : "setting",
      tools: c.tools?.base || c.tools?.free?.length || c.tools?.ask?.length || c.tools?.hidden?.length ? "profile" : "setting", roles: c.roles?.length ? "profile" : "setting" },
    workspace: o ? o.workspace : null,
  };
}

/** Whether this person (or an account key) may start a session with it: its roles, and the role's own right to launch. */
export function mayStart(e: Pick<Effective, "roles">, actor: { kind: string; role: AccountRole | null }): boolean {
  if (actor.kind === "key") return e.roles.includes("owner");
  if (actor.kind !== "person") return false;
  return !!actor.role && canAccount(actor.role, "launch") && e.roles.includes(actor.role);
}
const rolesWords = (roles: readonly string[]) => roles.map((r) => (ACCOUNT_ROLE_LABELS[r as AccountRole] ?? r).toLowerCase() + "s").join(", ").replace(/, ([^,]*)$/, " and $1");

// ---------------------------------------------------------------- seeding: the Default profile and the packs'

const DEFAULT_ROW = { name: "Default", description: "The platform's agent settings as they are (Admin › Agent configuration): a session started without a profile runs with these. Any setting set here takes their place." };
let seeded: unknown = null;
/** The packs' declared profiles (pack.json agent_profiles), with their pack. */
async function packProfiles(): Promise<{ pack: string; p: PackAgentProfile }[]> {
  const { packs } = await import("./packs.js");
  return packs().flatMap((x) => (x.definition.agentProfiles ?? []).map((p) => ({ pack: x.id, p: p as PackAgentProfile })));
}
/** Write the Default profile and each pack's that is not there yet (once per set of packs; idempotent). */
export async function ensureProfiles(): Promise<void> {
  const { packs } = await import("./packs.js");
  const key = packs();
  if (seeded === key) return;
  const wanted = [{ id: DEFAULT_PROFILE, name: DEFAULT_ROW.name, description: DEFAULT_ROW.description, source: "platform", config: {} as ProfileConfig, by: "the platform" },
    ...(await packProfiles()).map(({ pack, p }) => {
      const { id, name, description, $comment: _c, ...config } = p;
      return { id, name, description: description ?? "", source: `pack:${pack}`, config: ProfileConfigSchema.parse(config), by: `pack ${pack}` };
    })];
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

export interface ProfileSummary {
  id: string; name: string; description: string; version: number; status: ProfileStatus; source: "platform" | "pack"; pack: string | null; is_default: boolean;
  model: string; budget_usd: number; ceiling_usd: number; roles: AccountRole[]; tools: { base: ToolsBase; free: number; ask: number; hidden: number };
  web: WebTools; files: number; overrides: number; sessions: number; updated_at: string; updated_by: string;
}
const sourceOf = (s: string) => (s.startsWith("pack:") ? { source: "pack" as const, pack: s.slice(5) } : { source: "platform" as const, pack: null });
function summary(r: ProfileRow, sessions = 0): ProfileSummary {
  const e = effectiveOf(r.config ?? {});
  return { id: r.id, name: r.name, description: r.description, version: r.version, status: r.status, ...sourceOf(r.source), is_default: r.id === DEFAULT_PROFILE,
    model: e.model, budget_usd: e.budget_usd, ceiling_usd: e.ceiling_usd, roles: e.roles, tools: { base: e.tools.base, free: e.tools.free.length, ask: e.tools.ask.length, hidden: e.tools.hidden.length },
    web: e.web.tools, files: e.files.length, overrides: (r.config?.overrides ?? []).length, sessions, updated_at: iso(r.updated_at)!, updated_by: r.updated_by };
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

/** Staff: one profile, what it resolves to with no workspace's override, its versions and its changes (newest first). */
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

export interface ProfileInput { id?: unknown; name?: unknown; description?: unknown; config?: unknown; version?: unknown; copy_of?: unknown }

/** A config as staff send it, checked: its shape, what its shape cannot say, priced models, provider, the named workspaces. */
export async function checkConfig(raw: unknown): Promise<ProfileConfig> {
  const r = ProfileConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new PackError(r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ").slice(0, 2000), 400);
  const c = r.data;
  const problems = configProblems(c);
  const providers = [...new Set(AGENT_FLAVOURS.flatMap((f) => f.providers))];
  if (c.provider && !providers.includes(c.provider)) problems.push(`provider: ${c.provider} is not one the harness speaks to (${providers.join(", ")})`);
  const { hasPrice } = await import("./usage.js");
  const { unpricedModel } = await import("./gateway.js");
  for (const m of [...new Set([c.model, ...(c.overrides ?? []).map((o) => o.model)].filter((x): x is string => !!x))])
    if (!(await hasPrice(m))) problems.push(`model: ${unpricedModel(m)}`);
  const slugs = [...new Set((c.overrides ?? []).map((o) => o.workspace))];
  if (slugs.length) {
    const found = new Set((await read((q) => q.query<{ slug: string }>("/* tenant: platform staff, workspaces by slug */ SELECT slug FROM organizations WHERE slug = ANY ($1::text[])", [slugs]))).map((x) => x.slug));
    for (const s of slugs) if (!found.has(s)) problems.push(`overrides: no workspace is called ${s}`);
  }
  if (problems.length) throw new PackError(problems.join("; ").slice(0, 2000), 400);
  // Unset values are left out, so a profile stores only what it sets.
  return prune(c);
}
function prune(c: ProfileConfig): ProfileConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { if (v.length) out[k] = v; continue; }
    if (typeof v === "object") {
      // An empty host list is kept (web on, asking for each host); any other empty value is unset (the setting).
      const inner = Object.fromEntries(Object.entries(v).filter(([n, x]) => x !== null && x !== undefined && x !== "" && !(Array.isArray(x) && !x.length && !(k === "web" && n === "hosts"))));
      if (Object.keys(inner).length) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out as ProfileConfig;
}
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
  let raw = input.config;
  if (raw === undefined && typeof input.copy_of === "string") raw = (await read((q) => rowOf(q, String(input.copy_of)))).config;
  const config = await checkConfig(raw ?? {});
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
  const config = await checkConfig(input.config);
  const expected = Number(input.version);
  if (!Number.isSafeInteger(expected) || expected < 1) throw new PackError("version: the version you edited (it is refused when someone saved a newer one meanwhile)", 400);
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

// ---------------------------------------------------------------- starting a session with one

/** A profile resolved for a session about to start in workspace `slug`: its row, what it resolves to. Refused with why. */
export async function profileForStart(id: string | null | undefined, slug: string | null, actor: { kind: string; role: AccountRole | null }): Promise<{ row: ProfileRow; eff: Effective }> {
  needOn();
  await ensureProfiles();
  const row = await read((q) => rowOf(q, id && String(id).trim() ? String(id).trim() : DEFAULT_PROFILE));
  if (row.status === "archived") throw new PackError(`The ${row.name} profile is archived: no new session starts with it`, 409);
  const eff = effectiveOf(row.config ?? {}, slug);
  if (!mayStart(eff, actor)) throw new PackError(actor.kind === "key"
    ? `The ${row.name} profile is for ${rolesWords(eff.roles)}: an account key starts only a profile owners may start`
    : `The ${row.name} profile is for ${rolesWords(eff.roles)}: your role (${actor.role ? ACCOUNT_ROLE_LABELS[actor.role].toLowerCase() : "none"}) cannot start it`, 403);
  // A model the profile (or the workspace's override) names was priced when it was saved; a price removed since refuses
  // the start here. The platform setting's model is the gateway's to refuse, as before profiles.
  const { hasPrice } = await import("./usage.js");
  if (eff.from.model !== "setting" && !(await hasPrice(eff.model))) { const { unpricedModel } = await import("./gateway.js"); throw new PackError(unpricedModel(eff.model), 409); }
  return { row, eff };
}

/** What the Start a session dialog offers a person: the active profiles they may start, each with its terms for them. */
export interface StartableProfile {
  id: string; name: string; description: string; version: number; is_default: boolean; model: string;
  budget: { default_usd: number; max_usd: number; ceiling_usd: number }; tools: ToolsBase; web: WebTools; files: number;
}
export async function startableProfiles(slug: string | null, actor: { kind: string; role: AccountRole | null }, ceilingOf: (eff: Effective) => Promise<{ default_usd: number; max_usd: number; ceiling_usd: number }>): Promise<StartableProfile[]> {
  needOn();
  await ensureProfiles();
  const rows = await read((q) => q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles WHERE status = 'active' ORDER BY (id = 'default') DESC, lower(name), id`));
  const out: StartableProfile[] = [];
  for (const r of rows) {
    const eff = effectiveOf(r.config ?? {}, slug);
    if (!mayStart(eff, actor)) continue;
    out.push({ id: r.id, name: r.name, description: r.description, version: r.version, is_default: r.id === DEFAULT_PROFILE, model: eff.model,
      budget: await ceilingOf(eff), tools: eff.tools.base, web: eff.web.tools, files: eff.files.length });
  }
  return out;
}

/**
 * A record page's start_agent action as this person may take it (mold_v0-261; src/record-page-routes.ts): null when the
 * profile is unknown or not for their role (the action is not shown), else the profile and why it is disabled, if it is
 * (archived, or its model has no price for this workspace).
 */
export async function profileOffer(id: string, orgId: number, actor: { kind: string; role: AccountRole | null }): Promise<{ id: string; name: string; version: number; disabled: string | null } | null> {
  if (!agentHarnessOn()) return null;
  await ensureProfiles();
  const [row] = await read((q) => q.query<ProfileRow>(`SELECT ${COLS} FROM agent_profiles WHERE id = $1`, [String(id)]));
  if (!row) return null;
  const [ws] = await read((q) => q.query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [orgId]));
  const eff = effectiveOf(row.config ?? {}, ws?.slug ?? null);
  if (!mayStart(eff, actor)) return null;
  const { hasPrice } = await import("./usage.js");
  const disabled = row.status === "archived" ? `The ${row.name} profile is archived: no new session starts with it.`
    : eff.from.model !== "setting" && !(await hasPrice(eff.model)) ? `The ${row.name} profile's model (${eff.model}) has no price yet, so no session can start with it.` : null;
  return { id: row.id, name: row.name, version: row.version, disabled };
}
