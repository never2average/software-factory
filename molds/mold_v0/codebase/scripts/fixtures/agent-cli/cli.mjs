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
// Its answer is "Echo: <the turn's text>"; a resumed session's first answer starts "(resumed <id>) ".
// --script <file> (the lane shots): a JSON list of {match, say, delay_ms, fetch, cost}; the first whose match (a regular
// expression) finds the turn's text decides the turn instead: its words, how long it takes, a WebFetch it makes first.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
    const u = /^use (\S+)/.exec(w);
    if (u) { say({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `u${turns}`, name: u[1], input: {} }] } }); await new Promise((r) => setTimeout(r, 300)); }
  }
  turns++;
  total = Math.round((total + cost) * 1e6) / 1e6;
  const reply = `${first && resume ? `(resumed ${resume}) ` : ""}Echo: ${text.split("\n").filter(Boolean).slice(-1)[0] ?? ""}`;
  first = false;
  say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
  save();
  if (/^budget$/m.test(text)) { say({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget reached", total_cost_usd: total, num_turns: turns }); return; }
  say({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: total, num_turns: turns });
}
