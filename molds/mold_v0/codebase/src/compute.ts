import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { fill } from "./vocabulary.js";
import * as kv from "./keyvault.js";
import { AUTOSCALE, computeDemand, kickConfigured, type TickState } from "./autoscaler.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { currentPopulation } from "./agent-mix.js";
import { ENGINE_SETTINGS, listSettings } from "./settings.js";
import { classifySession } from "./error-classes.js";
import { directKeysAllowed, HARNESS_ENV, ORCHESTRATOR_ONLY_PROVIDERS } from "./gateway.js";
import { BOAT, BOAT_PRICE_PER_HOUR } from "../orchestrator/core/config.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";
import { ENV, legacyEnvName } from "./env-names.js";

/**
 * The admin Compute page's server side (docs/compute-and-traces-spec.md §2): one summary that answers "is compute
 * healthy, is work flowing, what is stuck, and why" from what already exists: the last autoscaler tick (its lease row),
 * orchestrator_sandboxes, agent_sessions, product_research, gateway spend, compute_events and boat's own listing.
 * Read only: nothing here launches, deletes or changes anything.
 *
 * boat.dev is asked through two caches, so a page refreshing every 15 s does not hammer it: the sandbox listing for
 * 30 s and the plan limits for 5 min, each with an 8 s timeout. When boat does not answer, the last good value is
 * served marked stale (or just the error), and everything backed by the database still renders.
 */

const env = ENV;
const MIN = 60_000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const usd = (x: number) => Math.round(x * 10_000) / 10_000;

// ---------------------------------------------------------------- cached boat calls

export interface Fetched<T> {
  /** A value is there (fresh, or the last good one when `stale`). */
  ok: boolean;
  stale: boolean;
  error: string | null;
  /** When the value was fetched. */
  at: string | null;
  value: T | null;
}

/** Reject after `ms` with a plain-English error, so a hung boat call never holds the page. */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "boat.dev"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * A fetch with an in-process cache and a timeout. A fresh value is reused for `ttlMs`; a failure is remembered for
 * `ttlMs` too (a down boat is not asked again on every refresh), and serves the last good value marked stale.
 * Concurrent callers share one call. `force` skips both caches (the page's "Test connection").
 */
export function cachedFetch<T>(fetch: () => Promise<T>, opts: { ttlMs: number; timeoutMs: number; what?: string }) {
  let good: { at: number; value: T } | null = null;
  let failed: { at: number; error: string } | null = null;
  let inflight: Promise<Fetched<T>> | null = null;
  const result = (): Fetched<T> => {
    const fresh = good && (!failed || failed.at < good.at);
    return { ok: !!good, stale: !!good && !fresh, error: fresh ? null : failed?.error ?? null, at: good ? new Date(good.at).toISOString() : null, value: good?.value ?? null };
  };
  const get = (force = false): Promise<Fetched<T>> => {
    const now = Date.now(), last = Math.max(good?.at ?? 0, failed?.at ?? 0);
    if (!force && last && now - last < opts.ttlMs) return Promise.resolve(result());
    inflight ??= withTimeout(fetch(), opts.timeoutMs, opts.what)
      .then((value) => { good = { at: Date.now(), value }; failed = null; })
      .catch((e) => { failed = { at: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 300) }; })
      .then(result)
      .finally(() => { inflight = null; });
    return inflight;
  };
  return Object.assign(get, { reset: () => { good = null; failed = null; } });
}

// The boat key from the vault, re-read every 10 minutes (as the autoscaler does). No key: boat is not asked at all.
let keyAt = 0;
async function boatKey() {
  if (BOAT.apiKey && Date.now() - keyAt < 10 * MIN) return;
  BOAT.apiKey = (await kv.useCredential("boat")).secret;
  keyAt = Date.now();
}

const listing = cachedFetch(async () => { await boatKey(); return lib.listSandboxes(); }, { ttlMs: 30_000, timeoutMs: 8_000 });
const limits = cachedFetch(async () => { await boatKey(); return lib.boatLimits(); }, { ttlMs: 5 * MIN, timeoutMs: 8_000 });

// ---------------------------------------------------------------- the boat listing, classified

export type SandboxKind = "orchestrator" | "worker" | "image_builder" | "image" | "other";
export interface ClassifiedSandbox extends lib.Sb {
  kind: SandboxKind;
  live: boolean;
  /** Workers: the orchestrator the name says it belongs to (`${ns}-w-<orchId>-<agent>`). */
  parent_orchestrator_id: string | null;
  /** Other deployments' sandboxes: the first part of the name ("octv"), or "(unnamed)". */
  prefix: string | null;
}

/**
 * Sort boat's sandboxes by name: ours are `${ns}-orch-…` (orchestrators), `${ns}-orch-img-…` (snapshot images),
 * `${ns}-img-build` (the image builder) and `${ns}-w-<orchId>-<agent>` (workers); everything else belongs to another
 * deployment on the same boat account. A worker's parent is matched against the orchestrator ids we know first (ids
 * may hold dashes), then read from the name.
 */
export function classifySandboxNames(list: lib.Sb[], ns: string = lib.BOAT_NAMESPACE, orchestratorIds: string[] = []): ClassifiedSandbox[] {
  const orchPrefix = `${ns}-orch-`, imagePrefix = `${ns}-orch-img-`, builder = `${ns}-img-build`, workerPrefix = `${ns}-w-`;
  const workerOf = (id: string) => `${workerPrefix}${id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const known = orchestratorIds.map((id) => ({ id, prefix: `${workerOf(id)}-` }));
  return list.map((s) => {
    const name = s.name ?? "";
    const base = { ...s, live: lib.isLive(s), parent_orchestrator_id: null, prefix: null };
    if (name.startsWith(imagePrefix)) return { ...base, kind: "image" as const };
    if (name.startsWith(orchPrefix)) return { ...base, kind: "orchestrator" as const };
    if (name === builder) return { ...base, kind: "image_builder" as const };
    if (name.startsWith(workerPrefix)) {
      const parent = known.find((k) => name.startsWith(k.prefix))?.id ?? /^[^-]+-w-(orch-[a-z0-9]+)-/.exec(name)?.[1] ?? null;
      return { ...base, kind: "worker" as const, parent_orchestrator_id: parent };
    }
    return { ...base, kind: "other" as const, prefix: name ? name.split("-")[0]! : "(unnamed)" };
  });
}

export interface SandboxListing { ok: boolean; stale: boolean; error: string | null; at: string | null; sandboxes: ClassifiedSandbox[] }

/** boat's live listing (30 s cache, 8 s timeout), each sandbox classified against our live orchestrator rows. */
export async function classifiedSandboxes(opts: { force?: boolean } = {}): Promise<SandboxListing> {
  const [r, rows] = await Promise.all([
    listing(opts.force),
    getDb().then((db) => db.query<{ orchestrator_id: string }>("SELECT orchestrator_id FROM orchestrator_sandboxes WHERE state <> 'deleted' AND orchestrator_id IS NOT NULL")),
  ]);
  return { ok: r.ok, stale: r.stale, error: r.error, at: r.at,
    sandboxes: classifySandboxNames(r.value ?? [], lib.BOAT_NAMESPACE, rows.map((x) => x.orchestrator_id)) };
}

/** For tests: forget what boat said. */
export function resetComputeCaches() { listing.reset(); limits.reset(); summaryCache = null; keyAt = 0; }

// ---------------------------------------------------------------- which agents lack a key

/**
 * For each scheduled agent (and its model variants): the env vars its sessions need (registry `requires_env`, else
 * the harness default) that no enabled vault provider the broker may hand out covers. The same rule as
 * `brokerSessionCredentials`, so an agent listed here fails with "No vault provider supplies …" when it runs.
 */
export async function agentKeyCoverage(): Promise<{ agent_id: string; harness: string; missing_env: string[] }[]> {
  let agents: { id: string; harness: string; requires_env?: string[] }[] = [];
  try { agents = scheduledAgents(await currentPopulation()).flatMap((a) => [a, ...variantsOf(a).filter((v) => v.id !== a.id)]); }
  catch { return []; }
  const needsOf = (a: { harness: string; requires_env?: string[] }) => (a.requires_env?.length ? a.requires_env : HARNESS_ENV[a.harness] ?? []);
  const all = [...new Set(agents.flatMap(needsOf))];
  const providers = (await kv.providersForEnv(all))
    .filter((p) => p.mode === "gateway" || (directKeysAllowed() && !ORCHESTRATOR_ONLY_PROVIDERS.has(p.slug)));
  const seen = new Set<string>();
  return agents.filter((a) => !seen.has(a.id) && seen.add(a.id)).map((a) => ({
    agent_id: a.id, harness: a.harness, missing_env: needsOf(a).filter((v) => !providers.some((p) => p.env_vars.includes(v))),
  }));
}

// ---------------------------------------------------------------- verdict (pure; smoke-tested)

export type Level = "red" | "amber" | "green";
export interface Verdict { level: Level; code: string; text: string; href: string | null }

/** Everything the verdict rules read, gathered by computeSummary. */
export interface VerdictFacts {
  enabled: boolean; runtime: "vm" | "vercel"; kick_configured: boolean;
  has_boat_key: boolean; boat_error: string | null;
  tick: { age_s: number | null; error: string | null; note: string | null };
  queue: { sessions: number; research: number; oldest_session_age_s: number | null; oldest_research_age_s: number | null; unclaimable: number };
  running: { sessions: number; orchestrators: number };
  others: number; free: number | null;
  per_job: boolean; job_orch_live: number; job_orch_cap: number;
  not_checking_in: number;
  launch_failures_1h: { count: number; step: string | null; message: string | null };
  missing_keys: { agent_id: string; missing_env: string[] }[];
  leaked_workers: number;
  orphan_deletes_24h: number; namespace: string;
  idle_orchestrators: number;
}

const mins = (s: number) => Math.max(1, Math.round(s / 60));
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const ago = (s: number | null) => (s == null ? "none" : s < 90 ? `${Math.round(s)} s` : `${mins(s)} min`);

/**
 * The verdict rules, worst first, in the spec's order (§2.2 B). Every true rule is returned; the page shows the first
 * and folds the rest under "+N more". With none true: one green line.
 */
export function computeVerdict(f: VerdictFacts): Verdict[] {
  const out: Verdict[] = [];
  const add = (level: Level, code: string, text: string, href: string | null) => out.push({ level, code, text, href });
  const queued = f.queue.sessions + f.queue.research;
  const note = f.tick.note ?? "";
  if (!f.enabled) add("red", "autoscale_off", "The autoscaler is off. Queued work will not get orchestrators.", "#environment");
  if (f.runtime === "vercel" && f.enabled && !f.kick_configured)
    add("red", "kick_unconfigured", "This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset.", "#environment");
  // Without a key boat is never asked, so "not answering" would only repeat the missing key.
  if (f.has_boat_key && f.boat_error) add("red", "boat_down", `boat.dev is not answering: ${f.boat_error}`, "/admin/keys");
  if (!f.has_boat_key) add("red", "no_boat_key", "No boat key. Add one in Key vault.", "/admin/keys");
  if (f.tick.error) add("red", "tick_error", `The last tick failed: ${f.tick.error}`, "/admin/compute?section=decisions&has=error");
  if (f.enabled && queued > 0 && (f.tick.age_s == null || f.tick.age_s > 600)) {
    const what = [f.queue.sessions && plural(f.queue.sessions, "session"), f.queue.research && plural(f.queue.research, "research job")].filter(Boolean).join(" and ");
    add("red", "tick_stale", `${what} ${queued === 1 ? "is" : "are"} queued but ${f.tick.age_s == null ? "the autoscaler has never ticked" : `nothing has ticked for ${mins(f.tick.age_s)} min`}.`, "#tick");
  }
  const oldS = f.queue.oldest_session_age_s ?? 0, oldR = f.queue.oldest_research_age_s ?? 0;
  if (oldS > 15 * 60 || oldR > 20 * 60)
    add("amber", "queue_old", oldS > 15 * 60 ? `The oldest queued session has waited ${mins(oldS)} min.` : `The oldest queued research has waited ${mins(oldR)} min.`,
      "/admin/health?section=sessions&status=queued&sort=queued_at");
  if (f.queue.unclaimable > 0)
    add("amber", "unclaimable", `${plural(f.queue.unclaimable, "session")} can never run: ${f.queue.unclaimable === 1 ? "its" : "their"} agent is not in the scheduled population.`,
      "/admin/health?section=sessions&class=unclaimable");
  const plan = /(\S+) waits for boat plan capacity \((\d+) free\)/.exec(note);
  if (plan) add("amber", "plan_capacity", `${plan[1]} waits for boat capacity: ${plan[2]} free, other deployments use ${f.others}.`, "#limits");
  if (f.per_job && f.job_orch_live >= f.job_orch_cap && queued > 0)
    add("amber", "at_cap", `At the orchestrator limit (${f.job_orch_cap}). Raise it in Limits or wait.`, "#limits");
  if (f.not_checking_in > 0)
    add("amber", "not_checking_in", `${plural(f.not_checking_in, "orchestrator")} ${f.not_checking_in === 1 ? "is" : "are"} not checking in.`, "/admin/compute?section=orchestrators&state=stale");
  if (f.launch_failures_1h.count >= 2)
    add("amber", "launch_failures", `${f.launch_failures_1h.count} orchestrator launches failed in the last hour (latest: ${f.launch_failures_1h.step ?? "unknown"}: ${f.launch_failures_1h.message ?? "no message"}).`,
      "/admin/compute?section=failures");
  const cooldown = /cooldown: [^;]*/.exec(note);
  if (cooldown) add("amber", "cooldown", `Relaunch is paused (cooldown): ${cooldown[0].replace(/^cooldown: /, "")}`, "/admin/compute?section=decisions");
  const missing = f.missing_keys.filter((m) => m.missing_env.length);
  if (missing.length) {
    const envs = [...new Set(missing.flatMap((m) => m.missing_env))];
    const names = missing.length > 3 ? `${missing.slice(0, 3).map((m) => m.agent_id).join(", ")} and ${missing.length - 3} more` : missing.map((m) => m.agent_id).join(", ");
    add("amber", "missing_keys", `${names} cannot run: no vault key for ${envs.join(", ")}.`, "/admin/keys");
  }
  if (f.leaked_workers > 0)
    add("amber", "leaked_workers", `${plural(f.leaked_workers, "worker sandbox", "worker sandboxes")} ${f.leaked_workers === 1 ? "is" : "are"} running with no live orchestrator.`,
      "/admin/compute?section=orchestrators&state=unmatched");
  if (f.orphan_deletes_24h > 0)
    add("amber", "namespace_collision", `${plural(f.orphan_deletes_24h, "orchestrator sandbox", "orchestrator sandboxes")} with no row ${f.orphan_deletes_24h === 1 ? "was" : "were"} deleted in 24 h. Another deployment may share namespace ${f.namespace}.`,
      "/admin/compute?section=decisions");
  if (f.idle_orchestrators > 0)
    add("amber", "idle_orch", `${plural(f.idle_orchestrators, "orchestrator")} ${f.idle_orchestrators === 1 ? "is" : "are"} idle but not drained.`, "/admin/compute?section=orchestrators&state=live");
  if (!out.length)
    add("green", "ok", `Compute is healthy. ${plural(f.running.sessions, "session")} running on ${plural(f.running.orchestrators, "orchestrator")}, queue ${queued}${queued ? `, oldest ${ago(Math.max(oldS, oldR))}` : ""}.`, null);
  return out;
}

// ---------------------------------------------------------------- limits (pure; smoke-tested)

export type Binding = "plan" | "job_orch" | "pods" | null;

/**
 * Which ceiling binds. The latest tick's note wins: it names the cap that actually held a job back. Otherwise the
 * boat plan (shared fleet: computeBudget's reason; per job: nothing free while work waits), then the job-orchestrator cap, then pods per orchestrator, each only while
 * work is queued (a full cap with nothing waiting holds nothing back).
 */
export function bindingLimit(x: { note: string | null; budget_reason: string | undefined; queued: number; per_job: boolean; free: number | null;
  job_orch_live: number; job_orch_cap: number; pods_max_reserved: number; pods_cap: number }): Binding {
  if (x.note && x.note.includes(`at ${ENGINE_SETTINGS.maxJobOrchestrators}`)) return "job_orch";
  if (x.note && /waits for boat plan capacity/.test(x.note)) return "plan";
  // Shared fleet: the whole fleet at full pods does not fit the plan. Per job: each orchestrator reserves only its own
  // pods, so the plan binds only when work waits and not one more sandbox is free.
  if (!x.per_job && x.budget_reason) return "plan";
  if (x.per_job && x.queued > 0 && x.free != null && x.free < 1) return "plan";
  if (x.queued > 0 && x.per_job && x.job_orch_live >= x.job_orch_cap) return "job_orch";
  if (x.queued > 0 && x.pods_max_reserved >= x.pods_cap) return "pods";
  return null;
}

/**
 * What is active on the boat account and whose, all from the one sandbox listing (30 s), never mixed with the plan
 * limits' activeNow (cached 5 min): a launch or reap since then would show up as other deployments. Ours is every
 * sandbox named with our namespace: orchestrators, workers, the image builder and images. Without a listing, boat's
 * activeNow less what our rows say we hold (`oursHeld`: live orchestrators plus their running workers).
 */
export function sandboxUsage(sb: { ok: boolean; sandboxes: ClassifiedSandbox[] }, limitsActiveNow: number | null, oursHeld: number) {
  const live = sb.sandboxes.filter((s) => s.live);
  const count = (...kinds: SandboxKind[]) => live.filter((s) => kinds.includes(s.kind)).length;
  const others = live.filter((s) => s.kind === "other");
  return {
    active_now: sb.ok ? live.length : limitsActiveNow,
    ours_orch: count("orchestrator"), ours_workers: count("worker"), ours_images: count("image_builder", "image"),
    others: sb.ok ? others.length : limitsActiveNow != null ? Math.max(0, limitsActiveNow - oursHeld) : 0,
    other_prefixes: [...new Set(others.map((s) => s.prefix!))].sort(),
  };
}

// ---------------------------------------------------------------- environment knobs

const KNOBS: { name: string; def: string; meaning: string }[] = [
  { name: "APP_AUTOSCALE", def: "on", meaning: "Kill switch: off launches and deletes nothing; running orchestrators idle out." },
  { name: "APP_ORCH_PER_JOB", def: "on", meaning: "One orchestrator per {run} or research job, instead of a shared fleet." },
  { name: "APP_AUTOSCALE_TICK_SECONDS", def: "15", meaning: "How often the autoscaler ticks on a VM (Vercel ticks on events instead)." },
  { name: "APP_ORCH_LAUNCHES_PER_TICK", def: "2", meaning: "Most orchestrators launched in one tick." },
  { name: "APP_ORCH_IDLE_MINUTES", def: "10", meaning: "An orchestrator with nothing to claim this long drains and exits." },
  { name: "APP_ORCH_STALE_MINUTES", def: "5", meaning: "A running orchestrator with no check-in this long is deleted." },
  { name: "APP_ORCH_BOOT_MINUTES", def: "10", meaning: "An orchestrator still booting after this long is deleted." },
  { name: "APP_ORCH_SNAPSHOT", def: "off", meaning: "Boot orchestrators from a snapshot image (measured slower than a code upload)." },
  { name: "APP_POD_CAPACITY", def: "20", meaning: "Worker sandboxes per shared orchestrator (per-job mode uses the Limits setting)." },
  { name: "APP_FLEET_STALE_SECONDS", def: "90", meaning: "An orchestrator not seen this long no longer counts as live in the fleet." },
  { name: "APP_RESEARCH_STALE_MINUTES", def: "20", meaning: "Running research with no heartbeat this long gets a new orchestrator." },
  { name: "APP_SESSION_INFRA_RETRIES", def: "1", meaning: "Times a session that failed on infrastructure is queued again." },
  { name: "APP_LEASE_MINUTES", def: "30", meaning: "How long a claimed session is held before it can be claimed again." },
  { name: "MAX_SESSION_MINUTES", def: "45", meaning: "Longest an agent session may run before it is stopped as timed out." },
  { name: "BOAT_TTL_MARGIN_MINUTES", def: "15", meaning: "Extra lifetime a worker sandbox gets beyond the session limit." },
  { name: "BOAT_READY_TIMEOUT_SECONDS", def: "300", meaning: "How long a new sandbox may take to become ready." },
];

/**
 * A knob's name as the Compute page shows it: in a build with the session engine (a host pack's tables) the spelling its
 * admins have always seen, which the server still reads (src/env-names.ts); otherwise the shell's own APP_ name.
 */
const shownName = (n: string) => (sessionEngine() ? legacyEnvName(n) ?? n : n);

export function computeKnobs(runtime: "vm" | "vercel") {
  const set = (k: string) => env[k] !== undefined && env[k] !== "";
  return [
    ...KNOBS.map((k) => ({ name: shownName(k.name), value: set(k.name) ? String(env[k.name]) : k.def, source: set(k.name) ? "env" as const : "default" as const, meaning: fill(k.meaning) })),
    { name: shownName("APP_BOAT_NAMESPACE"), value: lib.BOAT_NAMESPACE, source: set("APP_BOAT_NAMESPACE") ? "env" as const : "default" as const,
      meaning: "Name prefix of this deployment's sandboxes; it only ever touches sandboxes named with it." },
    { name: "Runtime", value: runtime === "vercel" ? "Vercel" : "VM", source: set("VERCEL") ? "env" as const : "default" as const,
      meaning: runtime === "vercel" ? "Serverless: the autoscaler ticks on events and a cron every 5 minutes." : "A long-running server: the autoscaler ticks on a timer." },
    { name: "Kick configured", value: kickConfigured() ? "yes" : "no", source: "env" as const,
      meaning: "Events can trigger a tick: the autoscaler is on, PUBLIC_URL is HTTPS and APP_WORKER_TOKEN is set." },
  ];
}

// ---------------------------------------------------------------- the summary

const HEARTBEAT_STALE_S = 90;
let summaryCache: { at: number; value: Awaited<ReturnType<typeof buildSummary>> } | null = null;

/** GET /compute/summary: cached 5 s; `fresh` asks boat again (the page's Refresh and Test connection). */
export async function computeSummary(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh && summaryCache && Date.now() - summaryCache.at < 5_000) return summaryCache.value;
  const value = await buildSummary(!!opts.fresh);
  summaryCache = { at: Date.now(), value };
  return value;
}

async function buildSummary(fresh: boolean) {
  const db = await getDb();
  const now = Date.now();
  const runtime: "vm" | "vercel" = env.VERCEL ? "vercel" : "vm";
  const perJob = AUTOSCALE.perJob();
  const creds = (await kv.listCredentials() as { provider: string; label: string; hint: string; enabled: boolean; uses: number; last_used_at: Date | null }[])
    .filter((c) => c.provider === "boat");
  const key = creds.find((c) => c.enabled) ?? null;

  const [lease] = await db.query<{ holder: string; state: TickState | null }>("SELECT holder, state FROM autoscaler_lease WHERE name = 'autoscaler'");
  const tick = lease?.state ?? null;
  const tickAge = tick?.at ? Math.max(0, (now - Date.parse(tick.at)) / 1000) : null;

  // Sessions and research are the session engine's, a host pack's tables (mold_v0-049): none in a build without them.
  const eng = sessionEngine();
  const [ses] = !eng ? [{} as Record<string, unknown>] : await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, counts and sums across all orgs, no row data */
     SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
            min(queued_at) FILTER (WHERE status = 'queued') AS oldest_queued,
            count(DISTINCT simulation_id) FILTER (WHERE status = 'queued') AS queued_jobs,
            count(*) FILTER (WHERE status = 'running') AS running,
            count(*) FILTER (WHERE status IN ('failed', 'timeout') AND ended_at > now() - interval '24 hours') AS failed_24h,
            count(*) FILTER (WHERE ended_at > now() - interval '24 hours') AS ended_24h,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - queued_at)) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_p95,
            count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS wait_n,
            coalesce(sum(cost_usd) FILTER (WHERE ended_at >= current_date), 0) AS model_today,
            coalesce(sum(CASE WHEN jsonb_typeof(metadata->'boat_est_cost_usd') = 'number' THEN (metadata->>'boat_est_cost_usd')::numeric END)
                     FILTER (WHERE ended_at >= current_date), 0) AS sandbox_today,
            count(*) FILTER (WHERE sandbox_id IS NOT NULL AND started_at > now() - interval '1 minute') AS starts_minute,
            count(*) FILTER (WHERE sandbox_id IS NOT NULL AND started_at > now() - interval '1 hour') AS starts_hour,
            count(*) FILTER (WHERE sandbox_id IS NOT NULL AND started_at > now() - interval '1 day') AS starts_day
       FROM agent_sessions
      WHERE status IN ('queued', 'running') OR ended_at > now() - interval '24 hours' OR started_at > now() - interval '24 hours'`);
  const [rsh] = !researchJobs() ? [{} as Record<string, unknown>] : await db.query<Record<string, unknown>>(
    `/* tenant: internal: admin Compute page, counts across all orgs */
     SELECT count(*) FILTER (WHERE status = 'queued') AS queued, min(created_at) FILTER (WHERE status = 'queued') AS oldest,
            count(*) FILTER (WHERE status = 'running') AS running
       FROM product_research WHERE status IN ('queued', 'running')`);

  // Our orchestrators: live rows, with their fleet check-in (what each runs, by agent).
  const live = await db.query<{ id: number; orchestrator_id: string | null; state: string; job_id: string | null; pods: number | null; created_at: Date;
    ready_at: Date | null; last_seen: Date | null; fleet_seen: Date | null; meta: { running?: Record<string, number>; worker_id?: string } | null }>(
    `SELECT o.id, o.orchestrator_id, o.state, o.job_id, o.pods, o.created_at, o.ready_at, o.last_seen, f.last_seen AS fleet_seen, f.meta
       FROM orchestrator_sandboxes o LEFT JOIN orchestrators f ON f.id = o.orchestrator_id
      WHERE o.state <> 'deleted' ORDER BY o.id`);
  const runningOf = (r: (typeof live)[number]) => Object.values(r.meta?.running ?? {}).reduce((a, b) => a + n(b), 0);
  const byState = { booting: 0, running: 0, draining: 0 } as Record<string, number>;
  for (const r of live) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const podsUsed = live.reduce((a, r) => a + runningOf(r), 0);
  const podsOf = (r: (typeof live)[number]) => r.pods ?? (r.job_id ? 0 : AUTOSCALE.podCapacity());
  const podsReserved = live.reduce((a, r) => a + podsOf(r), 0);
  const jobLive = live.filter((r) => r.job_id);
  // What the per-job orchestrator cap (ENGINE_SETTINGS.maxJobOrchestrators) counts, as the autoscaler does: booting and running, not draining.
  const jobActive = jobLive.filter((r) => r.state === "booting" || r.state === "running");
  const heartbeatAge = (r: (typeof live)[number]) => {
    const t = r.fleet_seen ?? r.last_seen ?? r.ready_at;
    return t ? (now - new Date(t).getTime()) / 1000 : null;
  };
  const notCheckingIn = live.filter((r) => r.state === "booting" ? now - new Date(r.created_at).getTime() > AUTOSCALE.bootMinutes() * MIN
    : r.state === "running" ? (heartbeatAge(r) ?? Infinity) > HEARTBEAT_STALE_S : false).length;

  // Idle but not drained: running nothing, and no session or research of its worker active for idle + 5 minutes.
  const idleWindowS = (AUTOSCALE.idleMinutes() + 5) * 60;
  const idleCandidates = live.filter((r) => r.state === "running" && runningOf(r) === 0 && r.meta?.worker_id &&
    r.ready_at && (now - new Date(r.ready_at).getTime()) / 1000 > idleWindowS);
  let idle = 0;
  if (idleCandidates.length && !eng) idle = idleCandidates.length; // no session engine: nothing of theirs is active
  else if (idleCandidates.length) {
    const ids = idleCandidates.map((r) => r.meta!.worker_id!);
    const active = new Set((await db.query<{ worker_id: string }>(
      `/* tenant: internal: admin Compute page, by orchestrator worker id, returns only those ids */
       SELECT worker_id FROM agent_sessions WHERE worker_id = ANY($1) AND greatest(heartbeat_at, ended_at, started_at) > now() - make_interval(secs => $2)${researchJobs() ? `
       UNION SELECT worker_id FROM product_research WHERE worker_id = ANY($1) AND greatest(heartbeat_at, finished_at, started_at) > now() - make_interval(secs => $2)` : ""}`,
      [ids, idleWindowS])).map((x) => x.worker_id));
    idle = ids.filter((id) => !active.has(id)).length;
  }

  const [orch] = await db.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE launch_step IS NOT NULL AND created_at > now() - interval '1 hour') AS failed_1h,
            count(*) FILTER (WHERE launch_step IS NOT NULL AND created_at > now() - interval '24 hours') AS failed_24h,
            count(*) FILTER (WHERE created_at > now() - interval '1 minute') AS starts_minute,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS starts_hour,
            count(*) FILTER (WHERE created_at > now() - interval '1 day') AS starts_day,
            coalesce(sum(extract(epoch FROM coalesce(deleted_at, now()) - greatest(created_at, current_date::timestamptz)))
                     FILTER (WHERE coalesce(deleted_at, now()) > current_date::timestamptz), 0) AS seconds_today
       FROM orchestrator_sandboxes WHERE created_at > now() - interval '1 day' OR state <> 'deleted' OR deleted_at >= current_date`);
  const [lastFail] = await db.query<{ launch_step: string; launch_error: string | null }>(
    "SELECT launch_step, launch_error FROM orchestrator_sandboxes WHERE launch_step IS NOT NULL AND created_at > now() - interval '1 hour' ORDER BY created_at DESC LIMIT 1");
  const [orchSpend] = await db.query<{ usd: unknown }>("SELECT coalesce(sum(cost_usd), 0) AS usd FROM gateway_model_usage WHERE consumer = 'orchestrator' AND day = current_date");
  const [orphans] = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM compute_events WHERE kind = 'orphan_deleted' AND at > now() - interval '24 hours'");

  // Failed sessions by class (24 h); the most common one names the Failures tile's "top".
  const failed = !eng ? [] : await db.query<{ status: string; agent_id: string | null; error_message: string | null; completed_reason: string | null; infra_error: string | null }>(
    `/* tenant: internal: admin Compute page, classified into counts across all orgs */
     SELECT status, agent_id, error_message, completed_reason, metadata->>'infra_error' AS infra_error
       FROM agent_sessions WHERE status IN ('failed', 'timeout') AND ended_at > now() - interval '24 hours' ORDER BY ended_at DESC LIMIT 5000`);
  const classes = new Map<string, { key: string; label: string; count: number }>();
  for (const f of failed) {
    const c = classifySession({ ...f, metadata: { infra_error: f.infra_error } });
    if (!c) continue;
    const e = classes.get(c.key) ?? { key: c.key, label: c.label, count: 0 };
    e.count++; classes.set(c.key, e);
  }
  const top = [...classes.values()].sort((a, b) => b.count - a.count)[0] ?? null;

  const demand = await computeDemand().catch(() => null);
  const missingKeys = await agentKeyCoverage().catch(() => []);

  // boat: the plan limits and the classified listing. No key: boat is not asked.
  const sb: SandboxListing = key ? await classifiedSandboxes({ force: fresh })
    : { ok: false, stale: false, error: "No boat key in the vault", at: null, sandboxes: [] };
  const lim = key ? await limits(fresh) : { ok: false, stale: false, error: "No boat key in the vault", at: null, value: null };
  const liveSb = sb.sandboxes.filter((s) => s.live);
  const liveOrchIds = new Set(live.map((r) => r.orchestrator_id).filter(Boolean));
  const leaked = liveSb.filter((s) => s.kind === "worker" && !(s.parent_orchestrator_id && liveOrchIds.has(s.parent_orchestrator_id))).length;
  const L = lim.value;
  const use = sandboxUsage(sb, L?.activeNow ?? null, live.length + podsUsed);
  const { active_now: activeNow, ours_orch: oursOrch, ours_workers: oursWorkers, others, other_prefixes: otherPrefixes } = use;

  const jobCap = AUTOSCALE.maxJobOrchestrators(), podsCap = AUTOSCALE.jobPodCapacity();
  const podCapacity = perJob ? podsCap : AUTOSCALE.podCapacity();
  const budget = L ? lib.computeBudget(L, live.length, podCapacity, L.activeNow - others) /* its other-active is `others` */ : null;
  // free: what the last per-job tick left, else the same formula (plan - other deployments - ours reserved) here.
  const free = typeof tick?.free === "number" ? tick.free : L ? L.activeSandboxes - others - live.reduce((a, r) => a + 1 + podsOf(r), 0) : null;
  const perOrchestrator = 1 + podCapacity;
  const queuedAll = n(ses?.queued) + n(rsh?.queued);
  const podsMax = jobLive.reduce((a, r) => Math.max(a, r.pods ?? 0), 0);
  const binding = bindingLimit({ note: tick?.note ?? null, budget_reason: budget?.reason, queued: queuedAll, per_job: perJob, free,
    job_orch_live: jobActive.length, job_orch_cap: jobCap, pods_max_reserved: podsMax, pods_cap: podsCap });

  const oldestSession = iso(ses?.oldest_queued), oldestResearch = iso(rsh?.oldest);
  const ageOf = (d: string | null) => (d ? Math.max(0, (now - Date.parse(d)) / 1000) : null);
  const facts: VerdictFacts = {
    enabled: AUTOSCALE.enabled(), runtime, kick_configured: kickConfigured(), has_boat_key: !!key, boat_error: key ? sb.error ?? lim.error : null,
    tick: { age_s: tickAge, error: tick?.error ?? null, note: tick?.note ?? null },
    queue: { sessions: n(ses?.queued), research: n(rsh?.queued), oldest_session_age_s: ageOf(oldestSession), oldest_research_age_s: ageOf(oldestResearch),
             unclaimable: demand?.unclaimable_sessions ?? 0 },
    running: { sessions: n(ses?.running), orchestrators: live.length },
    others, free, per_job: perJob, job_orch_live: jobActive.length, job_orch_cap: jobCap, not_checking_in: notCheckingIn,
    launch_failures_1h: { count: n(orch?.failed_1h), step: lastFail?.launch_step ?? null, message: lastFail?.launch_error?.slice(0, 160) ?? null },
    missing_keys: missingKeys, leaked_workers: leaked, orphan_deletes_24h: n(orphans?.n), namespace: lib.BOAT_NAMESPACE, idle_orchestrators: idle,
  };

  const orchSandboxUsd = (n(orch?.seconds_today) / 3600) * (BOAT_PRICE_PER_HOUR[lib.ORCH_SANDBOX_TYPE] ?? 0);
  const spend = { session_model_usd: usd(n(ses?.model_today)), orchestrator_model_usd: usd(n(orchSpend?.usd)), sandbox_est_usd: usd(n(ses?.sandbox_today) + orchSandboxUsd) };
  const ended = n(ses?.ended_24h), failedN = n(ses?.failed_24h);

  return {
    at: new Date(now).toISOString(),
    runtime,
    verdict: computeVerdict(facts),
    tick: { at: tick?.at ?? null, age_s: tickAge == null ? null : Math.round(tickAge), holder: lease?.holder ?? null, enabled: AUTOSCALE.enabled(),
            kick_configured: kickConfigured(), note: tick?.note ?? null, error: tick?.error ?? null, tick_seconds: AUTOSCALE.tickMs() / 1000, free },
    queue: { sessions: n(ses?.queued), research: n(rsh?.queued), oldest_session_at: oldestSession, oldest_research_at: oldestResearch,
             unclaimable: demand?.unclaimable_sessions ?? 0, jobs_waiting: n(ses?.queued_jobs) + n(rsh?.queued) },
    running: { sessions: n(ses?.running), research: n(rsh?.running), orchestrators: { booting: byState.booting ?? 0, running: byState.running ?? 0, draining: byState.draining ?? 0 },
               pods_used: podsUsed, pods_reserved: podsReserved },
    wait_1h: { p50_s: ses?.wait_p50 == null ? null : Math.round(n(ses.wait_p50)), p95_s: ses?.wait_p95 == null ? null : Math.round(n(ses.wait_p95)), n: n(ses?.wait_n) },
    failures_24h: { sessions: failedN, launches: n(orch?.failed_24h), ended, rate: ended ? failedN / ended : 0, top },
    spend_today: { ...spend, total_usd: usd(spend.session_model_usd + spend.orchestrator_model_usd + spend.sandbox_est_usd) },
    limits: {
      ok: !!L && sb.ok, error: lim.error ?? sb.error, stale: lim.stale || sb.stale,
      plan: L?.activeSandboxes ?? null, active_now: activeNow, ours_orch: oursOrch, ours_workers: oursWorkers, ours_images: use.ours_images, others, other_prefixes: otherPrefixes,
      our_starts: { minute: n(orch?.starts_minute) + n(ses?.starts_minute), hour: n(orch?.starts_hour) + n(ses?.starts_hour), day: n(orch?.starts_day) + n(ses?.starts_day) },
      starts: L ? { per_minute: L.startsPerMinute, per_hour: L.startsPerHour, per_day: L.startsPerDay } : null,
      job_orch_live: jobActive.length, job_orch_draining: jobLive.length - jobActive.length, job_orch_cap: jobCap, shared_orch_live: live.length - jobLive.length, shared_orch_cap: AUTOSCALE.maxOrchestrators(), per_job_mode: perJob,
      pods_max_reserved: podsMax, pods_avg_running: jobLive.length ? Math.round(jobLive.reduce((a, r) => a + runningOf(r), 0) / jobLive.length) : 0, pods_cap: podsCap,
      available: free == null ? null : Math.max(0, Math.floor(free / perOrchestrator)), per_orchestrator: perOrchestrator,
      sessions_per_day_ceiling: budget?.sessionsPerDayCeiling ?? null, reason: budget?.reason ?? null, binding, note: tick?.note ?? null,
      sandbox_prices: BOAT_PRICE_PER_HOUR,
    },
    settings: await listSettings(),
    knobs: computeKnobs(runtime),
    provider: { name: "boat.dev", api: BOAT.apiUrl, namespace: lib.BOAT_NAMESPACE, ok: key ? sb.ok && !sb.stale : false, error: key ? sb.error : "No boat key in the vault",
                has_key: !!key, key_hint: key?.hint ?? null, key_label: key?.label ?? null, uses: key ? n(key.uses) : 0, last_used_at: iso(key?.last_used_at) },
    links: { newrelic: env.NEW_RELIC_DASHBOARD_URL || null },
  };
}
