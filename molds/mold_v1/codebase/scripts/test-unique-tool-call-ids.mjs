// Tool-call ids must be unique for the life of a conversation, whatever the model mints.
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-unique-tool-call-ids.mjs [--live]
import assert from "node:assert/strict";
import { needsRewrite, mintToolCallId, uniqueToolCallIds } from "../agent/lib/unique-tool-call-ids.ts";

for (const id of ["functions.lodr_filings:0", "functions.eve:subagent:lodr-filings:12", "call_0", "tool-2", "0", "", undefined, "abc"]) {
  assert.equal(needsRewrite(id), true, `counter-style or weak id must be rewritten: ${id}`);
}
for (const id of ["call_eab8da43c5374e1aad39531d", "toolu_01AXa8WTdEZiU7utWhk7g5Fe", "chatcmpl-tool-9f8e7d6c5b4a39281706f5e4"]) {
  assert.equal(needsRewrite(id), false, `a random provider id passes through: ${id}`);
}
const a = mintToolCallId(), b = mintToolCallId();
assert.match(a, /^call_[0-9a-f]{24}$/); assert.notEqual(a, b); assert.equal(needsRewrite(a), false, "what we mint is never rewritten again");

// generate: two calls with the SAME counter id in one response stay distinct from another response's
const gen = (ids) => uniqueToolCallIds.wrapGenerate({ doGenerate: async () => ({ content: ids.map((toolCallId) => ({ type: "tool-call", toolCallId, toolName: "t", input: "{}" })).concat([{ type: "text", text: "hi" }]) }) });
const r1 = await gen(["functions.t:0", "functions.t:1"]), r2 = await gen(["functions.t:0"]);
const ids1 = r1.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId), ids2 = r2.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId);
assert.equal(new Set([...ids1, ...ids2]).size, 3, "the restarted counter no longer collides");
assert.equal(r1.content.at(-1).text, "hi", "other parts are untouched");

// stream: start / delta / end / tool-call of ONE call share one rewritten id
const parts = [{ type: "tool-input-start", id: "functions.t:0", toolName: "t" }, { type: "tool-input-delta", id: "functions.t:0", delta: "{}" },
  { type: "tool-input-end", id: "functions.t:0" }, { type: "tool-call", toolCallId: "functions.t:0", toolName: "t", input: "{}" }, { type: "text-delta", id: "x", delta: "ok" }];
const s = await uniqueToolCallIds.wrapStream({ doStream: async () => ({ stream: new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }) }) });
const out = []; for await (const p of s.stream) out.push(p);
const callIds = new Set([out[0].id, out[1].id, out[2].id, out[3].toolCallId]);
assert.equal(callIds.size, 1, "one call, one id across its stream parts"); assert.match(out[3].toolCallId, /^call_[0-9a-f]{24}$/);
assert.equal(out[4].id, "x", "a text part's id is not a tool-call id and is left alone");
console.log("test-unique-tool-call-ids: all assertions passed");

if (process.argv.includes("--live")) {
  const { generateText, streamText, tool, stepCountIs } = await import("ai");
  const { z } = await import("zod");
  process.env.MODEL_PROVIDER = "cloudflare"; process.env.CLOUDFLARE_MODEL_ORCHESTRATOR = "@cf/moonshotai/kimi-k2.6";
  const { agentModel } = await import("../agent/lib/model.ts");
  const tools = { lodr_filings: tool({ description: "Delegate to the LODR filings specialist.", inputSchema: z.object({ message: z.string() }), execute: async () => "filed 2 documents" }) };
  const seen = [];
  for (const mode of ["generate", "stream"]) {
    const args = { model: agentModel("orchestrator"), tools, stopWhen: stepCountIs(3), prompt: "Use lodr_filings to get the latest filings for Can Fin Homes, then tell me what it returned." };
    const res = mode === "generate" ? await generateText(args) : await (async () => { const r = streamText(args); await r.consumeStream(); return { steps: await r.steps, text: await r.text }; })();
    const ids = res.steps.flatMap((st) => st.toolCalls.map((c) => c.toolCallId)); seen.push(...ids);
    console.log(`live ${mode}: tool ids ${JSON.stringify(ids)} | tool results ${res.steps.flatMap((st) => st.toolResults).length} | answered: ${Boolean(res.text)}`);
    assert.ok(ids.length > 0 && ids.every((id) => /^call_[0-9a-f]{24}$/.test(id)), "Kimi's counter ids were rewritten");
    assert.ok(res.text, "the model finished its answer after the tool result came back under the rewritten id");
  }
  assert.equal(new Set(seen).size, seen.length, "no id repeats across the two fresh conversations");
  console.log("live: passed");
}
