/**
 * "The chat died with 'Empty model response' and nothing recorded why."
 *
 * THE DEFECT, measured on the live deployment on 2026-09-23. A person uploaded a
 * pdf and asked for KPIs. The sandbox fetched it and `pdfplumber` returned real
 * page text. About three bash calls later:
 *
 *     step.failed / turn.failed   MODEL_CALL_FAILED   "Empty model response"
 *     [eve:harness.tool-loop] empty model response; reissuing the model call once
 *
 * twice, then the turn ended. Every attempt, the same depth, two separate
 * sessions. The pdf HAD been read and that work went with the turn; the person
 * saw a chat that simply stopped. `automation_audit` recorded nothing at all,
 * because every chat telemetry kind that existed is emitted by the BROWSER.
 *
 * This runs the two halves of the fix against a model that really answers empty:
 *
 *   SURVIVE     agent/lib/empty-model-response.ts — one same-model retry, then
 *               the other role's model, then a sentence the person can read. The
 *               person always gets something.
 *   DIAGNOSE    the record that comes out of it: finish reason (unified AND
 *               raw), prompt/completion/REASONING tokens, whether any tool call
 *               came back, message and tool counts, request bytes, model id, and
 *               THE OUTPUT CAP IN FORCE AND WHAT IT WAS — with nothing from the
 *               prompt, the document or a tool argument anywhere in it.
 *
 * THE OUTPUT CAP is the hypothesis this exists to settle. `max_tokens: 256` is
 * the only way anybody reproduced the failure by hand (`finish_reason: "length"`,
 * empty content, 256 completion tokens burned by a reasoning model). Section 6
 * drives the REAL provider construction (`agentModel`) at
 * scripts/fake-model-server.mjs and asserts on the request that actually
 * arrived — not on what the source says it sends.
 *
 * Offline: no provider, no network beyond 127.0.0.1, no database, no spend.
 *
 * Run:  npm run test:empty-model-response
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  NUDGE_NO_TOOL_RESULTS,
  LAST_RESORT_SENTENCE,
  SAME_MODEL_RETRIES,
  buildNudgedParams,
  createEmptyResponseRecovery,
  describeModelCall,
  formatEmptyResponseDetail,
  kindForRecord,
  planRecovery,
  summarizeGenerateResult,
} from "../agent/lib/empty-model-response.ts";
import { CHAT_TELEMETRY_KINDS, chatSessionTag, chatTelemetrySentence } from "../lib/chat-telemetry.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/* ── the shapes the AI SDK really hands a middleware ─────────────────────── */

const usage = ({ prompt = 8213, completion = 256, reasoning = 256 } = {}) => ({
  inputTokens: { total: prompt, noCache: prompt, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: completion, text: completion - reasoning, reasoning },
});
const finish = (unified, raw) => ({ unified, raw });

/** A response with reasoning and nothing else — the measured failure. */
const emptyGenerate = () => ({
  content: [{ type: "reasoning", text: "…" }],
  finishReason: finish("length", "length"),
  usage: usage(),
  warnings: [],
});
const answerGenerate = (text) => ({
  content: [{ type: "text", text }],
  finishReason: finish("stop", "stop"),
  usage: usage({ completion: 40, reasoning: 10 }),
  warnings: [],
});

const streamOf = (parts) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
const emptyStream = () => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "thinking…" },
    { type: "reasoning-end", id: "r" },
    { type: "finish", finishReason: finish("length", "length"), usage: usage() },
  ]),
});
const answerStream = (text) => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: finish("stop", "stop"), usage: usage({ completion: 40, reasoning: 10 }) },
  ]),
});

const CANARY_PROMPT = "REVENUE-GREW-TO-4831-CRORE-IN-FY26";
const CANARY_TOOL = "CANARY-TOOL-DESCRIPTION-SECRET";
const params = ({ cap, image = false, tools = 59 } = {}) => ({
  prompt: [
    { role: "system", content: `You are the agent. ${CANARY_PROMPT}` },
    {
      role: "user",
      content: image
        ? [{ type: "file", mediaType: "image/png", data: "AAAA" }]
        : [{ type: "text", text: CANARY_PROMPT }],
    },
  ],
  tools: Array.from({ length: tools }, (_, i) => ({
    type: "function",
    name: `tool_${i}`,
    description: CANARY_TOOL,
    inputSchema: { type: "object" },
  })),
  ...(cap === undefined ? {} : { maxOutputTokens: cap }),
});

/** The real middleware, with the delays and the id generator made boring. */
function harness({ fallback = { id: "@cf/zai-org/glm-5.3" }, modelId = "@cf/moonshotai/kimi-k2.6" } = {}) {
  const log = { records: [], slept: [], fallbackCalls: 0, reissues: [], fallbackParams: [] };
  let n = 0;
  const middleware = createEmptyResponseRecovery({
    modelId: () => modelId,
    fallback: () =>
      fallback === null
        ? null
        : {
            id: fallback.id,
            model: {
              async doGenerate(p) {
                log.fallbackCalls++;
                log.fallbackParams.push(p);
                return fallback.answers ? answerGenerate("the specialist finished it") : emptyGenerate();
              },
              async doStream(p) {
                log.fallbackCalls++;
                log.fallbackParams.push(p);
                return fallback.answers ? answerStream("the specialist finished it") : emptyStream();
              },
            },
          },
    publish: (record) => log.records.push(record),
    sleep: async (ms) => log.slept.push(ms),
    newId: () => `rec_${++n}`,
  });
  return { middleware, log };
}

/**
 * The raw model the middleware is wrapped around — where a REISSUE goes.
 * `doStream()`/`doGenerate()` from the middleware options can only repeat the
 * identical request, so the retry calls this instead and the params it receives
 * are what the test inspects.
 */
function reissuer(log, answers) {
  let n = 0;
  return {
    async doStream(p) {
      log.reissues.push(p);
      return answers[n++] ? answerStream(answers[n - 1]) : emptyStream();
    },
    async doGenerate(p) {
      log.reissues.push(p);
      return answers[n++] ? answerGenerate(answers[n - 1]) : emptyGenerate();
    },
  };
}

const drain = async (result) => {
  const out = [];
  for await (const part of result.stream) out.push(part);
  return out;
};
const textOf = (parts) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

/* ═══ 1. THE SHAPE READ OFF A REQUEST ════════════════════════════════════ */

console.log("What a request is allowed to tell us:");
{
  const capped = describeModelCall(params({ cap: 256 }));
  check("the output cap in force is read off the call, and its VALUE is kept", capped.outputCap === 256);
  check(
    "an uncapped call is 'none', not 0 — the difference the hypothesis turns on",
    describeModelCall(params({})).outputCap === null,
  );
  check("the tool count is the advertised definitions (59 on this deployment)", capped.tools === 59);
  check("the message count is messages, not bytes", capped.messages === 2);
  check("the request's approximate size is recorded", capped.approxBytes > 1000);
  check("a text-only request carries no image", capped.hasImageInput === false);
  check("an image part is seen", describeModelCall(params({ image: true })).hasImageInput === true);
  check(
    "a prompt that cannot be serialized still yields a record",
    (() => {
      const cyclic = params({});
      cyclic.prompt.push({ role: "user", content: [] });
      cyclic.prompt.at(-1).content.push(cyclic.prompt.at(-1));
      return describeModelCall(cyclic).approxBytes === -1;
    })(),
  );
}

console.log("\nWhat a response is allowed to tell us:");
{
  const outcome = summarizeGenerateResult(emptyGenerate());
  check("reasoning-only is EMPTY — eve's own rule, one layer down", outcome.empty === true);
  check("the unified and the RAW finish reason are both kept", outcome.finishReason === "length" && outcome.finishReasonRaw === "length");
  check("prompt and completion tokens come off the nested provider usage", outcome.promptTokens === 8213 && outcome.completionTokens === 256);
  check(
    "the reasoning tokens are broken out — 'it spent the budget thinking' in one number",
    outcome.reasoningTokens === 256,
  );
  check("no tool call came back", outcome.hadToolCalls === false);
  check("a real answer is not empty", summarizeGenerateResult(answerGenerate("hi")).empty === false);
  check(
    "whitespace is not an answer",
    summarizeGenerateResult({ content: [{ type: "text", text: "   " }], usage: usage(), finishReason: finish("stop") }).empty === true,
  );
  check(
    "a tool call with no text is NOT empty — the model did something",
    summarizeGenerateResult({
      content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: "{}" }],
      usage: usage(),
      finishReason: finish("tool-calls"),
    }).empty === false,
  );
}

/* ═══ 2. THE LADDER ══════════════════════════════════════════════════════ */

console.log("\nWhat happens after an empty answer:");
{
  const shape = describeModelCall(params({}));
  const vision = describeModelCall(params({ image: true }));
  check("the first empty buys exactly one same-model retry", SAME_MODEL_RETRIES === 1);
  // The outcome is part of the plan since the output budget landed: an answer that
  // ran out of room (`length`) is retried with MORE room, because the same call at
  // the same ceiling cannot succeed. The budget's own rules are in
  // scripts/test-model-output-budget.mjs; here it is only passed so the ladder's
  // shape is judged on a real outcome rather than on an absent one.
  const ranOut = summarizeGenerateResult(emptyGenerate());
  const plan = (over) => planRecovery({ attempt: 1, shape, outcome: ranOut, fallbackAvailable: true, fallbackUsed: false, ...over });
  check("attempt 1 retries the same model", plan({}).action === "retry");
  check(
    "attempt 2 changes the model — a deterministic failure is not fixed by repeating it",
    plan({ attempt: 2 }).action === "fallback",
  );
  check(
    "the ladder is a ladder, not a loop: a fallback that is also empty ends it",
    plan({ attempt: 3, fallbackUsed: true }).action === "explain" &&
      plan({ attempt: 3, fallbackUsed: true }).reason === "fallback-also-empty",
  );
  check(
    "a turn carrying an image NEVER falls back to the text-only model",
    plan({ attempt: 2, shape: vision }).action === "explain" && plan({ attempt: 2, shape: vision }).reason === "vision-required",
  );
  check(
    "with no second model configured, the person gets the sentence rather than a fourth identical call",
    plan({ attempt: 2, fallbackAvailable: false }).reason === "no-fallback-configured",
  );
  check("the retry waits, but not long enough to look like a hang", plan({}).delayMs <= 1000);
  {
    const original = params({});
    const nudged = buildNudgedParams(original);
    check("the nudge is appended as a trailing user note", JSON.stringify(nudged.prompt.at(-1)).includes(NUDGE_NO_TOOL_RESULTS));
    check("…on a copy, so nothing the person never said enters the conversation", original.prompt.length === 2);
    check("…and every other call setting is carried over unchanged", nudged.tools === original.tools);
  }
}

/* ═══ 3. THE STREAMED PATH — what the person actually sees ═══════════════ */

console.log("\nThe streamed chat survives it:");
{
  // Every attempt empty, and a fallback that is also empty: the worst case.
  const { middleware, log } = harness({ fallback: { id: "@cf/zai-org/glm-5.3", answers: false } });
  let calls = 0;
  const firstParams = params({});
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => {
        calls++;
        return emptyStream();
      },
      doGenerate: async () => emptyGenerate(),
      params: firstParams,
      model: reissuer(log, []),
    }),
  );
  check("the person is told what happened instead of watching a chat stop", textOf(out) === LAST_RESORT_SENTENCE);
  check("…and the sentence promises the work is not lost", /Nothing is lost/.test(LAST_RESORT_SENTENCE));
  check("…and says nothing about models, tokens or empty responses", !/model|token|empty/i.test(LAST_RESORT_SENTENCE));
  check("the stream still finishes, so eve completes the turn rather than parking it", out.at(-1).type === "finish" && out.at(-1).finishReason.unified === "stop");
  check("the same model was asked exactly twice (first + one retry)", calls + log.reissues.length === 2);
  check(
    "the retry is NOT an identical request — it carries the nudge eve only ever used after the turn died",
    log.reissues.length === 1 && JSON.stringify(log.reissues[0].prompt).includes(NUDGE_NO_TOOL_RESULTS),
  );
  check("…which is never written into the conversation itself", !JSON.stringify(firstParams).includes(NUDGE_NO_TOOL_RESULTS));
  check(
    "the fallback model is NOT told its previous reply was empty — it has not replied yet",
    log.fallbackParams.length === 1 && !JSON.stringify(log.fallbackParams[0].prompt).includes(NUDGE_NO_TOOL_RESULTS),
  );
  check("the other role's model was asked once", log.fallbackCalls === 1);
  check("three empties were recorded, not one", log.records.length === 3);
  check(
    "each record says what it caused: retry, then fallback, then the sentence",
    log.records.map((r) => r.next).join(",") === "retry,fallback,explain",
  );
  check(
    "the record names the model that actually answered empty",
    log.records[2].modelId === "@cf/zai-org/glm-5.3" && log.records[0].modelId === "@cf/moonshotai/kimi-k2.6",
  );
  check("only the last one is filed as a give-up", log.records.map(kindForRecord).join(",") === "model-empty,model-empty,model-empty-gave-up");
  check("exactly one `stream-start` reaches the consumer", out.filter((p) => p.type === "stream-start").length === 1);
  check("no failed attempt's `finish` leaks out mid-turn", out.filter((p) => p.type === "finish").length === 1);
}
{
  // The ordinary case once the fix is live: a retry works.
  const { middleware, log } = harness();
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => emptyStream(),
      doGenerate: async () => emptyGenerate(),
      params: params({ cap: 256 }),
      model: reissuer(log, ["Revenue grew 18%."]),
    }),
  );
  check("a retry that works delivers the real answer", textOf(out) === "Revenue grew 18%.");
  check("…and the incident is still recorded, once", log.records.length === 1 && log.records[0].next === "retry");
  check("…carrying the cap that was in force", log.records[0].outputCap === 256);
  check("…and the fallback was never needed", log.fallbackCalls === 0);
}
{
  // The measured workflow: the pdf arrives as TEXT, so the text-only model can finish the job.
  const { middleware, log } = harness({ fallback: { id: "@cf/zai-org/glm-5.3", answers: true } });
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => emptyStream(),
      doGenerate: async () => emptyGenerate(),
      params: params({}),
      model: reissuer(log, []),
    }),
  );
  check("the text-only model finishes a turn the orchestrator would not", textOf(out) === "the specialist finished it");
  check("…after exactly two empties", log.records.length === 2);
}
{
  // Vision: falling back would answer a different question confidently.
  const { middleware, log } = harness({ fallback: { id: "@cf/zai-org/glm-5.3", answers: true } });
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => emptyStream(),
      doGenerate: async () => emptyGenerate(),
      params: params({ image: true }),
      model: reissuer(log, []),
    }),
  );
  check("a turn that needs to SEE is never handed to the text-only model", log.fallbackCalls === 0);
  check("…the person gets the sentence instead", textOf(out) === LAST_RESORT_SENTENCE);
  check("…and the row says why", log.records.at(-1).nextReason === "vision-required" && log.records.at(-1).hasImageInput === true);
}
{
  // A provider error is somebody else's failure.
  const { middleware, log } = harness();
  let calls = 0;
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => {
        calls++;
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "error", error: new Error("429 Too Many Requests") },
            { type: "finish", finishReason: finish("error", "error"), usage: usage({ completion: 0, reasoning: 0 }) },
          ]),
        };
      },
      doGenerate: async () => emptyGenerate(),
      params: params({}),
      model: reissuer(log, []),
    }),
  );
  check("a 429 is not retried three times behind an empty-response ladder", calls === 1 && log.records.length === 0);
  check("…and reaches eve as the error it is", out.some((p) => p.type === "error"));
}
{
  // The normal path must not pay for any of this.
  const { middleware, log } = harness();
  let calls = 0;
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => {
        calls++;
        return answerStream("hello");
      },
      doGenerate: async () => emptyGenerate(),
      params: params({}),
      model: reissuer(log, []),
    }),
  );
  check("a model that answers is called once and recorded never", calls === 1 && log.records.length === 0);
  check("…and its parts arrive unchanged", textOf(out) === "hello" && out[0].type === "stream-start" && out.at(-1).type === "finish");
}

/* ═══ 4. THE GENERATED PATH ══════════════════════════════════════════════ */

console.log("\nThe non-streamed path behaves the same:");
{
  const { middleware, log } = harness({ fallback: { id: "@cf/zai-org/glm-5.3", answers: true } });
  let calls = 0;
  const result = await middleware.wrapGenerate({
    doGenerate: async () => {
      calls++;
      return emptyGenerate();
    },
    doStream: async () => emptyStream(),
    params: params({}),
    model: reissuer(log, []),
  });
  check(
    "the same ladder runs: one nudged retry, then the other model",
    calls === 1 && log.reissues.length === 1 && log.fallbackCalls === 1,
  );
  check("…and the retry carries the nudge here too", JSON.stringify(log.reissues[0].prompt).includes(NUDGE_NO_TOOL_RESULTS));
  check("the answer comes back", result.content[0].text === "the specialist finished it");
  check("both empties are recorded as generate-path", log.records.every((r) => r.path === "generate"));
}
{
  const { middleware, log } = harness({ fallback: null });
  const result = await middleware.wrapGenerate({
    doGenerate: async () => emptyGenerate(),
    doStream: async () => emptyStream(),
    params: params({}),
    model: reissuer(log, []),
  });
  check("with nothing to fall back to, the caller still gets a sentence", result.content[0].text === LAST_RESORT_SENTENCE);
  check("…and a finish reason that completes rather than fails", result.finishReason.unified === "stop");
}

/* ═══ 5. THE RECORD — enough to name the cause, nothing a person wrote ═══ */

console.log("\nThe record:");
{
  const { middleware, log } = harness({ fallback: null });
  await drain(
    await middleware.wrapStream({
      doStream: async () => emptyStream(),
      doGenerate: async () => emptyGenerate(),
      params: params({ cap: 256 }),
      model: reissuer(log, []),
    }),
  );
  const record = log.records[0];
  const detail = formatEmptyResponseDetail(record);
  const sentence = `${chatTelemetrySentence(kindForRecord(record))} · attempt ${record.attempt} · ${detail}`;

  for (const [field, present] of [
    ["finish reason", /finish=length/],
    ["raw provider finish reason", /finish_raw=length/],
    ["prompt tokens", /in=8213/],
    ["completion tokens", /out=256/],
    ["reasoning tokens", /out_thinking=256/],
    ["whether any tool call came back", /toolcalls=no/],
    ["the message count", /msgs=2/],
    ["the tool count", /tools=59/],
    ["the request's byte size", /bytes=\d+/],
    ["THE OUTPUT CAP AND ITS VALUE", /cap=256/],
    ["the model id", /model=@cf\/moonshotai\/kimi-k2\.6/],
    ["what it caused next", /next=retry/],
  ]) {
    check(`the row carries ${field}`, present.test(detail));
  }
  check(
    "an uncapped call reads as cap=none, which is what kills the hypothesis",
    /cap=none/.test(formatEmptyResponseDetail({ ...record, outputCap: null })),
  );

  const serialized = JSON.stringify(record) + detail + sentence;
  check("no prompt text reaches the record", !serialized.includes(CANARY_PROMPT));
  check("no tool description or argument reaches the record", !serialized.includes(CANARY_TOOL));
  check("no message content of any kind is stored", !/content/i.test(JSON.stringify(record)));
  check("the detail fits the 400 characters the telemetry route accepts", detail.length <= 400);
  check(
    "a withheld answer (not empty, but claiming a write no tool made) files under its own kind and says so",
    kindForRecord({ ...record, rejected: "unbacked-claim" }) === "model-unbacked-claim" &&
      /rejected=unbacked-claim/.test(formatEmptyResponseDetail({ ...record, rejected: "unbacked-claim" })),
  );
  check("an empty one carries no rejection on its row", record.rejected === null && !/rejected=/.test(detail));
  check("the sentence opens with something a human can act on", sentence.startsWith("Model returned an empty response"));
}

/* ═══ 6. THE KINDS REACH THE OPERATOR ═══════════════════════════════════ */

console.log("\nThe telemetry lands where an operator reads it:");
{
  // The route's OWN schema, from the route's own source constant. A kind the
  // route cannot describe is accepted, dropped, and looks exactly like a kind
  // that never fired — the trap that hid `resync` and `stop` for weeks.
  const schema = z.object({
    sessionId: z.string().max(200).optional(),
    kind: z.enum(CHAT_TELEMETRY_KINDS),
    detail: z.string().max(400).optional(),
  });
  for (const kind of ["model-empty", "model-empty-gave-up", "model-unbacked-claim"]) {
    check(`"${kind}" is a kind the route records rather than silently drops`, schema.safeParse({ kind }).success);
    check(`"${kind}" reads as a sentence`, chatTelemetrySentence(kind).length > 20);
  }
  check(
    "the session id is hashed by ONE function both deployments call",
    chatSessionTag("sess_abc", (v) => `${v}0000000000000000`).startsWith("chat_") &&
      !chatSessionTag("sess_abc", () => "deadbeefdeadbeefdeadbeef").includes("sess_abc"),
  );
  const route = src("app/api/ops/chat-telemetry/route.ts");
  check("the route no longer keeps its own copy of the hash", /chatSessionTag\(/.test(route));

  const log = src("agent/lib/empty-model-response-log.ts");
  check("the agent writes the row under automation_type 'chat', like the web surface", /automationType: "chat"/.test(log));
  check("…into the workspace's own RLS scope, via recordAudit", /recordAudit\(/.test(log));
  check(
    "…with a hashed session id, never the raw one",
    /chatSessionTag\(/.test(log) && /automationId: sessionId \? sessionTag\(sessionId\)/.test(log),
  );
  check("…and refuses to guess a workspace", /personal:unknown/.test(log));
  check(
    "the record travels on eve's per-step context, not a module-level queue that mixes sessions up",
    /defineState<[^>]*>\(/.test(log),
  );

  const hook = src("agent/hooks/empty-model-response.ts");
  check(
    "the recorder fires on step.completed too — a RECOVERED empty must not go quiet",
    /"step\.completed"/.test(hook) && /"step\.failed"/.test(hook) && /"turn\.failed"/.test(hook),
  );
}

/* ═══ 7. THE WIRING ═════════════════════════════════════════════════════ */

console.log("\nThe wiring:");
{
  const model = src("agent/lib/model.ts");
  check("agentModel installs the recovery", /createEmptyResponseRecovery\(/.test(model));
  check(
    "…INSIDE uniqueToolCallIds, so a fallback model's counter ids are rewritten too",
    /middleware: \[\s*uniqueToolCallIds,\s*createOutputBudget\([^\n]*\),\s*createEmptyResponseRecovery/.test(model),
  );
  check(
    "…and OUTSIDE the output budget, whose transformParams must have run before this middleware reads `cap`",
    model.indexOf("createOutputBudget({") < model.indexOf("createEmptyResponseRecovery({"),
  );
  check("…and the fallback is the other configured role", /agentModelId\(other\)/.test(model));
  {
    // No tool on the read-only allow-list may carry an approval policy: approval is how this codebase marks a
    // tool that changes something, so the two lists must never overlap.
    const { READ_ONLY_BASE_TOOLS } = await import("../agent/lib/read-only-tools.ts");
    const { readdirSync } = await import("node:fs");
    const gated = [];
    for (const f of readdirSync(new URL("../agent/lib/", import.meta.url)).filter((n) => n.endsWith(".ts"))) {
      const text = src(`agent/lib/${f}`);
      for (const m of text.matchAll(/modelFacing\(\s*"([a-z_]+)"/g)) {
        const next = text.indexOf("modelFacing(", (m.index ?? 0) + 12);
        if (/approval:/.test(text.slice(m.index, next < 0 ? undefined : next))) gated.push(m[1]);
      }
    }
    check(
      `no approval-gated tool is on the read-only allow-list (gated: ${gated.length})`,
      gated.length > 10 && READ_ONLY_BASE_TOOLS.every((n) => !gated.includes(n)),
    );
  }
  check(
    "the guard's evidence is an explicit READ-ONLY allow-list, not a registry filled at tool load",
    /from "\.\/read-only-tools\.ts"/.test(src("agent/lib/empty-model-response.ts")) && !/registerWriteTool/.test(src("agent/lib/model-facing/tools/model-facing.ts")),
  );
  check("…which is null when both roles are the same model", /if \(id === agentModelId\(role\)\) return null/.test(model));

  // THE HYPOTHESIS, SETTLED AND THEN CORRECTED. These three checks used to assert
  // the opposite — "nothing this repo authors caps output" — which was true of the
  // CHAT path and false of the one call that was failing: the live row says
  // `path=generate`, and only `read_image` generates. agent/lib/vision-tools.ts
  // set `maxOutputTokens: 1_500` itself, sized for the answer on a model that pays
  // for its thinking out of the same budget, and burned all 1,500 of it thinking.
  // So the absence is no longer the thing to protect; the SINGLE SOURCE is.
  const agent = src("agent/agent.ts");
  check("agent/agent.ts still sets no limits.* — a session budget parks a turn, it does not cap a call", !/limits\s*:/.test(agent));
  check(
    "agent/lib/model.ts now installs a per-role output budget rather than leaving the ceiling to whatever the provider picks today",
    /createOutputBudget\(/.test(model) && /modelOutputBudgetTokens/.test(model),
  );
  check(
    "…and the one call site that set its own number now asks for the same role budget",
    /maxOutputTokens: modelOutputBudgetTokens\("vision"\)/.test(src("agent/lib/vision-tools.ts")),
  );
  check(
    "…so nothing but agent/lib/model-output-budget.ts decides what the agent sends",
    !/maxOutputTokens:\s*\d/.test(src("agent/lib/vision-tools.ts")) && !/maxOutputTokens:\s*\d/.test(model),
  );
  check(
    "agent/instrumentation.ts contributes runtime context only, never call settings",
    !/maxOutputTokens/.test(src("agent/instrumentation.ts")),
  );
}

/* ═══ 8. THE WIRE — what max_tokens the whole stack really sends ════════ */

console.log("\nThe real provider path, against a model that answers empty:");
{
  const port = 8791;
  const server = spawn(
    process.execPath,
    ["scripts/fake-model-server.mjs", "--port", String(port), "--script", "empty-then-answer", "--empties", "1"],
    { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "ignore", "pipe"] },
  );
  server.stderr.on("data", () => {});
  try {
    // Wait for the listener rather than sleeping a guess.
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/__requests`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    process.env.MODEL_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.CLOUDFLARE_MODEL_ORCHESTRATOR = "@cf/moonshotai/kimi-k2.6";
    process.env.CLOUDFLARE_MODEL_SPECIALIST = "@cf/zai-org/glm-5.3";
    const { streamText } = await import("ai");
    const { agentModel } = await import("../agent/lib/model.ts");

    const run = streamText({ model: agentModel("orchestrator"), prompt: "What were the KPIs in the pdf?" });
    await run.consumeStream();
    const text = await run.text;
    check("the real provider path survives an empty answer and delivers one", text.length > 0);

    const requests = await (await fetch(`http://127.0.0.1:${port}/__requests`)).json();
    check("…by reissuing the call, not by giving up", requests.length >= 2);

    // THE HYPOTHESIS, settled at the wire — and then acted on. This assertion used
    // to read "nothing in the model path sets max_tokens", and it was TRUE: the
    // chat, which is what this section drives, left the ceiling to the provider.
    // That is no longer safe to leave alone, because an unchosen ceiling is exactly
    // what could not be diagnosed from a row. Every call now carries the role's
    // budget (agent/lib/model-output-budget.ts), and the RETRY after a `length`
    // failure carries twice it, because reissuing a call that ran out of room
    // inside the same room is a call that cannot succeed.
    const caps = requests.map((r) => ("max_tokens" in r && r.max_tokens !== null ? r.max_tokens : "absent"));
    check(
      `every call in the model path now carries a budget somebody chose (saw: ${caps.join(", ")})`,
      caps.every((cap) => typeof cap === "number" && cap > 0),
    );
    check(
      `…and the reissue after a "length" finish asks for more room than the call that ran out (saw: ${caps.join(", ")})`,
      caps.length >= 2 && caps[1] > caps[0],
    );
    check(
      `…and asks it to think less: the reissue carries reasoning_effort "low", the first call nothing (saw: ${requests.map((r) => r.reasoning_effort ?? "absent").join(", ")})`,
      requests[0].reasoning_effort === undefined && requests[1]?.reasoning_effort === "low",
    );
    check(
      "…and the model server can emit the capped failure when asked, so the shape is testable",
      /finish_reason: "length"/.test(src("scripts/fake-model-server.mjs")) &&
        /reasoning_tokens/.test(src("scripts/fake-model-server.mjs")),
    );
  } finally {
    server.kill("SIGKILL");
  }
}

console.log(`\n${passed} checks passed.`);
