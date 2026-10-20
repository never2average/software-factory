#!/usr/bin/env node
// Mock ACP agent for orchestrator/test/acp-client.ts: records what the client sent (to $MOCK_ACP_LOG) and exercises
// streamed chunks, a permission request, fs write/read, a terminal, a plan and session/load.
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const record = (k, v) => appendFileSync(process.env.MOCK_ACP_LOG, JSON.stringify({ k, v }) + "\n");
const models = { id: "model", name: "Model", category: "model", type: "select", currentValue: "default",
  options: [{ value: "default", name: "Default" }, { value: "claude-opus-5-5", name: "Opus 5.5" }] };

new AgentSideConnection((conn) => ({
  async initialize(p) { record("initialize", p); return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "mock-agent", version: "1.0.0" },
    authMethods: [{ id: "browser-login", name: "Log in" }, { id: "api-key", name: "API key" }] }; },
  async authenticate(p) { record("authenticate", p); return {}; },
  async newSession(p) { record("newSession", p); return { sessionId: "sess-1", configOptions: [models] }; },
  async loadSession(p) {
    record("loadSession", p);
    // replay, as real agents do
    await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier prompt" } } });
    await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED earlier answer" } } });
    return { configOptions: [models] };
  },
  async setSessionConfigOption(p) { record("setConfig", p); return { configOptions: [{ ...models, currentValue: p.value }] }; },
  async cancel() {},
  async prompt(p) {
    record("prompt", p);
    const sid = p.sessionId;
    const up = (u) => conn.sessionUpdate({ sessionId: sid, update: u });
    await up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it" } });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll add the " } });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mailer." } });
    await up({ sessionUpdate: "plan", entries: [{ content: "write mailer", priority: "high", status: "in_progress" }] });
    await up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Write src/mail.ts", kind: "edit", status: "pending",
               rawInput: { file_path: `${process.cwd()}/src/mail.ts`, content: "import { Postmark } from 'postmark';" }, locations: [{ path: `${process.cwd()}/src/mail.ts` }] });
    const perm = await conn.requestPermission({ sessionId: sid, toolCall: { toolCallId: "t1", title: "Write src/mail.ts" },
      options: [{ optionId: "rej", name: "Reject", kind: "reject_once" }, { optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }] });
    record("permission", perm);
    await conn.writeTextFile({ sessionId: sid, path: `${process.cwd()}/src/mail.ts`, content: "import { Postmark } from 'postmark';\n" });
    const back = await conn.readTextFile({ sessionId: sid, path: `${process.cwd()}/src/mail.ts` });
    record("readBack", back.content);
    await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    const term = await conn.createTerminal({ sessionId: sid, command: "echo", args: ["built ok"] });
    const exit = await term.waitForExit();
    const out = await term.currentOutput();
    record("terminal", { exit, output: out.output });
    await term.release();
    await up({ sessionUpdate: "tool_call", toolCallId: "t2", title: "npm run build", kind: "execute", status: "completed", rawInput: { command: "npm run build" } });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: I used Postmark " } });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "for the emails." } });
    return { stopReason: "end_turn" };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
