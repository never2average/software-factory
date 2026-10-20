/**
 * Octillion deterministic worker (no orchestrator LLM).
 *
 * Claims jobs, runs the harness in a sandbox (boat.dev by default), streams its JSONL and, while the agent stops
 * before it is done (core/progress.ts), resumes it with neutral canned developer nudges (core/session.ts
 * driveToDone) up to MAX_AGENT_TURNS. Then finishes: git diff event, /complete, sandbox deleted. The Pi
 * orchestrator (pi-octillion/main.ts) adds the in-character simulated developer and falls back to this driver.
 *
 * Run: `npx tsx orchestrator/worker.ts`
 */
import { getAdapter } from "./harnesses/adapters.js";
import { CFG } from "./core/config.js";
import { PodPool, POOL } from "./core/pool.js";
import { RUNNERS, checkRunner, type Runner } from "./core/runners.js";
import { activeSessions, adapterFor, claimJobs, driveToDone, markShuttingDown, WorkerSession, type Job } from "./core/session.js";
import { log, sleep } from "./core/util.js";
import { CREDENTIALS_MODE, orchestratorCredentials, redact } from "./core/credentials.js";
import { assertOrchestratorHost } from "./core/host-guard.js";
import { holdBusy, markBusy, startIdleWatcher } from "./core/activity.js";
import { FLEET, FleetMembership } from "./core/fleet-client.js";

/** Launch -> nudge until done (or a cap) -> finish. Also the fallback path of the Pi orchestrator. */
export async function runDeterministic(job: Job, runner: Runner, orchestrator: Record<string, unknown> = { orchestrator: "none" }): Promise<void> {
  let s: WorkerSession;
  try { s = await WorkerSession.start(job, runner); }
  catch { return; } // already completed as failed (unsupported harness / missing key)
  await driveToDone(s).catch((e) => log(`[${job.session_id}] nudge loop stopped:`, String(e)));
  await s.finish({ orchestrator });
}

/**
 * Generic claim loop shared by worker.ts and pi-octillion/main.ts.
 * RUNNER=pool: claims per harness with limit = idle pods of that harness, and reserves a pod per job.
 * Other runners: claims up to WORKER_CONCURRENCY free slots.
 */
export async function claimLoop(runJob: (job: Job, runner: Runner) => Promise<void>, label: string): Promise<void> {
  // Production: only inside a boat orchestrator sandbox, only RUNNER=boat (OCTILLION_DEV_ALLOW_LOCAL=1: tests).
  assertOrchestratorHost(CFG.runner);
  if (!CFG.token) throw new Error("OCTILLION_WORKER_TOKEN is required");
  // Broker mode: the boat key and the orchestrator LLM token come from the server (docs/credentials.md).
  await orchestratorCredentials().catch((e) => {
    if (CREDENTIALS_MODE === "broker" && CFG.runner === "boat") throw new Error(`orchestrator credentials: ${redact(String(e))}`);
    log("orchestrator credentials unavailable:", redact(String(e)));
  });
  let pool: PodPool | null = null;
  let fleet: FleetMembership | null = null;
  let runner: Runner;
  if (CFG.runner === "pool") {
    pool = new PodPool();
    await pool.start();
    runner = pool.runner();
  } else {
    const r = RUNNERS[CFG.runner];
    if (!r) throw new Error(`RUNNER must be one of ${[...Object.keys(RUNNERS), "pool"].join(", ")}`);
    await checkRunner(r);
    runner = r;
    // RUNNER=boat: the fleet assignment caps concurrent (ephemeral) worker sandboxes per agent group.
    if (r.name === "boat" && FLEET.mode !== "off") { fleet = new FleetMembership(); await fleet.start(); }
  }
  if (CFG.job) log(`${label} bound to ${CFG.job}: claims only its sessions and exits when it is over`);
  const capacity = pool ? POOL.capacity : fleet ? fleet.capacity : CFG.concurrency;
  log(`${label} ${CFG.workerId} runner=${runner.name}${pool ? ` fleet=${pool.mode} orchestrator_id=${pool.orchestratorId}` : fleet ? ` fleet=${fleet.mode} orchestrator_id=${fleet.orchestratorId}` : ""} capacity=${capacity} url=${CFG.url} max=${CFG.maxSessionMs / 60000}m`);

  let stopping = false;
  let stoppedAt = 0;
  const tasks = new Set<Promise<void>>();
  const stop = async (sig: string) => {
    if (stopping) {
      if (Date.now() - stoppedAt < 3000) return; // npx/tsx forward the same signal twice
      log("second signal: exiting now"); process.exit(1);
    }
    stopping = true;
    stoppedAt = Date.now();
    markShuttingDown();
    log(`${sig}: stopping ${activeSessions.size} session(s)`);
    await Promise.all([...activeSessions].map((s) => s.kill()));
    await Promise.allSettled(tasks); // every session's finish() deletes its worker sandbox
    await pool?.drain();
    await fleet?.leave();
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // Per-job: the run finished or was cancelled -> same graceful path (nothing of it is still running).
  if (fleet && CFG.job) {
    fleet.onJobDone = () => void stop("job over");
    if (fleet.job?.done) fleet.onJobDone();
  }

  // Only claim harnesses this worker can actually run (adapter; in env mode also the provider keys).
  const runnable = (h: string) => { try { adapterFor({ harness: h }); return true; } catch { return false; } };
  const skippedLogged = new Set<string>();

  const groupOf = new Map<string, string>(); // session_id -> agent group holding a boat slot
  const claim = async (): Promise<Job[]> => {
    if (fleet) {
      const out: Job[] = [];
      // One claim per agent group: {agent_ids: the group's agents}, limit = that group's free worker-sandbox slots. A slot
      // agent's group (pi) also claims its model_variants; each job carries its own model.
      for (const g of fleet.groups()) {
        if (CFG.harness && getAdapterId(g.harness) !== getAdapterId(CFG.harness)) continue;
        if (!runnable(g.harness)) {
          if (!skippedLogged.has(g.agent_id)) { skippedLogged.add(g.agent_id); log(`fleet: not claiming for ${g.agent_id} (no adapter)`); }
          continue;
        }
        const free = fleet.free(g.agent_id);
        if (!free) continue;
        for (const job of await claimJobs(free, { agentIds: g.agents?.length ? g.agents : [g.agent_id] })) {
          fleet.acquire(g.agent_id);
          groupOf.set(job.session_id, g.agent_id);
          out.push(job);
        }
      }
      return out;
    }
    if (!pool) return claimJobs(capacity - tasks.size);
    const out: Job[] = [];
    // One claim per pod group (registry agent): {agent_ids:[id]}, limit = that group's idle pods.
    for (const g of pool.groups()) {
      if (CFG.harness && getAdapterId(g.harness) !== getAdapterId(CFG.harness)) continue;
      if (!runnable(g.harness)) {
        if (!skippedLogged.has(g.agent_id)) { skippedLogged.add(g.agent_id); log(`pool: not claiming for ${g.agent_id} (no adapter or credentials); its pods stay idle`); }
        continue;
      }
      const idle = pool.idle(g.agent_id);
      if (!idle) continue;
      for (const job of await claimJobs(idle, { agentIds: [g.agent_id] })) {
        if (job.agent_id && job.agent_id !== g.agent_id) log(`[${job.session_id}] server returned agent ${job.agent_id} for a ${g.agent_id} claim`);
        if (!pool.reserve(job.session_id, job.agent_id ?? g.agent_id)) log(`[${job.session_id}] no idle ${g.agent_id} pod for a claimed job; it will fail fast`);
        out.push(job);
      }
    }
    return out;
  };

  while (!stopping) {
    if (tasks.size >= capacity) { await Promise.race(tasks); continue; }
    let jobs: Job[] = [];
    try { jobs = await claim(); }
    catch (e) { log("claim failed:", String(e)); }
    if (jobs.length || tasks.size) markBusy();
    for (const job of jobs) {
      const releaseBusy = holdBusy(); // a running session keeps an on-demand orchestrator from idling out
      const t: Promise<void> = runJob(job, runner)
        .catch((e) => log(`[${job.session_id}] crashed:`, e))
        .finally(() => {
          releaseBusy();
          tasks.delete(t);
          pool?.release(job.session_id);
          const g = groupOf.get(job.session_id);
          if (g) { fleet?.release(g); groupOf.delete(job.session_id); }
        });
      tasks.add(t);
    }
    if (pool && jobs.length) log(`pool: ${pool.summary()}`);
    if (fleet && jobs.length) log(`fleet: ${fleet.summary()}`);
    if (!jobs.length) await Promise.race([sleep(CFG.pollMs), ...tasks]);
  }
  await Promise.allSettled(tasks);
  log(`${label} stopped`);
}

function getAdapterId(h: string): string {
  try { return getAdapter(h).id; } catch { return h; }
}

// Run only when executed directly (pi-octillion imports runDeterministic/claimLoop).
if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  startIdleWatcher();
  claimLoop((job, runner) => runDeterministic(job, runner), "worker")
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
