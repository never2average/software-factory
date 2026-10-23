/**
 * WorkerSession: one claimed job running in one sandbox, possibly over several harness runs
 * (launch, then resumes carrying the simulated developer's replies).
 *
 * This is the deterministic core. A host pack's orchestrator (orchestrator/packs/<id>/, e.g. the Pi one) drives it through tools; worker.ts drives
 * it with no LLM at all (launch -> nudge until done -> finish). Both share every guarantee here: heartbeats, the
 * MAX_SESSION_MINUTES deadline, server-side cancellation, max_user_turns, the git diff event, /complete, cleanup.
 *
 * Run until done: a session only ends once the agent has produced something worth scoring (core/progress.ts: a
 * non-empty workspace diff with code, dependency or config changes), or at MAX_AGENT_TURNS agent turns (summed over
 * launch + resumes, core/turns.ts), or MAX_SESSION_MINUTES, or after GIVE_UP_RUNS nudged runs without any change.
 * Why it ended is recorded as completed_reason: done | turn_cap | time_cap | agent_gave_up | error.
 */
import { egressPolicy } from "./egress.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { acpAdapter, getAdapter, PLAN_FIRST, type HarnessAdapter, type TurnDigest } from "../harnesses/adapters.js";
import { CFG } from "./config.js";
import { CREDENTIALS_MODE, redact, sessionCredentials, sessionCredsExpiring, type SessionCreds } from "./credentials.js";
import { harnessCredentials, withCredentialSetup, providersFromEnv, CRED_SPECS } from "../harnesses/credentials.js";
import type { Runner, Sandbox, RunExit } from "./runners.js";
import { EventSink } from "./sink.js";
import { rememberAgents } from "../fleet/plan.js";
import { UsageTracker } from "./usage.js";
import { api, HttpError, log, withRetry } from "./util.js";
import { assessDiff, type Progress } from "./progress.js";
import { newStepCounter } from "./turns.js";
import { selectTemplate, type TemplateId } from "./workspaces.js";
import { ACP_CLIENT_PATH, ACP_ROUTES, type SessionEnvironment } from "./environment.js";
import { ENV } from "./env-names.js";

export interface Profile {
  slug?: string;
  name?: string;
  summary?: string;
  attributes?: Record<string, unknown>;
  instructions?: string;
}

export interface Job {
  session_id: string;
  simulation_id: string;
  org_id?: number;
  product_id?: number;
  model: string;
  harness: string;
  /** Registry agent (harness + model), e.g. "claude-code/opus". */
  agent_id?: string | null;
  /** The agent's registry spec from the server (src/worker.ts): how admin-added harnesses reach this orchestrator. */
  agent?: { id?: string; harness?: string; model?: string; label?: string; harness_version?: string; requires_env?: string[];
            image?: { docker?: string; boat_snapshot?: string }; origin?: string; base_agent?: string } | null;
  attempt: number;
  prompt: string;
  repo_url: string | null;
  language: string | null;
  /** Scenario starter-workspace hint (orchestrator/workspaces/<template>), tags and title: template selection. */
  template?: string | null;
  tags?: string[] | null;
  title?: string | null;
  max_user_turns?: number;
  profile?: Profile | null;
  /** The persona's developer environment for this session (resolved and blindness-filtered by the server at claim). */
  environment?: SessionEnvironment | null;
  /** A private run: the agent's network is locked down to the gateway, registries and the task's git host. */
  private?: boolean;
  /**
   * How the agent works (server sql/migrations/0001_baseline.sql exec_mode). "plan": its first run is a plan (the CLI's plan mode, or
   * PLAN_FIRST appended where it has none) and the developer approves before it implements. "direct" (or absent, an
   * older server): it implements straight away.
   */
  exec_mode?: "plan" | "direct";
}

/** What the orchestrator sees after a harness run. Contains none of the server's ids. */
export interface TurnReport {
  session: string;
  run: number;
  exited: boolean;
  exit_code: number | null;
  ok: boolean;
  error: string | null;
  last_assistant_text: string;
  commands: string[];
  files: string[];
  user_turns_used: number;
  user_turns_left: number;
  /** Agent turns (model responses / steps) used so far across all runs, and left under MAX_AGENT_TURNS. */
  agent_turns_used: number;
  agent_turns_left: number;
  /** Deterministic done check on the workspace diff (null while a run is still going). */
  workspace: { done: boolean; reason: string; changed_files: string[] } | null;
  /**
   * "plan": the agent was asked to plan first and has not been approved yet; its last message is the plan, and the
   * developer's reply is the go-ahead. "execute": every other run.
   */
  phase: "plan" | "execute";
  /** True when a reply is possible: run ended cleanly, the harness gave a resumable id, turns left, session alive. */
  can_reply: boolean;
  /** Not done yet and the agent can be resumed: the developer must reply (finish_session is refused). */
  must_continue: boolean;
  /** Set when the session can only be finished (timeout, cancelled, shutdown, failure, caps). */
  stop_reason: string | null;
}

export type CompletedReason = "done" | "turn_cap" | "time_cap" | "agent_gave_up" | "error";

const PLAN_APPROVALS = [
  "Looks good, go ahead and implement it.",
  "Plan makes sense. Go ahead.",
  "Sounds good, go ahead and build it.",
];
const NUDGES_AFTER_QUESTION = [
  "Yes, go ahead and make the change.",
  "Your call. Please go ahead and implement it.",
  "Sounds good, do it.",
];
const NUDGES = [
  "Please go ahead and implement it in this project.",
  "I don't see any changes in the code yet. Please make the actual changes.",
  "Keep going until it's actually implemented, please.",
];

/** Deterministic, neutral developer nudge (never names a product): used when no LLM developer is available. */
export function defaultNudge(r: Pick<TurnReport, "last_assistant_text"> & { phase?: TurnReport["phase"] }, n: number): string {
  if (r.phase === "plan") return PLAN_APPROVALS[n % PLAN_APPROVALS.length]!;
  const t = r.last_assistant_text.trim();
  const asked = /\?\s*$/.test(t) || /\b(should i|shall i|do you want|would you like|want me to|let me know)\b/i.test(t);
  const list = asked ? NUDGES_AFTER_QUESTION : NUDGES;
  return list[n % list.length]!;
}

export type FinishHint = { status?: string; note?: string; orchestrator?: Record<string, unknown> };

export const activeSessions = new Set<WorkerSession>();
let shuttingDown = false;
export function markShuttingDown() { shuttingDown = true; }
export const isShuttingDown = () => shuttingDown;

const TEXT_CAP = 8000;

/**
 * Validate the harness without touching a sandbox. Broker mode: the server decides per session (it returns the
 * providers or fails). Env mode (dev): the worker's env must have every provider the harness needs.
 */
export function adapterFor(job: Pick<Job, "harness">): HarnessAdapter {
  const a = getAdapter(job.harness);
  if (CREDENTIALS_MODE === "env") {
    const have = providersFromEnv();
    const missing = (CRED_SPECS[a.id]?.providers ?? []).filter((p) => !have[p]);
    if (missing.length) throw new Error(`Worker has no ${missing.join(", ")} credentials for ${a.id} (CREDENTIALS_MODE=env)`);
  }
  return a;
}

export async function completeJob(sessionId: string, body: Record<string, unknown>) {
  try {
    const res = await withRetry(() => api(`/api/worker/sessions/${encodeURIComponent(sessionId)}/complete`, { json: body }));
    log(`[${sessionId}] complete ${body.status}`, JSON.stringify(res));
  } catch (e) {
    log(`[${sessionId}] /complete failed (server will time it out):`, String(e));
  }
}

/**
 * Claim queued jobs. Pool groups claim with `agentIds: [agent_id]` so a group only gets its own agent's sessions. A
 * per-job orchestrator (ORCHESTRATOR_JOB=sim_...) only ever claims its own simulation's sessions.
 */
export async function claimJobs(limit: number, filter: { harness?: string; agentIds?: string[] } = { harness: CFG.harness }): Promise<Job[]> {
  const res = (await api("/api/worker/claim", {
    json: { worker_id: CFG.workerId, limit: Math.max(1, Math.min(limit, 50)), models: CFG.models, harness: filter.harness, agent_ids: filter.agentIds,
            simulation_id: CFG.job?.startsWith("sim_") ? CFG.job : undefined },
  })) as { jobs?: Job[] };
  const jobs = res?.jobs ?? [];
  rememberAgents(jobs.map((j) => j.agent)); // harness_version pins etc. of agents not in our registry.json (runners.ts harnessPin)
  return jobs;
}

export class WorkerSession {
  readonly handle = `w_${randomUUID().slice(0, 8)}`;
  readonly maxUserTurns: number;
  readonly started = Date.now();
  private sandbox: Sandbox | null = null;
  private sink: EventSink;
  private tracker = new UsageTracker();
  private hbTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private current: Promise<{ exit: RunExit; digest: TurnDigest }> | null = null;
  private last: { exit: RunExit; digest: TurnDigest } | null = null;
  private resumeId: string | null = null;
  private creds: SessionCreds | null = null;
  private stderrTail = "";
  private finishing: Promise<{ status: string; skipped: boolean }> | null = null;
  runs = 0;
  userTurns = 0;
  /** Agent turns used across all runs (core/turns.ts), capped at maxAgentTurns. */
  agentTurns = 0;
  readonly maxAgentTurns = CFG.maxAgentTurns;
  /** Starter workspace seeded into the sandbox (no repo_url), or null. */
  template: TemplateId | null = null;
  /** Latest done check of the workspace diff. */
  progress: Progress | null = null;
  /** Developer replies sent while the agent was not done yet. */
  nudges = 0;
  /** Consecutive resumed runs that changed nothing in the workspace while not done. */
  noProgressRuns = 0;
  /** Plan-then-execute: how the plan was asked for (the CLI's plan mode, or PLAN_FIRST in the task); null = direct. */
  planMode: "native" | "prompted" | null = null;
  /** The plan the agent proposed (its first run's last message), kept for the session's metadata. */
  planText: string | null = null;
  /** Whether the first run left the workspace untouched, i.e. the agent planned and waited as asked. */
  planWaited: boolean | null = null;
  /** The run was stopped at the agent-turn cap (its non-zero exit is not a failure). */
  capStopped = false;
  completedReason: CompletedReason | null = null;
  timedOut = false;
  cancelledByServer = false;
  startError: string | null = null;

  /** The harness adapter; a Zed persona's session switches to its ACP launch once the ACP client is installed. */
  adapter: HarnessAdapter;
  private constructor(readonly job: Job, adapter: HarnessAdapter, private runner: Runner) {
    this.adapter = adapter;
    this.maxUserTurns = Math.max(0, Number.isFinite(job.max_user_turns) ? Number(job.max_user_turns) : CFG.defaultMaxUserTurns);
    this.template = job.repo_url ? null : selectTemplate({ template: job.template, language: job.language, tags: job.tags, title: job.title, prompt: job.prompt });
    this.sink = new EventSink(
      { org_id: job.org_id ?? 0, product_id: job.product_id ?? 0, simulation_id: job.simulation_id, session_id: job.session_id, model: job.model },
      (status) => this.serverRejected(status),
    );
  }

  get finished() { return this.finishing !== null; }
  get running() { return this.current !== null; }

  /**
   * Open the sandbox and launch the harness with the scenario prompt (verbatim, on stdin).
   * Never throws for job-level problems: the session is finished as failed and returned.
   */
  static async start(job: Job, runner: Runner): Promise<WorkerSession> {
    let adapter: HarnessAdapter;
    try { adapter = adapterFor(job); }
    catch (e) {
      await completeJob(job.session_id, { status: "failed", error_message: String(e instanceof Error ? e.message : e) });
      throw e;
    }
    const s = new WorkerSession(job, adapter, runner);
    activeSessions.add(s);
    await s.sink.init();
    s.sink.start();
    const enc = encodeURIComponent(job.session_id);
    s.hbTimer = setInterval(() => {
      api(`/api/worker/sessions/${enc}/heartbeat`).catch((e) => {
        if (e instanceof HttpError && (e.status === 409 || e.status === 404)) s.serverRejected(e.status);
      });
    }, CFG.heartbeatMs);
    s.deadline = setTimeout(() => { s.timedOut = true; log(`[${job.session_id}] max duration hit; killing`); void s.sandbox?.kill(); }, CFG.maxSessionMs);
    try {
      // Credentials first: no point opening a sandbox the broker won't serve.
      s.creds = await sessionCredentials(job.session_id).catch((e) => { throw new Error(`credentials: ${redact(String(e instanceof Error ? e.message : e))}`); });
      harnessCredentials(adapter, s.creds.providers, job.model); // validate the mapping before paying for a sandbox
      // Private runs (customer-written tasks or personas): the agent may only reach the gateway, registries and the
      // task's git host (core/egress.ts). Opt-in until the transparent HTTPS path is verified on boat VMs:
      // APP_EGRESS=private (private runs) or =all (every run); unset = no lockdown.
      const lockdown = ENV.APP_EGRESS === "all" || (job.private && ENV.APP_EGRESS === "private");
      const egress = lockdown && runner.name === "boat"
        ? egressPolicy({ gatewayUrls: Object.values(s.creds.providers).map((p) => p.base_url).filter((u): u is string => !!u), repoUrl: job.repo_url })
        : null;
      if (lockdown && runner.name !== "boat" && ENV.APP_DEV_ALLOW_LOCAL !== "1")
        throw new Error(`private runs need the boat runner for network lockdown (RUNNER=${runner.name})`);
      s.sandbox = await runner.open({ adapter, harness: job.harness, jobKey: job.session_id, agentId: job.agent_id ?? undefined, model: job.model, repoUrl: job.repo_url, template: s.template,
                                       environment: job.environment ?? null, egress });
      if (s.sandbox.egress) s.sink.push({ type: "environment", egress: s.sandbox.egress });
      if (s.sandbox.environment) {
        const e = s.sandbox.environment;
        // Zed persona: launch over the Agent Client Protocol, as Zed's agent panel does (CLI if the ACP install failed).
        if (e.launch === "acp" && ACP_ROUTES[adapter.id]) s.adapter = acpAdapter(adapter, ACP_ROUTES[adapter.id]!, ACP_CLIENT_PATH);
        s.sink.push({ type: "environment", ...e });
        log(`[${job.session_id}] environment ${e.editor}/${e.language ?? "-"}: ${e.present.length} present, ${e.installed.length} installed, ${e.failed.length} failed in ${e.seconds}s; ${e.wiring}`);
      }
      log(`[${job.session_id}] ${s.handle} started ${adapter.id}/${job.model}${s.adapter !== adapter ? " over ACP (Zed)" : ""} in ${s.sandbox.id}${job.repo_url ? ` repo=${job.repo_url}` : ` template=${s.template}`}`);
      // Plan-then-execute needs a second run to implement: a harness that cannot resume works directly (the session's
      // metadata says so, and the server records the mode it actually ran in).
      if (job.exec_mode === "plan" && !s.adapter.canResume) log(`[${job.session_id}] ${s.adapter.id} cannot resume; running directly instead of plan-then-execute`);
      if (job.exec_mode === "plan" && s.adapter.canResume) {
        s.planMode = s.adapter.planArgv ? "native" : "prompted";
        s.sink.push({ type: "exec_mode", mode: "plan", plan: s.planMode });
        await s.launch(s.planMode === "prompted" ? `${job.prompt}\n\n${PLAN_FIRST}` : job.prompt, null, true);
      } else await s.launch(job.prompt, null);
    } catch (e) {
      s.startError = String(e instanceof Error ? e.message : e);
      log(`[${job.session_id}] start failed:`, s.startError);
    }
    return s;
  }

  private serverRejected(status: number) {
    if (this.cancelledByServer) return;
    this.cancelledByServer = true;
    log(`[${this.job.session_id}] server rejected the session (${status}); stopping sandbox`);
    void this.sandbox?.kill();
  }

  private argvBin(): string | undefined {
    if (this.runner.name !== "local") return undefined;
    return this.adapter.id === "claude-code" ? CFG.claudeBin : this.adapter.id === "codex" ? CFG.codexBin : undefined;
  }

  /** Start one harness run. `resumeId` null = first launch; `plan` = the first launch in the CLI's plan mode. */
  private async launch(input: string, resumeId: string | null, plan = false): Promise<void> {
    const sb = this.sandbox!;
    const turnsLeft = Math.max(1, this.maxAgentTurns - this.agentTurns);
    const o = { model: this.job.model, workdir: sb.workdir, maxBudgetUsd: CFG.maxBudgetUsd, maxTurns: turnsLeft, bin: this.argvBin() };
    // Session tokens are short-lived: refetch before a run when close to expiry (e.g. a late resume).
    if (!this.creds || sessionCredsExpiring(this.creds)) this.creds = await sessionCredentials(this.job.session_id);
    const hc = harnessCredentials(this.adapter, this.creds.providers, this.job.model);
    const base = resumeId ? this.adapter.resumeArgv({ ...o, sessionId: resumeId })
      : plan && this.adapter.planArgv ? this.adapter.planArgv(o) : this.adapter.launchArgv(o);
    const argv = withCredentialSetup(base, hc.setup, hc.argv);
    const run = ++this.runs;
    const digest = this.adapter.newDigest();
    const steps = newStepCounter(this.adapter.id);
    const countTurns = (n: number) => {
      if (!n) return;
      this.agentTurns += n;
      if (this.agentTurns >= this.maxAgentTurns && !this.capStopped) {
        this.capStopped = true;
        log(`[${this.job.session_id}] agent turn cap (${this.maxAgentTurns}) reached; stopping the run`);
        this.sink.push({ type: "turn_cap", agent_turns: this.agentTurns, max_agent_turns: this.maxAgentTurns });
        void sb.stopTurn?.();
      }
    };
    const turn = await sb.runTurn(argv, input, hc.env);
    let tail = "";
    turn.stderr.on("data", (d: Buffer | string) => { tail = (tail + d.toString()).slice(-8000); });
    const rl = createInterface({ input: turn.stdout, crlfDelay: Infinity });
    const linesDone = new Promise<void>((r) => rl.once("close", () => r()));
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev === "object" && !Array.isArray(ev)) {
          this.tracker.observe(ev);
          digest.observe(ev);
          countTurns(steps.observe(ev));
          this.sink.pushLine(t, ev); // verbatim (api mode)
          return;
        }
      } catch { /* non-JSON */ }
      this.sink.push({ type: "raw_stdout", text: t.slice(0, 20_000) });
    });
    this.current = (async () => {
      const exit = await turn.exited;
      await Promise.race([linesDone, new Promise((r) => setTimeout(r, 5000))]);
      rl.close();
      if (tail.trim()) { this.stderrTail = tail; this.sink.push({ type: "worker_stderr", run, text: tail.slice(-4000) }); }
      countTurns(steps.end());
      const d = digest.result();
      if (d.capped) this.capStopped = true;
      if (d.sessionId) this.resumeId = d.sessionId;
      await this.checkProgress(run);
      if (this.planMode && run === 1) {
        this.planText = d.lastText.slice(0, 6000) || null;
        this.planWaited = !this.progress?.done;
      }
      const r = { exit, digest: d };
      this.last = r;
      this.current = null;
      return r;
    })();
  }

  /** Done check after a run: the workspace diff vs the seed / cloned commit (deterministic, no LLM). */
  private async checkProgress(run: number): Promise<void> {
    if (!this.sandbox || this.timedOut || this.cancelledByServer) return;
    const diff = await this.sandbox.diff().catch(() => null);
    if (diff === null) return;
    const before = this.progress?.hash ?? null;
    this.progress = assessDiff(diff);
    if (run > 1 && !this.progress.done) this.noProgressRuns = this.progress.hash === before ? this.noProgressRuns + 1 : 0;
    else this.noProgressRuns = 0;
    log(`[${this.job.session_id}] run ${run}: ${this.agentTurns}/${this.maxAgentTurns} agent turns; ${this.progress.done ? "DONE" : "not done"} (${this.progress.reason})`);
  }

  get done(): boolean { return !!this.progress?.done; }
  get gaveUp(): boolean { return !this.done && this.noProgressRuns >= CFG.giveUpRuns; }
  get turnCapped(): boolean { return this.capStopped || this.agentTurns >= this.maxAgentTurns; }

  private stopReason(): string | null {
    if (this.startError) return `start failed: ${this.startError}`;
    if (this.timedOut) return "timeout";
    if (this.cancelledByServer) return "cancelled by server";
    if (shuttingDown) return "worker shutting down";
    if (this.finished) return "finished";
    return null;
  }

  private lastFailed(): string | null {
    if (!this.last) return this.startError ? this.startError : "no run";
    const { exit, digest } = this.last;
    if (exit.error) return exit.error;
    if (this.capStopped) return null; // stopped by us at the agent-turn cap (SIGTERM / error_max_turns)
    // A plan-mode run that produced its plan ended where it should, even if the CLI reports the unapproved
    // plan-exit as an error: the developer's go-ahead resumes it.
    if (this.runs === 1 && this.planMode === "native" && this.planText && !exit.error) return null;
    if (digest.error) return digest.error;
    if (exit.code !== 0) return `Exit code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}: ${this.stderrTail.slice(-500)}`;
    return null;
  }

  /** Wait for the current harness run to end (or `timeoutMs`), then report what the agent said and did. */
  async waitForTurn(timeoutMs?: number): Promise<TurnReport> {
    if (this.current) {
      const t = timeoutMs ? new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)) : null;
      const res = await (t ? Promise.race([this.current, t]) : this.current);
      if (res === "timeout") return this.report(false);
    }
    return this.report(true);
  }

  private report(exited: boolean): TurnReport {
    const d = this.last?.digest;
    const failure = exited ? this.lastFailed() : null;
    const stop = this.stopReason();
    const left = Math.max(0, this.maxUserTurns - this.userTurns);
    const text = d?.lastText ?? "";
    const agentLeft = Math.max(0, this.maxAgentTurns - this.agentTurns);
    // Not done: the developer keeps the agent going (up to the turn cap). Done: optional replies, max_user_turns.
    const repliesLeft = this.done ? left > 0 : true;
    const canReply = exited && !failure && !stop && !!this.resumeId && agentLeft > 0 && !this.turnCapped && !this.gaveUp && repliesLeft;
    const p = exited ? this.progress : null;
    return {
      session: this.handle,
      run: this.runs,
      exited,
      exit_code: this.last?.exit.code ?? null,
      ok: exited && !failure,
      error: failure,
      last_assistant_text: text.length > TEXT_CAP ? "…" + text.slice(-TEXT_CAP) : text, // questions sit at the end
      commands: d?.commands.slice(-25) ?? [],
      files: d?.files.slice(-40) ?? [],
      user_turns_used: this.userTurns,
      user_turns_left: this.done ? left : Math.max(left, 1),
      agent_turns_used: this.agentTurns,
      agent_turns_left: agentLeft,
      workspace: p ? { done: p.done, reason: p.reason, changed_files: p.changed_files.slice(0, 15) } : null,
      phase: this.planMode && this.userTurns === 0 && !this.done ? "plan" : "execute",
      can_reply: canReply,
      must_continue: canReply && !this.done,
      stop_reason: stop ?? (failure ? "harness failed"
        : this.turnCapped ? `agent turn cap reached (${this.maxAgentTurns})`
        : this.gaveUp ? `no workspace change after ${this.noProgressRuns} nudges`
        : !this.resumeId && exited ? "harness gave no resumable session id"
        : this.done && left === 0 ? "max_user_turns reached" : null),
    };
  }

  /** Why finish_session must not end the session yet (the agent is resumable and not done), or null. */
  finishRefusal(): string | null {
    if (this.finished) return null;
    if (this.current) return "the sub-agent is still running; call wait_for_turn first";
    const r = this.report(true);
    if (!r.must_continue) return null;
    return `not done: ${r.workspace?.reason ?? "no workspace changes"}. The agent stopped before implementing the task; reply as the developer to get it to actually make the change (agent turns left: ${r.agent_turns_left})`;
  }

  /** Emit the simulated developer's reply and resume the same harness conversation with it (verbatim, on stdin). */
  async replyAsDeveloper(text: string): Promise<{ run: number; user_turns_left: number }> {
    const reply = text.trim();
    if (!reply) throw new Error("reply is empty");
    // Short on purpose: the prompt asks for one to three sentences, and a long reply is room to leak instructions.
    if (reply.length > 1200) throw new Error("reply too long (max 1200 chars); developers type short chat messages");
    if (this.current) throw new Error("the sub-agent is still running; call wait_for_turn first");
    const r = this.report(true);
    if (!r.can_reply) throw new Error(`cannot reply: ${r.stop_reason ?? "not resumable"}; call finish_session`);
    this.userTurns++;
    if (!this.done) this.nudges++;
    this.sink.push({ type: "simulated_user", turn: this.userTurns, content: reply, ...(r.phase === "plan" ? { phase: "plan_approval" } : {}) });
    await this.launch(reply, this.resumeId);
    return { run: this.runs, user_turns_left: this.maxUserTurns - this.userTurns };
  }

  kill(): Promise<void> { return this.sandbox?.kill() ?? Promise.resolve(); }

  /**
   * Idempotent. Waits for a running harness run (bounded by the session deadline), emits the git diff event,
   * flushes, deletes the sandbox and calls /complete. Status is computed here, never taken from the LLM.
   */
  finish(hint: FinishHint = {}): Promise<{ status: string; skipped: boolean }> {
    this.finishing ??= (async () => {
      try { if (this.current) await this.current; } catch { /* reported below */ }
      const sb = this.sandbox;
      if (sb && !this.timedOut && !this.cancelledByServer) {
        // Codex's stream has no edit contents: one diff event lets the scorer see every change.
        const diff = await sb.diff().catch(() => null);
        if (diff !== null) { this.sink.push({ type: "file_edit", name: "git diff", content: diff }); this.progress = assessDiff(diff); }
      }
      if (this.hbTimer) clearInterval(this.hbTimer);
      if (this.deadline) clearTimeout(this.deadline);

      let status: "completed" | "failed" | "timeout";
      let error: string | undefined;
      let reason: CompletedReason;
      const failure = this.lastFailed();
      if (this.timedOut) { status = "timeout"; reason = "time_cap"; error = `Exceeded MAX_SESSION_MINUTES (${CFG.maxSessionMs / 60000})`; }
      else if (this.startError) { status = "failed"; reason = "error"; error = this.startError; }
      else if (shuttingDown && failure) { status = "failed"; reason = "error"; error = "Worker shut down"; }
      else if (failure) { status = "failed"; reason = "error"; error = failure; }
      else { status = "completed"; reason = this.done ? "done" : this.turnCapped ? "turn_cap" : "agent_gave_up"; }
      this.completedReason = reason;
      this.sink.push({ type: "session_end", completed_reason: reason, agent_turns: this.agentTurns, done_reason: this.progress?.reason ?? null });
      this.sink.stop();
      await this.sink.drain();
      await sb?.cleanup().catch(() => {});
      activeSessions.delete(this);

      if (this.cancelledByServer) { log(`[${this.job.session_id}] cancelled server-side; skipping /complete`); return { status: "cancelled", skipped: true }; }
      const u = this.tracker.usage();
      await completeJob(this.job.session_id, {
        status,
        completed_reason: reason,
        error_message: error,
        sandbox_id: sb?.id,
        tokens_in: u.tokens_in,
        tokens_out: u.tokens_out,
        cost_usd: u.cost_usd,
        metadata: {
          ...u.meta, ...(sb?.meta() ?? {}), ...(sb?.environment ? { environment: sb.environment } : {}),
          runner: this.runner.name, harness: this.adapter.id, worker_id: CFG.workerId,
          exit_code: this.last?.exit.code ?? null, exit_signal: this.last?.exit.signal ?? null,
          wall_ms: Date.now() - this.started, attempt: this.job.attempt,
          harness_runs: this.runs, simulated_user_turns: this.userTurns, max_user_turns: this.maxUserTurns,
          agent_turns: this.agentTurns, max_agent_turns: this.maxAgentTurns, developer_nudges: this.nudges,
          completed_reason: reason, done_reason: this.progress?.reason ?? null, changed_files: this.progress?.changed_files.length ?? 0,
          exec_mode: this.planMode ? "plan" : "direct",
          ...(this.planMode ? { plan_mode: this.planMode, plan_waited: this.planWaited, plan_text: this.planText } : {}),
          ...(this.template ? { workspace_template: this.template } : {}),
          events: this.sink.count,
          ...(hint.status ? { orchestrator_status: hint.status } : {}),
          ...(hint.note ? { orchestrator_note: hint.note.slice(0, 500) } : {}),
          ...(hint.orchestrator ?? {}),
        },
      });
      return { status, skipped: false };
    })();
    return this.finishing;
  }
}

/**
 * Deterministic driver: wait for the run; while the agent is resumable and not done, nudge it as the developer
 * (neutral canned replies, never a product name) and wait again. Stops at done, the turn cap, give-up, a failure or
 * the deadline. Used without an LLM developer (worker.ts) and as the Pi orchestrator's safety net.
 */
export async function driveToDone(s: WorkerSession, nudge: (r: TurnReport, n: number) => string = defaultNudge): Promise<TurnReport> {
  for (;;) {
    const r = await s.waitForTurn();
    if (!r.must_continue || s.finished) return r;
    await s.replyAsDeveloper(nudge(r, s.nudges));
  }
}
