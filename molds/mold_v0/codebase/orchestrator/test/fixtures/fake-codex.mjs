#!/usr/bin/env node
// Scripted stand-in for `codex exec --json` (test/run-until-done.ts). Behaviour comes from MODE=<name> in the first
// prompt; state lives in $HOME (outside the workspace). Emits Codex-shaped JSONL events.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = readFileSync(0, "utf8");
const resume = process.argv.includes("resume");
const statePath = join(process.env.HOME ?? "/tmp", ".fake-codex.json");
const state = resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { mode: /MODE=(\w+)/.exec(input)?.[1] ?? "plan_then_code", runs: 0, inputs: [] };
state.runs++;
state.inputs.push(input.slice(0, 200));
writeFileSync(statePath, JSON.stringify(state));

const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
let item = 0;
const msg = (text) => out({ type: "item.completed", item: { id: `item_${item++}`, type: "agent_message", text } });
const cmd = (command) => out({ type: "item.completed", item: { id: `item_${item++}`, type: "command_execution", command, exit_code: 0, status: "completed", aggregated_output: "" } });
const write = (path, content) => {
  mkdirSync(join(process.cwd(), path, ".."), { recursive: true });
  appendFileSync(join(process.cwd(), path), content);
  out({ type: "item.completed", item: { id: `item_${item++}`, type: "file_change", changes: [{ path, kind: "add" }], status: "completed" } });
};

out({ type: "thread.started", thread_id: "thread-fake-1" });
out({ type: "turn.started" });
cmd("ls -la");
switch (state.mode) {
  case "plan_then_code": // plans and asks first; implements once the developer says go
    if (state.runs === 1) msg(`Plan: add a validation module for POST /orders and wire it into the route.${/go-ahead/.test(input) ? " (waiting for your go-ahead)" : ""} Should I proceed?`);
    else { write("src/validate.ts", "export const validate = (b: unknown) => !!b;\n"); msg("Implemented validation in src/validate.ts."); }
    break;
  case "docs_then_code": // first run only writes notes (not done), second writes code
    if (state.runs === 1) { write("NOTES.md", "- add validation\n"); msg("I wrote down the plan in NOTES.md."); }
    else { write("src/validate.ts", "export const ok = true;\n"); msg("Done."); }
    break;
  case "busy_never_done": // burns many steps per run and never changes the workspace
    for (let i = 0; i < 30; i++) cmd(`grep -rn order src # ${state.runs}.${i}`);
    msg("Still investigating.");
    break;
  case "gives_up": // one short message, never changes anything
    msg("There is nothing for me to do here.");
    break;
}
out({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 } });
