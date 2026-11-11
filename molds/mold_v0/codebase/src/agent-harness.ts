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
 *   workspace   the app's own customer MCP server (mold_v0-250): an --mcp-config naming it "app" at the API's /mcp,
 *               its Authorization a ${RUN_WORKSPACE_TOKEN} reference to this wake's token (never written to a file), and
 *               the workspace's context appended to the standing instructions
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
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EGRESS_PROXY_PORT, proxyEnv } from "../orchestrator/core/egress.js";
import type { RunView } from "./pack-api.js";
import type { Claim } from "./runs.js";
import type { AgentPolicy } from "./agent-harness-config.js";
import type { BeatAnswer, BeatInput, EndReason, WakeStart } from "./harness-sessions.js";
import { redactText, type Secret } from "./credential-redact.js";
import { governToolUse, isNestedTool, VIOLATION_WORDS, type GovernanceViolation } from "./agent-governance.js";
import { packBundle, unpackBundle } from "./workspace-bundle.js";
import { linkTools, RUN_TOOL_CATALOG, verifyToolSet } from "./run-tools.js";
import { killUser, leaseRunUser, sweepUserFiles, type RunUser } from "./run-users.js";
import { runIsolation, startRunProxy, type HarnessOptions, type RunnerClient, type RunProxy } from "./run-harness.js";
import { fetchPinned, type FetchOptions } from "./agent-workspace.js";
import { gitCredentialFiles } from "./agent-workspace-steps.js";

/** The workspace's MCP server name the CLI gets (src/agent-harness-config.ts WORKSPACE_SERVER: the same word). */
const WORKSPACE = "app";
/** The wake's environment variable holding its workspace token, referenced from its MCP config. */
export const WORKSPACE_TOKEN_ENV = "RUN_WORKSPACE_TOKEN";

/**
 * The MCP config a wake's CLI reads: the workspace's server over HTTP, its token by reference (Claude Code expands ${...}),
 * its tools loaded up front (alwaysLoad, as the reference does: not deferred behind the CLI's own tool search, which the
 * session's policy would have to ask for).
 */
export function workspaceMcpConfig(apiUrl: string): { mcpServers: Record<string, { type: "http"; url: string; alwaysLoad: boolean; headers: Record<string, string> }> } {
  return { mcpServers: { [WORKSPACE]: { type: "http", url: `${apiUrl.replace(/\/+$/, "")}/mcp`, alwaysLoad: true, headers: { Authorization: `Bearer \${${WORKSPACE_TOKEN_ENV}}` } } } };
}

/** What the runner needs of the API for an agent wake (in-process, or over /api/worker/runs/:id/agent with the lease). */
export interface AgentRunnerClient {
  start(runId: string, lease: string): Promise<WakeStart>;
  beat(runId: string, lease: string, b: BeatInput): Promise<BeatAnswer>;
  turn(runId: string, lease: string, t: { text: string; cost_usd?: number | null; answered?: number[] | null }): Promise<{ id: number }>;
  request(runId: string, lease: string, r: { kind: "web" | "tool"; subject: string; detail?: Record<string, unknown> }): Promise<{ id: string }>;
  end(runId: string, lease: string, e: { reason: EndReason; detail?: string }): Promise<{ state: string }>;
  checkpointPut(runId: string, lease: string, seq: number, body: Buffer): Promise<{ seq: number; stored: boolean }>;
  checkpointGet(runId: string, lease: string): Promise<Buffer | null>;
  /** mold_v0-267: one part of a file its profile uploads into the session's workspace. */
  uploadPart(runId: string, lease: string, uploadId: string, part: number): Promise<Buffer>;
  /** mold_v0-290: a short-lived read-only token and the commits for the repositories its session's messages chose. */
  repositories?(runId: string, lease: string, only?: string[]): Promise<import("./github-app.js").SessionRepositoryGrant>;
  /** mold_v0-271: the agent's proposed next version of a recipe its session used (a bundle of its proposal's folder). */
  recipeProposal?(runId: string, lease: string, recipe: string, bundle: Buffer, executable: string[]): Promise<{ proposal: string }>;
  /** mold_v0-291: the candidate a machine's state produced (a bundle of its `.candidate/`). */
  candidate?(runId: string, lease: string, bundle: Buffer): Promise<{ sha256: string; paths: number }>;
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
/** The tool results of a `user` event (the CLI answers a tool_use this way): the call's id, its text, and whether it failed. */
export function toolResults(e: Record<string, unknown>): { id: string; text: string; isError: boolean }[] {
  if (e.type !== "user" || e.isReplay === true) return [];
  const content = (e.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => !!b && (b as { type?: string }).type === "tool_result").map((b) => {
    const x = b as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
    const text = typeof x.content === "string" ? x.content
      : Array.isArray(x.content) ? x.content.map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join("\n") : "";
    return { id: String(x.tool_use_id ?? ""), text, isError: x.is_error === true };
  });
}
/**
 * A trace event's data within the run's event limit (16 KB, src/runs.ts appendRunEvents), its long fields shortened
 * (a tool's arguments or result can be any size). Fields are strings already redacted by the caller.
 */
export function fitEvent(data: Record<string, unknown>, limit = 15 * 1024): Record<string, unknown> {
  const out = { ...data };
  for (const k of ["input", "result", "preview"]) if (typeof out[k] === "string") out[k] = (out[k] as string).slice(0, k === "preview" ? 300 : 12_000);
  for (let keep = 8000; Buffer.byteLength(JSON.stringify(out)) > limit && keep > 100; keep = Math.floor(keep / 2)) {
    for (const k of ["input", "result"]) if (typeof out[k] === "string" && (out[k] as string).length > keep) { out[k] = (out[k] as string).slice(0, keep); out.truncated = true; }
  }
  return out;
}

/** mold_v0-295: the kind of sub-agent a Task (Agent) call starts, as the harness names it (its subagent_type), or null. */
export const subagentOf = (u: ToolUse): string | null => ((u.name === "Task" || u.name === "Agent") && typeof u.input.subagent_type === "string" && u.input.subagent_type ? u.input.subagent_type.slice(0, 80) : null);

/** The one identifying detail of a tool call in the trace: a command, a file path, a search; else its arguments. */
export function previewOf(u: ToolUse): string {
  const i = u.input;
  const pick = u.name === "Bash" ? i.command : u.name === "Read" || u.name === "Edit" || u.name === "Write" ? i.file_path : u.name === "Grep" || u.name === "Glob" ? i.pattern : u.name === "WebFetch" ? i.url : u.name === "WebSearch" ? i.query : u.name === "Task" || u.name === "Agent" ? i.description : null;
  return typeof pick === "string" ? pick : JSON.stringify(i);
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

export type ToolCheckResult =
  | { ok: true; web: boolean; mcp?: boolean }
  | { ok: false; request: { kind: "web" | "tool"; subject: string; egress?: "website" | "package"; url?: string | null } }
  | { ok: false; limit: true } | { ok: false; hidden: true }
  /** mold_v0-267: refused outright by its governance policy (the reference's code): the session ends with it. */
  | { ok: false; violation: GovernanceViolation };
/**
 * What a tool call needs under the session's policy: allowed, a request (a host or a tool), or the web calls are used
 * up. Under a governance policy (mold_v0-267) its rules decide first (src/agent-governance.ts governToolUse): a web call
 * or one of the app's tools, a shell command that downloads; `mcpCalls` is this wake's calls of the app's tools.
 */
export function checkToolUse(t: ToolUse, policy: AgentPolicy, webCalls: number, mcpCalls = 0, now = Date.now()): ToolCheckResult {
  const c = checkToolUseInner(t, policy, webCalls, mcpCalls, now);
  // mold_v0-291: a child never asks a person for more: what its policy (the intersection with its parent's) does not allow ends it.
  if (!c.ok && "request" in c && policy.nested?.is_child) return { ok: false, violation: c.request.kind === "web" ? "web_fetch_domain_not_allowed" : "mcp_tool_not_allowed" };
  return c;
}
function checkToolUseInner(t: ToolUse, policy: AgentPolicy, webCalls: number, mcpCalls = 0, now = Date.now()): ToolCheckResult {
  // mold_v0-291: the session's own spawn and collect tools, on a session that has them: no governance allowlist is theirs to hide.
  if (policy.nested && isNestedTool(t.name, WORKSPACE) && policy.tools.includes(t.name)) return { ok: true, web: false };
  if (policy.governance) {
    const g = governToolUse(t, policy.governance, { webCalls, mcpCalls, now, appServer: WORKSPACE });
    if (g.decision === "allow") return { ok: true, web: g.web, mcp: g.mcp };
    if (g.decision === "deny") return { ok: false, violation: g.code };
    if (g.decision === "ask") return { ok: false, request: { kind: "web", subject: g.host, egress: g.kind, url: g.url } };
  }
  // mold_v0-261: a workspace tool its agent profile hides is not the session's: never asked for (the CLI's own rules and
  // the server refuse the call).
  const own = t.name.startsWith(`mcp__${WORKSPACE}__`) ? t.name.slice(`mcp__${WORKSPACE}__`.length) : null;
  if (own && (policy.workspace?.hidden ?? []).includes(own)) return { ok: false, hidden: true };
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
export function claudeCommand(bin: string, w: WakeStart, hooksText: { append_system: string | null }, mcpConfig: string | null = null): string[] {
  const p = w.policy;
  const allowed = [...p.tools];
  const web: string[] = [];
  if (p.web.tools !== "off") for (const h of p.web.hosts) web.push(`WebFetch(domain:${h.replace(/^\*\./, "")})`);
  if (p.web.tools === "search") web.push("WebSearch");
  const builtin = [...p.tools.filter((t) => /^[A-Z]/.test(t)), ...(p.web.tools !== "off" ? ["WebFetch"] : []), ...(p.web.tools === "search" ? ["WebSearch"] : [])];
  const argv = [bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--model", p.model, "--max-turns", String(p.max_turns), "--permission-mode", "dontAsk", "--setting-sources", "", ...(mcpConfig ? ["--mcp-config", mcpConfig] : []), "--strict-mcp-config",
    "--tools", builtin.join(","), "--allowedTools", ...allowed, ...web];
  if (w.budget_usd > 0) argv.push("--max-budget-usd", String(Math.round(w.budget_usd * 100) / 100));
  if (hooksText.append_system) argv.push("--append-system-prompt", hooksText.append_system);
  if (w.resume) argv.push("--resume", w.resume);
  return argv;
}

// ---------------------------------------------------------------- one wake

/** The stand-in a test gives instead of the pinned CLI (offline tests only). */
export type AgentCliOverride = { command: string; args: string[] };
export interface AgentHarnessOptions { agentCli?: AgentCliOverride; clock?: () => number; pollMs?: number; beatMs?: number;
  /** Tests only: where a repository's copy is fetched from (a file:// mirror, as the workspace steps' own tests), and the options for it. */
  repositoryFetch?: { remote: (fullName: string) => string; options: FetchOptions } }
const REPOSITORIES = "repos";
/** The most one repository's copy may hold: the size a workspace may be (src/workspace-bundle.ts). */
const REPOSITORY_MAX_BYTES = () => Number(process.env.APP_WORKSPACE_MAX_BYTES ?? 256 * 1024 * 1024);

const STATE = "state", WORK = "work", HOME = "home";
/** The file in a session's scratch (beside its state, never in a checkpoint) naming the wake that holds it. */
const HOLDER = ".wake";

/**
 * A session's scratch for one wake (mold_v0-246): `<base>/agent-sessions-<uid>/<session>`, the same path on every wake
 * of the session, so the harness's working directory (state/work) never changes under it (a model notices, and Claude
 * Code keys its saved sessions by that path). Other sessions have their own: the parent is the runner's (0711: passed
 * through, never listed; refused when it is a link or another user's), each session's directory 0700. What a wake
 * before this one left (a runner that died before removing it) is taken away first: one wake of a session runs at a
 * time, so it is no one's. The wake's run id is written beside the state; releaseSessionScratch removes the directory
 * only while it still says so (a wake that lost its lease leaves the next wake's alone).
 */
export function sessionScratch(base: string, sessionId: string, runId: string): string {
  const uid = process.getuid?.() ?? 0;
  const root = path.join(base, `agent-sessions-${uid}`);
  try { mkdirSync(root, { mode: 0o711 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== uid)) throw new Error(`the sessions' scratch ${root} is not this runner's own directory`);
  chmodSync(root, 0o711);
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ? sessionId : createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const dir = path.join(root, name);
  if (existsSync(dir) || isLink(dir)) {
    const stale = `${dir}.stale-${randomUUID()}`;
    renameSync(dir, stale);
    rmSync(stale, { recursive: true, force: true });
  }
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(path.join(dir, HOLDER), runId, { mode: 0o600 });
  return dir;
}

/** Removes a wake's session scratch, unless a later wake of the session holds it now. */
export function releaseSessionScratch(dir: string, runId: string) {
  let holder: string | null = null;
  try { holder = readFileSync(path.join(dir, HOLDER), "utf8"); } catch { /* gone */ }
  if (holder === null || holder === runId) rmSync(dir, { recursive: true, force: true });
}
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

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
  let scratch: string | null = null;
  const secrets: Secret[] = claim.gateway.token ? [{ name: "gateway token", value: claim.gateway.token }] : [];
  const clean = (s: string) => (secrets.length ? redactText(s, secrets) : s);
  let proxy: RunProxy | null = null;
  let child: ChildProcess | null = null;
  let ended: { reason: EndReason; detail?: string } | null = null;
  let completed: RunView | null = null;
  try {
    const w = await agent.start(run.id, lease);
    // The session's own scratch, at the same path on every wake (the harness sees its working directory's path).
    scratch = sessionScratch(opts.tmp ?? tmpdir(), w.session_id, run.id);
    if (as) chmodSync(scratch, 0o711); // the run's user may pass through to its own directories (run-harness.ts does the same)
    const state = path.join(scratch, STATE), work = path.join(state, WORK), home = path.join(state, HOME), hooksDir = path.join(scratch, "hooks");
    const policy = w.policy;
    const flavour = policy.flavour;
    // The checkpoint: the harness's own session files and the working directory, as the last wake left them.
    if (w.checkpoint) {
      const body = await agent.checkpointGet(run.id, lease).catch(() => null);
      if (body && createHash("sha256").update(body).digest("hex") === w.checkpoint.sha256) unpackBundle(body, state);
    }
    mkdirSync(work, { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
    // mold_v0-261: the files its agent profile gives its workspace (skills, guides, templates), written into the working
    // directory at its start; a later wake finds them in its checkpoint as the agent left them. A path that would leave
    // the working directory is never written.
    if (!w.checkpoint) for (const f of policy.files ?? []) {
      const dest = path.resolve(work, f.path);
      if (!dest.startsWith(work + path.sep) || existsSync(dest)) continue;
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, f.content, { mode: 0o600 });
    }
    // mold_v0-267: the files its profile uploads (runtime binaries too), fetched part by part with the lease, checked
    // against their sha256 and written into the working directory on every wake (a checkpoint never carries them, so it
    // stays small), executables made so. A path that would leave the working directory is never written.
    const uploaded = new Set<string>();
    const writeUploads = async (list: WakeStart["uploads"]) => {
      for (const u of list) {
        const dest = path.resolve(work, u.path);
        if (!dest.startsWith(work + path.sep)) continue;
        const h = createHash("sha256"), parts: Buffer[] = [];
        for (let n = 0; n < u.parts; n++) { const b = await agent.uploadPart(run.id, lease, u.id, n); h.update(b); parts.push(b); }
        if (h.digest("hex") !== u.sha256) throw new Error(`the uploaded file ${u.path} did not arrive as it was uploaded`);
        mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        if (isLink(dest)) rmSync(dest, { force: true });
        writeFileSync(dest, Buffer.concat(parts), { mode: u.executable ? 0o700 : 0o600 });
        chmodSync(dest, u.executable ? 0o700 : 0o600);
        uploaded.add(path.relative(state, dest).split(path.sep).join("/"));
        if (as) { chownSync(dest, as.uid, as.gid); chownSync(path.dirname(dest), as.uid, as.gid); }
      }
    };
    await writeUploads(w.uploads ?? []);
    // The hooks as resolved at the session's start, written beside the agent: which text it got, from where.
    for (const h of policy.hooks ?? []) {
      mkdirSync(path.join(hooksDir, h.event), { recursive: true });
      writeFileSync(path.join(hooksDir, h.event, "source"), h.source + "\n");
      if (h.text) writeFileSync(path.join(hooksDir, h.event, "prompt.md"), h.text + "\n");
    }
    // The standing instructions: the hook's text, then (mold_v0-250) what the session was given of its workspace.
    const hookSystem = policy.hooks?.find((h) => h.event === "append_system")?.text ?? null;
    const appendSystem = [hookSystem, w.workspace ? policy.workspace?.context?.text : null].filter(Boolean).join("\n\n") || null;
    if (w.workspace && policy.workspace?.context?.text) {
      mkdirSync(path.join(hooksDir, "append_system"), { recursive: true });
      writeFileSync(path.join(hooksDir, "append_system", "workspace.md"), policy.workspace.context.text + "\n");
    }
    // The workspace's tools: its MCP config (the token stays in the environment, by reference).
    let mcpConfig: string | null = null;
    if (w.workspace) {
      secrets.push({ name: "workspace token", value: w.workspace.token });
      const dir = path.join(scratch, "mcp");
      mkdirSync(dir, { mode: 0o700 });
      mcpConfig = path.join(dir, "config.json");
      writeFileSync(mcpConfig, JSON.stringify(workspaceMcpConfig(claim.gateway.gateway_url)), { mode: 0o600 });
      if (as) { chownTree(dir, as.uid, as.gid); }
    }
    if (as) {
      chownTree(state, as.uid, as.gid);
      // The scratch is passed through (0711); what the agent reads in it is its own user's alone.
      if (existsSync(hooksDir)) { chownTree(hooksDir, as.uid, as.gid); chmodSync(hooksDir, 0o700); }
    }
    // The program: the pinned run tool (or a test's stand-in).
    let argv: string[];
    let binDir: string | null = null;
    if (opts.agentCli) argv = [opts.agentCli.command, ...opts.agentCli.args, ...claudeCommand("claude", w, { append_system: appendSystem }, mcpConfig).slice(1)];
    else {
      const set = verifyToolSet([flavourTool(flavour)], { dir: opts.runTools?.dir, catalog: opts.runTools?.catalog ?? RUN_TOOL_CATALOG });
      binDir = linkTools(set.bins, path.join(scratch, "tools-bin"));
      argv = claudeCommand(path.join(binDir, "claude"), w, { append_system: appendSystem }, mcpConfig);
    }
    // Egress: the run's proxy (or its sandbox's own, behind the firewall), as for every run.
    const mode = opts.egress ?? "proxy";
    if (mode === "proxy") proxy = await startRunProxy(claim.egress.hosts, path.join(scratch, "egress"), claim.egress.exact ?? []);
    else if (mode === "system") proxy = { port: EGRESS_PROXY_PORT, env: proxyEnv(), log: "", stop: () => {} };
    const env: Record<string, string> = {
      PATH: [binDir, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"), HOME: home, LANG: "C.UTF-8",
      RUN_ID: run.id, RUN_ATTEMPT: String(run.attempt), RUN_HOOKS_DIR: hooksDir, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
      ...claim.gateway.env, ...(proxy?.env ?? {}), ...(w.workspace ? { [WORKSPACE_TOKEN_ENV]: w.workspace.token, ENABLE_TOOL_SEARCH: "false" } : {}),
    };
    // mold_v0-262: the workspace credentials its profile gives the session (a workspace owner's), and (mold_v0-267) its
    // platform key vault entries, fetched with the lease
    // as a run's are (the engine records which were delivered): each in its env (never over one the wake sets itself) or
    // its file, and redacted from everything the wake writes.
    if (policy.credentials?.length || policy.vault_keys?.length) {
      const got = await client.credentials(run.id, lease);
      const dir = path.join(scratch, "credentials");
      for (const c of got.credentials) {
        secrets.push({ name: c.name, value: c.value });
        if ("env" in c && c.env && !(c.env in env)) env[c.env] = c.value;
        else if ("file" in c && c.file && /^[A-Za-z0-9._-]{1,100}$/.test(c.file)) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const f = path.join(dir, c.file);
          writeFileSync(f, c.value, { mode: 0o600 });
          if (as) chownTree(dir, as.uid, as.gid);
          if (c.path_env && !(c.path_env in env)) env[c.path_env] = f;
        }
      }
    }
    // A resumed session's running total restarts from its saved figure: reports are reduced by min(saved, charged).
    const baseline = w.resume ? resumedBaseline(savedSessionCost(path.join(home, ".claude"), w.resume), w.charged_usd) : 0;

    // mold_v0-287: what the wake did, for the session's trace: each tool call and result (arguments and output as the
    // transcript has them: every secret the wake holds redacted, then capped), its stages, retries. Sent in batches with
    // the beat; a lost batch is never retried against a lease that is gone.
    const trace: { type: string; data: Record<string, unknown> }[] = [];
    const toolStarted = new Map<string, { at: number; name: string }>();
    let flushTimer: NodeJS.Timeout | null = null;
    const queueTrace = (type: string, data: Record<string, unknown>) => {
      trace.push({ type, data: { ...data, t: new Date().toISOString() } });
      if (!flushTimer) { flushTimer = setTimeout(() => { flushTimer = null; void flushTrace(); }, 400); flushTimer.unref(); }
    };
    const flushTrace = async () => {
      const batch = trace.splice(0, 200);
      if (!batch.length) return;
      await client.events(run.id, lease, batch).catch((e) => { if ((e as { status?: number }).status === undefined && trace.length < 500) trace.unshift(...batch); });
    };
    const stage = (name: string) => queueTrace("agent_stage", { stage: name });
    // mold_v0-290: the repositories its messages chose, copied read-only into repos/<owner>/<name> by this runner: the token
    // stays here (a helper file in a directory only this runner can open, gone once the copy is made), so the agent's own
    // program never has one; the copy has no git history and leaves out everything else, and is never in a checkpoint.
    const copyRepositories = async (only?: string[]): Promise<string> => {
      if (!agent.repositories) return "";
      const g = await agent.repositories(run.id, lease, only);
      if (g.token) secrets.push({ name: "repository access", value: g.token });
      const failed = [...g.missing];
      if (g.token && g.repositories.length) {
        const secretDir = path.join(scratch!, `repo-access-${randomUUID()}`);
        mkdirSync(secretDir, { mode: 0o700 });
        const keep = setInterval(() => { client.heartbeat(run.id, lease).catch(() => {}); }, (claim.lease_seconds * 1000) / 3);
        keep.unref();
        try {
          const first = new URL(g.repositories[0]!.clone_url);
          const cred = gitCredentialFiles(secretDir, [{ protocol: first.protocol.replace(":", "") as "https", host: first.host, username: "x-access-token", value: g.token }], null);
          for (const r of g.repositories) {
            const dest = path.resolve(work, REPOSITORIES, ...r.full_name.split("/"));
            if (!dest.startsWith(path.join(work, REPOSITORIES) + path.sep)) continue;
            try {
              rmSync(dest, { recursive: true, force: true });
              mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
              const remote = opts.repositoryFetch?.remote(r.full_name) ?? r.clone_url;
              await fetchPinned(remote, r.commit, dest, { ...opts.repositoryFetch?.options, maxTreeBytes: REPOSITORY_MAX_BYTES(), timeoutMs: 300_000, credentialHelper: { scope: cred.scopes[0]!, script: cred.helper } });
              stage(`It can read ${r.full_name}`);
            } catch (e) { failed.push({ full_name: r.full_name, why: clean((e as Error).message).slice(0, 300) }); rmSync(dest, { recursive: true, force: true }); }
          }
        } finally { clearInterval(keep); rmSync(secretDir, { recursive: true, force: true }); }
        if (as && existsSync(path.join(work, REPOSITORIES))) chownTree(path.join(work, REPOSITORIES), as.uid, as.gid);
      }
      for (const f of failed) queueTrace("agent_error", { subtype: "repository", error: clean(`${f.full_name} could not be given to it: ${f.why}`).slice(0, 600) });
      return failed.length ? `These repositories could not be made available: ${failed.map((f) => `${f.full_name} (${clean(f.why)})`).join(", ")}.` : "";
    };
    const repositoryNote = w.repositories?.length ? await copyRepositories().catch((e) => { queueTrace("agent_error", { subtype: "repository", error: clean((e as Error).message).slice(0, 600) }); return "The repositories chosen for this session could not be made available."; }) : "";
    const attached = (w.uploads ?? []).filter((u) => u.path.startsWith("attachments/")).length;
    if (attached) stage(`${attached === 1 ? "The attached file is" : `The ${attached} attached files are`} in its workspace`);
    stage("Starting the agent's program");

    const ledger = new SteerLedger();
    const consumed: string[] = [];
    const t0 = now();
    const s = { sessionId: w.resume as string | null, inTurn: true, lastActivity: t0, cost: null as number | null, webCalls: w.web_calls, mcpCalls: 0, turnText: [] as string[],
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
    const opening = [w.preface, repositoryNote, ...w.first.map((m) => m.text)].filter(Boolean).join("\n\n") || policy.hooks?.find((h) => h.event === "on_resume")?.text || "Continue.";
    write(opening, w.first.map((m) => m.id), false);
    if (!holds) closeStdin();

    // stdout: stream-json events.
    let buf = "";
    const queue: Promise<unknown>[] = [];
    const onEvent = async (e: Record<string, unknown>) => {
      if (typeof e.session_id === "string" && e.session_id) s.sessionId = e.session_id;
      const echoed = replayedUuid(e);
      if (echoed) { ledger.replayed(echoed); consumed.push(echoed); return; }
      if (e.type === "user") {
        for (const r of toolResults(e)) {
          const began = toolStarted.get(r.id); toolStarted.delete(r.id);
          const text = clean(r.text);
          queueTrace("agent_tool_result", fitEvent({ id: r.id, name: began?.name ?? "tool", is_error: r.isError, result: text, preview: text, duration_ms: began ? now() - began.at : null }));
        }
        return;
      }
      if (e.type === "assistant") {
        s.inTurn = true; s.lastActivity = now();
        const t = assistantText(e); if (t) s.turnText.push(t);
        for (const u of toolUses(e)) {
          toolStarted.set(u.id, { at: now(), name: u.name });
          const input = clean(JSON.stringify(u.input));
          queueTrace("agent_tool_call", fitEvent({ id: u.id, name: u.name, input, preview: clean(previewOf(u)), ...(subagentOf(u) ? { subagent: clean(subagentOf(u)!) } : {}), ...(typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id ? { parent: e.parent_tool_use_id } : {}) }));
        }
        for (const u of toolUses(e)) {
          if (e.parent_tool_use_id) continue;
          const c = checkToolUse(u, policy, s.webCalls, s.mcpCalls, now());
          if (c.ok) { if (c.web) s.webCalls++; if (c.mcp) s.mcpCalls++; continue; }
          if ("hidden" in c) continue;
          if ("violation" in c) {
            // mold_v0-267: refused outright by its governance policy, as the reference's harness does: the wake stops and
            // the session ends with the code (and what it tried, its credentials taken out).
            if (u.name === "WebFetch" || u.name === "WebSearch") s.webCalls++;
            await say(`Stopped by this session's governance policy: ${VIOLATION_WORDS[c.violation]} (${c.violation}: ${clean(u.name)}).`);
            stop({ reason: "policy", detail: c.violation });
            return;
          }
          if ("limit" in c) { await say(`the session used its ${policy.web.calls_max} web calls`); stop({ reason: "web_limit" }); return; }
          // Outside its policy: asked, and the wake stops for the decision (the egress proxy refuses the host meanwhile).
          // A workspace tool (mold_v0-250): what it wanted to send, so the person sees the change before approving it.
          const own = u.name.startsWith(`mcp__${WORKSPACE}__`) ? u.name.slice(`mcp__${WORKSPACE}__`.length) : null;
          const { egress, url: egressUrl, ...asked } = c.request;
          await agent.request(run.id, lease, { ...asked, detail: { tool: u.name, ...(u.name === "WebFetch" ? { url: clean(String(u.input.url ?? "")).slice(0, 500) } : {}),
            ...(egress ? { egress, ...(egressUrl ? { url: clean(egressUrl).slice(0, 500) } : {}), ...(u.name === "Bash" ? { command: clean(String(u.input.command ?? "")).slice(0, 500) } : {}) } : {}),
            ...(own ? { workspace_tool: own, input: clean(JSON.stringify(u.input)).slice(0, 1500) } : {}) } });
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
          queueTrace("agent_retry", { retry: s.transientRetries, error: clean(String(e.result)).slice(0, 2000) });
          setTimeout(() => { if (!s.stdinClosed) proc.stdin?.write(encodeStdinMessage(TRANSIENT_RETRY)); }, s.transientRetries * 10_000).unref();
          return;
        }
        if (!e.is_error) s.transientRetries = 0;
        else queueTrace("agent_error", { subtype: typeof e.subtype === "string" ? e.subtype : null, error: clean(typeof e.result === "string" ? e.result : "").slice(0, 2000) });
        await postTurn(e);
        s.inTurn = false; s.lastActivity = now();
        if (policy.mode === "task") {
          if (ledger.turnEnded()) finish({ reason: "done" });
          else armIdleClose();
        }
      }
    };
    const postTurn = async (e: Record<string, unknown>) => {
      await flushTrace().catch(() => {}); // its steps first, so the answer follows them in the stream
      const text = clean(s.turnText.join("\n\n") || (typeof e.result === "string" ? e.result : "")).slice(0, 20_000);
      s.turnText = [];
      // The person's messages this turn answers: those the CLI echoed it took in (without echoes, every one delivered).
      const answered = consumed.splice(0).flatMap((u) => s.uuidIds.get(u) ?? []);
      await agent.turn(run.id, lease, { text, cost_usd: observedCost(e), answered: ledger.seen ? answered : null }).catch(() => {});
    };
    const say = async (t: string) => { await flushTrace().catch(() => {}); return agent.turn(run.id, lease, { text: t }).catch(() => {}); };
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
    let steering: Promise<void> = Promise.resolve();
    const beat = async () => {
      await flushTrace();
      const a = await agent.beat(run.id, lease, { in_turn: s.inTurn, total_cost_usd: s.cost, session_id: s.sessionId, web_calls: s.webCalls,
        ...(!s.baselineSent ? { baseline_usd: baseline } : {}), discarded: discarded.splice(0) });
      s.baselineSent = true;
      beatMs = opts.beatMs ?? Math.max(1000, Math.min(a.interval_seconds * 1000, (claim.lease_seconds * 1000) / 3));
      if (a.cancel) { stop({ reason: "stopped", detail: a.reason ?? "cancelled" }); return; }
      if (a.steer.length) {
        if (!holds || s.stdinClosed) discarded.push(...a.steer.map((m) => m.id));
        else for (const m of a.steer) {
          if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
          s.inTurn = true; s.lastActivity = now();
          // mold_v0-290: what it carries is in place before its words arrive, so the beat keeps its time while a copy is made.
          // A file that does not arrive sends the message back to wait for the next wake, which fetches them all again.
          steering = steering.then(async () => {
            let note = "";
            try {
              if (m.uploads?.length) { await writeUploads(m.uploads); stage(`${m.uploads.length === 1 ? "The attached file is" : `The ${m.uploads.length} attached files are`} in its workspace`); }
              if (m.repositories?.length) note = await copyRepositories(m.repositories);
            } catch (e) { queueTrace("agent_error", { subtype: "attachment", error: clean((e as Error).message).slice(0, 600) }); discarded.push(m.id); return; }
            write(note ? `${m.text}\n\n${note}` : m.text, [m.id]);
          });
        }
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
        const { bundle } = packBundle(state, (f) => uploaded.has(f) || f.startsWith(`${WORK}/${REPOSITORIES}/`));
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
    await steering.catch(() => {});
    if (lost) return null;
    // A last beat (its spend), the last checkpoint, then how it ended (everything it did before the wake closes).
    await beat().catch(() => {});
    if (flushTimer) clearTimeout(flushTimer);
    while (trace.length) { const n = trace.length; await flushTrace(); if (trace.length >= n) break; }
    // mold_v0-271: what the agent proposes of the recipes its session used (.recipe-proposal/<recipe>/), sent once, then removed.
    await sendRecipeProposals(agent, run.id, lease, work, policy);
    await sendCandidate(agent, run.id, lease, work, policy);
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
    if (scratch) releaseSessionScratch(scratch, run.id);
    if (user && iso?.mode !== "given") await user.release().catch(() => false);
  }
}

/**
 * mold_v0-271 (self-improvement): each `.recipe-proposal/<recipe id>/` the agent wrote in its working directory, for a
 * recipe its session started with: note.md (why), remove.txt (paths to drop, one a line) and files/<path> (each file
 * changed or added; an executable one stays so), sent to the API as an approval request staff decide, then removed so
 * it is sent once. A proposal that is refused is logged (the next wake may send a corrected one); it never fails the wake.
 */
export async function sendRecipeProposals(agent: Pick<AgentRunnerClient, "recipeProposal">, runId: string, lease: string, work: string, policy: Pick<AgentPolicy, "recipes">): Promise<string[]> {
  const root = path.join(work, ".recipe-proposal");
  if (!agent.recipeProposal || !policy.recipes?.length || !existsSync(root) || isLink(root)) return [];
  const sent: string[] = [];
  for (const r of policy.recipes) {
    const dir = path.join(root, r.id);
    if (!existsSync(dir) || isLink(dir)) continue;
    try {
      const executable: string[] = [];
      const walk = (d: string, rel: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name), q = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(p, q);
          else if (e.isFile() && (lstatSync(p).mode & 0o100)) executable.push(q);
        }
      };
      if (existsSync(path.join(dir, "files"))) walk(path.join(dir, "files"), "");
      const { bundle } = packBundle(dir);
      const got = await agent.recipeProposal(runId, lease, r.id, bundle, executable);
      sent.push(got.proposal);
    } catch (e) { console.error(`agent ${runId}: the proposed version of recipe ${r.id} was not taken: ${(e as Error).message}`); }
    rmSync(dir, { recursive: true, force: true });
  }
  return sent;
}

/**
 * mold_v0-291: the candidate a machine's state produced: everything under `.candidate/` of its working directory, sent once
 * as a bundle when its wake ends. The candidate is only ever measured by the server's evaluator; nothing the agent says about it counts.
 */
export async function sendCandidate(agent: Pick<AgentRunnerClient, "candidate">, runId: string, lease: string, work: string, policy: Pick<AgentPolicy, "nested">): Promise<boolean> {
  const dir = path.join(work, ".candidate");
  if (!policy.nested?.candidate || !agent.candidate || !existsSync(dir) || isLink(dir)) return false;
  try {
    const { bundle } = packBundle(dir);
    await agent.candidate(runId, lease, bundle);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) { console.error(`agent ${runId}: the candidate was not taken: ${(e as Error).message}`); return false; }
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
