// Scripted fake LLM endpoint (OpenAI chat/responses, Anthropic messages, Gemini generateContent) for capturing
// real harness event streams without API spend. Turn 1: call the shell tool with `npm install left-pad`.
// Turn 2 (a tool result is present): reply with FINAL_TEXT. Requests without tools get a short plain reply.
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 18080);
const CMD = process.env.MOCK_CMD ?? "npm install left-pad --no-audit --no-fund";
const FINAL_TEXT = process.env.MOCK_FINAL ?? "Installed left-pad with npm. Done.";
const LOG = process.env.MOCK_LOG ?? "/tmp/app-mock-llm.log";

const SHELL_NAMES = ["bash", "shell", "run_shell_command", "execute_command", "execute", "run_command", "exec_command",
  "run_terminal_cmd", "terminal", "command", "exec", "run_in_terminal", "powershell"];

function pickShell(tools) {
  const norm = (tools ?? []).map((t) => {
    const fn = t.function ?? t; // openai chat: {type, function:{name, parameters}}; responses/anthropic: {name, parameters|input_schema}
    return { name: fn.name, schema: fn.parameters ?? fn.input_schema ?? fn.parametersJsonSchema ?? {} };
  }).filter((t) => t.name);
  let best = null;
  for (const n of SHELL_NAMES) { best = norm.find((t) => t.name.toLowerCase() === n); if (best) break; }
  if (!best) best = norm.find((t) => /bash|shell|command|terminal|exec/i.test(t.name));
  if (!best) return null;
  const props = best.schema?.properties ?? {};
  const key = ["command", "cmd", "commands", "script", "input"].find((k) => k in props) ?? Object.keys(props)[0] ?? "command";
  const args = { [key]: props[key]?.type === "array" ? [CMD] : CMD };
  for (const [k, v] of Object.entries(props)) {
    if (k === key || !(best.schema.required ?? []).includes(k)) continue;
    // fill other required fields with harmless defaults
    args[k] = v.type === "boolean" ? false : v.type === "number" || v.type === "integer" ? 120000 : v.type === "array" ? [] : k.toLowerCase().includes("desc") ? "Install left-pad" : ".";
  }
  return { name: best.name, args };
}

function hasToolResult(body) {
  const s = JSON.stringify(body.messages ?? body.input ?? body.contents ?? []);
  return /"role":"tool"|"type":"tool_result"|"functionResponse"|"function_call_output"/.test(s);
}

let n = 0;
const id = () => `mock_${Date.now().toString(36)}_${n++}`;

function decide(body, toolsKey = "tools") {
  const tools = body[toolsKey];
  const flatTools = Array.isArray(tools) && tools.some((t) => t.functionDeclarations)
    ? tools.flatMap((t) => t.functionDeclarations ?? []) : tools;
  if (!flatTools?.length || hasToolResult(body)) return { text: flatTools?.length ? FINAL_TEXT : "ok" };
  const call = pickShell(flatTools);
  return call ? { call } : { text: FINAL_TEXT };
}

const sse = (res) => { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); return (ev, data) => res.write((ev ? `event: ${ev}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`); };
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

function openaiChat(body, res) {
  const d = decide(body); const cid = id(); const model = body.model ?? "mock";
  const msg = d.call
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_" + cid, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }] }
    : { role: "assistant", content: d.text };
  const finish = d.call ? "tool_calls" : "stop";
  if (!body.stream) return json(res, { id: cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage });
  const w = sse(res); const base = { id: cid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  w(null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (d.call) w(null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_" + cid, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }] }, finish_reason: null }] });
  else w(null, { ...base, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] });
  w(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
  w(null, "[DONE]"); res.end();
}

function openaiResponses(body, res) {
  const d = decide(body); const rid = "resp_" + id(); const model = body.model ?? "mock";
  const item = d.call
    ? { type: "function_call", id: "fc_" + rid, call_id: "call_" + rid, name: d.call.name, arguments: JSON.stringify(d.call.args), status: "completed" }
    : { type: "message", id: "msg_" + rid, role: "assistant", status: "completed", content: [{ type: "output_text", text: d.text, annotations: [] }] };
  const resp = { id: rid, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  if (!body.stream) return json(res, resp);
  const w = sse(res);
  w("response.created", { type: "response.created", response: { ...resp, status: "in_progress", output: [] } });
  w("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(item.content ? { content: [] } : { arguments: "" }) } });
  if (d.call) {
    w("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
    w("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    w("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    w("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: d.text });
    w("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: d.text });
    w("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  w("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
  w("response.completed", { type: "response.completed", response: resp });
  res.end();
}

function anthropic(body, res) {
  const d = decide(body); const mid = "msg_" + id(); const model = body.model ?? "mock";
  const block = d.call ? { type: "tool_use", id: "toolu_" + mid, name: d.call.name, input: d.call.args } : { type: "text", text: d.text };
  const stop = d.call ? "tool_use" : "end_turn";
  const u = { input_tokens: 100, output_tokens: 20 };
  if (!body.stream) return json(res, { id: mid, type: "message", role: "assistant", model, content: [block], stop_reason: stop, stop_sequence: null, usage: u });
  const w = sse(res);
  w("message_start", { type: "message_start", message: { id: mid, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  w("content_block_start", { type: "content_block_start", index: 0, content_block: d.call ? { type: "tool_use", id: block.id, name: block.name, input: {} } : { type: "text", text: "" } });
  w("content_block_delta", { type: "content_block_delta", index: 0, delta: d.call ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: d.text } });
  w("content_block_stop", { type: "content_block_stop", index: 0 });
  w("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  w("message_stop", { type: "message_stop" });
  res.end();
}

function gemini(body, res, stream) {
  const d = decide(body);
  const part = d.call ? { functionCall: { name: d.call.name, args: d.call.args } } : { text: d.text };
  const out = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }, modelVersion: "mock" };
  if (!stream) return json(res, out);
  const w = sse(res); w(null, out); res.end();
}

function json(res, obj, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c)).on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const u = req.url ?? "";
    appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u} tools=${(body.tools ?? []).length} stream=${!!body.stream}\n`);
    try {
      if (req.method === "GET" && /\/models\/?(\?|$)/.test(u)) return json(res, { object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] });
      if (u.includes("/chat/completions")) return openaiChat(body, res);
      if (u.includes("/responses")) return openaiResponses(body, res);
      if (u.includes("/messages/count_tokens")) return json(res, { input_tokens: 100 });
      if (u.includes("/messages")) return anthropic(body, res);
      if (u.includes(":streamGenerateContent")) return gemini(body, res, true);
      if (u.includes(":generateContent")) return gemini(body, res, false);
      if (u.includes(":countTokens")) return json(res, { totalTokens: 100 });
      json(res, { error: { message: "mock: unknown route " + u } }, 404);
    } catch (e) { json(res, { error: { message: String(e) } }, 500); }
  });
}).listen(PORT, "0.0.0.0", () => console.log("mock llm on", PORT));
