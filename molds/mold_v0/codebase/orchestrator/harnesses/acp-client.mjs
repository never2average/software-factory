#!/usr/bin/env node
// Headless ACP client (agentclientprotocol.com) that runs a coding agent the way the Zed editor does. Runs inside the
// worker sandbox as the agent user. It advertises what Zed advertises, sends the prompt as plain text (Zed attaches no
// automatic context), forwards no MCP servers, answers permission requests by allowing (a developer who clicks
// "Always allow"), and serves fs/* and terminal/* on the workspace.
//
//   node acp-client.mjs --cwd <dir> [--model <id>] [--load <sessionId>] -- <agent command...>   (prompt on stdin)
//
// stdout: one JSON event per line. Streamed chunks are joined, so each message or thought is one event:
//   acp.session {sessionId, agent, loadSession, models}   acp.message {text}   acp.thought {text}
//   acp.tool_call {toolCallId, title, kind, status, rawInput, locations}   acp.plan {entries}
//   acp.permission {title, chosen}   acp.result {sessionId, stopReason}   acp.error {message}
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { accessSync, constants } from "node:fs";

const acp = await import(process.env.ACP_SDK_PATH || "@agentclientprotocol/sdk");
// Adapters that wrap a CLI run the pinned one already on PATH (not a bundled copy).
const onPath = (bin) => (process.env.PATH ?? "").split(":").map((d) => `${d}/${bin}`).find((p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
for (const [k, bin] of [["CLAUDE_CODE_EXECUTABLE", "claude"], ["CODEX_PATH", "codex"]]) if (!process.env[k]) { const p = onPath(bin); if (p) process.env[k] = p; }

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = {}, flags = sep >= 0 ? argv.slice(0, sep) : argv;
for (let i = 0; i < flags.length; i += 2) opts[flags[i].replace(/^--/, "")] = flags[i + 1];
const agentCmd = sep >= 0 ? argv.slice(sep + 1) : [];
if (!agentCmd.length || !opts.cwd) { console.error("usage: acp-client --cwd DIR [--model ID] [--load ID] -- CMD..."); process.exit(2); }
const cwd = resolve(opts.cwd);
// claude-agent-acp takes its model from the environment as well as the model selector.
if (agentCmd[0] === "claude-agent-acp" && opts.model && !process.env.ANTHROPIC_MODEL) process.env.ANTHROPIC_MODEL = opts.model;

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const chunks = { kind: null, text: "" };
const flush = () => { if (chunks.kind && chunks.text) emit({ type: chunks.kind, text: chunks.text }); chunks.kind = null; chunks.text = ""; };
const tools = new Map();
const finishTool = (id) => { const t = tools.get(id); if (t && !t.emitted) { t.emitted = true; emit({ type: "acp.tool_call", ...t, emitted: undefined }); } };

const inside = (p) => { const a = isAbsolute(p) ? p : resolve(cwd, p); return a; };
const terminals = new Map();
let nextTerm = 1;

// session/load replays the conversation as session/update notifications: already in the transcript, so not re-emitted.
let replaying = false;

const client = {
  async sessionUpdate({ update: u }) {
    if (replaying) return;
    const k = u?.sessionUpdate;
    if (k === "agent_message_chunk" || k === "agent_thought_chunk") {
      const kind = k === "agent_message_chunk" ? "acp.message" : "acp.thought";
      if (chunks.kind !== kind) flush();
      chunks.kind = kind;
      if (u.content?.type === "text") chunks.text += u.content.text ?? "";
      return;
    }
    flush();
    if (k === "tool_call" || k === "tool_call_update") {
      const t = tools.get(u.toolCallId) ?? { toolCallId: u.toolCallId };
      for (const f of ["title", "kind", "status", "rawInput", "rawOutput", "locations"]) if (u[f] !== undefined && u[f] !== null) t[f] = u[f];
      tools.set(u.toolCallId, t);
      if (t.status === "completed" || t.status === "failed") finishTool(u.toolCallId);
    } else if (k === "plan") emit({ type: "acp.plan", entries: u.entries });
    else if (k === "usage_update") emit({ type: "acp.usage", ...u, sessionUpdate: undefined });
  },
  async requestPermission({ toolCall, options }) {
    const pick = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options[0];
    emit({ type: "acp.permission", title: toolCall?.title ?? null, chosen: pick?.kind ?? null });
    return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
  },
  async readTextFile({ path, line, limit }) {
    let content = await readFile(inside(path), "utf8");
    if (line || limit) { const lines = content.split("\n"); const s = Math.max(0, (line ?? 1) - 1); content = lines.slice(s, limit ? s + limit : undefined).join("\n"); }
    return { content };
  },
  async writeTextFile({ path, content }) {
    const p = inside(path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
    return {};
  },
  async createTerminal({ command, args, cwd: tcwd, env, outputByteLimit }) {
    const id = `term-${nextTerm++}`;
    const child = spawn(command, args ?? [], { cwd: tcwd ? inside(tcwd) : cwd, shell: !args?.length,
      env: { ...process.env, ...Object.fromEntries((env ?? []).map((e) => [e.name, e.value])) } });
    const t = { child, output: "", truncated: false, limit: outputByteLimit ?? 1_000_000, exit: null };
    const add = (d) => { t.output += d.toString(); if (t.output.length > t.limit) { t.output = t.output.slice(-t.limit); t.truncated = true; } };
    child.stdout.on("data", add); child.stderr.on("data", add);
    t.done = new Promise((r) => child.on("close", (code, signal) => { t.exit = { exitCode: code, signal: signal ?? null }; r(t.exit); }));
    child.on("error", (e) => { add(String(e)); t.exit = { exitCode: 127, signal: null }; });
    terminals.set(id, t);
    return { terminalId: id };
  },
  async terminalOutput({ terminalId }) {
    const t = terminals.get(terminalId);
    return { output: t?.output ?? "", truncated: !!t?.truncated, ...(t?.exit ? { exitStatus: t.exit } : {}) };
  },
  async waitForTerminalExit({ terminalId }) { const t = terminals.get(terminalId); return t ? await t.done : { exitCode: null, signal: null }; },
  async killTerminal({ terminalId }) { terminals.get(terminalId)?.child.kill("SIGTERM"); return {}; },
  async releaseTerminal({ terminalId }) { const t = terminals.get(terminalId); if (t && !t.exit) t.child.kill("SIGTERM"); terminals.delete(terminalId); return {}; },
};

const prompt = await new Promise((r) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); });
const agent = spawn(agentCmd[0], agentCmd.slice(1), { cwd, stdio: ["pipe", "pipe", "inherit"], env: process.env });
agent.on("error", (e) => { emit({ type: "acp.error", message: `agent did not start: ${e.message}` }); process.exit(1); });
const conn = new acp.ClientSideConnection(() => client, acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout)));

let sessionId = null;
const stop = async () => { if (sessionId) await conn.cancel({ sessionId }).catch(() => {}); setTimeout(() => process.exit(130), 5000).unref(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

try {
  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION ?? 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true },
                          session: { configOptions: { boolean: {} }, compaction: {}, notices: {} }, _meta: { terminal_output: true, "terminal-auth": true } },
    clientInfo: { name: "zed", title: "Zed", version: process.env.ZED_VERSION || "1.23.3" },
  });
  const canLoad = !!init.agentCapabilities?.loadSession;
  // An agent that offers API-key auth (codex-acp) uses the key from the environment once told to: what a Zed user
  // does by picking "API key" in the agent's login prompt. Login flows (browser, account) are never started.
  const keyAuth = (init.authMethods ?? []).find((m) => /^api[-_]?key$/i.test(m.id ?? ""));
  if (keyAuth && (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY))
    await conn.authenticate({ methodId: keyAuth.id }).catch((e) => emit({ type: "acp.error", message: `authenticate ${keyAuth.id}: ${e?.message ?? e}` }));
  let res;
  if (opts.load && canLoad) {
    replaying = true;
    try { res = await conn.loadSession({ sessionId: opts.load, cwd, mcpServers: [] }); } finally { replaying = false; }
    sessionId = opts.load;
    chunks.kind = null; chunks.text = "";
  }
  else { res = await conn.newSession({ cwd, mcpServers: [] }); sessionId = res.sessionId; }
  flush();
  // The job's model, through the agent's own model selector (what picking a model in Zed's thread does).
  const models = [];
  const modelOpt = (res.configOptions ?? []).find((o) => o.category === "model" && o.type === "select");
  if (modelOpt && opts.model) {
    const flat = (modelOpt.options ?? []).flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
    models.push(...flat.map((o) => o.value));
    const want = opts.model.toLowerCase();
    const hit = flat.find((o) => String(o.value).toLowerCase() === want) ?? flat.find((o) => String(o.value).toLowerCase().endsWith(want) || want.endsWith(String(o.value).toLowerCase()));
    if (hit && hit.value !== modelOpt.currentValue) await conn.setSessionConfigOption({ sessionId, configId: modelOpt.id, value: hit.value }).catch((e) => emit({ type: "acp.error", message: `set model: ${e?.message ?? e}` }));
  }
  emit({ type: "acp.session", sessionId, agent: init.agentInfo ?? null, loadSession: canLoad, loaded: !!(opts.load && canLoad),
         model: modelOpt ? (opts.model ?? null) : null, models: models.slice(0, 30) });
  const out = await conn.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
  flush();
  for (const id of tools.keys()) finishTool(id);
  emit({ type: "acp.result", sessionId, stopReason: out.stopReason });
  agent.stdin.end(); agent.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  flush();
  for (const id of tools.keys()) finishTool(id);
  emit({ type: "acp.error", sessionId, message: String(e?.message ?? e).slice(0, 2000) });
  agent.kill("SIGTERM");
  process.exit(1);
}
