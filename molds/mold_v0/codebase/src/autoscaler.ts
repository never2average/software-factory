import { mintJobWorkerToken, revokeSandboxWorkerTokens } from "./workerauth.js";
import { hostname } from "node:os";
import { asPlatform } from "./tenant-scope.js";
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { useCredential } from "./keyvault.js";
import { scheduledAgents, variantsOf } from "./agents.js";
import { currentPopulation } from "./agent-mix.js";
import { hosts } from "./host.js";
import { JOB_POD_CAPACITY, jobState, orchestratorBusy, setCurrentCodeHash, staleOrchestratorIds } from "./fleet.js";
import { BOAT } from "../orchestrator/core/config.js";
import { ENGINE_SETTINGS, freshSettings, setting, settingNumber } from "./settings.js";
import { freshPlatformHarnesses } from "./harnesses.js";
import { launchFailure, recordComputeEvent } from "./compute-events.js";
import { pruneComputeHistory, recordTick } from "./autoscaler-ticks.js";
import { keepAlive } from "./telemetry.js";
import * as lib from "../orchestrator/deploy/boat-lib.js";
import { RunScaler, runSandboxStatus, type RunTick } from "./run-sandboxes.js";
import { queuedRunsByKind } from "./runs.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { ENV } from "./env-names.js";

/**
 * On-demand orchestrators: scale from zero to zero.
 *
 * Every APP_AUTOSCALE_TICK_SECONDS (15) the leader (a lease row in Postgres, so several server replicas never
 * double-launch) computes demand: claimable queued+running agent sessions and queued+running product research.
 *   desired = 0 without demand, else max(ceil(sessions / pod capacity), research ? 1 : 0),
 * clamped to APP_MAX_ORCHESTRATORS and to the boat plan (orchestrators + their workers <= plan concurrency).
 * Missing orchestrators are launched with the boat key from the vault (orchestrator/deploy/boat-lib.ts), preferably
 * optionally from a named snapshot image (APP_ORCH_SNAPSHOT=on; measured slower than a fresh `npm ci`, ~22s vs ~8s).
 *
 * Scale down: an orchestrator with no claimable work for APP_ORCH_IDLE_MINUTES (10) drains, leaves the fleet
 * (DELETE /api/worker/fleet/:id marks its row `draining`) and exits; the next tick deletes its sandbox. The tick also
 * reaps stale (no fleet check-in for 5 min), stuck-booting (> 10 min), expired and orphan sandboxes, reconciling
 * against boat's own listing by name prefix, so nothing leaks across server restarts.
 *
 * Runs (mold_v0-055, src/run-sandboxes.ts): the demand also counts queued runs per kind, and each tick launches one
 * sandbox per claimable run (its own lease, "runs", so the compose project's runner service can hold it instead when
 * the run sandboxes are local containers), and tears each down when its run's attempt ends.
 *
 * Kill switch: APP_AUTOSCALE=off (no launches, no deletes; existing orchestrators keep running and idle out).
 *
 * One orchestrator per job (APP_ORCH_PER_JOB=on, the default): instead of a shared fleet sized by total demand,
 * every onboarding research and every simulation with claimable sessions gets its own orchestrator, launched with
 * ORCHESTRATOR_JOB=<id>. It claims only that job (claims filtered by simulation_id / research_id), runs a simulation's
 * sessions on up to APP_JOB_POD_CAPACITY (40) worker sandboxes, and exits when its check-in says the job is
 * over. Launches fit the boat plan: each reserves 1 + its pods; a job that does not fit waits for the next tick. At
 * most APP_MAX_JOB_ORCHESTRATORS (12) at once. Context passes between the two kinds only through the database
 * (research writes personas with their developer environment and the problems in each persona's words; jobs carry them).
 */

const env = ENV;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const AUTOSCALE = {
  enabled: () => (env.APP_AUTOSCALE ?? "on").toLowerCase() !== "off",
  tickMs: () => Math.max(1, num(env.APP_AUTOSCALE_TICK_SECONDS, 15)) * 1000,
  podCapacity: () => Math.max(1, Math.min(20, num(env.APP_POD_CAPACITY, num(env.APP_PODS_PER_ORCHESTRATOR, 20)))),
  maxOrchestrators: () => settingNumber(ENGINE_SETTINGS.maxOrchestrators), // global setting (/admin/compute), else env
  idleMinutes: () => num(env.APP_ORCH_IDLE_MINUTES, 10),
  staleMinutes: () => num(env.APP_ORCH_STALE_MINUTES, 5),
  bootMinutes: () => num(env.APP_ORCH_BOOT_MINUTES, 10),
  // Measured live 2026-10-10: code upload + `npm ci` boots in ~8s; booting from the named snapshot took ~22s (lazy
  // disk hydration) and each image costs a ~170s build per code change. So the image path is opt-in.
  snapshots: () => (env.APP_ORCH_SNAPSHOT ?? "off").toLowerCase() === "on",
  maxLaunchesPerTick: () => Math.max(1, num(env.APP_ORCH_LAUNCHES_PER_TICK, 2)),
  perJob: () => (env.APP_ORCH_PER_JOB ?? "on").toLowerCase() !== "off",
  jobPodCapacity: () => JOB_POD_CAPACITY(),
  maxJobOrchestrators: () => Math.max(1, settingNumber(ENGINE_SETTINGS.maxJobOrchestrators)),
  // Where orchestrators reach the API: APP_INTERNAL_URL (the API itself) when the public URL is a proxy in front of it.
  publicUrl: () => (env.APP_INTERNAL_URL || env.PUBLIC_URL || "").replace(/\/$/, ""),
};

export interface Demand {
  sessions: number; queued_sessions: number; research: number;
  /** Queued sessions whose agent is not in the scheduled population: no orchestrator will ever claim them. */
  unclaimable_sessions: number;
  /** Claimable sessions queued after `freshSince` (only when computeDemand was given one). */
  fresh_queued_sessions?: number;
  /** Queued runs per kind, "pack/kind" (mold_v0-055): each gets its own run sandbox (src/run-sandboxes.ts). */
  runs?: Record<string, number>;
}
export interface Row {
  id: number; sandbox_id: string | null; orchestrator_id: string | null; state: "booting" | "running" | "draining" | "deleted";
  created_at: Date; ready_at: Date | null; last_seen: Date | null; error: string | null; from_image: string | null;
  code_hash: string | null; retiring_since: Date | null; job_id: string | null; pods: number | null;
  /** Why it ended: the launch step that failed and its error, or the reap reason (`error` holds either, as before). */
  launch_step?: string | null; launch_error?: string | null; reap_reason?: string | null;
}

/** Pure: how many orchestrators the demand needs (before caps). */
export function desiredOrchestrators(d: Demand, podCapacity: number): number {
  const s = d.sessions > 0 ? Math.ceil(d.sessions / podCapacity) : 0;
  return Math.max(s, d.research > 0 ? 1 : 0);
}

export async function computeDemand(freshSince?: Date): Promise<Demand> {
  const db = await getDb();
  // The session engine's tables are a host pack's (mold_v0-049): with none, no session or research demand, runs only.
  if (!sessionEngine()) {
    const runs = await queuedRunsByKind();
    return { sessions: 0, queued_sessions: 0, research: 0, unclaimable_sessions: 0, ...(freshSince ? { fresh_queued_sessions: 0 } : {}), ...(Object.keys(runs).length ? { runs } : {}) };
  }
  let agents: string[] = [];
  try { agents = scheduledAgents(await currentPopulation()).flatMap((a) => [a.id, ...variantsOf(a).map((v) => v.id)]); }
  catch { /* no population: count everything */ }
  const claimable = "(agent_id IS NULL OR cardinality($1::text[]) = 0 OR agent_id = ANY($1))";
  const [s] = await db.query<{ sessions: number; queued: number; unclaimable: number; fresh: number }>(
    `/* tenant: internal: autoscaler demand counts across all orgs, counts only */ SELECT count(*) FILTER (WHERE ${claimable}) AS sessions,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable}) AS queued,
            count(*) FILTER (WHERE status = 'queued' AND NOT ${claimable}) AS unclaimable,
            count(*) FILTER (WHERE status = 'queued' AND ${claimable} AND $2::timestamptz IS NOT NULL AND queued_at > $2) AS fresh
       FROM agent_sessions WHERE status IN ('queued', 'running')`, [agents, freshSince ?? null]);
  const [r] = researchJobs() ? await db.query<{ n: number }>("/* tenant: internal: autoscaler demand counts across all orgs, counts only */ SELECT count(*) AS n FROM product_research WHERE status IN ('queued', 'running')") : [{ n: 0 }];
  const runs = await queuedRunsByKind();
  return {
    sessions: Number(s?.sessions ?? 0), queued_sessions: Number(s?.queued ?? 0), research: Number(r?.n ?? 0),
    unclaimable_sessions: Number(s?.unclaimable ?? 0), ...(freshSince ? { fresh_queued_sessions: Number(s?.fresh ?? 0) } : {}),
    ...(Object.keys(runs).length ? { runs } : {}),
  };
}

/** A job that wants its own orchestrator (per-job mode). */
export interface JobDemand { id: string; kind: "simulation" | "research"; sessions: number; queued: number; last_queued: Date | null }

/** Research that is queued (or stalled), and simulations with claimable sessions still to run, oldest first. */
export async function computeJobDemand(): Promise<JobDemand[]> {
  if (!sessionEngine()) return []; // no session engine tables in this build (mold_v0-049)
  const db = await getDb();
  let agents: string[] = [];
  try { agents = scheduledAgents(await currentPopulation()).flatMap((a) => [a.id, ...variantsOf(a).map((v) => v.id)]); }
  catch { /* no population: count everything */ }
  const research = !researchJobs() ? [] : await db.query<{ id: string }>(
    `/* tenant: internal: autoscaler job demand across all orgs, ids go to the orchestrator only */ SELECT id FROM product_research WHERE status = 'queued'
        OR (status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)) ORDER BY created_at`,
    [num(env.APP_RESEARCH_STALE_MINUTES, 20)]);
  const sims = await db.query<{ id: string; sessions: number; queued: number; last_queued: Date | null }>(
    `/* tenant: internal: autoscaler job demand across all orgs, ids go to the orchestrator only */ SELECT simulation_id AS id, count(*) AS sessions, count(*) FILTER (WHERE status = 'queued') AS queued,
            max(queued_at) FILTER (WHERE status = 'queued') AS last_queued
       FROM agent_sessions
      WHERE status IN ('queued', 'running') AND (agent_id IS NULL OR cardinality($1::text[]) = 0 OR agent_id = ANY($1))
      GROUP BY simulation_id HAVING count(*) FILTER (WHERE status = 'queued') > 0 ORDER BY min(queued_at)`, [agents]);
  return [
    ...research.map((r) => ({ id: r.id, kind: "research" as const, sessions: 0, queued: 0, last_queued: null })),
    ...sims.map((s) => ({ id: s.id, kind: "simulation" as const, sessions: Number(s.sessions), queued: Number(s.queued),
                          last_queued: s.last_queued ? new Date(s.last_queued) : null })),
  ];
}

export interface TickState {
  at: string; enabled: boolean; leader: boolean; holder: string; demand?: Demand; desired?: number; cap?: number;
  active?: number; launched?: string[]; reaped?: { sandbox_id: string; reason: string }[]; image?: string | null; note?: string; error?: string;
  /** Per-job mode: the jobs wanting an orchestrator and whether one serves them. */
  jobs?: { id: string; kind: string; sessions: number; served: boolean }[];
  /** Per-job mode: boat plan sandboxes left after this tick's launches (plan - other deployments - ours reserved). */
  free?: number;
  /** What `launched` names, as data: the orchestrator row inserted, and its job and pods (per-job mode). */
  launches?: Launch[];
  /** The run sandboxes' tick (mold_v0-055): demand per kind, launches, teardowns, or why runs wait. */
  runs?: RunTick;
}
export interface Launch { row: number; job_id: string | null; pods: number | null; label: string }

export class Autoscaler {
  readonly holder = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private inflight = new Map<number, Promise<void>>();
  private imageBuild: Promise<unknown> | null = null;
  private keyAt = 0;
  private limits: { at: number; v: lib.BoatLimits } | null = null;
  private lastDrainAt = 0;
  /** Per-job mode: when each job's orchestrator last idled out (cooldown against relaunch loops). */
  private jobDrainAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  last: TickState | null = null;

  /** One run sandbox per queued run (mold_v0-055). */
  readonly runs: RunScaler;
  constructor(private opts: { log?: (m: string) => void; root?: string } = {}) {
    this.runs = new RunScaler({ log: (m) => this.log(`runs: ${m}`), tickMs: () => AUTOSCALE.tickMs() });
  }
  private log(m: string) { (this.opts.log ?? ((x: string) => console.error(`autoscaler: ${x}`)))(m); }

  start() {
    if (this.timer) return;
    let prunedAt = 0;
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log(`tick failed: ${(e as Error).message}`); }
      // History retention (autoscaler_ticks 14 days, compute_events 90), never inside a tick. Vercel prunes from its cron.
      // A host pack's queued background work (src/host.ts; the product's loss reasons), never inside a tick.
      for (const h of hosts()) { try { h.background?.tick?.(); } catch (e) { this.log(`host ${h.id} tick failed: ${(e as Error).message}`); } }
      if (Date.now() - prunedAt > 6 * 3600_000) {
        prunedAt = Date.now();
        await pruneComputeHistory().catch((e) => this.log(`prune failed: ${(e as Error).message}`));
      }
      this.timer = setTimeout(loop, AUTOSCALE.tickMs());
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** Stop ticking and give up the lease, so another replica (a rolling deploy's new one) leads on its next tick. */
  async release(): Promise<void> {
    this.stop();
    await (await getDb()).query("DELETE FROM autoscaler_lease WHERE name = 'autoscaler' AND holder = $1", [this.holder]).catch(() => {});
    await this.runs.release();
  }
  /** Wait for in-flight launches and image builds (tests; serverless, before the function is frozen). */
  async settle() { await Promise.allSettled([...this.inflight.values(), this.imageBuild, this.runs.settle()]); }

  /** Lease row: one leader across replicas; renewed every tick, expires after 3 ticks. */
  async acquireLease(): Promise<boolean> {
    const db = await getDb();
    const ttl = Math.ceil((AUTOSCALE.tickMs() * 3) / 1000);
    const rows = await db.query<{ holder: string }>(
      `INSERT INTO autoscaler_lease (name, holder, expires_at) VALUES ('autoscaler', $1, now() + make_interval(secs => $2))
       ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE autoscaler_lease.holder = excluded.holder OR autoscaler_lease.expires_at < now()
       RETURNING holder`, [this.holder, ttl]);
    return rows[0]?.holder === this.holder;
  }

  private async boatKey() {
    if (BOAT.apiKey && Date.now() - this.keyAt < 10 * 60_000) return;
    BOAT.apiKey = (await useCredential("boat")).secret;
    this.keyAt = Date.now();
  }

  private async boatLimits(): Promise<lib.BoatLimits> {
    if (!this.limits || Date.now() - this.limits.at > 5 * 60_000) this.limits = { at: Date.now(), v: await lib.boatLimits() };
    return this.limits.v;
  }

  private async cap(oursActive: number): Promise<number> {
    const b = lib.computeBudget(await this.boatLimits(), 0, AUTOSCALE.podCapacity(), oursActive);
    return Math.max(0, Math.min(AUTOSCALE.maxOrchestrators(), b.maxOrchestrators));
  }

  /** One tick. A tick asked for while one runs (the loop and "Run a tick now" in the same process) shares that tick
   * rather than starting a second one beside it, which could launch the same job's orchestrator twice. */
  tick(): Promise<TickState> {
    return (this.ticking ??= this.tickOnce().finally(() => { this.ticking = null; }));
  }
  private ticking: Promise<TickState> | null = null;

  private async tickOnce(): Promise<TickState> {
    await freshSettings(); // caps and launch tuning come from global settings
    await freshPlatformHarnesses(); // demand and pod plans count admin-added harnesses (registry())
    const st: TickState = { at: new Date().toISOString(), enabled: AUTOSCALE.enabled(), leader: false, holder: this.holder };
    if (!st.enabled) { this.last = { ...st, note: "APP_AUTOSCALE=off" }; return this.last; }
    // Runs first, under their own lease: they need no orchestrator, and a run's sandbox must not wait on a boat outage
    // of the orchestrators' (mold_v0-055).
    st.runs = await this.runs.tick().catch((e) => ({ provider: null, leader: false, error: (e as Error).message }));
    if (!(await this.acquireLease())) { this.last = { ...st, note: "not the leader" }; return this.last; }
    st.leader = true;
    const db = await getDb();
    try {
      await this.boatKey();
      // Sessions queued in the last FRESH_MS before an idle exit (or after it) were never ignored by a live orchestrator,
      // so they are new work, not stuck work: they must not wait out the relaunch cooldown below.
      const FRESH_MS = 2 * 60_000;
      const demand = await computeDemand(this.lastDrainAt ? new Date(this.lastDrainAt - FRESH_MS) : undefined);
      st.demand = demand;
      const listing = await lib.listSandboxes();
      const byId = new Map(listing.map((s) => [s.id, s]));
      const rows = await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
      const seen = new Map((await db.query<{ id: string; last_seen: Date }>("SELECT id, last_seen FROM orchestrators")).map((o) => [o.id, new Date(o.last_seen)]));
      const now = Date.now(), min = 60_000;
      setCurrentCodeHash(lib.codeHash(this.opts.root)); // what this autoscaler launches; older code is retired
      const staleIds = await staleOrchestratorIds();
      const reaped: { sandbox_id: string; reason: string }[] = [];
      const reap = async (row: Row, reason: string, deleteIt = true) => {
        if (row.sandbox_id && deleteIt) await lib.deleteSandbox(row.sandbox_id).catch((e) => this.log(`delete ${row.sandbox_id}: ${(e as Error).message}`));
        await db.query("UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = coalesce(error, $2), reap_reason = coalesce(reap_reason, $2) WHERE id = $1", [row.id, reason]);
        await recordComputeEvent({ kind: "reaped", sandbox_id: row.sandbox_id, orchestrator_id: row.orchestrator_id, job_id: row.job_id, reason });
        await revokeSandboxWorkerTokens(row.id);
        if (row.orchestrator_id) {
          await db.query("DELETE FROM orchestrators WHERE id = $1", [row.orchestrator_id]);
          // worker sandboxes a crashed/stale orchestrator could not clean up itself (<ns>-w-<orch>-<agent>)
          for (const w of listing.filter((s) => lib.isLive(s) && lib.isWorkerOf(s.name, row.orchestrator_id!))) {
            await lib.deleteSandbox(w.id).catch(() => {});
            reaped.push({ sandbox_id: w.id, reason: `worker of reaped ${row.orchestrator_id}` });
            await recordComputeEvent({ kind: "worker_deleted", sandbox_id: w.id, orchestrator_id: row.orchestrator_id, job_id: row.job_id, reason: `worker of reaped ${row.orchestrator_id} (${reason})` });
          }
        }
        reaped.push({ sandbox_id: row.sandbox_id ?? "(none)", reason });
        this.log(`reaped ${row.sandbox_id ?? `row ${row.id}`}: ${reason}`);
      };

      // 1. reconcile our rows with boat + the fleet, reap what must go
      for (const row of rows) {
        const age = now - new Date(row.created_at).getTime();
        const inflight = this.inflight.has(row.id);
        if (!row.sandbox_id) { if (!inflight && age > AUTOSCALE.bootMinutes() * min) await reap(row, "launch never created a sandbox", false); continue; }
        const sb = byId.get(row.sandbox_id);
        if (!sb || !lib.isLive(sb)) {
          if (inflight && age < 2 * min) continue; // listing can lag a fresh create
          await reap(row, sb ? `sandbox is ${sb.state}` : "sandbox gone from boat", !!sb);
          continue;
        }
        if (row.state === "draining") {
          this.lastDrainAt = now;
          if (row.job_id) this.jobDrainAt.set(row.job_id, now);
          await reap(row, row.job_id ? `drained (job ${row.job_id} over or idle)` : "drained (idle exit)");
          continue;
        }
        if (sb.archiveAfter && Date.parse(sb.archiveAfter) < now + 5 * min) { await reap(row, "TTL about to expire"); continue; }
        if (row.state === "booting") {
          if (!inflight && age > AUTOSCALE.bootMinutes() * min) await reap(row, `stuck booting > ${AUTOSCALE.bootMinutes()} min`);
          continue;
        }
        // running
        const checkIn = row.orchestrator_id ? seen.get(row.orchestrator_id) : undefined;
        if (checkIn) await db.query("UPDATE orchestrator_sandboxes SET last_seen = $2 WHERE id = $1", [row.id, checkIn]);
        // Recycle on deploy (src/fleet.ts): once a pre-deploy orchestrator has been handed its empty assignment and
        // has checked in again since, delete it as soon as nothing of its is running. No idle-timeout wait.
        if (row.orchestrator_id && staleIds.has(row.orchestrator_id)) {
          const told = row.retiring_since ? new Date(row.retiring_since).getTime() : 0;
          if (told && checkIn && checkIn.getTime() > told && !(await orchestratorBusy(row.orchestrator_id))) {
            await reap(row, "retired: launched before this deploy (old code)");
            continue;
          }
        }
        // Per-job backstop: the orchestrator leaves by itself when its check-in reports the job over; if it has not
        // within 3 minutes and runs nothing, delete it.
        if (row.job_id && row.orchestrator_id) {
          const js = await jobState(row.job_id);
          if (js.done && now - (js.finished_at?.getTime() ?? 0) > 3 * min && !(await orchestratorBusy(row.orchestrator_id))) {
            await reap(row, `job ${row.job_id} is ${js.status ?? "gone"}`);
            continue;
          }
        }
        const since = checkIn?.getTime() ?? (row.ready_at ? new Date(row.ready_at).getTime() : new Date(row.created_at).getTime());
        if (now - since > AUTOSCALE.staleMinutes() * min) await reap(row, `stale: no fleet check-in for ${AUTOSCALE.staleMinutes()} min`);
      }
      // orphans: our name prefix on boat but no live row (e.g. a launch interrupted by a server restart); under the
      // namespace's old default too (lib.NAMESPACES): one launched before mold_v0-156 that lost its row
      const known = new Set((await db.query<{ sandbox_id: string }>("SELECT sandbox_id FROM orchestrator_sandboxes WHERE state <> 'deleted' AND sandbox_id IS NOT NULL")).map((r) => r.sandbox_id));
      const reapedIds = new Set(reaped.map((r) => r.sandbox_id)); // the listing predates this tick's reaping
      for (const sb of listing) {
        if (!lib.isLive(sb) || known.has(sb.id) || reapedIds.has(sb.id)) continue;
        const isOrch = lib.isOrchName(sb.name);
        const isStaleBuilder = lib.isImageBuilderName(sb.name) && (sb.name !== lib.IMAGE_BUILDER_NAME || !this.imageBuild) && sb.createdAt && now - Date.parse(sb.createdAt) > 30 * min;
        if (isOrch || isStaleBuilder) {
          await lib.deleteSandbox(sb.id).catch(() => {});
          const reason = isOrch ? "orphan orchestrator sandbox (no row)" : "stale image builder";
          reaped.push({ sandbox_id: sb.id, reason });
          await recordComputeEvent({ kind: isOrch ? "orphan_deleted" : "image_builder_deleted", sandbox_id: sb.id,
                                     orchestrator_id: isOrch ? lib.orchIdOf(sb.id) : null, reason: `${reason}: ${sb.name}` });
          this.log(`deleted orphan ${sb.id} (${sb.name})`);
        }
      }
      st.reaped = reaped;

      // 2. scale up within the caps
      if (AUTOSCALE.perJob()) {
        await this.scaleJobs(st, staleIds, listing, now);
      } else {
        // Retiring (pre-deploy) orchestrators claim nothing new, so they do not count as capacity for the demand.
        const active = (await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state IN ('booting', 'running')"))
          .filter((r) => !(r.orchestrator_id && staleIds.has(r.orchestrator_id))).length;
        const oursActive = listing.filter((s) => lib.isLive(s) && lib.isOursName(s.name)).length;
        const cap = await this.cap(oursActive);
        let desired = Math.min(desiredOrchestrators(demand, AUTOSCALE.podCapacity()), cap);
        // An orchestrator just idled out while sessions are still "queued": they are not claimable by it; don't relaunch
        // in a loop (each launch is a boat start). Research or freshly queued sessions launch right away.
        if (demand.research === 0 && demand.sessions > 0 && !demand.fresh_queued_sessions && active === 0 &&
            now - this.lastDrainAt < AUTOSCALE.idleMinutes() * min) {
          st.note = "cooldown: the last orchestrator idled out with these sessions still queued";
          desired = 0;
        }
        st.active = active; st.cap = cap; st.desired = desired;
        st.launched = []; st.launches = [];
        const image = AUTOSCALE.snapshots() ? await this.readyImage() : null;
        st.image = image;
        for (let i = 0; i < Math.min(desired - active, AUTOSCALE.maxLaunchesPerTick()); i++) {
          const l = await this.launch(image);
          st.launched.push(l.label); st.launches.push(l);
        }
      }

      // 3. keep the image current (built in the background, once per code hash)
      if (AUTOSCALE.snapshots() && !st.image && !this.imageBuild) {
        this.imageBuild = lib.buildImage({ root: this.opts.root, log: (m) => this.log(m) })
          .catch((e) => this.log(`image build failed: ${(e as Error).message}`))
          .finally(() => { this.imageBuild = null; });
      }
    } catch (e) {
      st.error = (e as Error).message;
      this.log(`tick error: ${st.error}`);
      await recordComputeEvent({ kind: "tick_error", reason: st.error });
    }
    this.last = st;
    await db.query("UPDATE autoscaler_lease SET state = $2 WHERE name = 'autoscaler' AND holder = $1", [this.holder, JSON.stringify(st)]).catch(() => {});
    await recordTick(st); // history for the Compute page: acting ticks, and a sample once a minute
    return st;
  }

  private imageCache: { hash: string; name: string | null; at: number } | null = null;
  private async readyImage(): Promise<string | null> {
    const hash = lib.codeHash(this.opts.root);
    if (this.imageCache?.hash === hash && this.imageCache.name && Date.now() - this.imageCache.at < 10 * 60_000) return this.imageCache.name;
    const name = lib.imageName(hash);
    const ok = (await lib.imageStatus(name).catch(() => "missing")) === "ready";
    this.imageCache = { hash, name: ok ? name : null, at: Date.now() };
    return ok ? name : null;
  }

  /**
   * Per-job mode: one orchestrator for each job that has none, oldest first (research before runs: a customer is
   * waiting on it and it needs a single sandbox). Each launch reserves 1 + its pods on the boat plan; a run gets
   * min(JOB_POD_CAPACITY, its unfinished sessions, what is free). A job whose orchestrator just idled out with nothing
   * new queued waits out the idle period (no relaunch loop on work it cannot claim).
   */
  private async scaleJobs(st: TickState, staleIds: Set<string>, listing: lib.Sb[], now: number): Promise<void> {
    const db = await getDb();
    const min = 60_000, FRESH_MS = 2 * min;
    const jobs = await computeJobDemand();
    const live = await db.query<Row>("SELECT * FROM orchestrator_sandboxes WHERE state IN ('booting', 'running')");
    const isRetiring = (r: Row) => !!(r.orchestrator_id && staleIds.has(r.orchestrator_id));
    const served = new Set(live.filter((r) => r.job_id && !isRetiring(r)).map((r) => r.job_id!));
    const workersOf = (orchId: string) => listing.filter((s) => lib.isLive(s) && lib.isWorkerOf(s.name, orchId)).length;
    // Boat plan: what others use, plus what each live orchestrator of ours holds or has reserved. A retiring one only
    // holds the workers it still runs (it claims nothing new); a shared one counts the workers it has.
    const limits = await this.boatLimits();
    const oursActive = listing.filter((s) => lib.isLive(s) && lib.isOursName(s.name)).length;
    const reserved = live.reduce((n, r) => n + 1 + (r.pods != null && !isRetiring(r) ? r.pods : r.orchestrator_id ? workersOf(r.orchestrator_id) : 0), 0);
    let free = limits.activeSandboxes - Math.max(0, limits.activeNow - oursActive) - reserved;
    let active = live.filter((r) => !isRetiring(r)).length;
    const image = AUTOSCALE.snapshots() ? await this.readyImage() : null;
    const notes: string[] = [];
    st.launched = []; st.launches = [];
    st.image = image;
    for (const j of jobs) {
      if (served.has(j.id)) continue;
      if (st.launched.length >= AUTOSCALE.maxLaunchesPerTick()) break;
      if (active >= AUTOSCALE.maxJobOrchestrators()) { notes.push(`at ${ENGINE_SETTINGS.maxJobOrchestrators} (${AUTOSCALE.maxJobOrchestrators()})`); break; }
      const drained = this.jobDrainAt.get(j.id);
      if (drained && now - drained < AUTOSCALE.idleMinutes() * min && !(j.last_queued && j.last_queued.getTime() > drained - FRESH_MS)) {
        notes.push(`cooldown: ${j.id}'s orchestrator idled out with its sessions still queued`);
        continue;
      }
      const pods = j.kind === "research" ? 0 : Math.min(AUTOSCALE.jobPodCapacity(), j.sessions, free - 1);
      if (free < 1 || (j.kind === "simulation" && pods < 1)) { notes.push(`${j.id} waits for boat plan capacity (${Math.max(0, free)} free)`); continue; }
      const l = await this.launch(image, { id: j.id, pods });
      st.launched.push(l.label); st.launches.push(l);
      served.add(j.id);
      free -= 1 + pods;
      active++;
    }
    st.jobs = jobs.map((j) => ({ id: j.id, kind: j.kind, sessions: j.sessions, served: served.has(j.id) }));
    st.active = active; st.cap = AUTOSCALE.maxJobOrchestrators(); st.desired = jobs.length; st.free = free;
    if (notes.length) st.note = notes.join("; ");
  }

  /** Insert the row first (counts toward `active` at once), then create + configure + start in the background. */
  private async launch(image: string | null, job?: { id: string; pods: number }): Promise<Launch> {
    const db = await getDb();
    const [row] = await db.query<{ id: number }>(
      "INSERT INTO orchestrator_sandboxes (state, from_image, code_hash, job_id, pods) VALUES ('booting', $1, $2, $3, $4) RETURNING id",
      [image, lib.codeHash(this.opts.root), job?.id ?? null, job ? job.pods : null]);
    const id = row!.id;
    // A per-job orchestrator gets a token bound to its job, never the fleet token (docs/security.md, phase 0b).
    const workerToken = job ? await mintJobWorkerToken(job.id, id) : env.APP_WORKER_TOKEN ?? "";
    const tuning: Record<string, string> = { APP_ORCH_IDLE_MINUTES: String(AUTOSCALE.idleMinutes()) };
    // Global settings (/admin/compute) win over this server's env: e.g. BOAT_SANDBOX_SIZE, RESEARCH_MAX_COST_USD, ORCHESTRATOR_MODEL.
    for (const k of lib.TUNING_VARS) { const v = setting(k) ?? env[k]; if (v != null && v !== "") tuning[k] = String(v); }
    if (job) tuning.ORCHESTRATOR_JOB = job.id;
    tuning.APP_BOAT_NAMESPACE = lib.BOAT_NAMESPACE; // its worker sandboxes carry this deployment's prefix
    const p = lib.launchOrchestrator(
      { url: AUTOSCALE.publicUrl(), workerToken, podCapacity: job ? Math.max(1, job.pods) : AUTOSCALE.podCapacity(), tuning, root: this.opts.root, log: (m) => this.log(m) },
      { image, onCreated: async (sandboxId, orchId) => { await db.query("UPDATE orchestrator_sandboxes SET sandbox_id = $2, orchestrator_id = $3 WHERE id = $1", [id, sandboxId, orchId]); } },
    ).then(async (r) => {
      await db.query("UPDATE orchestrator_sandboxes SET state = 'running', ready_at = now(), from_image = $2, timings = $3 WHERE id = $1 AND state = 'booting'",
        [id, r.fromImage ? image : null, JSON.stringify(r.timings)]);
      this.log(`launched ${r.sandboxId} (${r.orchId}) in ${Math.round((r.timings.started ?? 0) / 1000)}s${r.fromImage ? " from image" : " (code upload + npm ci)"}`);
    }).catch(async (e) => {
      const f = launchFailure(e);
      const [r] = await db.query<{ sandbox_id: string | null; orchestrator_id: string | null }>(
        `UPDATE orchestrator_sandboxes SET state = 'deleted', deleted_at = now(), error = $2, launch_step = $3, launch_error = $4
          WHERE id = $1 RETURNING sandbox_id, orchestrator_id`, [id, f.message.slice(0, 500), f.step, f.error.slice(0, 500)]);
      await recordComputeEvent({ kind: "launch_failed", sandbox_id: r?.sandbox_id, orchestrator_id: r?.orchestrator_id, job_id: job?.id, step: f.step, reason: f.error });
      await revokeSandboxWorkerTokens(id);
      this.log(`launch failed: ${f.message}`);
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return { row: id, job_id: job?.id ?? null, pods: job ? job.pods : null, label: job ? `row ${id} (${job.id}, ${job.pods} pods)` : `row ${id}` };
  }
}

let singleton: Autoscaler | null = null;

/**
 * Serverless (Vercel) has no ticking loop, so the autoscaler runs on events instead: a deep research job queued, an
 * orchestrator checking in or leaving, and a cron every 5 minutes (vercel.json). One tick, then wait for its launches (boat create + code
 * upload + start) so the function is not frozen mid-launch. At most one kick per instance every 10 seconds.
 */
let lastKick = 0;
/** Can this deployment kick the autoscaler at all: on, an HTTPS URL orchestrators reach, and a worker token. A null
 * from kickAutoscaler means this is false, or the kick was debounced. */
export const kickConfigured = (): boolean => AUTOSCALE.enabled() && /^https:\/\//.test(AUTOSCALE.publicUrl()) && !!env.APP_WORKER_TOKEN;
export async function kickAutoscaler(opts: { force?: boolean } = {}): Promise<TickState | null> {
  // Cross-tenant by design: demand across every organization (src/tenant-scope.ts).
  return asPlatform(async () => {
  if (!kickConfigured()) return null;
  if (!opts.force && Date.now() - lastKick < 10_000) return null;
  lastKick = Date.now();
  singleton ??= new Autoscaler();
  let st = await singleton.tick();
  // Another instance holds the lease (it ticked moments ago): wait for it to lapse, then tick here, so work that only
  // this event announces (an orchestrator that just left) is not left for the next cron.
  if (!st.leader && st.enabled) {
    const db = await getDb();
    const [l] = await db.query<{ expires_at: Date }>("SELECT expires_at FROM autoscaler_lease WHERE name = 'autoscaler'");
    const wait = l ? new Date(l.expires_at).getTime() - Date.now() + 1000 : 0;
    if (wait > 0 && wait < 120_000) { await new Promise((r) => setTimeout(r, wait)); st = await singleton.tick(); }
  }
  await singleton.settle();
  return st;
});
}

/**
 * "Run a tick now" on /admin/compute (src/compute-actions.ts): one tick at once, past the kick's 10-second debounce. A
 * VM ticks with its loop's own autoscaler; Vercel needs what a kick needs (an HTTPS PUBLIC_URL and the worker token),
 * and waits out another instance's lease as a kick does. The answer comes back once the tick has decided; its launches
 * finish in the background (kept alive on Vercel). Throws 409 when this deployment cannot tick.
 */
export async function runTickNow(): Promise<TickState> {
  if (!AUTOSCALE.enabled()) throw Object.assign(new Error("Autoscaling is off on this deployment (APP_AUTOSCALE=off), so there is nothing to tick."), { status: 409 });
  const vercel = !!process.env.VERCEL;
  if (vercel && !kickConfigured()) throw Object.assign(new Error("This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset."), { status: 409 });
  lastKick = Date.now();
  singleton ??= new Autoscaler();
  let st = await singleton.tick();
  if (vercel && !st.leader && st.enabled) {
    const db = await getDb();
    const [l] = await db.query<{ expires_at: Date }>("SELECT expires_at FROM autoscaler_lease WHERE name = 'autoscaler'");
    const wait = l ? new Date(l.expires_at).getTime() - Date.now() + 1000 : 0;
    if (wait > 0 && wait < 60_000) { await new Promise((r) => setTimeout(r, wait)); st = await singleton.tick(); }
  }
  keepAlive(singleton.settle());
  return st;
}

/** Graceful shutdown: stop this process's autoscaler and release its lease. */
export async function stopAutoscaler(): Promise<void> { await singleton?.release(); }

export function startAutoscaler(): Autoscaler {
  singleton ??= new Autoscaler();
  singleton.start();
  return singleton;
}

/** For get_simulation / get_onboarding: what capacity is doing for queued work. */
export async function capacityStatus(): Promise<{ autoscale: "on" | "off"; booting: number; running: number; message: string }> {
  // Cross-tenant by design: capacity across every organization (src/tenant-scope.ts).
  return asPlatform(async () => {
  const db = await getDb();
  const [c] = await db.query<{ booting: number; running: number }>(
    "SELECT count(*) FILTER (WHERE state = 'booting') AS booting, count(*) FILTER (WHERE state = 'running') AS running FROM orchestrator_sandboxes WHERE state <> 'deleted'");
  const [o] = await db.query<{ n: number }>("SELECT count(*) AS n FROM orchestrators WHERE last_seen > now() - interval '90 seconds'");
  const booting = Number(c?.booting ?? 0), running = Math.max(Number(c?.running ?? 0), Number(o?.n ?? 0));
  const autoscale = AUTOSCALE.enabled() ? "on" : "off";
  const message = running > 0 ? "an orchestrator is running and will pick this up"
    : autoscale === "off" ? "waiting for an orchestrator (autoscaling is off)"
    : booting > 0 ? "starting orchestrator…" : "starting orchestrator… (queued for the next autoscaler tick)";
  return { autoscale, booting, running, message };
});
}

/** Admin / fleet:status view. */
export async function autoscalerStatus() {
  const db = await getDb();
  const [lease] = await db.query<{ holder: string; expires_at: Date; state: TickState }>("SELECT holder, expires_at, state FROM autoscaler_lease WHERE name = 'autoscaler'");
  const rows = await db.query("SELECT id, sandbox_id, orchestrator_id, job_id, pods, state, created_at, ready_at, last_seen, error, launch_step, launch_error, reap_reason, from_image, timings FROM orchestrator_sandboxes ORDER BY id DESC LIMIT 50");
  return { enabled: AUTOSCALE.enabled(), knobs: {
      per_job: AUTOSCALE.perJob(), job_pod_capacity: AUTOSCALE.jobPodCapacity(), max_job_orchestrators: AUTOSCALE.maxJobOrchestrators(),
      pod_capacity: AUTOSCALE.podCapacity(), max_orchestrators: AUTOSCALE.maxOrchestrators(), idle_minutes: AUTOSCALE.idleMinutes(),
      stale_minutes: AUTOSCALE.staleMinutes(), boot_minutes: AUTOSCALE.bootMinutes(), snapshots: AUTOSCALE.snapshots(), tick_seconds: AUTOSCALE.tickMs() / 1000 },
    leader: lease ? { holder: lease.holder, expires_at: lease.expires_at } : null, last_tick: lease?.state ?? null, sandboxes: rows,
    run_sandboxes: await runSandboxStatus() };
}
