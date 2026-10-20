/**
 * Fleet membership for RUNNER=boat: the server's per-agent assignment (`pods`) is the MAX number of concurrent
 * worker sandboxes per agent group on this orchestrator. Sandboxes are ephemeral: one fresh boat VM per session,
 * deleted when it ends, so nothing is paid for while no agent runs.
 *
 *  - server (default): POST /api/worker/fleet {orchestrator_id, capacity} at start and every next_checkin_seconds;
 *    unreachable -> keep the last assignment and retry in 10s. SIGTERM -> DELETE /api/worker/fleet/:id.
 *  - standalone: fleet/plan.ts planFleet(capacity).
 */
import { userInfo } from "node:os";
import { planFleet } from "../fleet/plan.js";
import { CFG, env, num } from "./config.js";
import { api, log } from "./util.js";

/** `agents`: registry agent ids this group claims (itself + a slot agent's model_variants; same harness). */
export interface GroupTarget { agent_id: string; harness: string; model: string; pods: number; agents?: string[] }

export const FLEET = {
  // Up to 20 on a shared orchestrator; a per-job one (ORCHESTRATOR_JOB) is launched with its run's share, up to 50.
  capacity: Math.max(1, Math.min(50, num(env.POD_CAPACITY ?? env.FLEET_SIZE, 20))),
  mode: (env.FLEET_MODE === "standalone" ? "standalone" : env.FLEET_MODE === "off" ? "off" : "server") as "server" | "standalone" | "off",
};

export class FleetMembership {
  targets = new Map<string, GroupTarget>();
  /** Per-job orchestrator: the server's view of its job; `onJobDone` runs once when the job is over. */
  job: { id: string; kind: string; status: string | null; done: boolean } | null = null;
  onJobDone: (() => void) | null = null;
  private running = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private left = false;

  constructor(readonly opts: { capacity?: number; mode?: "server" | "standalone"; orchestratorId?: string } = {}) {}
  get capacity() { return this.opts.capacity ?? FLEET.capacity; }
  get mode() { return this.opts.mode ?? (FLEET.mode === "standalone" ? "standalone" : "server"); }
  get orchestratorId() { return this.opts.orchestratorId ?? CFG.orchestratorId; }

  async start(): Promise<void> {
    await this.refresh();
    log(`fleet[${this.orchestratorId}] ${this.mode}: ${this.summary()}`);
  }

  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    let next = 30;
    try {
      if (this.mode === "standalone") {
        this.set(planFleet(this.capacity).map((g) => ({ agent_id: g.agent_id, harness: g.harness, model: g.model, pods: g.pods })));
      } else {
        const r = (await api("/api/worker/fleet", {
          json: { orchestrator_id: this.orchestratorId, capacity: this.capacity,
                  meta: { worker_id: CFG.workerId, runner: "boat", running: Object.fromEntries(this.running), ...(CFG.job ? { job: CFG.job } : {}), user: serviceUser() } },
        })) as { assignment?: GroupTarget[]; next_checkin_seconds?: number; job?: FleetMembership["job"] };
        this.set((r.assignment ?? []).map((a) => ({ agent_id: a.agent_id, harness: a.harness, model: a.model, pods: a.pods,
                                                    ...(Array.isArray(a.agents) ? { agents: a.agents } : {}) })));
        next = Math.max(5, Number(r.next_checkin_seconds ?? 30));
        if (r.job) {
          this.job = r.job;
          if (r.job.done && this.onJobDone) {
            const done = this.onJobDone;
            this.onJobDone = null;
            log(`fleet[${this.orchestratorId}] job ${r.job.id} is ${r.job.status ?? "gone"}: leaving`);
            done();
          }
        }
      }
    } catch (e) {
      next = 10;
      log(`fleet[${this.orchestratorId}] check-in failed (keeping the last assignment, retry in ${next}s):`, String(e));
    }
    if (!this.left) this.timer = setTimeout(() => void this.refresh(), next * 1000);
  }

  private set(list: GroupTarget[]) {
    this.targets = new Map(list.filter((t) => t.pods > 0 && t.agent_id).map((t) => [t.agent_id, t]));
  }

  /** Free worker-sandbox slots of a group (assignment minus sessions running in it). */
  free(agentId: string): number { return Math.max(0, (this.targets.get(agentId)?.pods ?? 0) - (this.running.get(agentId) ?? 0)); }
  groups(): GroupTarget[] { return [...this.targets.values()]; }
  acquire(agentId: string) { this.running.set(agentId, (this.running.get(agentId) ?? 0) + 1); }
  release(agentId: string) { this.running.set(agentId, Math.max(0, (this.running.get(agentId) ?? 0) - 1)); }
  runningCount(): number { return [...this.running.values()].reduce((a, b) => a + b, 0); }

  summary(): string {
    return this.groups().map((g) => `${g.agent_id} ${this.running.get(g.agent_id) ?? 0}/${g.pods}`).join(", ") || "no assignment";
  }

  /** Graceful leave (server mode): the server re-deals this orchestrator's share at once. */
  async leave(): Promise<void> {
    this.left = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.mode === "server")
      await api(`/api/worker/fleet/${encodeURIComponent(this.orchestratorId)}`, { method: "DELETE" })
        .catch((e) => log("fleet leave failed (the server drops us after 90s anyway):", String(e)));
  }
}

/** The OS user this orchestrator runs as (reported at check-in; production runs as the unprivileged "octi"). */
function serviceUser(): string {
  try { return userInfo().username; } catch { return "unknown"; }
}
