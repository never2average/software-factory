import { getDb } from "./db.js";
import { settingNumber } from "./settings.js";
import { apportion, findAgent, scheduledAgents, variantsOf } from "./agents.js";
import { codeHash } from "../orchestrator/deploy/boat-lib.js";

/** Agent ids a pod group claims: the agent itself plus its model_variants. */
export function claimIds(agentId: string): string[] {
  const spec = findAgent(agentId);
  return [...new Set([agentId, ...(spec ? variantsOf(spec).map((v) => v.id) : [])])];
}
import { getPopulation } from "./populations.js";

/**
 * Global pod fleet across horizontally scaled orchestrators.
 *
 * Each orchestrator runs up to OCTILLION_PODS_PER_ORCHESTRATOR (20) warm worker pods. Orchestrators register and
 * heartbeat via POST /api/worker/fleet; the server apportions the *total* capacity of live orchestrators across
 * worker agents by real-world usage, then deals pods out so each orchestrator gets a near-identical mix.
 * A pod group is one registry agent = harness + model: a harness with several popular models gets one group per
 * model (Claude Code · Opus and Claude Code · Sonnet), each sized by that model's own usage share.
 * 10 orchestrators x 20 = 200 pods; an agent at 40% usage gets 80 pods, ~8 per orchestrator.
 * Planning globally avoids the rounding drift of every orchestrator planning 20 pods on its own.
 */

export const PODS_PER_ORCHESTRATOR = () => Math.max(1, Number(process.env.OCTILLION_PODS_PER_ORCHESTRATOR ?? 20));
/** Worker sandboxes one per-job orchestrator may run at once (one simulation's sessions). */
export const JOB_POD_CAPACITY = () => Math.max(1, Math.min(50, settingNumber("OCTILLION_JOB_POD_CAPACITY"))); // global setting (/admin/compute), else env
export const JOB_ID = /^(sim|rsh)_[A-Za-z0-9_-]{1,40}$/;
const STALE_SECONDS = () => Number(process.env.OCTILLION_FLEET_STALE_SECONDS ?? 90);

export interface AgentShare { agent_id: string; harness: string; model: string; weight: number; image?: string; version?: string }

/** One pod group per scheduled agent (harness + model) of the default developer population, weighted by its sandboxes. */
export async function agentShares(): Promise<AgentShare[]> {
  return scheduledAgents(await getPopulation())
    .map((a) => ({ agent_id: a.id, harness: a.harness, model: a.model, weight: a.weight, image: a.image?.docker, version: a.harness_version }))
    .sort((a, b) => b.weight - a.weight || a.agent_id.localeCompare(b.agent_id));
}

/**
 * Pods per harness for a total fleet size: strictly proportional to usage (largest remainder), then any harness
 * left with zero pods gets one, taken from whichever harness is most over its exact share (so no harness's
 * sessions starve, and the big shares stay exact: 200 pods at 40% -> 80).
 */
export function planPods(total: number, shares: AgentShare[]): (AgentShare & { pods: number })[] {
  const plan = apportion(shares, total).map(({ item, count }) => ({ ...item, pods: count }));
  if (total >= plan.length)
    for (const empty of plan.filter((p) => p.pods === 0)) {
      const donor = plan.filter((p) => p.pods > 1).sort((a, b) => (b.pods - b.weight * total) - (a.pods - a.weight * total))[0];
      if (!donor) break;
      donor.pods--;
      empty.pods++;
    }
  return plan;
}

/**
 * Deal a global plan to orchestrators (sorted by id, deterministic): every orchestrator first gets an even base
 * share of each harness (floor(pods / N), within its capacity); leftover pods then go one at a time to the
 * orchestrator with the most free room relative to its capacity that holds the fewest of that harness.
 */
export function assign(plan: { agent_id: string; pods: number }[], orchestrators: { id: string; capacity: number }[]) {
  const out = new Map(orchestrators.map((o) => [o.id, new Map<string, number>()]));
  const load = new Map(orchestrators.map((o) => [o.id, 0]));
  const give = (o: { id: string }, agentId: string, n: number) => {
    const m = out.get(o.id)!;
    m.set(agentId, (m.get(agentId) ?? 0) + n);
    load.set(o.id, load.get(o.id)! + n);
  };
  if (!orchestrators.length) return out;
  const left = new Map(plan.map((p) => [p.agent_id, p.pods]));
  for (const p of plan) {
    const base = Math.floor(p.pods / orchestrators.length);
    for (const o of orchestrators) {
      const n = Math.min(base, o.capacity - load.get(o.id)!);
      if (n > 0) give(o, p.agent_id, n), left.set(p.agent_id, left.get(p.agent_id)! - n);
    }
  }
  for (const p of plan) {
    for (let rem = left.get(p.agent_id)!; rem > 0; rem--) {
      const o = orchestrators
        .filter((x) => load.get(x.id)! < x.capacity)
        .sort((a, b) =>
          load.get(a.id)! / a.capacity - load.get(b.id)! / b.capacity ||
          (out.get(a.id)!.get(p.agent_id) ?? 0) - (out.get(b.id)!.get(p.agent_id) ?? 0) ||
          a.id.localeCompare(b.id))[0];
      if (!o) break;
      give(o, p.agent_id, 1);
    }
  }
  return out;
}

/**
 * The job a per-job orchestrator serves: the job its token is bound to, else its sandbox row (written at launch), else
 * what its check-in says (manual runs with the fleet token only; a job token can never claim another job this way).
 */
export async function jobOf(orchestratorId: string, meta: Record<string, unknown> = {}, tokenJob?: string): Promise<string | null> {
  if (tokenJob) return tokenJob;
  const db = await getDb();
  const [r] = await db.query<{ job_id: string }>(
    "SELECT job_id FROM orchestrator_sandboxes WHERE orchestrator_id = $1 AND job_id IS NOT NULL ORDER BY id DESC LIMIT 1", [orchestratorId]);
  return r?.job_id ?? (typeof meta.job === "string" && JOB_ID.test(meta.job) ? meta.job : null);
}

/** Register / heartbeat an orchestrator and return its share of the global fleet, or of its job when it has one. */
export async function fleetCheckin(orchestratorId: string, capacity?: number, meta: Record<string, unknown> = {}, tokenJob?: string) {
  const job = await jobOf(orchestratorId, meta, tokenJob);
  const max = job ? JOB_POD_CAPACITY() : PODS_PER_ORCHESTRATOR();
  const cap = Math.min(Math.max(1, Math.trunc(capacity ?? max)), max);
  meta = { ...meta, job };
  const db = await getDb();
  await db.query(
    `INSERT INTO orchestrators (id, capacity, meta, registered_at, last_seen) VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (id) DO UPDATE SET capacity = excluded.capacity, meta = excluded.meta, last_seen = now()`,
    [orchestratorId, cap, JSON.stringify(meta)],
  );
  return job ? jobFleetStatus(orchestratorId, job, cap) : fleetStatus(orchestratorId);
}

export async function fleetLeave(orchestratorId: string) {
  const db = await getDb();
  await db.query("DELETE FROM orchestrators WHERE id = $1", [orchestratorId]);
  // On-demand orchestrators leave when idle (or on SIGTERM): the autoscaler deletes their sandbox on its next tick.
  await db.query("UPDATE orchestrator_sandboxes SET state = 'draining', last_seen = now() WHERE orchestrator_id = $1 AND state IN ('booting', 'running')", [orchestratorId]);
}

/**
 * Recycle on deploy. An orchestrator gets its code once, when the server launches it; the launch records that code's
 * hash (orchestrator_sandboxes.code_hash). One whose hash differs from the code this server ships runs a previous
 * deploy's code and is retired without waiting for its idle timeout: it gets an empty assignment (so it claims nothing
 * new, and fresh orchestrators take the pods), and the autoscaler deletes it as soon as it has checked in again with
 * nothing running. All of it is in the database, so several server replicas agree, and a plain restart (same code)
 * recycles nothing. OCTILLION_RECYCLE_ON_DEPLOY=off keeps the old behaviour (they live until idle).
 */
export const SERVER_STARTED_AT = new Date();
let currentHash: string | undefined;
/** The hash of the orchestrator code this server launches (the autoscaler sets it; default: the repo's). */
export const setCurrentCodeHash = (hash: string) => { currentHash = hash; };
export const currentCodeHash = () => (currentHash ??= codeHash());

/** Autoscaler-launched orchestrators running other code than this server ships (manually run ones are never retired). */
export async function staleOrchestratorIds(): Promise<Set<string>> {
  if ((process.env.OCTILLION_RECYCLE_ON_DEPLOY ?? "on").toLowerCase() === "off") return new Set();
  const db = await getDb();
  // Rows from before code_hash existed have none: those are stale when they predate this server process.
  const rows = await db.query<{ orchestrator_id: string }>(
    `SELECT orchestrator_id FROM orchestrator_sandboxes
      WHERE state IN ('booting', 'running') AND orchestrator_id IS NOT NULL
        AND ((code_hash IS NOT NULL AND code_hash <> $1) OR (code_hash IS NULL AND created_at < $2))`,
    [currentCodeHash(), SERVER_STARTED_AT]);
  return new Set(rows.map((r) => r.orchestrator_id));
}

/** Whether an orchestrator still has agent sessions or product research running (by the worker id it checks in with). */
export async function orchestratorBusy(orchestratorId: string): Promise<boolean> {
  const db = await getDb();
  const [o] = await db.query<{ worker_id: string | null }>("SELECT meta->>'worker_id' AS worker_id FROM orchestrators WHERE id = $1", [orchestratorId]);
  if (!o?.worker_id) return true; // unknown: never delete on a guess
  const [n] = await db.query<{ n: number }>(
    `/* tenant: internal: autoscaler, by the orchestrator's worker id; returns a count only */ SELECT (SELECT count(*) FROM agent_sessions WHERE status = 'running' AND worker_id = $1)
          + (SELECT count(*) FROM product_research WHERE status = 'running' AND worker_id = $1) AS n`, [o.worker_id]);
  return Number(n?.n ?? 0) > 0;
}

export async function fleetStatus(orchestratorId?: string) {
  const db = await getDb();
  const stale = await staleOrchestratorIds();
  if (orchestratorId && stale.has(orchestratorId))
    await db.query("UPDATE orchestrator_sandboxes SET retiring_since = coalesce(retiring_since, now()) WHERE orchestrator_id = $1 AND state IN ('booting', 'running')", [orchestratorId]);
  const live = (await db.query<{ id: string; capacity: number; last_seen: Date; job: string | null }>(
    `SELECT id, capacity, last_seen, meta->>'job' AS job FROM orchestrators WHERE last_seen > now() - make_interval(secs => $1) ORDER BY id`,
    [STALE_SECONDS()],
  )).filter((o) => !stale.has(o.id) && !o.job); // retiring orchestrators get no pods (empty `assignment`); per-job ones have their own
  const total = live.reduce((s, o) => s + Number(o.capacity), 0);
  const plan = planPods(total, await agentShares());
  const dealt = assign(plan, live.map((o) => ({ id: o.id, capacity: Number(o.capacity) })));
  const [queue] = await db.query<{ queued: number; running: number }>(
    "/* tenant: worker API: global queue counts for orchestrators, counts only */ SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running FROM agent_sessions",
  );
  const mine = orchestratorId ? dealt.get(orchestratorId) : undefined;
  return {
    orchestrators: live.length,
    total_pods: total,
    plan,
    queue,
    ...(orchestratorId
      ? {
          orchestrator_id: orchestratorId,
          // One entry per pod group: claim with `agents` so a Sonnet pod only takes Sonnet sessions. A slot agent with
          // model_variants (pi) also takes its variants' sessions (same harness; the model comes from the session).
          assignment: plan.map((s) => ({ agent_id: s.agent_id, harness: s.harness, model: s.model, pods: mine?.get(s.agent_id) ?? 0,
                                         image: s.image ?? null, version: s.version ?? null, agents: claimIds(s.agent_id) }))
            .filter((a) => a.pods > 0),
          next_checkin_seconds: Math.max(10, Math.floor(STALE_SECONDS() / 3)),
        }
      : { assignments: Object.fromEntries([...dealt].map(([id, m]) => [id, Object.fromEntries(m)])) }),
  };
}

/** Whether a job is over: its simulation or research is no longer queued or running (or is gone). */
export async function jobState(jobId: string): Promise<{ kind: "simulation" | "research"; status: string | null; done: boolean; finished_at: Date | null }> {
  const db = await getDb();
  const research = jobId.startsWith("rsh_");
  const [r] = await db.query<{ status: string; finished_at: Date | null }>(
    `SELECT status, finished_at FROM ${research ? "product_research" : "simulations"} WHERE id = $1`, [jobId]);
  return { kind: research ? "research" : "simulation", status: r?.status ?? null, done: !r || !["queued", "running"].includes(r.status),
           finished_at: r?.finished_at ? new Date(r.finished_at) : null };
}

/**
 * Pure: split `capacity` worker sandboxes over groups by their unfinished sessions, never more than a group's demand.
 * Each group gets one before any gets a second (no agent of the run starves), then the most under-served goes next.
 */
export function splitPods(capacity: number, demands: number[]): number[] {
  const pods = demands.map(() => 0);
  for (let left = Math.max(0, Math.trunc(capacity)); left > 0; left--) {
    let best = -1;
    demands.forEach((d, i) => {
      if (pods[i]! >= d) return;
      const r = pods[i]! / d, rb = best < 0 ? Infinity : pods[best]! / demands[best]!;
      if (r < rb || (r === rb && d > demands[best]!)) best = i;
    });
    if (best < 0) break;
    pods[best]!++;
  }
  return pods;
}

/**
 * One orchestrator per job. A simulation's orchestrator gets pod groups for that run's unfinished sessions only (per
 * agent, claimed with simulation_id so nothing of another run or customer reaches it); a research orchestrator gets
 * none (it runs one onboarding research). `job.done` tells it to leave and exit: the run finished or was cancelled,
 * or the research completed or failed. A retiring orchestrator (old code) gets nothing, and the autoscaler launches a
 * fresh one for the job.
 */
export async function jobFleetStatus(orchestratorId: string, jobId: string, capacity: number) {
  const db = await getDb();
  const stale = await staleOrchestratorIds();
  if (stale.has(orchestratorId))
    await db.query("UPDATE orchestrator_sandboxes SET retiring_since = coalesce(retiring_since, now()) WHERE orchestrator_id = $1 AND state IN ('booting', 'running')", [orchestratorId]);
  const state = await jobState(jobId);
  type Group = { agent_id: string; harness: string; model: string; image: string | null; version: string | null; agents: string[]; demand: number };
  const groups = new Map<string, Group>();
  if (state.kind === "simulation" && !state.done && !stale.has(orchestratorId)) {
    const counts = await db.query<{ agent_id: string | null; n: number }>(
      "/* tenant: simulation is the job token's own job, or fleet token (jobOf in fleetCheckin) */ SELECT agent_id, count(*) AS n FROM agent_sessions WHERE simulation_id = $1 AND status IN ('queued', 'running') GROUP BY agent_id ORDER BY agent_id", [jobId]);
    const slotOf = new Map<string, AgentShare>();
    for (const sh of await agentShares()) for (const id of claimIds(sh.agent_id)) if (!slotOf.has(id)) slotOf.set(id, sh);
    for (const c of counts) {
      if (!c.agent_id) continue; // sessions without a registry agent are not claimable by agent groups
      const slot = slotOf.get(c.agent_id);
      const spec = slot ? undefined : findAgent(c.agent_id);
      if (!slot && !spec) continue;
      const id = slot?.agent_id ?? spec!.id;
      const g = groups.get(id) ?? { agent_id: id, harness: slot?.harness ?? spec!.harness, model: slot?.model ?? spec!.model,
                                     image: (slot ? slot.image : spec!.image?.docker) ?? null, version: (slot ? slot.version : spec!.harness_version) ?? null,
                                     agents: slot ? claimIds(id) : [id], demand: 0 };
      g.demand += Number(c.n);
      groups.set(id, g);
    }
  }
  const list = [...groups.values()];
  const pods = splitPods(capacity, list.map((g) => g.demand));
  return {
    orchestrator_id: orchestratorId,
    job: { id: jobId, kind: state.kind, status: state.status, done: state.done },
    assignment: list.map(({ demand: _d, ...g }, i) => ({ ...g, pods: pods[i]! })).filter((a) => a.pods > 0),
    next_checkin_seconds: Math.max(10, Math.floor(STALE_SECONDS() / 6)),
  };
}
