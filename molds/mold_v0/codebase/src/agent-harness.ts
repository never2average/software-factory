/**
 * The workspace agent's runner (mold_v0-243; molds/mold_v0/docs/agent-harness.md): one wake of a session, carried out
 * where every run is (src/run-harness.ts dispatches a run whose kind's runner is "agent-harness" here): a run user of
 * its own, the run's egress proxy or its sandbox's firewall, the pinned run tool, and the run's lease.
 *
 *   start       POST .../agent/start: the session's frozen policy, the harness session to resume, the first turn (the
 *               person's messages, or the on_resume hook), what the session was already charged
 *   restore     its last checkpoint (the harness's session files and the working directory) unpacked into the scratch
 *   run         the harness CLI with stream-json on an OPEN stdin: the first turn is one line; every message the
 *               person sends while it works is one more line (steer), echoed back by the CLI as it takes it in
 *   beat        every few seconds: the lease, the cumulative spend (once per session: from the baseline a resumed
 *               session re-reports), the person's messages, pause, end and budget
 *   policy      each tool call is checked against the session's policy: a web host not granted or a tool not allowed
 *               becomes a request and the wake stops (SIGTERM: the CLI flushes its session) awaiting the decision
 *   park        a conversation quiet for park_after_seconds, or past its wake's cap, closes stdin (a turn in progress
 *               finishes) and its wake ends "parked"; a task ends once its work is answered (the stdin ledger)
 *   checkpoint  every checkpoint_seconds and as it ends: a bundle of the scratch's state, sealed by the API
 *   end         POST .../agent/end with how it ended, then the run completes; a wake that dies without saying is a crash
 *
 * This module is part of the run sandbox's code (orchestrator/deploy/boat-lib.ts runnerCodeFiles follows its static
 * imports): it imports only node's modules and runner files, never the API's (types aside).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EGRESS_PROXY_PORT, proxyEnv } from "../orchestrator/core/egress.js";
import type { RunView } from "./pack-api.js";
import type { Claim } from "./runs.js";
import type { AgentPolicy } from "./agent-harness-config.js";
import type { BeatAnswer, BeatInput, EndReason, WakeStart } from "./harness-sessions.js";
import { redactText, type Secret } from "./credential-redact.js";
import { packBundle, unpackBundle } from "./workspace-bundle.js";
import { linkTools, RUN_TOOL_CATALOG, verifyToolSet } from "./run-tools.js";
import { killUser, leaseRunUser, sweepUserFiles, type RunUser } from "./run-users.js";
import { runIsolation, startRunProxy, type HarnessOptions, type RunnerClient, type RunProxy } from "./run-harness.js";

/** What the runner needs of the API for an agent wake (in-process, or over /api/worker/runs/:id/agent with the lease). */
export interface AgentRunnerClient {
  start(runId: string, lease: string): Promise<WakeStart>;
  beat(runId: string, lease: string, b: BeatInput): Promise<BeatAnswer>;
  turn(runId: string, lease: string, t: { text: string; cost_usd?: number | null; answered?: number[] | null }): Promise<{ id: number }>;
  request(runId: string, lease: string, r: { kind: "web" | "tool"; subject: string; detail?: Record<string, unknown> }): Promise<{ id: string }>;
  end(runId: string, lease: string, e: { reason: EndReason; detail?: string }): Promise<{ state: string }>;
  checkpointPut(runId: string, lease: string, seq: number, body: Buffer): Promise<{ seq: number; stored: boolean }>;
  checkpointGet(runId: string, lease: string): Promise<Buffer | null>;
}

// ---------------------------------------------------------------- stream-json (pure; the tests drive these)

/**
 * One user turn as a stream-json line. With `uuid` the CLI (run with --replay-user-messages) echoes it back carrying the
 * same uuid when it takes it in: how the harness knows an instruction folded into a running turn was consumed.
 */
export function encodeStdinMessage(text: string, uuid?: string): string {
  const env: Record<string, unknown> = { type: "user", message: { role: "user", content: text } };
  if (uuid) env.uuid = uuid;
  return JSON.stringify(env) + "\n";
}
/** The uuid of a message the CLI echoed back, or null (a tool result is a `user` event too: only isReplay is an echo). */
export function replayedUuid(e: Record<string, unknown>): string | null {
  if (e.type !== "user" || e.isReplay !== true) return null;
  return typeof e.uuid === "string" && e.uuid ? e.uuid : null;
}
/** The text blocks of a top-level assistant event, joined (a subagent's events carry parent_tool_use_id: not the answer). */
export function assistantText(e: Record<string, unknown>): string | null {
  if (e.type !== "assistant" || e.parent_tool_use_id) return null;
  const content = (e.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const t = content.filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string").map((b) => b.text).join("\n").trim();
  return t || null;
}
export interface ToolUse { id: string; name: string; input: Record<string, unknown> }
export function toolUses(e: Record<string, unknown>): ToolUse[] {
  if (e.type !== "assistant") return [];
  const content = (e.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => !!b && (b as { type?: string }).type === "tool_use").map((b) => {
    const x = b as { id?: unknown; name?: unknown; input?: unknown };
    return { id: String(x.id ?? ""), name: String(x.name ?? ""), input: x.input && typeof x.input === "object" ? (x.input as Record<string, unknown>) : {} };
  });
}
/** A session's cumulative cost as the CLI reports it on a turn's result (never inferred from tokens). */
export function observedCost(e: Record<string, unknown>): number | null {
  const v = e.total_cost_usd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
const TRANSIENT = ["server error mid-response", "overloaded", "service unavailable", "internal server error", "api error: 500", "api error: 502", "api error: 503", "api error: 529"];
/** A turn the model provider cut short (worth asking again in the same session); never the agent's own failure. */
export function transientUpstreamError(e: Record<string, unknown>): boolean {
  if (e.type !== "result" || !e.is_error || typeof e.result !== "string") return false;
  const t = e.result.toLowerCase();
  return t.trimStart().startsWith("api error") && TRANSIENT.some((m) => t.includes(m));
}
/** The result said the CLI's own budget (--max-budget-usd) stopped it. */
export const budgetStopped = (e: Record<string, unknown>) => e.type === "result" && typeof e.subtype === "string" && /budget/i.test(e.subtype);

/**
 * The spend a resumed harness session starts its running total from (its transcript's last saved cost), so a woken
 * session's first report is not charged again for what earlier wakes spent. 0 when there is none.
 */
export function savedSessionCost(stateDir: string, sessionId: string | null): number {
  if (!sessionId) return 0;
  let saved = 0;
  const projects = path.join(stateDir, "projects");
  if (!existsSync(projects)) return 0;
  for (const d of readdirSync(projects)) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (!existsSync(f) || lstatSync(f).isSymbolicLink()) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"cost-state"')) continue;
      try {
        const x = JSON.parse(line) as { type?: string; sessionId?: string; totalCostUSD?: unknown };
        if (x.type === "cost-state" && (x.sessionId === undefined || x.sessionId === sessionId) && typeof x.totalCostUSD === "number" && x.totalCostUSD >= 0) saved = x.totalCostUSD;
      } catch { /* a torn line */ }
    }
  }
  return saved;
}
/** The baseline a resumed session's reports are reduced by: the lower of its saved total and what it was charged. */
export const resumedBaseline = (savedUsd: number, chargedUsd: number | null) => (chargedUsd == null ? Math.max(0, savedUsd) : Math.max(0, Math.min(savedUsd, chargedUsd)));

/**
 * The stdin ledger. A turn's result ends a turn, not the session: under stream-json input the CLI waits for the next
 * line while stdin is open. For a task, each message the person sends holds the session open for its answer, and once
 * nothing injected is unconsumed the result closes stdin and the CLI exits. With echoes the truth is which uuids were
 * taken in (two messages folded into one running turn are answered by that turn's result); without, one turn per
 * message. A session left open by a miscount is closed after an idle grace. A conversation is held open by the person
 * instead, until it parks.
 */
export class SteerLedger {
  outstanding = 0;
  pending = new Set<string>();
  seen = false;
  injected(uuid: string) { this.outstanding++; this.pending.add(uuid); }
  replayed(uuid: string) { this.seen = true; this.pending.delete(uuid); }
  /** A turn's result: whether stdin should close now (else an idle grace is armed). */
  turnEnded(): boolean {
    const heldByCount = this.outstanding > 0;
    if (heldByCount) this.outstanding--;
    return this.seen ? this.pending.size === 0 : !heldByCount;
  }
}

/** What a tool call needs under the session's policy: allowed, a request (a host or a tool), or the web calls are used up. */
export function checkToolUse(t: ToolUse, policy: AgentPolicy, webCalls: number): { ok: true; web: boolean } | { ok: false; request: { kind: "web" | "tool"; subject: string } } | { ok: false; limit: true } {
  if (t.name === "WebFetch" || t.name === "WebSearch") {
    if (policy.web.tools === "off" || (t.name === "WebSearch" && policy.web.tools !== "search")) return { ok: false, request: { kind: "tool", subject: t.name } };
    if (webCalls + 1 > policy.web.calls_max) return { ok: false, limit: true };
    if (t.name === "WebFetch") {
      let host = "";
      try { const u = new URL(String(t.input.url ?? "")); host = u.protocol === "https:" && !u.username && !u.password && !u.port ? u.hostname.toLowerCase() : ""; } catch { /* not a URL */ }
      if (!host) return { ok: false, request: { kind: "tool", subject: "WebFetch" } };
      if (!hostRule(host, policy.web.hosts)) return { ok: false, request: { kind: "web", subject: host } };
    }
    return { ok: true, web: true };
  }
  if (policy.tools.includes(t.name)) return { ok: true, web: false };
  return { ok: false, request: { kind: "tool", subject: t.name } };
}
const hostRule = (h: string, rules: string[]) => rules.some((r) => (r.startsWith("*.") ? h === r.slice(2) || h.endsWith(`.${r.slice(2)}`) : h === r));

/** Claude Code's argv for one wake: stream-json both ways, its echoes, the policy's tools, its hooks, its budget, its session. */
export function claudeCommand(bin: string, w: WakeStart, hooksText: { append_system: string | null }): string[] {
  const p = w.policy;
  const allowed = [...p.tools];
  const web: string[] = [];
  if (p.web.tools !== "off") for (const h of p.web.hosts) web.push(`WebFetch(domain:${h.replace(/^\*\./, "")})`);
  if (p.web.tools === "search") web.push("WebSearch");
  const builtin = [...p.tools.filter((t) => /^[A-Z]/.test(t)), ...(p.web.tools !== "off" ? ["WebFetch"] : []), ...(p.web.tools === "search" ? ["WebSearch"] : [])];
  const argv = [bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--model", p.model, "--max-turns", String(p.max_turns), "--permission-mode", "dontAsk", "--setting-sources", "", "--strict-mcp-config",
    "--tools", builtin.join(","), "--allowedTools", ...allowed, ...web];
  if (w.budget_usd > 0) argv.push("--max-budget-usd", String(Math.round(w.budget_usd * 100) / 100));
  if (hooksText.append_system) argv.push("--append-system-prompt", hooksText.append_system);
  if (w.resume) argv.push("--resume", w.resume);
  return argv;
}

// ---------------------------------------------------------------- one wake

/** The stand-in a test gives instead of the pinned CLI (offline tests only). */
export type AgentCliOverride = { command: string; args: string[] };
export interface AgentHarnessOptions { agentCli?: AgentCliOverride; clock?: () => number; pollMs?: number; beatMs?: number }

const STATE = "state", WORK = "work", HOME = "home";

/** Carry out one wake of an agent session. Never throws for the wake's own failures: it ends and completes them. */
export async function runAgentHarness(client: RunnerClient, claim: Claim, opts: HarnessOptions & AgentHarnessOptions = {}): Promise<RunView | null> {
  const agent = client.agent;
  const run = claim.run, lease = claim.lease_token;
  if (!agent) return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: "this runner cannot carry out agent sessions (its client has no agent calls)" }).catch(() => null);
  const now = opts.clock ?? (() => Date.now());
  const iso = runIsolation(opts);
  let user: RunUser | null = null;
  if (iso) {
    try {
      user = iso.mode === "given" ? iso.user : await leaseRunUser(run.id, { ...(iso.mode === "fixed" ? { fixed: { uid: iso.uid, gid: iso.gid } } : { range: iso.range }), dir: opts.runUidDir });
    } catch (e) {
      return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: `prepare: the run's user: ${(e as Error).message}`.slice(0, 2000) }).catch(() => null);
    }
  }
  const as = user ? { uid: user.uid, gid: user.gid } : null;
  if (as) { killUser(as); sweepUserFiles(as.uid); }
  const scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), `agent-${run.id.slice(4, 12)}-`));
  const state = path.join(scratch, STATE), work = path.join(state, WORK), home = path.join(state, HOME), hooksDir = path.join(scratch, "hooks");
  const secrets: Secret[] = claim.gateway.token ? [{ name: "gateway token", value: claim.gateway.token }] : [];
  const clean = (s: string) => (secrets.length ? redactText(s, secrets) : s);
  let proxy: RunProxy | null = null;
  let child: ChildProcess | null = null;
  let ended: { reason: EndReason; detail?: string } | null = null;
  let completed: RunView | null = null;
  try {
    const w = await agent.start(run.id, lease);
    const policy = w.policy;
    const flavour = policy.flavour;
    // The checkpoint: the harness's own session files and the working directory, as the last wake left them.
    if (w.checkpoint) {
      const body = await agent.checkpointGet(run.id, lease).catch(() => null);
      if (body && createHash("sha256").update(body).digest("hex") === w.checkpoint.sha256) unpackBundle(body, state);
    }
    mkdirSync(work, { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
    // The hooks as resolved at the session's start, written beside the agent: which text it got, from where.
    for (const h of policy.hooks ?? []) {
      mkdirSync(path.join(hooksDir, h.event), { recursive: true });
      writeFileSync(path.join(hooksDir, h.event, "source"), h.source + "\n");
      if (h.text) writeFileSync(path.join(hooksDir, h.event, "prompt.md"), h.text + "\n");
    }
    const appendSystem = policy.hooks?.find((h) => h.event === "append_system")?.text ?? null;
    if (as) { chownTree(state, as.uid, as.gid); }
    // The program: the pinned run tool (or a test's stand-in).
    let argv: string[];
    let binDir: string | null = null;
    if (opts.agentCli) argv = [opts.agentCli.command, ...opts.agentCli.args, ...claudeCommand("claude", w, { append_system: appendSystem }).slice(1)];
    else {
      const set = verifyToolSet([flavourTool(flavour)], { dir: opts.runTools?.dir, catalog: opts.runTools?.catalog ?? RUN_TOOL_CATALOG });
      binDir = linkTools(set.bins, path.join(scratch, "tools-bin"));
      argv = claudeCommand(path.join(binDir, "claude"), w, { append_system: appendSystem });
    }
    // Egress: the run's proxy (or its sandbox's own, behind the firewall), as for every run.
    const mode = opts.egress ?? "proxy";
    if (mode === "proxy") proxy = await startRunProxy(claim.egress.hosts, path.join(scratch, "egress"), claim.egress.exact ?? []);
    else if (mode === "system") proxy = { port: EGRESS_PROXY_PORT, env: proxyEnv(), log: "", stop: () => {} };
    const env: Record<string, string> = {
      PATH: [binDir, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"), HOME: home, LANG: "C.UTF-8",
      RUN_ID: run.id, RUN_ATTEMPT: String(run.attempt), RUN_HOOKS_DIR: hooksDir, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
      ...claim.gateway.env, ...(proxy?.env ?? {}),
    };
    // A resumed session's running total restarts from its saved figure: reports are reduced by min(saved, charged).
    const baseline = w.resume ? resumedBaseline(savedSessionCost(path.join(home, ".claude"), w.resume), w.charged_usd) : 0;

    const ledger = new SteerLedger();
    const consumed: string[] = [];
    const t0 = now();
    const s = { sessionId: w.resume as string | null, inTurn: true, lastActivity: t0, cost: null as number | null, webCalls: w.web_calls, turnText: [] as string[],
      transientRetries: 0, baselineSent: false, checkpointSeq: checkpointBase(w), stdinClosed: false, idleTimer: null as NodeJS.Timeout | null, uuidIds: new Map<string, number[]>() };
    const discarded: number[] = [];
    const holds = flavourHoldsStdin(flavour);

    const [cmd, ...args] = argv;
    child = spawn(cmd!, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], detached: true, ...(as ? { uid: as.uid, gid: as.gid } : {}) });
    const proc = child;
    const exited = new Promise<number | null>((resolve) => { proc.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : null))); proc.on("error", () => resolve(75)); });
    /** A line on stdin; a steer (not the opening turn) holds a task's session open for its own answer. */
    const write = (text: string, ids: number[], steer = true): boolean => {
      if (s.stdinClosed || !proc.stdin || proc.stdin.destroyed) { discarded.push(...ids); return false; }
      const uuid = randomUUID();
      s.uuidIds.set(uuid, ids);
      if (steer) ledger.injected(uuid);
      proc.stdin.write(encodeStdinMessage(text, uuid));
      return true;
    };
    const closeStdin = () => { if (!s.stdinClosed) { s.stdinClosed = true; proc.stdin?.end(); } };
    const stop = (e: { reason: EndReason; detail?: string }) => {
      if (ended) return;
      ended = e;
      // SIGTERM, not a kill: the CLI flushes its session file, which is what a resume continues from.
      try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } }, 30_000).unref();
    };
    const finish = (e: { reason: EndReason; detail?: string }) => { if (!ended) ended = e; closeStdin(); };

    // The first turn: the person's messages (one line), after the reason it talks again, or the on_resume hook alone.
    const opening = [w.preface, ...w.first.map((m) => m.text)].filter(Boolean).join("\n\n") || policy.hooks?.find((h) => h.event === "on_resume")?.text || "Continue.";
    write(opening, w.first.map((m) => m.id), false);
    if (!holds) closeStdin();

    // stdout: stream-json events.
    let buf = "";
    const queue: Promise<unknown>[] = [];
    const onEvent = async (e: Record<string, unknown>) => {
      if (typeof e.session_id === "string" && e.session_id) s.sessionId = e.session_id;
      const echoed = replayedUuid(e);
      if (echoed) { ledger.replayed(echoed); consumed.push(echoed); return; }
      if (e.type === "assistant") {
        s.inTurn = true; s.lastActivity = now();
        const t = assistantText(e); if (t) s.turnText.push(t);
        for (const u of toolUses(e)) {
          if (e.parent_tool_use_id) continue;
          const c = checkToolUse(u, policy, s.webCalls);
          if (c.ok) { if (c.web) s.webCalls++; continue; }
          if ("limit" in c) { await say(`the session used its ${policy.web.calls_max} web calls`); stop({ reason: "web_limit" }); return; }
          // Outside its policy: asked, and the wake stops for the decision (the egress proxy refuses the host meanwhile).
          await agent.request(run.id, lease, { ...c.request, detail: { tool: u.name, ...(u.name === "WebFetch" ? { url: clean(String(u.input.url ?? "")).slice(0, 500) } : {}) } });
          stop({ reason: "awaiting", detail: `${c.request.kind} ${c.request.subject}` });
          return;
        }
        return;
      }
      if (e.type === "result") {
        const cost = observedCost(e); if (cost !== null) s.cost = cost;
        if (budgetStopped(e)) { await postTurn(e); stop({ reason: "budget" }); return; }
        if (policy.mode === "conversation" && transientUpstreamError(e) && s.transientRetries < 2 && !s.stdinClosed) {
          s.transientRetries++;
          setTimeout(() => { if (!s.stdinClosed) proc.stdin?.write(encodeStdinMessage(TRANSIENT_RETRY)); }, s.transientRetries * 10_000).unref();
          return;
        }
        if (!e.is_error) s.transientRetries = 0;
        await postTurn(e);
        s.inTurn = false; s.lastActivity = now();
        if (policy.mode === "task") {
          if (ledger.turnEnded()) finish({ reason: "done" });
          else armIdleClose();
        }
      }
    };
    const postTurn = async (e: Record<string, unknown>) => {
      const text = clean(s.turnText.join("\n\n") || (typeof e.result === "string" ? e.result : "")).slice(0, 20_000);
      s.turnText = [];
      // The person's messages this turn answers: those the CLI echoed it took in (without echoes, every one delivered).
      const answered = consumed.splice(0).flatMap((u) => s.uuidIds.get(u) ?? []);
      await agent.turn(run.id, lease, { text, cost_usd: observedCost(e), answered: ledger.seen ? answered : null }).catch(() => {});
    };
    const say = (t: string) => agent.turn(run.id, lease, { text: t }).catch(() => {});
    const armIdleClose = () => {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => finish({ reason: "done", detail: "closed after an idle grace" }), policy.stdin_idle_seconds * 1000);
      s.idleTimer.unref();
    };
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(l); } catch { continue; }
        queue.push(onEvent(e).catch((x) => console.error(`agent ${run.id}: ${(x as Error).message}`)));
      }
    });
    let stderrTail = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => { stderrTail = (stderrTail + d).slice(-2000); });
    proc.stdin!.on("error", () => { s.stdinClosed = true; });

    // The beat: lease, spend, and the person's messages, pause, end and budget.
    let beatMs = opts.beatMs ?? 3000;
    let lost = false;
    const beat = async () => {
      const a = await agent.beat(run.id, lease, { in_turn: s.inTurn, total_cost_usd: s.cost, session_id: s.sessionId, web_calls: s.webCalls,
        ...(!s.baselineSent ? { baseline_usd: baseline } : {}), discarded: discarded.splice(0) });
      s.baselineSent = true;
      beatMs = opts.beatMs ?? Math.max(1000, Math.min(a.interval_seconds * 1000, (claim.lease_seconds * 1000) / 3));
      if (a.cancel) { stop({ reason: "stopped", detail: a.reason ?? "cancelled" }); return; }
      if (a.steer.length) {
        if (!holds || s.stdinClosed) discarded.push(...a.steer.map((m) => m.id));
        else for (const m of a.steer) { if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } write(m.text, [m.id]); s.inTurn = true; s.lastActivity = now(); }
      }
      if (a.end) finish({ reason: "stopped" });
      else if (a.pause) stop({ reason: "paused" });
      else if (a.budget) stop({ reason: "budget" });
    };
    let beating = true;
    const beatLoop = (async () => {
      while (beating) {
        await new Promise((r) => setTimeout(r, beatMs));
        if (!beating) break;
        try { await beat(); } catch (e) { if ((e as { status?: number }).status === 409) { lost = true; stop({ reason: "failed", detail: "the run's lease was lost" }); } }
      }
    })();
    // The conversation's watcher: park when quiet, or at the wake's cap (the next message wakes it again).
    const poll = opts.pollMs ?? 1000;
    const watcher = setInterval(() => {
      if (ended || policy.mode !== "conversation") return;
      const t = now();
      const park = (why: string) => {
        if (!s.sessionId) { finish({ reason: "stopped", detail: `${why}, with no session to come back to` }); return; }
        finish({ reason: "parked", detail: why });
      };
      if (t - t0 >= policy.wake_max_seconds * 1000) park("max_duration");
      else if (!s.inTurn && t - s.lastActivity >= policy.park_after_seconds * 1000) park("idle");
    }, poll);
    watcher.unref();
    // Checkpoints while it works.
    const cpEvery = policy.checkpoint_seconds * 1000;
    const checkpoint = async () => {
      if (!s.sessionId && !existsSync(path.join(home, ".claude"))) return;
      try {
        const { bundle } = packBundle(state);
        await agent.checkpointPut(run.id, lease, ++s.checkpointSeq, bundle);
      } catch (e) { console.error(`agent ${run.id}: checkpoint: ${(e as Error).message}`); }
    };
    const cpTimer = cpEvery > 0 ? setInterval(() => void checkpoint(), cpEvery) : null;
    cpTimer?.unref();

    const code = await exited;
    beating = false; clearInterval(watcher); if (cpTimer) clearInterval(cpTimer); if (s.idleTimer) clearTimeout(s.idleTimer);
    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ }
    if (as) killUser(as);
    await new Promise((r) => setTimeout(r, 100));
    if (buf.trim()) { try { queue.push(onEvent(JSON.parse(buf))); } catch { /* torn */ } }
    await Promise.all(queue);
    await beatLoop.catch(() => {});
    if (lost) return null;
    // A last beat (its spend), the last checkpoint, then how it ended.
    await beat().catch(() => {});
    if (s.sessionId) await checkpoint();
    const out: { reason: EndReason; detail?: string } = ended ?? (code === 0
      ? { reason: policy.mode === "task" ? "done" : s.sessionId ? "parked" : "stopped", detail: "the harness exited" }
      : { reason: "failed", detail: `the harness exited ${code}: ${clean(stderrTail).split("\n").filter(Boolean).slice(-1)[0] ?? ""}`.slice(0, 300) });
    await agent.end(run.id, lease, out);
    completed = await client.complete(run.id, lease, out.reason === "failed"
      ? { outcome: "failed", error_kind: "run", error: out.detail ?? "the harness failed" }
      : { outcome: "succeeded", results: [] });
    return completed;
  } catch (e) {
    try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    // An infrastructure failure: the session settles as a crash (src/harness-sessions.ts reconcileWake).
    return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: clean(`agent wake: ${(e as Error).message}`).slice(0, 2000) }).catch(() => null);
  } finally {
    proxy?.stop();
    if (as) killUser(as);
    rmSync(scratch, { recursive: true, force: true });
    if (user && iso?.mode !== "given") await user.release().catch(() => false);
  }
}

const TRANSIENT_RETRY = "Your previous response was cut off by a temporary error from the model provider. Nothing you said after the cut reached the person. Continue from where you left off, without repeating tool calls whose results you already have.";
/** Each wake numbers its checkpoints after the session's last (the API ignores one that is not newer). */
const checkpointBase = (w: WakeStart) => w.checkpoint?.seq ?? 0;
/** The flavours the runner knows (src/agent-harness-config.ts AGENT_FLAVOURS: the same ids and contract). */
const flavourTool = (id: string) => (id === "claude-code" ? "claude-code" : id);
const flavourHoldsStdin = (id: string) => id === "claude-code";
function chownTree(dir: string, uid: number, gid: number) {
  chownSync(dir, uid, gid);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) chownTree(p, uid, gid); else chownSync(p, uid, gid);
  }
}
