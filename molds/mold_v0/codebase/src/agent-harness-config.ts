/**
 * The workspace agent's configuration (mold_v0-243; molds/mold_v0/docs/agent-harness.md): the harness flavours it can
 * run, each flavour's lifecycle hooks, the built-in job kind its wakes run as, and the policy a session freezes at its
 * start from the platform settings (src/settings.ts, group "agent"). Read by the control plane (src/agent-sessions.ts)
 * and by the runner (src/agent-harness.ts), so the two cannot hold different opinions about a flavour.
 *
 * Nothing here is on unless the app's profile turns the `agent_harness` feature on (src/features.json; off by default).
 */
import { featureSetting } from "./feature-flags.js";
import { settingNumber, settingText } from "./settings.js";
import type { JobKind } from "./runs.js";

/** The built-in kind's pack and name: a wake of a session is a run of `_agent/session`. No pack may take the id (it starts with _). */
export const AGENT_PACK = "_agent";
export const AGENT_KIND = "session";
export const AGENT_RUNNER = "agent-harness";

/** The workspace agent is on: the profile's `agent_harness` (requested always; src/features.ts featureOn says the same). */
export const agentHarnessOn = (): boolean => featureSetting("agent_harness");

// ---------------------------------------------------------------- flavours and their hooks

export type HookEvent = "on_start" | "on_resume" | "append_system";
export interface HookDef { event: HookEvent; label: string; about: string; delivered: "first_message" | "resume_message" | "system_prompt"; default: string | null }
export interface AgentFlavour {
  id: string;
  label: string;
  /** The run tool (src/run-tools.ts) whose program it is, and the program's name. */
  tool: string;
  bin: string;
  /** Reads stream-json on an open stdin: a person can steer it mid-run. A flavour that reads stdin to EOF cannot. */
  holds_stdin_open: boolean;
  /** Echoes each stdin message back as it takes it in (its uuid): the harness knows which instruction was consumed. */
  replays_user_messages: boolean;
  /** Continues a saved session (`--resume <id>`): pause, park and crash recovery resume it. */
  resumes: boolean;
  /** The gateway providers it can speak to (src/gateway.ts). */
  providers: string[];
  /** The hooks it has: a flavour has exactly these, each with its own default text (or none). */
  hooks: HookDef[];
}

/** The on_resume default: why the session talks again, and that its earlier files are what the checkpoint kept. */
export const RESUMED_PROMPT =
  "This session was resumed in its workspace: your earlier messages and the files in your working directory are as the " +
  "last checkpoint kept them. If you were in the middle of answering, finish that answer; otherwise say briefly that " +
  "you are back and wait for the next message.";
/** Re-asked once in the same session when the model provider cut a turn short (never for the agent's own failure). */
export const TRANSIENT_RETRY_PROMPT =
  "Your previous response was cut off by a temporary error from the model provider. Nothing you said after the cut " +
  "reached the person. Continue from where you left off, without repeating tool calls whose results you already have.";

/**
 * The flavours this platform can run. A flavour is offered only when its program is pinned in the run tools' catalogue
 * (src/run-tools.ts): today Claude Code. The contract for a flavour that reads stdin to EOF (no steer) is kept by the
 * runner and the API (holds_stdin_open: false), for the next pinned CLI.
 */
export const AGENT_FLAVOURS: readonly AgentFlavour[] = [
  {
    id: "claude-code", label: "Claude Code", tool: "claude-code", bin: "claude", holds_stdin_open: true, replays_user_messages: true, resumes: true,
    providers: ["anthropic"],
    hooks: [
      { event: "on_start", label: "On start", about: "The first message of a new session: the person's own words.", delivered: "first_message", default: null },
      { event: "on_resume", label: "On resume", about: "The first message of a session continued after a pause, a park or a crash, when the person sent none.", delivered: "resume_message", default: RESUMED_PROMPT },
      { event: "append_system", label: "Standing instructions", about: "Added to the harness's own system prompt on every wake.", delivered: "system_prompt",
        default: "You work in this session's own workspace directory. Ask before reaching a web address you have not been allowed; a request you make is shown to the person, who approves or declines it." },
    ],
  },
];
export const flavourOf = (id: string): AgentFlavour | null => AGENT_FLAVOURS.find((f) => f.id === id) ?? null;

export interface ResolvedHook { event: HookEvent; text: string | null; source: "harness" | "session" | "unset" }
/**
 * The hooks a session gets, resolved once at its start (frozen into its policy, written beside the agent before each
 * wake): the session's own text, else the flavour's default, else nothing. A hook the flavour does not have is refused.
 */
export function resolveHooks(f: AgentFlavour, own: Partial<Record<HookEvent, string>> = {}): ResolvedHook[] {
  for (const k of Object.keys(own)) if (!f.hooks.some((h) => h.event === k)) throw new Error(`${f.label} has no ${k} hook`);
  return f.hooks.map((h) => {
    const mine = own[h.event]?.trim();
    return mine ? { event: h.event, text: mine, source: "session" } : h.default ? { event: h.event, text: h.default, source: "harness" } : { event: h.event, text: null, source: "unset" };
  });
}

// ---------------------------------------------------------------- the policy a session freezes at its start

export type WebTools = "off" | "fetch" | "search";
export interface AgentPolicy {
  flavour: string;
  model: string;
  provider: string;
  max_turns: number;
  wake_max_seconds: number;
  park_after_seconds: number;
  stdin_idle_seconds: number;
  checkpoint_seconds: number;
  approval_window_hours: number;
  crash_resumes: number;
  auto_resume: boolean;
  budget_ceiling_usd: number;
  web: { tools: WebTools; hosts: string[]; calls_max: number };
  /** Tools the harness may use without asking (the flavour's own names); anything else becomes a request. */
  tools: string[];
  hooks: ResolvedHook[];
  /** "conversation": parks when idle and wakes on the next message; "task": ends when its work is answered. */
  mode: "conversation" | "task";
  /**
   * What the session reaches of its workspace (mold_v0-250), frozen at its start: the app's own customer MCP server as the
   * person who started it (its tools, each a read or not, and which the setting lets it use without asking: those are in
   * `tools` as mcp__workspace__<name>), and the workspace's context as standing instructions. Absent on sessions started
   * before it (they reach nothing of the workspace).
   */
  workspace?: WorkspaceReach;
}

/** The MCP server name the harness gets the workspace's tools under: Claude Code calls them mcp__workspace__<tool>. */
export const WORKSPACE_SERVER = "workspace";
export const workspaceToolName = (tool: string) => `mcp__${WORKSPACE_SERVER}__${tool}`;
/** The workspace tool a harness tool name is (mcp__workspace__<tool>), or null. */
export const workspaceToolOf = (name: string): string | null => (name.startsWith(`mcp__${WORKSPACE_SERVER}__`) ? name.slice(`mcp__${WORKSPACE_SERVER}__`.length) || null : null);
export type WorkspaceToolsFree = "reads" | "reads_and_named" | "all";
export interface WorkspaceReach {
  server: string;
  /** Who the tools act as: the person (their role at the start; re-read on every call) or the account's key. */
  acts_as: { kind: "person" | "key"; name: string | null; role: string | null };
  free: WorkspaceToolsFree;
  named: string[];
  /** The tools the person may call, as the server listed them to them at the start. */
  tools: { name: string; title: string | null; read: boolean }[];
  /** The standing instructions added for the workspace (capped), and its parts' sizes for the session card. */
  context: { text: string; max_chars: number; parts: { part: "instructions" | "context"; label: string; chars: number; kept: number }[] };
}

/** Which of the workspace's tools a session may use without asking, under the setting: reads, plus the named, or all. */
export function freeWorkspaceTools(tools: { name: string; read: boolean }[], free: WorkspaceToolsFree, named: string[]): string[] {
  return tools.filter((t) => free === "all" || t.read || (free === "reads_and_named" && named.includes(t.name))).map((t) => t.name);
}

/** The harness's own tools a session may use without asking: the workspace's files and its shell. */
export const WORKSPACE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "Bash", "TodoWrite", "Task"];

const hostList = (s: string) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/** The policy in force now (the settings), as a session freezes it at its start. */
export function currentPolicy(mode: AgentPolicy["mode"] = "conversation", hooks: Partial<Record<HookEvent, string>> = {}): AgentPolicy {
  const flavour = flavourOf(settingText("AGENT_HARNESS")) ?? AGENT_FLAVOURS[0]!;
  const web = settingText("AGENT_WEB_TOOLS") as WebTools;
  const provider = flavour.providers.includes(settingText("AGENT_PROVIDER")) ? settingText("AGENT_PROVIDER") : flavour.providers[0]!;
  return {
    flavour: flavour.id, model: settingText("AGENT_MODEL"), provider, mode,
    max_turns: settingNumber("AGENT_MAX_TURNS"),
    wake_max_seconds: settingNumber("AGENT_WAKE_MAX_MINUTES") * 60,
    park_after_seconds: settingNumber("AGENT_PARK_AFTER_MINUTES") * 60,
    stdin_idle_seconds: settingNumber("AGENT_STDIN_IDLE_SECONDS"),
    checkpoint_seconds: settingNumber("AGENT_CHECKPOINT_SECONDS"),
    approval_window_hours: settingNumber("AGENT_APPROVAL_WINDOW_HOURS"),
    crash_resumes: settingNumber("AGENT_CRASH_RESUMES"),
    auto_resume: settingText("AGENT_AUTO_RESUME") === "on",
    budget_ceiling_usd: settingNumber("AGENT_BUDGET_CEILING_USD"),
    web: { tools: web === "fetch" || web === "search" ? web : "off", hosts: hostList(settingText("AGENT_WEB_HOSTS")), calls_max: settingNumber("AGENT_WEB_CALLS_MAX") },
    tools: [...WORKSPACE_TOOLS],
    hooks: resolveHooks(flavour, hooks),
  };
}

/** Whether `host` is allowed by a list of exact hosts and `*.suffix` entries (a suffix also allows the bare domain). */
export function hostAllowed(host: string, rules: string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return rules.some((r) => {
    const x = r.trim().toLowerCase();
    if (x.startsWith("*.")) { const d = x.slice(2); return h === d || h.endsWith(`.${d}`); }
    return h === x;
  });
}

/** A host name as a policy may hold it: letters, digits, dots and hyphens, at least one dot, no address or port. */
export const HOST_NAME = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
export const validHost = (h: string) => HOST_NAME.test(h) && !/^\d+(\.\d+)+$/.test(h);

// ---------------------------------------------------------------- the built-in kind

/**
 * The job kind a wake runs as (frozen into its run, src/runs.ts): the run engine's lease, deadline, gateway token and
 * limits apply as for every run. Its budget is the session's remaining allowance (startRun's override); its month
 * budget and concurrency per workspace are the settings'.
 */
export function agentKind(policy?: AgentPolicy): JobKind {
  const p = policy ?? currentPolicy();
  return {
    pack: AGENT_PACK, name: AGENT_KIND, label: "Agent session", runner: AGENT_RUNNER, providers: [p.provider],
    egress: [], max_attempts: 1, lease_seconds: 60,
    // The wake's own cap, plus the turn running when it is reached, plus its checkpoint.
    token_lifetime_seconds: p.wake_max_seconds + 900,
    budget_usd: p.budget_ceiling_usd,
    concurrency_per_workspace: settingNumber("AGENT_SESSIONS_PER_WORKSPACE"),
    month_budget_usd: settingNumber("AGENT_MONTH_BUDGET_USD"),
    workspace: false, args: {}, credentials: [],
  } as unknown as JobKind;
}

/** The kinds the engine claims and launches sandboxes for besides the packs' (src/runs.ts runnableKinds): the agent's, when on. */
export const builtInKinds = (): JobKind[] => (agentHarnessOn() ? [agentKind()] : []);
export const isAgentRun = (r: { pack: string; kind?: string }) => r.pack === AGENT_PACK;
