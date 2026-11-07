#!/usr/bin/env node
// A stand-in for the workspace agent's harness CLI (mold_v0-243 tests and lane shots only, never shipped as the agent):
// it speaks the same stream-json the pinned Claude Code does, so src/agent-harness.ts is driven offline.
//   stdin   one JSON line per user turn ({type: "user", message: {content}, uuid}); EOF ends the session
//   stdout  {type: "system", subtype: "init", session_id}, then per turn: the echo of the line it took in
//           ({type: "user", isReplay: true, uuid}), assistant events (text, tool_use), and a result carrying the
//           session's cumulative total_cost_usd; a resumed session (--resume <id>) starts its total from the last
//           {"type": "cost-state"} line of its transcript (HOME/.claude/projects/w/<id>.jsonl), as the real CLI does
// What a turn does, from its text (the last line that matches wins):
//   fetch <url>     a WebFetch tool call to <url>, then (if it is not stopped) "Read <host>."
//   use <Tool>      a tool call of <Tool>
//   slow <ms>       the turn takes <ms> before it answers (so a message can arrive mid-turn, or a pause land)
//   spend <usd>     the turn costs <usd> (default 0.01)
//   die             exits 3 without answering (the harness's own failure: a crash)
//   budget          the turn ends on the CLI's own budget (subtype error_max_budget_usd)
//   pwd             the answer is "Working in <its working directory>." (what a model would see of the path)
//   standing        the answer says what it was given (mold_v0-250): "Standing: <n> characters; workspace: yes|no; servers:
//                   <names>; token: set|unset" (the --append-system-prompt, the --mcp-config file, the token's variable)
//   mcp <tool> <json>  a call of the workspace's tool (mold_v0-250): a tool_use of mcp__app__<tool> (the harness checks
//                   it against the policy, as with any tool), then the call itself over HTTP to the server --mcp-config
//                   names, its ${...} header expanded from the environment as the real CLI does; the answer is
//                   "MCP <tool>: <the result's text>" or "MCP <tool> refused: <why>"
//   said            (mold_v0-261) the answer is "Said: <the whole turn as the CLI got it, lines joined by " | ">" (an agent
//                   profile's on_start template around the person's words shows here)
//   system          (mold_v0-261) the answer is "System: <its --append-system-prompt, lines joined by " | ">"
//   files           (mold_v0-261) the answer is "Files: <every file under its working directory, relative, sorted>"
//   cat <path>      (mold_v0-261) the answer is "File <path>: <its text, lines joined by " | ">" (or "File <path>: none")
// Its answer is "Echo: <the turn's text>"; a resumed session's first answer starts "(resumed <id>) ".
// --script <file> (the lane shots): a JSON list of {match, say, delay_ms, fetch, cost}; the first whose match (a regular
// expression) finds the turn's text decides the turn instead: its words, how long it takes, a WebFetch it makes first.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";

/** The workspace server's config (--mcp-config), its headers' ${VAR} expanded from the environment. */
function workspaceServer() {
  const f = arg("--mcp-config");
  if (!f || !existsSync(f)) return null;
  const s = JSON.parse(readFileSync(f, "utf8")).mcpServers?.app;
  if (!s) return null;
  const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "")]));
  return { url: s.url, headers };
}
/** One tools/call to the workspace's server (stateless streamable HTTP: JSON or one SSE event back). */
async function callWorkspace(tool, args) {
  const s = workspaceServer();
  if (!s) return "no workspace server";
  const r = await fetch(s.url, { method: "POST", headers: { ...s.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await r.text();
  const json = t.trim().startsWith("{") ? JSON.parse(t) : JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? "data: {}").slice(5));
  if (json.error) return `refused: ${json.error.message}`;
  const text = (json.result?.content ?? []).map((c) => c.text ?? "").join(" ").replace(/\s+/g, " ");
  return json.result?.isError ? `error: ${text}` : text;
}
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const resume = arg("--resume");
const script = arg("--script") ? JSON.parse(readFileSync(arg("--script"), "utf8")) : [];
const sid = resume ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
const dir = path.join(process.env.HOME ?? ".", ".claude", "projects", "w");
mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sid}.jsonl`);
let total = 0;
if (resume && existsSync(transcript)) for (const l of readFileSync(transcript, "utf8").split("\n")) {
  try { const x = JSON.parse(l); if (x.type === "cost-state") total = x.totalCostUSD; } catch { /* torn */ }
}
const say = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + "\n");
const save = () => appendFileSync(transcript, JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: total }) + "\n");
process.on("SIGTERM", () => { save(); process.exit(143); });
say({ type: "system", subtype: "init", model: arg("--model") ?? "", cwd: process.cwd() });
let first = true, turns = 0;
const mcpSaid = [];
const lines = [];
let busy = false, ended = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => { if (l.trim()) { lines.push(l); void pump(); } });
rl.on("close", () => { ended = true; void pump(); });
async function pump() {
  if (busy) return;
  busy = true;
  while (lines.length) await turn(JSON.parse(lines.shift()));
  busy = false;
  if (ended && !lines.length) { save(); process.exit(0); }
}
async function turn(m) {
  if (m.uuid) say({ type: "user", isReplay: true, uuid: m.uuid, message: m.message });
  const text = String(m.message?.content ?? "");
  let cost = 0.01;
  const scripted = script.find((x) => new RegExp(x.match, "i").test(text));
  if (scripted) {
    if (scripted.fetch) {
      say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: scripted.before ?? "Let me check that page." }, { type: "tool_use", id: `t${turns}`, name: "WebFetch", input: { url: scripted.fetch, prompt: "read it" } }] } });
      await new Promise((r) => setTimeout(r, 300));
    }
    if (scripted.delay_ms) await new Promise((r) => setTimeout(r, scripted.delay_ms));
    turns++;
    total = Math.round((total + (scripted.cost ?? cost)) * 1e6) / 1e6;
    say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: scripted.say }] } });
    save();
    say({ type: "result", subtype: "success", is_error: false, result: scripted.say, total_cost_usd: total, num_turns: turns });
    return;
  }
  for (const l of text.split("\n")) {
    const w = l.trim();
    if (w === "die") { process.exit(3); }
    const slow = /^slow (\d+)/.exec(w); if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
    const sp = /^spend ([\d.]+)/.exec(w); if (sp) cost = Number(sp[1]);
    const f = /^fetch (\S+)/.exec(w);
    if (f) {
      say({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${turns}`, name: "WebFetch", input: { url: f[1], prompt: "read it" } }] } });
      await new Promise((r) => setTimeout(r, 300));
      say({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${turns}`, content: "ok" }] } });
      say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Read ${new URL(f[1]).hostname}.` }] } });
    }
    const mc = /^mcp (\S+)(?: (.+))?$/.exec(w);
    if (mc) {
      say({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `m${turns}`, name: `mcp__app__${mc[1]}`, input: mc[2] ? JSON.parse(mc[2]) : {} }] } });
      await new Promise((r) => setTimeout(r, 300));
      const got = await callWorkspace(mc[1], mc[2] ? JSON.parse(mc[2]) : {}).catch((e) => `failed: ${e.message}`);
      mcpSaid.push(got.startsWith("refused: ") ? `MCP ${mc[1]} refused: ${got.slice(9)}` : `MCP ${mc[1]}: ${got.slice(0, 4000)}`);
    }
    const u = /^use (\S+)/.exec(w);
    if (u) { say({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `u${turns}`, name: u[1], input: {} }] } }); await new Promise((r) => setTimeout(r, 300)); }
  }
  turns++;
  total = Math.round((total + cost) * 1e6) / 1e6;
  const standing = () => { const sys = arg("--append-system-prompt") ?? ""; const srv = workspaceServer();
    return `Standing: ${sys.length} characters; workspace: ${/## This workspace/.test(sys) ? "yes" : "no"}; servers: ${srv ? "app" : "none"}; token: ${process.env.RUN_WORKSPACE_TOKEN ? "set" : "unset"}`; };
  const flat = (t) => t.split("\n").map((x) => x.trim()).filter(Boolean).join(" | ");
  const listFiles = (dir, base = "") => readdirSync(dir).flatMap((n) => { const f = path.join(dir, n), r = base ? `${base}/${n}` : n; return statSync(f).isDirectory() ? listFiles(f, r) : [r]; });
  const cat = /^cat (\S+)$/m.exec(text);
  // mold_v0-262: what the wake's environment holds under a name (a delivered credential is redacted on its way out).
  const envName = /^env ([A-Z][A-Z0-9_]{0,63})$/m.exec(text);
  const said = mcpSaid.length ? mcpSaid.splice(0).join("\n") : /^standing$/m.test(text) ? standing() : /^pwd$/m.test(text) ? `Working in ${process.cwd()}.`
    : /^said$/m.test(text) ? `Said: ${flat(text)}` : /^system$/m.test(text) ? `System: ${flat(arg("--append-system-prompt") ?? "")}`
    : /^files$/m.test(text) ? `Files: ${listFiles(process.cwd()).sort().join(", ")}`
    : envName ? `Env ${envName[1]}: ${process.env[envName[1]] ?? "unset"}`
    : cat ? `File ${cat[1]}: ${existsSync(path.join(process.cwd(), cat[1])) ? flat(readFileSync(path.join(process.cwd(), cat[1]), "utf8")) : "none"}`
    : `Echo: ${text.split("\n").filter(Boolean).slice(-1)[0] ?? ""}`;
  const reply = `${first && resume ? `(resumed ${resume}) ` : ""}${said}`;
  first = false;
  say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
  save();
  if (/^budget$/m.test(text)) { say({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget reached", total_cost_usd: total, num_turns: turns }); return; }
  say({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: total, num_turns: turns });
}
