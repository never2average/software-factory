/**
 * WHAT EVE'S COMPACTION KEEPS, with the patch (mold_v1-220) — the pure helpers of
 * scripts/eve-patch/files/harness/compaction-fidelity.js, as installed in node_modules/eve, and eve's own
 * createCompactionPrompt / compactMessages calling them. No model, no network: the summariser is a stub that echoes
 * the prompt it was given, which is exactly what the assertions are about.
 *
 *   1. The summariser reads tool calls and tool results IN FULL (eve showed 280 characters, and a tool result as
 *      `object(type=json, value=object(3 keys))`), and only over the budget are the largest parts shortened, first.
 *   2. The messages kept after the summary keep their tool calls and results as complete pairs; a result whose call
 *      is summarised goes into the summary with it.
 *   3. The kept window is at most a quarter of the threshold.
 *   4. The main agent's settings are untouched: agent/lib/compaction-threshold.ts gives the main agent eve's own
 *      threshold by default, a specialist the profile's 160,000, and holds every value to 90% of the window.
 *
 * Run:  npm run test:compaction-fidelity
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EVE = join(dirname(createRequire(import.meta.url).resolve("eve/package.json")), "dist/src/harness");
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`}`);
};

const fidelity = await import(pathToFileURL(join(EVE, "compaction-fidelity.js")).href).catch((e) => ({ missing: e }));
if (fidelity.missing) {
  console.log(`  FAIL node_modules/eve has no harness/compaction-fidelity.js — eve is not carrying the mold_v1-220 patch (npm ci)\n         ${fidelity.missing.message}`);
  process.exit(1);
}
const { compactionTranscriptMessages, keepRecentMessages, splitKeepingToolPairs, waterFillCap, compactionTranscriptBudgetChars, compactionRecentReserve } = fidelity;

/* ---- a specialist's history: the delegated message, three page reads, its own note ----------------------------- */
const page = (n) => `${"filler line of the filing.\n".repeat(400)}FACT-${n}=${String(n).repeat(8).slice(0, 8)} at the end of page ${n}\n`;
const call = (id, offset) => ({ role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "tool-call", toolCallId: id, toolName: "dataroom_read", input: { path: "Reports/filing.md", offset } }] });
const result = (id, n) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "dataroom_read", output: { type: "json", value: { path: "Reports/filing.md", content: page(n), offset: (n - 1) * 1000, nextOffset: n * 1000, totalChars: 9000 } } }] });
const history = [
  { role: "user", content: 'You are the subagent "reader". Read the filing and report every fact.' },
  call("c1", 0), result("c1", 1),
  call("c2", 1000), result("c2", 2),
  { role: "assistant", content: [{ type: "text", text: "Pages 1-2 read; two facts so far." }, { type: "tool-call", toolCallId: "c3", toolName: "dataroom_read", input: { path: "Reports/filing.md", offset: 2000 } }] },
  result("c3", 3),
];

console.log("1. the summariser reads every part in full:");
{
  const t = compactionTranscriptMessages(history, 1_000_000);
  const text = t.map((m) => m.content).join("\n");
  for (const n of [1, 2, 3]) check(`page ${n}'s fact, at the END of a ${page(n).length}-character result, reaches the summariser`, text.includes(`FACT-${n}=`), text.slice(0, 200));
  check("a tool call is shown with its input", text.includes('Called dataroom_read with {"path":"Reports/filing.md","offset":1000}'));
  check("a tool result is shown as its JSON (nextOffset included)", text.includes('"nextOffset":2000'));
  check("reasoning is not shown (as eve)", !text.includes("thinking"));
  const { createCompactionPrompt } = await import(pathToFileURL(join(EVE, "compaction-prompt.js")).href);
  const withBudget = createCompactionPrompt({ messages: history, previousCheckpoint: undefined, budgetChars: 1_000_000 }).prompt;
  const asShipped = createCompactionPrompt({ messages: history, previousCheckpoint: undefined }).prompt;
  check("eve's createCompactionPrompt uses it when given a budget", withBudget.includes("FACT-3="));
  check("…and without one is eve's 280-character digest, unchanged (the fact is not in it)", !asShipped.includes("FACT-3=") && asShipped.includes("object("), asShipped.slice(0, 400));
}

console.log("\n   over the budget, the largest parts are shortened first, never a short one:");
{
  check("water-fill: under the budget, nothing is cut", waterFillCap([10, 20, 30], 60) === Infinity);
  check("water-fill: the level leaves short parts whole", waterFillCap([10, 20, 1000, 1000], 1030) === 500, waterFillCap([10, 20, 1000, 1000], 1030));
  check("water-fill: never below eve's 280", waterFillCap([5000, 5000], 100) === 280);
  const small = { role: "user", content: "short instruction that must survive" };
  const t = compactionTranscriptMessages([small, ...history], 6_000);
  const text = t.map((m) => m.content).join("\n");
  check("the short message is whole", text.includes("short instruction that must survive"));
  check("a long result says how much is not shown", /more characters not shown/.test(text));
  check("the whole transcript keeps to about the budget", text.length < 6_000 + 2_000, text.length);
  check("the budget is at least 4 characters per threshold token (eve's own estimate)", compactionTranscriptBudgetChars({ threshold: 160_000 }, []) === 640_000);
  check("…and never less than the summarised messages' own size", compactionTranscriptBudgetChars({ threshold: 1_000 }, history) === JSON.stringify(history).length);
}

console.log("\n2. the kept messages keep complete tool pairs:");
{
  const kept = keepRecentMessages(history.slice(3));
  const calls = kept.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "tool-call") : []));
  const results = kept.flatMap((m) => (m.role === "tool" ? m.content : []));
  check("both kept calls are there, with their results", calls.map((c) => c.toolCallId).join() === "c2,c3" && results.map((r) => r.toolCallId).join() === "c2,c3", kept);
  check("the assistant's own text is kept beside its call", kept.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "text" && p.text.startsWith("Pages 1-2"))));
  check("reasoning is dropped (as eve)", !JSON.stringify(kept).includes("thinking"));
  const orphan = keepRecentMessages([result("c1", 1), call("c9", 5)]);
  check("a result with no kept call, and a call with no result, are dropped (as eve)", orphan.length === 0, orphan);
  const split = splitKeepingToolPairs(history, 4);
  check("a window that would start on a result starts after it: the result is summarised with its call", split.recent[0].role !== "tool" && split.older.at(-1).role === "tool", split.recent.map((m) => m.role));
  check("a window of 0 summarises everything", splitKeepingToolPairs(history, 0).recent.length === 0);
}

console.log("\n   eve's compactMessages, end to end (the summariser echoes its prompt):");
{
  const { compactMessages } = await import(pathToFileURL(join(EVE, "compaction.js")).href);
  const { MockLanguageModelV3 } = await import("ai/test").catch(() => ({}));
  if (!MockLanguageModelV3) {
    check("ai/test's MockLanguageModelV3 is available", false);
  } else {
    let prompt = "";
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompt = options.prompt.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""))).join("\n");
        const facts = [...prompt.matchAll(/FACT-\d+=\d+/g)].map((m) => m[0]);
        return { content: [{ type: "text", text: `SUMMARY ${[...new Set(facts)].join(" ")}` }], finishReason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } }, warnings: [] };
      },
    });
    // Compaction fires when the session is just past its threshold: here the history is ~10% over it.
    const config = { recentWindowSize: 10, threshold: Math.floor(JSON.stringify(history).length / 4 / 1.1) };
    const out = await compactMessages(history, model, config, undefined, undefined, undefined, undefined);
    const all = JSON.stringify(out);
    check("every fact survives: in the summary, or in a kept tool result", [1, 2, 3].every((n) => all.includes(`FACT-${n}=`)), all.slice(0, 600));
    check("the summary was written from the full results", /FACT-1=/.test(prompt));
    const keptChars = JSON.stringify(out.slice(2)).length / 4;
    check(`the kept window is at most a quarter of the threshold (${Math.round(keptChars)} <= ${config.threshold / 4} tokens)`, keptChars <= config.threshold / 4 + 1, keptChars);
    check("the reserve is three quarters of the threshold", compactionRecentReserve({ threshold: 160_000 }) === 120_000);
    const pairs = out.filter((m) => m.role === "tool").every((t) => t.content.every((r) => out.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call" && p.toolCallId === r.toolCallId))));
    check("every kept tool result has its call", pairs);
  }
}

console.log("\n4. the thresholds: main agent unchanged, specialists at the profile's value:");
{
  const { agentCompaction, compactAtTokens } = await import(pathToFileURL(join(ROOT, "agent/lib/compaction-threshold.ts")).href);
  const settings = { orchestrator_tokens: null, specialist_tokens: 160_000, specialists: { slow: 400_000, plain: null } };
  const W = 1_310_720;
  check("the main agent: eve's own (undefined)", agentCompaction("orchestrator", undefined, W, {}, settings) === undefined);
  const s = agentCompaction("specialist", "reader", W, {}, settings);
  check("a specialist: 160,000 tokens of a 1,310,720 window", s !== undefined && Math.floor(W * s.thresholdPercent) === 160_000, s);
  check("one specialist's own value wins", Math.floor(W * agentCompaction("specialist", "slow", W, {}, settings).thresholdPercent) === 400_000);
  check("one specialist set to null: eve's own", agentCompaction("specialist", "plain", W, {}, settings) === undefined);
  check("held to 90% of a small window (262,144 x 0.9 < 400,000): eve's own", agentCompaction("specialist", "slow", 262_144, {}, settings) === undefined);
  check("no window known (gateway mode): eve's own", agentCompaction("specialist", "reader", undefined, {}, settings) === undefined);
  check("MODEL_COMPACT_AT_TOKENS_SPECIALIST overrides", compactAtTokens("specialist", "reader", { MODEL_COMPACT_AT_TOKENS_SPECIALIST: "200000" }, settings) === 200_000);
  check("…\"off\" is eve's own", compactAtTokens("specialist", "reader", { MODEL_COMPACT_AT_TOKENS_SPECIALIST: "off" }, settings) === null);
  const warn = console.warn;
  console.warn = () => {};
  check("…a value under 32,000 is ignored, the profile's used", compactAtTokens("specialist", "reader", { MODEL_COMPACT_AT_TOKENS_SPECIALIST: "500" }, settings) === 160_000);
  console.warn = warn;
  check("MODEL_COMPACT_AT_TOKENS_ORCHESTRATOR gives the main agent one", compactAtTokens("orchestrator", undefined, { MODEL_COMPACT_AT_TOKENS_ORCHESTRATOR: "300000" }, settings) === 300_000);
}

console.log(`\ntest-compaction-fidelity: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
