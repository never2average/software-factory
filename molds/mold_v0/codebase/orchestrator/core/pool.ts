/**
 * RUNNER=pool: warm Docker pods in POD GROUPS, one group per registry agent (harness + model), e.g.
 * "claude-code/opus" and "claude-code/sonnet" each sized by its own usage share. Groups of one harness share its image.
 *
 * Sizing (FLEET_MODE):
 *  - server (default): the server plans the GLOBAL fleet across all orchestrators. Each orchestrator
 *    checks in (POST /api/worker/fleet {orchestrator_id, capacity}) at start and every next_checkin_seconds and
 *    reconciles to its `assignment` ([{agent_id, harness, model, pods, image, version}]). Server unreachable ->
 *    keep the current pool and retry. SIGTERM -> DELETE /api/worker/fleet/:id.
 *  - standalone: fleet/plan.ts planFleet(POD_CAPACITY), the same per-agent rule, locally.
 *
 * Reconcile: start missing pods; remove surplus IDLE pods; busy pods over target retire when their session ends.
 *
 * Pods: `orchestrator/images/Dockerfile.<harness>` images idling on `sleep infinity` (user agent, workdir
 * /home/agent/work), docker-runner limits, labels app.pool=1, app.agent=<agent_id>,
 * app.harness=<h>, app.pool.owner=<ORCHESTRATOR_ID>. Busy pods are renamed octi-busy-*.
 *
 * Jobs: each group claims with {agent_ids:[agent_id]} and limit = its idle pods, so an Opus pod only gets Opus
 * sessions; the job's model must equal the group's model (asserted). Every run is `docker exec -u agent` +
 * `env -i` with the image's env without the shell's own names and this session's brokered credentials (values via `-e NAME`).
 * Resumes run in the same pod. After the session the pod is destroyed and re-created while under target.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { planFleet } from "../fleet/plan.js";
import { CFG, env, num } from "./config.js";
import type { Runner, Sandbox, RunExit, Turn } from "./runners.js";
import { DIFF_SCRIPT, capDiff, AGENT_WORKDIR, AGENT_HOME, imageEnv, dockerExecHarness } from "./runners.js";
import { seedBase, seedScript } from "./workspaces.js";
import { api, log, sh } from "./util.js";

export const POOL = {
  capacity: Math.max(1, Math.min(20, num(env.POD_CAPACITY ?? env.FLEET_SIZE, 20))),
  mode: (env.FLEET_MODE === "standalone" ? "standalone" : "server") as "server" | "standalone",
  orchestratorId: CFG.orchestratorId,
  /** Dev/test only: run every group's pods from this image. */
  imageOverride: env.POOL_IMAGE_OVERRIDE || undefined,
};

interface Pod {
  id: string;
  name: string;
  agentId: string;
  harness: string;
  model: string;
  image: string;
  state: "starting" | "idle" | "reserved" | "busy";
  /** Non-secret image env (HOME, PATH, NPM_CONFIG_PREFIX...), APP_* removed. */
  baseEnv: string[];
}

/** One pod group: a registry agent (harness + model). */
export interface Target { agent_id: string; harness: string; model: string; pods: number; image: string }

function limits(): string[] {
  const a = ["--cpus", CFG.dockerCpus, "--memory", CFG.dockerMemory, "--pids-limit", "1024", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
  if (CFG.dockerNetwork) a.push("--network", CFG.dockerNetwork);
  return a;
}

const imageFor = (harness: string, image?: string | null, version?: string | null) =>
  POOL.imageOverride ?? image ?? `octillion/agent-${harness}:${version ?? "latest"}`;

/** Docker-label-safe form of an agent id ("claude-code/opus" -> "claude-code_opus") for container names. */
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, "_");

export class ModelMismatchError extends Error {}

export class PodPool {
  readonly pods = new Map<string, Pod>();
  targets = new Map<string, Target>(); // agent_id -> target
  private reservations = new Map<string, Pod>(); // job session_id -> pod
  private envCache = new Map<string, string[]>();
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  lastCheckin: Record<string, unknown> | null = null;

  constructor(readonly opts: { capacity?: number; mode?: "server" | "standalone"; orchestratorId?: string } = {}) {}

  get capacity() { return this.opts.capacity ?? POOL.capacity; }
  get mode() { return this.opts.mode ?? POOL.mode; }
  get orchestratorId() { return this.opts.orchestratorId ?? POOL.orchestratorId; }

  /** Remove leftovers of this orchestrator id, get a plan, start pods, then keep checking in. */
  async start(): Promise<void> {
    await this.removeOwned();
    await this.refresh();
    log(`pool[${this.orchestratorId}] ${this.mode}: ${this.summary()}`);
  }

  /** One planning round (check-in or local plan) + reconcile; schedules the next round. */
  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    let next = 30;
    try {
      if (this.mode === "standalone") {
        this.setTargets(planFleet(this.capacity).map((g) => ({ agent_id: g.agent_id, harness: g.harness, model: g.model, pods: g.pods, image: imageFor(g.harness, g.image) })));
      } else {
        const r = (await api("/api/worker/fleet", {
          json: { orchestrator_id: this.orchestratorId, capacity: this.capacity, meta: { worker_id: CFG.workerId, runner: "pool", pods: this.pods.size } },
        })) as { assignment?: { agent_id: string; harness: string; model: string; pods: number; image?: string | null; version?: string | null }[]; next_checkin_seconds?: number };
        this.lastCheckin = r as Record<string, unknown>;
        this.setTargets((r.assignment ?? []).map((a) => ({ agent_id: a.agent_id, harness: a.harness, model: a.model, pods: a.pods, image: imageFor(a.harness, a.image, a.version) })));
        next = Math.max(5, Number(r.next_checkin_seconds ?? 30));
      }
      await this.reconcile();
    } catch (e) {
      next = 10;
      log(`pool[${this.orchestratorId}] fleet check-in failed (keeping current pool, retry in ${next}s):`, String(e));
    }
    if (!this.draining) this.timer = setTimeout(() => void this.refresh(), next * 1000);
  }

  setTargets(list: Target[]) {
    this.targets = new Map(list.filter((t) => t.pods > 0 && t.agent_id).map((t) => [t.agent_id, t]));
  }

  private podsOf(agentId: string) { return [...this.pods.values()].filter((p) => p.agentId === agentId); }

  /** Converge pods to targets: start missing, remove surplus idle pods (busy ones retire after their session). */
  reconcile(): Promise<void> {
    this.reconciling ??= (async () => {
      const work: Promise<void>[] = [];
      for (const t of this.targets.values()) {
        for (let i = this.podsOf(t.agent_id).length; i < t.pods; i++) work.push(this.spawnPod(t));
      }
      for (const a of new Set([...this.pods.values()].map((p) => p.agentId))) {
        let surplus = this.podsOf(a).length - (this.targets.get(a)?.pods ?? 0);
        for (const p of this.podsOf(a)) {
          if (surplus <= 0) break;
          if (p.state !== "idle") continue;
          this.pods.delete(p.id);
          surplus--;
          work.push(sh("docker", ["rm", "-f", p.name]).then(() => {}));
        }
      }
      await Promise.allSettled(work);
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async spawnPod(t: Target): Promise<void> {
    if (this.draining) return;
    const id = randomUUID().slice(0, 8);
    const pod: Pod = { id, name: `octi-pool-${slug(t.agent_id)}-${id}`, agentId: t.agent_id, harness: t.harness, model: t.model, image: t.image, state: "starting", baseEnv: [] };
    this.pods.set(id, pod);
    try {
      if (!this.envCache.has(t.image)) this.envCache.set(t.image, await imageEnv(t.image));
      pod.baseEnv = this.envCache.get(t.image)!;
      const labels = ["--label", "app.pool=1", "--label", `app.agent=${t.agent_id}`, "--label", `app.harness=${t.harness}`,
        "--label", `app.model=${t.model}`, "--label", `app.pool.owner=${this.orchestratorId}`];
      const r = await sh("docker", ["run", "-d", "--init", "--name", pod.name, ...labels, ...limits(), "-w", AGENT_WORKDIR, t.image, "sleep", "infinity"]);
      if (r.code !== 0) throw new Error(r.out.slice(-300));
      if (this.draining || !this.pods.has(id)) { await sh("docker", ["rm", "-f", pod.name]); return; }
      pod.state = "idle";
    } catch (e) {
      this.pods.delete(id);
      log(`pool: could not start a ${t.agent_id} pod (${t.image}; build it with orchestrator/images/build.sh): ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    }
  }

  idle(agentId: string): number { return this.podsOf(agentId).filter((p) => p.state === "idle").length; }

  /** Pod groups (agent ids) that currently have pods or targets, with their harness. */
  groups(): { agent_id: string; harness: string; model: string }[] {
    const m = new Map<string, { agent_id: string; harness: string; model: string }>();
    for (const t of this.targets.values()) m.set(t.agent_id, { agent_id: t.agent_id, harness: t.harness, model: t.model });
    for (const p of this.pods.values()) if (!m.has(p.agentId)) m.set(p.agentId, { agent_id: p.agentId, harness: p.harness, model: p.model });
    return [...m.values()];
  }

  /** Reserve an idle pod of the job's group (by agent_id). */
  reserve(jobKey: string, agentId: string): boolean {
    const pod = [...this.pods.values()].find((p) => p.state === "idle" && p.agentId === agentId);
    if (!pod) return false;
    pod.state = "reserved";
    this.reservations.set(jobKey, pod);
    return true;
  }

  /** Called when a job ends: a reservation that never ran goes back to idle (pod is still clean). */
  release(jobKey: string) {
    const pod = this.reservations.get(jobKey);
    this.reservations.delete(jobKey);
    if (pod && pod.state === "reserved") pod.state = "idle";
  }

  /** Take the job's reserved pod, assert the model matches the group, mark it busy. */
  async take(jobKey: string | undefined, agentId: string | undefined, model: string | undefined): Promise<Pod> {
    let pod = jobKey ? this.reservations.get(jobKey) : undefined;
    if (!pod && jobKey && agentId && this.reserve(jobKey, agentId)) pod = this.reservations.get(jobKey);
    if (!pod) throw new Error(`no idle pod for agent ${agentId ?? "?"}`);
    if (model !== undefined && pod.model !== model) {
      this.release(jobKey!);
      throw new ModelMismatchError(`pod group ${pod.agentId} runs model ${pod.model}, but the job asks for ${model}`);
    }
    pod.state = "busy";
    const busy = `octi-busy-${slug(pod.agentId)}-${pod.id}`;
    if ((await sh("docker", ["rename", pod.name, busy])).code === 0) pod.name = busy;
    return pod;
  }

  /** Destroy a used pod; reconcile starts a fresh one if the group is still below target (else it retires). */
  async recycle(pod: Pod): Promise<void> {
    for (const [k, p] of this.reservations) if (p === pod) this.reservations.delete(k);
    this.pods.delete(pod.id);
    await sh("docker", ["rm", "-f", pod.name]);
    if (!this.draining) await this.reconcile();
  }

  private async removeOwned(): Promise<void> {
    const r = await sh("docker", ["ps", "-aq", "--filter", "label=app.pool=1", "--filter", `label=app.pool.owner=${this.orchestratorId}`]);
    const ids = r.out.split(/\s+/).filter(Boolean);
    if (ids.length) await sh("docker", ["rm", "-f", ...ids]);
  }

  /** SIGTERM: leave the fleet (server mode), stop refreshing, remove every pod this orchestrator owns. */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.mode === "server") {
      await api(`/api/worker/fleet/${encodeURIComponent(this.orchestratorId)}`, { method: "DELETE" })
        .catch((e) => log(`pool: fleet leave failed (server drops us after 90s anyway):`, String(e)));
    }
    if (this.reconciling) await this.reconciling.catch(() => {});
    await this.removeOwned();
    this.pods.clear();
    log(`pool[${this.orchestratorId}]: drained`);
  }

  counts(): Record<string, { harness: string; model: string; idle: number; busy: number; target: number }> {
    const out: Record<string, { harness: string; model: string; idle: number; busy: number; target: number }> = {};
    for (const g of this.groups()) {
      const ps = this.podsOf(g.agent_id);
      out[g.agent_id] = { harness: g.harness, model: g.model, idle: ps.filter((p) => p.state === "idle").length,
        busy: ps.filter((p) => p.state === "reserved" || p.state === "busy").length, target: this.targets.get(g.agent_id)?.pods ?? 0 };
    }
    return out;
  }

  summary(): string {
    return Object.entries(this.counts()).map(([a, c]) => `${a} ${c.idle} idle/${c.busy} busy (target ${c.target})`).join(", ") || "no pods";
  }

  runner(): Runner {
    const pool = this;
    return {
      name: "pool",
      async open(spec): Promise<Sandbox> {
        const pod = await pool.take(spec.jobKey, spec.agentId, spec.model);
        let base = "";
        const exec = (args: string[]) => sh("docker", ["exec", "-u", "agent", ...args]);
        try {
          if (spec.repoUrl) {
            const c = await exec([pod.name, "git", "clone", "--depth", "1", "-q", spec.repoUrl, AGENT_WORKDIR]);
            if (c.code !== 0) throw new Error(`git clone failed: ${c.out.slice(-500)}`);
            base = (await exec([pod.name, "git", "-C", AGENT_WORKDIR, "rev-parse", "HEAD"])).out.trim();
          } else if (spec.template) {
            const c = await exec(["-e", `W=${AGENT_WORKDIR}`, "-e", `HOME=${AGENT_HOME}`, pod.name, "bash", "-c", seedScript(spec.template)]);
            if (c.code !== 0) throw new Error(`workspace seed failed: ${c.out.slice(-500)}`);
            base = seedBase(c.out);
          }
        } catch (e) { await pool.recycle(pod); throw e; }
        let current: ChildProcess | null = null;
        let gone = false;
        const destroy = async () => { if (gone) return; gone = true; current?.kill("SIGKILL"); await pool.recycle(pod); };
        return {
          id: `pool:${pod.agentId}-${pod.id}`,
          workdir: AGENT_WORKDIR,
          async runTurn(argv: string[], input: string, env: Record<string, string>): Promise<Turn> {
            const child = spawn("docker", dockerExecHarness(pod.name, pod.baseEnv, Object.keys(env), argv), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
            current = child;
            child.stdin!.end(input);
            const exited = new Promise<RunExit>((resolve) => {
              child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
              child.on("close", (code, signal) => resolve({ code, signal }));
            });
            return { stdout: child.stdout!, stderr: child.stderr!, exited };
          },
          async diff() {
            const r = await exec(["-e", `BASE=${base}`, "-e", `WORK=${AGENT_WORKDIR}`, "-e", "SNAP=/tmp/.octi-snap.git", "-e", `HOME=${AGENT_HOME}`, pod.name, "bash", "-c", DIFF_SCRIPT]);
            return r.code === 0 ? capDiff(r.out) : null;
          },
          async stopTurn() { await sh("docker", ["exec", pod.name, "bash", "-c", "pkill -TERM -u agent || true"]); },
          kill: destroy,
          cleanup: destroy,
          meta: () => ({ pool_agent: pod.agentId, pool_harness: pod.harness, pool_model: pod.model, pool_image: pod.image, pool_orchestrator: pool.orchestratorId }),
        };
      },
    };
  }
}
