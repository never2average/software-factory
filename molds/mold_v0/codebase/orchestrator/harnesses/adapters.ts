/**
 * Harness adapters: everything harness-specific lives here, keyed by the `harness` ids of the repo-root
 * `harnesses/registry.json` (maintained separately; this file never writes it).
 *
 * An adapter knows: the CLI binary, the API-key env it needs, the launch argv (prompt on stdin), the resume
 * argv (reply on stdin), how to find the conversation id in its JSONL, and how to digest a run's events into
 * "last assistant text + commands run + files touched" for the orchestrator brain.
 *
 * Verified against the locally installed CLIs (claude 2.1.296 `--help`, codex 0.162 `exec resume --help`).
 * The other adapters were verified against the pinned images in orchestrator/images (`--help` of each CLI) and
 * by real runs of each CLI against a scripted mock LLM endpoint; those runs' stdout is checked in under
 * `fixtures/<harness>.jsonl` (see fixtures/README.md) and replayed by scripts/smoke.ts.
 *
 * The prompt always arrives on stdin. CLIs that only take the prompt as an argument are wrapped in
 * `bash -c 'exec "$@" "$(cat)"'`, which reads stdin and passes it as the last argv element. Trailing newlines
 * are dropped.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ArgvOptions {
  model: string;
  /** Absolute workdir inside the sandbox (the process cwd is already set to it by the runner). */
  workdir: string;
  maxBudgetUsd?: string;
  /** Agent turns left in this session (MAX_AGENT_TURNS minus turns used). Passed natively where the CLI has a flag. */
  maxTurns?: number;
  /** Binary override (local runner only). */
  bin?: string;
}

export interface ApiKeys { anthropic: string; openai: string }

/** What the brain sees after each harness run. */
export interface TurnDigest {
  lastText: string;
  commands: string[];
  files: string[];
  /** Harness conversation id seen in this run (session_id / thread_id). */
  sessionId: string | null;
  /** The harness reported an error in-band (e.g. Claude `result.is_error`, Codex `turn.failed`). */
  error: string | null;
  /** The run stopped at the harness's own turn limit (e.g. Claude `error_max_turns`); not a failure. */
  capped?: boolean;
}

export interface HarnessAdapter {
  /** Registry id, e.g. "claude-code". */
  id: string;
  supported: true;
  /**
   * Can a finished run be resumed headlessly with a follow-up message (resumeArgv)? When false, the digest never
   * reports a sessionId, so the session reports can_reply=false and the orchestrator offers no developer replies.
   */
  canResume: boolean;
  bin: string;
  /** Env for the harness process only (API key + quiet flags). Nothing of the shell's own. */
  env(keys: ApiKeys): Record<string, string>;
  /** Is the key this harness needs present? */
  hasKey(keys: ApiKeys): boolean;
  launchArgv(o: ArgvOptions): string[];
  /**
   * First launch in the CLI's own plan mode (read-only: it explores and proposes a plan, then stops), for sessions run
   * plan-then-execute (Job.exec_mode "plan"). Resumes always use resumeArgv, i.e. normal execution. Harnesses without
   * a headless plan mode leave it out and get PLAN_FIRST appended to the task instead.
   */
  planArgv?(o: ArgvOptions): string[];
  resumeArgv(o: ArgvOptions & { sessionId: string }): string[];
  newDigest(): DigestBuilder;
}

export interface DigestBuilder {
  observe(ev: Record<string, any>): void;
  result(): TurnDigest;
}

/**
 * Plan-then-execute for a harness without a headless plan mode: appended to the task, so the agent plans and waits
 * for the developer's go-ahead before changing anything. Neutral: it names no tool and asks for no particular plan.
 */
export const PLAN_FIRST = "Before you change anything, look through the project and write up your plan for this, then stop and wait for my go-ahead.";

const QUIET_ENV = { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", CI: "1" };
const MAX_ITEMS = 40;

function pushUnique(list: string[], v: unknown, max = MAX_ITEMS) {
  if (typeof v !== "string" || !v) return;
  const s = v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (!list.includes(s)) list.push(s);
  if (list.length > max) list.shift();
}

// ---------------------------------------------------------------- Claude Code

const claudeCode: HarnessAdapter = {
  id: "claude-code",
  supported: true,
  canResume: true,
  bin: "claude",
  env: (k) => ({ ...QUIET_ENV, ANTHROPIC_API_KEY: k.anthropic }),
  hasKey: (k) => !!k.anthropic,
  // Session persistence stays ON (no --no-session-persistence): `--resume` needs the stored session.
  launchArgv: (o) => [
    o.bin ?? "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--dangerously-skip-permissions",
    ...(o.maxBudgetUsd ? ["--max-budget-usd", o.maxBudgetUsd] : []),
    ...(o.maxTurns ? ["--max-turns", String(o.maxTurns)] : []),
  ],
  // Plan mode (claude --permission-mode plan): read-only tools only; the plan arrives in ExitPlanMode, which a print
  // run cannot approve, so the run ends there. The resume (resumeArgv) bypasses permissions again and implements.
  planArgv: (o) => [
    o.bin ?? "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--permission-mode", "plan",
    ...(o.maxBudgetUsd ? ["--max-budget-usd", o.maxBudgetUsd] : []),
    ...(o.maxTurns ? ["--max-turns", String(o.maxTurns)] : []),
  ],
  resumeArgv: (o) => [
    o.bin ?? "claude", "-p",
    "--resume", o.sessionId,
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--dangerously-skip-permissions",
    ...(o.maxBudgetUsd ? ["--max-budget-usd", o.maxBudgetUsd] : []),
    ...(o.maxTurns ? ["--max-turns", String(o.maxTurns)] : []),
  ],
  newDigest() {
    const d: TurnDigest = { lastText: "", commands: [], files: [], sessionId: null, error: null };
    let resultText: string | null = null;
    let plan: string | null = null;
    return {
      observe(ev) {
        if (typeof ev.session_id === "string" && (ev.type === "system" || !d.sessionId)) d.sessionId = ev.session_id;
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          const texts: string[] = [];
          for (const c of ev.message.content) {
            if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
            // Plan mode: the plan itself is ExitPlanMode's input, not text.
            if (c?.type === "tool_use" && c.name === "ExitPlanMode" && typeof c.input?.plan === "string") plan = c.input.plan;
            if (c?.type === "tool_use") {
              const inp = c.input ?? {};
              if (typeof inp.command === "string") pushUnique(d.commands, inp.command);
              for (const k of ["file_path", "path", "notebook_path"]) pushUnique(d.files, inp[k]);
            }
          }
          if (texts.length) d.lastText = texts.join("\n");
        }
        if (ev.type === "result") {
          if (typeof ev.result === "string" && ev.result.trim()) resultText = ev.result;
          if (ev.subtype === "error_max_turns") d.capped = true; // --max-turns reached: the session's turn cap
          else if (ev.is_error) d.error = String(ev.result ?? ev.subtype ?? "claude error").slice(0, 1000);
        }
      },
      result: () => {
        const said = resultText ?? d.lastText;
        return { ...d, lastText: plan && !said.includes(plan.slice(0, 200)) ? `${plan}\n\n${said}`.trim() : said };
      },
    };
  },
};

// ---------------------------------------------------------------- Codex CLI

const codex: HarnessAdapter = {
  id: "codex",
  supported: true,
  canResume: true,
  bin: "codex",
  env: (k) => ({ ...QUIET_ENV, CODEX_API_KEY: k.openai }), // codex exec reads CODEX_API_KEY
  hasKey: (k) => !!k.openai,
  // No --ephemeral: it disables the rollout file that `exec resume` needs.
  launchArgv: (o) => [
    o.bin ?? "codex", "exec", "--json",
    "--model", o.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--color", "never",
    "-C", o.workdir,
    "-",
  ],
  // `exec resume` has no -C/--color; the runner already starts it in the workdir.
  resumeArgv: (o) => [
    o.bin ?? "codex", "exec", "resume", o.sessionId,
    "--json",
    "--model", o.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-",
  ],
  newDigest() {
    const d: TurnDigest = { lastText: "", commands: [], files: [], sessionId: null, error: null };
    return {
      observe(ev) {
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") d.sessionId = ev.thread_id;
        const item = ev.item;
        if (ev.type === "item.completed" && item) {
          if ((item.type === "agent_message" || item.type === "assistant_message") && typeof item.text === "string") d.lastText = item.text;
          if (item.type === "command_execution") pushUnique(d.commands, item.command);
          if (item.type === "file_change" && Array.isArray(item.changes)) for (const c of item.changes) pushUnique(d.files, c?.path);
        }
        if (ev.type === "turn.failed") d.error = String(ev.error?.message ?? "codex turn failed").slice(0, 1000);
        if (ev.type === "error") d.error = String(ev.message ?? "codex error").slice(0, 1000);
      },
      result: () => ({ ...d }),
    };
  },
};

// ---------------------------------------------------------------- shared helpers for the other harnesses

/** Wrap argv so the prompt read from stdin becomes the last argument. `pre` runs first (same shell). */
function promptAsLastArg(argv: string[], pre = ""): string[] {
  return ["bash", "-c", `${pre}exec "$@" "$(cat)"`, "run", ...argv];
}

/** Run a small setup snippet, then exec argv with stdin untouched. */
function withSetup(argv: string[], pre: string): string[] {
  return ["bash", "-c", `${pre}exec "$@"`, "run", ...argv];
}

/** Write a harness config file under $HOME once (never overwrites). Shell snippet; `json` must not contain `'`. */
function ensureFile(relPath: string, json: string): string {
  return `f="$HOME/${relPath}"; [ -s "$f" ] || { mkdir -p "$(dirname "$f")" && printf '%s' '${json}' > "$f"; }; `;
}

/** "auto" / "default" mean: let the harness use its own default model, so pass no model flag. */
const isDefaultModel = (m: string) => !m || m === "default" || m === "auto";

/** Key lookup: the worker's ApiKeys first, then the worker process env (the extra provider keys live there). */
function envKey(k: ApiKeys, field: keyof ApiKeys | null, ...names: string[]): string {
  const v = field ? k[field] : "";
  if (v) return v;
  for (const n of names) if (process.env[n]) return process.env[n]!;
  return "";
}

const newDigestState = (): TurnDigest => ({ lastText: "", commands: [], files: [], sessionId: null, error: null });
const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path", "absolute_path", "TargetFile", "AbsolutePath", "target_file"];
const CMD_KEYS = ["command", "cmd", "CommandLine", "commandLine"];
const BASE_ENV = { NO_COLOR: "1", CI: "1" };

/** Record a tool call's command(s) and file paths from its (arbitrarily shaped) input object. */
function noteToolInput(d: TurnDigest, input: unknown) {
  if (!input || typeof input !== "object") return;
  const inp = input as Record<string, unknown>;
  for (const k of CMD_KEYS) pushUnique(d.commands, inp[k]);
  if (Array.isArray(inp.commands)) for (const c of inp.commands) pushUnique(d.commands, typeof c === "string" ? c : (c as any)?.command);
  for (const k of FILE_KEYS) pushUnique(d.files, inp[k]);
}

/**
 * Digest for Claude-Code-compatible stream-json (Qwen Code, Amp): system/assistant/user/result events with Anthropic
 * content blocks. lastText = the final `result` text if present, else the last assistant text.
 */
function claudeLikeDigest(): DigestBuilder {
  const d = newDigestState();
  let resultText: string | null = null;
  return {
    observe(ev) {
      if (typeof ev.session_id === "string" && (ev.type === "system" || !d.sessionId)) d.sessionId = ev.session_id;
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        const texts: string[] = [];
        for (const c of ev.message.content) {
          if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
          if (c?.type === "tool_use") noteToolInput(d, c.input);
        }
        if (texts.length) d.lastText = texts.join("\n");
      }
      if (ev.type === "result") {
        if (typeof ev.result === "string" && ev.result.trim()) resultText = ev.result;
        if (ev.is_error) d.error = String(ev.error ?? ev.result ?? ev.subtype ?? "error").slice(0, 1000);
      }
    },
    result: () => ({ ...d, lastText: resultText ?? d.lastText }),
  };
}

/** OpenCode `run --format json` (and its fork Kilo): {type, sessionID, part}. */
function opencodeDigest(): DigestBuilder {
  const d = newDigestState();
  let textMsg = ""; let texts: string[] = [];
  return {
    observe(ev) {
      if (typeof ev.sessionID === "string") d.sessionId = ev.sessionID;
      const part = ev.part ?? {};
      if (ev.type === "text" && typeof part.text === "string") {
        // Concatenate the text parts of one assistant message; a new message replaces the previous one.
        if (part.messageID !== textMsg) { textMsg = part.messageID; texts = []; }
        texts.push(part.text);
        d.lastText = texts.join("");
      }
      if (ev.type === "tool_use") noteToolInput(d, part.state?.input);
      if (ev.type === "error") d.error = String(ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? "opencode error").slice(0, 1000);
    },
    result: () => ({ ...d }),
  };
}

// ---------------------------------------------------------------- GitHub Copilot CLI

const copilot: HarnessAdapter = {
  id: "copilot",
  supported: true,
  canResume: true,
  bin: "copilot",
  env: (k) => ({ ...BASE_ENV, COPILOT_AUTO_UPDATE: "false", COPILOT_GITHUB_TOKEN: envKey(k, null, "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN") }),
  hasKey: (k) => !!envKey(k, null, "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"),
  // Piped stdin is the prompt (verified). --output-format json = JSONL session events.
  launchArgv: (o) => [o.bin ?? "copilot", "--output-format", "json", "--allow-all-tools", "--no-auto-update", ...(o.model ? ["--model", o.model] : [])],
  resumeArgv: (o) => [o.bin ?? "copilot", "--output-format", "json", "--allow-all-tools", "--no-auto-update", ...(o.model ? ["--model", o.model] : []), "--resume", o.sessionId],
  newDigest() {
    const d = newDigestState();
    return {
      observe(ev) {
        const data = ev.data ?? {};
        if (ev.type === "result" && typeof ev.sessionId === "string") d.sessionId = ev.sessionId;
        if (ev.type === "assistant.message") {
          if (typeof data.content === "string" && data.content.trim()) d.lastText = data.content;
          for (const t of data.toolRequests ?? []) noteToolInput(d, t?.arguments);
        }
        if (ev.type === "result" && typeof ev.exitCode === "number" && ev.exitCode !== 0) d.error = `copilot exited ${ev.exitCode}`;
        if (ev.type === "session.error" || ev.type === "error") d.error = String(data.message ?? ev.message ?? "copilot error").slice(0, 1000);
      },
      result: () => ({ ...d }),
    };
  },
};

// ---------------------------------------------------------------- Cursor CLI (cursor-agent)

const cursor: HarnessAdapter = {
  id: "cursor",
  supported: true,
  canResume: true,
  bin: "cursor-agent",
  env: (k) => ({ ...BASE_ENV, CURSOR_API_KEY: envKey(k, null, "CURSOR_API_KEY") }),
  hasKey: (k) => !!envKey(k, null, "CURSOR_API_KEY"),
  // The prompt is a positional argument; `--` keeps a prompt starting with "-" from being parsed as a flag.
  launchArgv: (o) => promptAsLastArg([o.bin ?? "cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust", "--model", o.model || "auto", "--"]),
  // cursor-agent --mode plan: read-only, proposes a plan and stops; the resume runs in the default (agent) mode.
  planArgv: (o) => promptAsLastArg([o.bin ?? "cursor-agent", "-p", "--output-format", "stream-json", "--trust", "--mode", "plan", "--model", o.model || "auto", "--"]),
  resumeArgv: (o) => promptAsLastArg([o.bin ?? "cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust", "--model", o.model || "auto", "--resume", o.sessionId, "--"]),
  newDigest() {
    const d = newDigestState();
    return {
      observe(ev) {
        if (typeof ev.session_id === "string") d.sessionId = ev.session_id;
        // Without --stream-partial-output each `assistant` event is one complete message between tool calls.
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          const t = ev.message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
          if (t.trim()) d.lastText = t;
        }
        if (ev.type === "tool_call" && ev.subtype === "started" && ev.tool_call && typeof ev.tool_call === "object")
          for (const v of Object.values(ev.tool_call as Record<string, any>)) noteToolInput(d, v?.args ?? (typeof v?.arguments === "string" ? safeJson(v.arguments) : v?.arguments));
        if (ev.type === "result" && ev.is_error) d.error = String(ev.result ?? "cursor error").slice(0, 1000);
      },
      result: () => ({ ...d }),
    };
  },
};

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return { command: s }; } }

// ---------------------------------------------------------------- OpenCode / Kilo Code

/** Provider-agnostic harnesses get the Anthropic key (registry models are `anthropic/...`). */
const anthropicEnv = (k: ApiKeys) => ({ ANTHROPIC_API_KEY: envKey(k, "anthropic", "ANTHROPIC_API_KEY") });

const opencode: HarnessAdapter = {
  id: "opencode",
  supported: true,
  canResume: true,
  bin: "opencode",
  env: (k) => ({ ...BASE_ENV, OPENCODE_DISABLE_AUTOUPDATE: "true", ...anthropicEnv(k) }),
  hasKey: (k) => !!envKey(k, "anthropic", "ANTHROPIC_API_KEY"),
  // `opencode run` reads the message from piped stdin (verified).
  launchArgv: (o) => [o.bin ?? "opencode", "run", "--format", "json", "--auto", "-m", o.model],
  resumeArgv: (o) => [o.bin ?? "opencode", "run", "--format", "json", "--auto", "-m", o.model, "-s", o.sessionId],
  newDigest: opencodeDigest,
};

const kilo: HarnessAdapter = {
  ...opencode,
  id: "kilo",
  bin: "kilo",
  env: (k) => ({ ...BASE_ENV, KILO_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", ...anthropicEnv(k) }),
  launchArgv: (o) => [o.bin ?? "kilo", "run", "--format", "json", "--auto", "-m", o.model],
  resumeArgv: (o) => [o.bin ?? "kilo", "run", "--format", "json", "--auto", "-m", o.model, "-s", o.sessionId],
};

// ---------------------------------------------------------------- Gemini CLI / Qwen Code

const gemini: HarnessAdapter = {
  id: "gemini-cli",
  supported: true,
  canResume: true,
  bin: "gemini",
  env: (k) => ({ ...BASE_ENV, GEMINI_API_KEY: envKey(k, null, "GEMINI_API_KEY", "GOOGLE_API_KEY") }),
  hasKey: (k) => !!envKey(k, null, "GEMINI_API_KEY", "GOOGLE_API_KEY"),
  // Piped stdin is the prompt. --skip-trust: without it a fresh workdir is "untrusted" and yolo is downgraded.
  launchArgv: (o) => [o.bin ?? "gemini", "-o", "stream-json", "--approval-mode", "yolo", "--skip-trust", ...(isDefaultModel(o.model) ? [] : ["-m", o.model])],
  resumeArgv: (o) => [o.bin ?? "gemini", "-o", "stream-json", "--approval-mode", "yolo", "--skip-trust", ...(isDefaultModel(o.model) ? [] : ["-m", o.model]), "--resume", o.sessionId],
  newDigest() {
    const d = newDigestState();
    let parts: string[] = [];
    return {
      observe(ev) {
        if (ev.type === "init" && typeof ev.session_id === "string") d.sessionId = ev.session_id;
        // Assistant text streams as `delta: true` chunks; a tool call or user message starts a new answer.
        if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
          if (!ev.delta) parts = [];
          parts.push(ev.content);
          d.lastText = parts.join("");
        }
        if (ev.type === "message" && ev.role === "user") parts = [];
        if (ev.type === "tool_use") { parts = []; noteToolInput(d, ev.parameters); }
        if (ev.type === "error") d.error = String(ev.message ?? "gemini error").slice(0, 1000);
        if (ev.type === "result" && ev.status && ev.status !== "success") d.error = String(ev.error?.message ?? ev.status).slice(0, 1000);
      },
      result: () => ({ ...d }),
    };
  },
};

/** DashScope (Alibaba Model Studio) OpenAI-compatible endpoint, international region. */
const DASHSCOPE_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const qwenCode: HarnessAdapter = {
  id: "qwen-code",
  supported: true,
  canResume: true,
  bin: "qwen",
  env: (k) => ({
    ...BASE_ENV, QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
    OPENAI_API_KEY: envKey(k, null, "DASHSCOPE_API_KEY"),
    OPENAI_BASE_URL: process.env.DASHSCOPE_BASE_URL || DASHSCOPE_BASE_URL,
  }),
  hasKey: (k) => !!envKey(k, null, "DASHSCOPE_API_KEY"),
  // No positional prompt: piped stdin is the prompt (verified). Output is Claude-Code-compatible stream-json.
  launchArgv: (o) => [o.bin ?? "qwen", "-o", "stream-json", "--yolo", "--auth-type", "openai", ...(isDefaultModel(o.model) ? [] : ["-m", o.model])],
  resumeArgv: (o) => [o.bin ?? "qwen", "-o", "stream-json", "--yolo", "--auth-type", "openai", ...(isDefaultModel(o.model) ? [] : ["-m", o.model]), "--resume", o.sessionId],
  newDigest: claudeLikeDigest,
};

// ---------------------------------------------------------------- Antigravity CLI (agy)

/** API-key auth needs modelProvider "gemini" in agy's settings (docs); written once into the sandbox HOME. */
const AGY_SETUP = ensureFile(".gemini/antigravity-cli/settings.json", '{"modelProvider":"gemini"}');

const antigravity: HarnessAdapter = {
  id: "antigravity",
  supported: true,
  canResume: true,
  bin: "agy",
  env: (k) => ({ ...BASE_ENV, GEMINI_API_KEY: envKey(k, null, "GEMINI_API_KEY", "GOOGLE_API_KEY") }),
  hasKey: (k) => !!envKey(k, null, "GEMINI_API_KEY", "GOOGLE_API_KEY"),
  // `-p` takes the prompt as its value, so it goes last and the wrapper appends the prompt after it.
  launchArgv: (o) => promptAsLastArg([o.bin ?? "agy", "--output-format", "stream-json", "--dangerously-skip-permissions", ...(isDefaultModel(o.model) ? [] : ["--model", o.model]), "-p"], AGY_SETUP),
  resumeArgv: (o) => promptAsLastArg([o.bin ?? "agy", "--output-format", "stream-json", "--dangerously-skip-permissions", ...(isDefaultModel(o.model) ? [] : ["--model", o.model]), "--conversation", o.sessionId, "-p"], AGY_SETUP),
  newDigest() {
    const d = newDigestState();
    let resultText: string | null = null;
    return {
      observe(ev) {
        if (typeof ev.conversation_id === "string") d.sessionId = ev.conversation_id;
        const st = ev.step_update;
        if (ev.event === "step_update" && st) {
          if (typeof st.conversation_id === "string") d.sessionId = st.conversation_id;
          if (st.step_type === "tool") noteToolInput(d, st.tool_info?.parameters);
          if (st.step_type === "agent_response" && st.state === "DONE" && typeof st.text_delta === "string" && st.text_delta.trim()) d.lastText = st.text_delta.trimEnd();
        }
        if (ev.event === "result" && ev.result) {
          if (typeof ev.result.conversation_id === "string") d.sessionId = ev.result.conversation_id;
          if (typeof ev.result.response === "string" && ev.result.response.trim()) resultText = ev.result.response.trimEnd();
          if (ev.result.status && ev.result.status !== "SUCCESS") d.error = String(ev.result.error ?? ev.result.status).slice(0, 1000);
        }
        if (ev.event === "error") d.error = String(ev.error?.message ?? ev.message ?? "agy error").slice(0, 1000);
      },
      result: () => ({ ...d, lastText: resultText ?? d.lastText }),
    };
  },
};

// ---------------------------------------------------------------- Pi

// Pi's ~/.pi/agent/models.json (gateway base URLs, Vertex compat flags, Cloudflare provider) is written by its
// credential mapping (credentials.ts), which knows the session's model.
const pi: HarnessAdapter = {
  id: "pi",
  supported: true,
  canResume: true,
  bin: "pi",
  env: (k) => ({ ...BASE_ENV, ...anthropicEnv(k) }),
  hasKey: (k) => !!envKey(k, "anthropic", "ANTHROPIC_API_KEY"),
  // Piped stdin is the prompt (verified). --model accepts "provider/id".
  launchArgv: (o) => [o.bin ?? "pi", "-p", "--mode", "json", "--model", o.model],
  resumeArgv: (o) => [o.bin ?? "pi", "-p", "--mode", "json", "--model", o.model, "--session", o.sessionId],
  newDigest() {
    const d = newDigestState();
    return {
      observe(ev) {
        if (ev.type === "session" && typeof ev.id === "string") d.sessionId = ev.id;
        // message_end carries the authoritative message; turn_end / agent_end repeat it.
        const m = ev.message;
        if (ev.type === "message_end" && m?.role === "assistant") {
          const texts: string[] = [];
          for (const c of Array.isArray(m.content) ? m.content : []) {
            if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
            if (c?.type === "toolCall") noteToolInput(d, c.arguments);
          }
          if (texts.join("").trim()) d.lastText = texts.join("\n");
          if (m.stopReason === "error" || m.stopReason === "aborted") d.error = String(m.errorMessage ?? m.stopReason).slice(0, 1000);
        }
      },
      result: () => ({ ...d }),
    };
  },
};

// ---------------------------------------------------------------- Cline CLI

const cline: HarnessAdapter = {
  id: "cline",
  supported: true,
  // `cline --id <session> --json <prompt>` fails headlessly in 3.0.70 ("JSON output mode requires a prompt"), and the
  // JSON stream does not carry the resumable session id. So no developer replies for Cline.
  canResume: false,
  bin: "cline",
  env: (k) => ({ ...BASE_ENV, ...anthropicEnv(k) }),
  hasKey: (k) => !!envKey(k, "anthropic", "ANTHROPIC_API_KEY"),
  // Prompt must be a positional argument. The key goes in via -k from the env (not argv), with provider anthropic.
  // Note: a one-word prompt is rejected by cline ("Unknown command"); scenario prompts are sentences.
  // CLINE_API_KEY comes from the credential mapping (gateway: Anthropic, OpenAI or Cloudflare token); direct runs use ANTHROPIC_API_KEY.
  launchArgv: (o) => ["bash", "-c", 'exec "$@" -k "${CLINE_API_KEY:-$ANTHROPIC_API_KEY}" -- "$(cat)"', "run", o.bin ?? "cline", "--json", "--auto-approve", "true", "-P", "anthropic", "-m", o.model],
  resumeArgv: () => { throw new UnsupportedHarnessError("cline cannot resume a session headlessly"); },
  newDigest() {
    const d = newDigestState();
    let resultText: string | null = null;
    return {
      observe(ev) {
        const e = ev.agent_event ?? ev.event;
        if (ev.type === "agent_event" && e) {
          if (e.type === "content_start" && e.contentType === "tool") noteToolInput(d, e.input);
          if (e.type === "content_end" && e.contentType === "text" && typeof e.text === "string" && e.text.trim()) d.lastText = e.text;
          if (e.type === "done" && e.reason && e.reason !== "completed") d.error = String(e.text ?? e.reason).slice(0, 1000);
        }
        if (ev.type === "run_result") {
          if (typeof ev.text === "string" && ev.text.trim() && ev.finishReason === "completed") resultText = ev.text;
          if (ev.finishReason && ev.finishReason !== "completed") d.error = String(ev.text ?? ev.finishReason).slice(0, 1000);
        }
        if (ev.type === "error" && typeof ev.message === "string" && !/hook dispatch failed/.test(ev.message)) d.error = ev.message.slice(0, 1000);
      },
      // sessionId stays null on purpose: canResume is false.
      result: () => ({ ...d, sessionId: null, lastText: resultText ?? d.lastText }),
    };
  },
};

// ---------------------------------------------------------------- Amp

/** Execute mode must not stop for command confirmations; this is Amp's documented setting for that. */
const AMP_SETUP = ensureFile(".config/amp/settings.json", '{"amp.dangerouslyAllowAll":true}');

const amp: HarnessAdapter = {
  id: "amp",
  supported: true,
  canResume: true,
  bin: "amp",
  env: (k) => ({ ...BASE_ENV, AMP_API_KEY: envKey(k, null, "AMP_API_KEY") }),
  hasKey: (k) => !!envKey(k, null, "AMP_API_KEY"),
  // Piped stdin is the prompt in execute mode (docs). "default" model = no --mode (Amp picks the model per mode).
  launchArgv: (o) => withSetup([o.bin ?? "amp", "-x", "--stream-json", ...(isDefaultModel(o.model) ? [] : ["--mode", o.model])], AMP_SETUP),
  resumeArgv: (o) => withSetup([o.bin ?? "amp", "threads", "continue", o.sessionId, "-x", "--stream-json", ...(isDefaultModel(o.model) ? [] : ["--mode", o.model])], AMP_SETUP),
  newDigest: claudeLikeDigest,
};

// ---------------------------------------------------------------- Factory droid

const droid: HarnessAdapter = {
  id: "droid",
  supported: true,
  canResume: true,
  bin: "droid",
  env: (k) => ({ ...BASE_ENV, FACTORY_API_KEY: envKey(k, null, "FACTORY_API_KEY") }),
  hasKey: (k) => !!envKey(k, null, "FACTORY_API_KEY"),
  // Piped stdin is the prompt (verified).
  launchArgv: (o) => [o.bin ?? "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", ...(isDefaultModel(o.model) ? [] : ["-m", o.model])],
  resumeArgv: (o) => [o.bin ?? "droid", "exec", "-o", "stream-json", "--skip-permissions-unsafe", ...(isDefaultModel(o.model) ? [] : ["-m", o.model]), "-s", o.sessionId],
  newDigest() {
    const d = newDigestState();
    let resultText: string | null = null;
    return {
      observe(ev) {
        if (typeof ev.session_id === "string") d.sessionId = ev.session_id;
        if (ev.type === "message" && ev.role === "assistant" && typeof ev.text === "string" && ev.text.trim()) d.lastText = ev.text;
        if (ev.type === "tool_call") noteToolInput(d, ev.parameters);
        if (ev.type === "completion" && typeof ev.finalText === "string" && ev.finalText.trim()) resultText = ev.finalText;
        if (ev.type === "error") d.error = String(ev.message ?? "droid error").slice(0, 1000);
      },
      result: () => ({ ...d, lastText: resultText ?? d.lastText }),
    };
  },
};

// ---------------------------------------------------------------- registry

const ADAPTERS: Record<string, HarnessAdapter> = {
  "claude-code": claudeCode, codex, copilot, cursor, opencode, kilo, "gemini-cli": gemini, "qwen-code": qwenCode,
  antigravity, pi, cline, amp, droid,
};

/** Ids we know exist (registry `enabled:false` entries) but cannot run. */
const KNOWN_UNSUPPORTED = ["junie", "devin", "kiro", "jules", "roo", "augment", "warp", "aider", "trae", "zed", "continue", "kimi", "goose"];

const ALIASES: Record<string, string> = {
  claude: "claude-code", claudecode: "claude-code", "claude-code-cli": "claude-code",
  "codex-cli": "codex", "openai-codex": "codex",
  "cursor-agent": "cursor", "cursor-cli": "cursor",
  gemini: "gemini-cli", agy: "antigravity", "antigravity-cli": "antigravity",
  "github-copilot": "copilot", "copilot-cli": "copilot",
  qwen: "qwen-code", "factory-droid": "droid", factory: "droid", kilocode: "kilo", "kilo-code": "kilo",
  "pi-coding-agent": "pi", "sourcegraph-amp": "amp", "opencode-ai": "opencode",
};

export function normalizeHarnessId(h: string): string {
  const k = h.trim().toLowerCase().replace(/[_\s]/g, "-");
  return ALIASES[k] ?? k;
}

export class UnsupportedHarnessError extends Error {}

/** Throws UnsupportedHarnessError for ids without an adapter ("not yet supported" stubs). */
export function getAdapter(harness: string): HarnessAdapter {
  const id = normalizeHarnessId(harness);
  const a = ADAPTERS[id];
  if (a) return a;
  const known = KNOWN_UNSUPPORTED.includes(id) || registryIds().includes(id);
  throw new UnsupportedHarnessError(`Harness "${harness}" is ${known ? "not yet supported by the orchestrator" : "unknown"}`);
}

export function supportedHarnesses(): string[] { return Object.keys(ADAPTERS); }

/** Harness ids from the repo-root registry, if present (read-only; tolerant of its exact shape). */
function registryIds(): string[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const data = JSON.parse(readFileSync(join(here, "..", "..", "harnesses", "registry.json"), "utf8"));
    const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : Array.isArray(data?.harnesses) ? data.harnesses : Object.values(data ?? {});
    return list.map((h) => (typeof h === "string" ? h : h?.harness ?? h?.id)).filter((x): x is string => typeof x === "string").map(normalizeHarnessId);
  } catch { return []; }
}

// ---------------------------------------------------------------- Agent Client Protocol (Zed personas)

/**
 * The same harness launched the way Zed launches it: over ACP, with orchestrator/harnesses/acp-client.mjs playing Zed
 * (core/environment.ts ACP_ROUTES). Credentials and the pinned binary are the base harness's; only the launch and the
 * event format differ. A follow-up turn reloads the ACP session (session/load).
 */
export function acpAdapter(base: HarnessAdapter, route: { command: string[]; env?: Record<string, string> }, clientPath: string): HarnessAdapter {
  const argv = (o: ArgvOptions, load?: string) =>
    ["node", clientPath, "--cwd", o.workdir, "--model", o.model, ...(load ? ["--load", load] : []), "--", ...route.command];
  return {
    ...base,
    canResume: true,
    env: (k) => ({ ...base.env(k), ...(route.env ?? {}) }),
    launchArgv: (o) => argv(o),
    resumeArgv: (o) => argv(o, o.sessionId),
    newDigest: acpDigest,
  };
}

function acpDigest(): DigestBuilder {
  const d: TurnDigest = { lastText: "", commands: [], files: [], sessionId: null, error: null };
  return {
    observe(ev) {
      if (ev.type === "acp.session" || ev.type === "acp.result") d.sessionId = ev.sessionId ?? d.sessionId;
      if (ev.type === "acp.message" && ev.text) d.lastText = String(ev.text);
      if (ev.type === "acp.tool_call") {
        const input = (ev.rawInput ?? {}) as Record<string, unknown>;
        if (ev.kind === "execute") pushUnique(d.commands, typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : ev.title);
        if (ev.kind === "edit" || ev.kind === "delete" || ev.kind === "move") {
          for (const l of (ev.locations ?? []) as { path?: string }[]) pushUnique(d.files, l.path);
          pushUnique(d.files, (input.file_path ?? input.path ?? input.filePath) as string | undefined);
        }
      }
      if (ev.type === "acp.error") d.error = String(ev.message ?? "acp error");
      if (ev.type === "acp.result" && (ev.stopReason === "refusal")) d.error = `agent stopped: ${ev.stopReason}`;
      if (ev.type === "acp.result" && (ev.stopReason === "max_turn_requests" || ev.stopReason === "max_tokens")) d.capped = true;
    },
    result: () => d,
  };
}
