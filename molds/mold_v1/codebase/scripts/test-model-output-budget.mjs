/**
 * "IT SPENT THE WHOLE BUDGET THINKING AND SAID NOTHING."
 *
 * THE DEFECT, measured on the live deployment on 2026-09-23. A turn was reading a
 * scanned pdf page. The row PR #51's telemetry wrote:
 *
 *     Model returned an empty response · attempt 1 ·
 *     model=@cf/moonshotai/kimi-k2.6  path=generate
 *     finish=length  finish_raw=length  in=2999  out=1500  out_thinking=1500
 *
 * `finish=length` with completion tokens == reasoning tokens == 1500: a reasoning
 * model handed an output budget sized for the ANSWER, which it spent entirely on
 * the THINKING that has to come first. eve reports that as MODEL_CALL_FAILED
 * "Empty model response". `path=generate` names the call — the chat streams, so
 * the only generator in the product is `read_image`, and
 * `agent/lib/vision-tools.ts` set `maxOutputTokens: 1_500` itself.
 *
 * PROBED DIRECTLY against Cloudflare with the deployment's own credentials:
 * the same model answers a simple question fine with NO cap (93–120 completion
 * tokens); `max_tokens: 256` reproduces the failure exactly; 8192 and 16384 are
 * accepted and answer normally. Switching models is not available on this
 * account (llama-3.2-11b-vision 403, llava-1.5-7b 400, uform-gen2 410).
 *
 * WHAT THIS HOLDS:
 *   THE NUMBERS      a budget per role, and the env grammar around it — in
 *                    particular that an EMPTY variable means the default and not
 *                    "off", because a Vercel Sensitive variable pulls down empty
 *                    (#46/#47).
 *   THE WIRE         that the budget really arrives as `max_tokens` on the
 *                    provider's request body, read back from the scripted
 *                    server's own `GET /__requests` recorder. A fix that does not
 *                    change the request body is not a fix, and #51 proved by
 *                    measurement that the source saying so is not evidence.
 *   THE LADDER       that a retry after `finish=length` RAISES the budget, since
 *                    reissuing a call that ran out of room inside the same room
 *                    is a call that cannot succeed — and that the raise does not
 *                    weaken the vision-required guard.
 *   THE ROW          that `cap=` now reports the budget in force (it read
 *                    `cap=none` on the chat path, which is what sent the
 *                    diagnosis looking for a provider default that did not exist)
 *                    and `next_cap=` reports the raise.
 *
 * Offline: no provider, no network beyond 127.0.0.1, no database, no spend.
 *
 * Run:  npm run test:model-output-budget
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freePort, spawnFakeModel } from "./lib/own-listener.mjs";
import { BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/* ── the scripted provider, on one port, restartable ─────────────────────── */

const PORT = await freePort();
const ROOT = new URL("..", import.meta.url).pathname;

// Set BEFORE agent/lib/model.ts is imported: the provider's base URL is frozen
// when that module loads, so the way to drive two behaviours in one process is to
// change what is listening, not where the client points.
process.env.MODEL_PROVIDER = "cloudflare";
process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
process.env.CLOUDFLARE_API_TOKEN = "test-token";
process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.CLOUDFLARE_MODEL_ORCHESTRATOR = "@cf/zai-org/glm-5.3";
process.env.CLOUDFLARE_MODEL_SPECIALIST = "@cf/moonshotai/kimi-k2.6";
process.env.CLOUDFLARE_MODEL_VISION = "@cf/moonshotai/kimi-k2.6";

let modelServer = null;
async function useModelScript(script, extra = []) {
  if (modelServer) {
    modelServer.kill("SIGKILL");
    await new Promise((resolve) => modelServer.once("exit", resolve));
  }
  // Same port every time (the client froze it), but the fake's own ready line is
  // the proof it bound — a held port rejects here instead of hanging or, worse,
  // being answered by whoever holds it (scripts/lib/own-listener.mjs).
  modelServer = (await spawnFakeModel(["--script", script, ...extra], { cwd: ROOT, port: PORT })).child;
}
const recordedRequests = async () => await (await fetch(`http://127.0.0.1:${PORT}/__requests`)).json();
/** What the provider was really told it may produce. "absent" is the pre-fix answer. */
const capsOnTheWire = (requests) => requests.map((r) => ("max_tokens" in r && r.max_tokens !== null ? r.max_tokens : "absent"));

const {
  DEFAULT_OUTPUT_BUDGET_TOKENS,
  MAX_OUTPUT_BUDGET_TOKENS,
  OUTPUT_BUDGET_ENV,
  createOutputBudget,
  resolveOutputBudget,
} = await import("../agent/lib/model-output-budget.ts");
const { planRecovery, describeModelCall, formatEmptyResponseDetail, raisedOutputBudget, withOutputBudget } = await import(
  "../agent/lib/empty-model-response.ts"
);
const { agentModel, modelOutputBudgetTokens } = await import("../agent/lib/model.ts");
const { streamText } = await import("ai");

/* ═══ 1. THE NUMBERS ════════════════════════════════════════════════════ */

console.log("The budget each role gets:");
{
  const { orchestrator, specialist, vision } = DEFAULT_OUTPUT_BUDGET_TOKENS;
  check(
    "every role has one — the chat path used to send no budget at all, which is how a ceiling nobody chose became undiagnosable",
    [orchestrator, specialist, vision].every((n) => Number.isInteger(n) && n > 0),
  );
  check(
    "every default is well clear of the 1,500 that burned itself out thinking",
    [orchestrator, specialist, vision].every((n) => n >= 8_192),
  );
  check(
    "…and inside the 16,384 that was probed as accepted on this account",
    [orchestrator, specialist, vision].every((n) => n <= 16_384),
  );
  check(
    "the vision role — the one that failed, and the one that renders up to 4 pages into a single answer — gets the most room",
    vision >= orchestrator,
  );
  check(
    "the orchestrator gets the least: it makes the most calls per turn, and it writes chat replies rather than documents",
    orchestrator <= specialist && orchestrator <= vision,
  );
  check(
    "nothing is the model's window (262,144 on Kimi): a ceiling the platform's own timeout reaches first bounds nothing",
    Math.max(orchestrator, specialist, vision) < 262_144 / 4,
  );
  check("and a hard ceiling exists over any override or raise", MAX_OUTPUT_BUDGET_TOKENS >= 16_384 && MAX_OUTPUT_BUDGET_TOKENS <= 131_072);
}

console.log("\nThe override, and the empty-string trap:");
{
  const env = (value) => resolveOutputBudget("vision", { [OUTPUT_BUDGET_ENV.vision]: value });
  check("one variable per role", new Set(Object.values(OUTPUT_BUDGET_ENV)).size === 3);
  check(
    "each names its role and carries no product role word",
    Object.entries(OUTPUT_BUDGET_ENV).every(([role, name]) => name.endsWith(role.toUpperCase()) && !new RegExp(`(^|_)${BASE_PRODUCT_WORD}(_|$)`, "i").test(name)),
  );
  check("unset means the default", resolveOutputBudget("vision", {}) === DEFAULT_OUTPUT_BUDGET_TOKENS.vision);
  check(
    "EMPTY also means the default — a Vercel Sensitive variable pulls down as an empty string and must not silently change behaviour",
    env("") === DEFAULT_OUTPUT_BUDGET_TOKENS.vision,
  );
  check("…including when it is only whitespace", env("   ") === DEFAULT_OUTPUT_BUDGET_TOKENS.vision);
  check("a number is honoured", env("4096") === 4096);
  check("…and trimmed, because `echo | vercel env add` leaves a newline", env("4096\n") === 4096);
  check("…and clamped to the ceiling, so a typo cannot outlive the request timeout", env("999999") === MAX_OUTPUT_BUDGET_TOKENS);
  for (const off of ["off", "none", "false", "disabled", "0", "OFF"]) {
    check(`"${off}" sends no budget at all — removal is typed, not fallen into`, env(off) === undefined);
  }
  for (const junk of ["lots", "-1", "8192.5", "8_192"]) {
    check(`"${junk}" is ignored rather than obeyed, and the default stands`, env(junk) === DEFAULT_OUTPUT_BUDGET_TOKENS.vision);
  }
  check("the three roles resolve independently", resolveOutputBudget("orchestrator", {}) !== resolveOutputBudget("vision", {}));
}

/* ═══ 2. THE MIDDLEWARE ═════════════════════════════════════════════════ */

console.log("\nWhat the middleware puts on a call:");
{
  const transform = (params, budget) =>
    createOutputBudget({ budget: () => budget }).transformParams({ params, type: "stream", model: {} });
  check("a call with no budget of its own gets the role's", (await transform({ prompt: [] }, 8192)).maxOutputTokens === 8192);
  check(
    "a call that named its own number keeps it — the web app's two 220- and 1200-token summaries are not made 8k behind their author's back",
    (await transform({ prompt: [], maxOutputTokens: 220 }, 8192)).maxOutputTokens === 220,
  );
  check("…including a deliberate 0", (await transform({ prompt: [], maxOutputTokens: 0 }, 8192)).maxOutputTokens === 0);
  check("with the budget turned off, nothing is added", (await transform({ prompt: [] }, undefined)).maxOutputTokens === undefined);
  check(
    "the params are copied, never mutated: the caller's object is eve's and is reused across a turn",
    await (async () => {
      const original = { prompt: [] };
      await transform(original, 8192);
      return original.maxOutputTokens === undefined;
    })(),
  );
}

/* ═══ 3. THE WIRE — the chat path, which set nothing at all ═════════════ */

console.log("\nThe budget reaches the provider's request body:");
await useModelScript("empty-then-answer", ["--empties", "0"]);
{
  const run = streamText({ model: agentModel("orchestrator"), prompt: "What were the KPIs in the pdf?" });
  await run.consumeStream();
  const caps = capsOnTheWire(await recordedRequests());
  check(
    `the orchestrator's chat call carries max_tokens=${DEFAULT_OUTPUT_BUDGET_TOKENS.orchestrator} (saw: ${caps.join(", ")})`,
    caps.length === 1 && caps[0] === DEFAULT_OUTPUT_BUDGET_TOKENS.orchestrator,
  );
}
await useModelScript("empty-then-answer", ["--empties", "0"]);
{
  const run = streamText({ model: agentModel("specialist"), prompt: "Extract the segment table." });
  await run.consumeStream();
  const caps = capsOnTheWire(await recordedRequests());
  check(
    `the specialist's delegated call carries its own, larger budget, max_tokens=${DEFAULT_OUTPUT_BUDGET_TOKENS.specialist} (saw: ${caps.join(", ")})`,
    caps.length === 1 && caps[0] === DEFAULT_OUTPUT_BUDGET_TOKENS.specialist,
  );
}
await useModelScript("empty-then-answer", ["--empties", "0"]);
{
  // The override, end to end: an operator setting a Vercel variable must move the
  // number on the wire, or the knob is decoration.
  process.env[OUTPUT_BUDGET_ENV.specialist] = "4096";
  const run = streamText({ model: agentModel("specialist"), prompt: "Extract the segment table." });
  await run.consumeStream();
  const caps = capsOnTheWire(await recordedRequests());
  delete process.env[OUTPUT_BUDGET_ENV.specialist];
  check(`the env override moves the number on the wire (saw: ${caps.join(", ")})`, caps[0] === 4096);
}
await useModelScript("empty-then-answer", ["--empties", "0"]);
{
  process.env[OUTPUT_BUDGET_ENV.specialist] = "off";
  const run = streamText({ model: agentModel("specialist"), prompt: "Extract the segment table." });
  await run.consumeStream();
  const caps = capsOnTheWire(await recordedRequests());
  delete process.env[OUTPUT_BUDGET_ENV.specialist];
  check(`"off" really sends nothing, so the pre-fix behaviour is reachable without a deploy (saw: ${caps.join(", ")})`, caps[0] === "absent");
}

/* ═══ 4. THE WIRE — the retry raises it ═════════════════════════════════ */

console.log("\nA retry after `finish=length` is not the same call again:");
// The measured shape at the new budget: finish_reason "length", no content, and
// every completion token spent on reasoning.
await useModelScript("empty-then-answer", [
  "--empties",
  "1",
  "--empty-completion-tokens",
  String(DEFAULT_OUTPUT_BUDGET_TOKENS.orchestrator),
]);
{
  const run = streamText({ model: agentModel("orchestrator"), prompt: "What were the KPIs in the pdf?" });
  await run.consumeStream();
  const text = await run.text;
  const caps = capsOnTheWire(await recordedRequests());
  check("the person still gets the answer the empty response was hiding", text.includes("RECOVERED"));
  check(
    `the first call carries the role's budget and the RETRY carries twice it (saw: ${caps.join(", ")})`,
    caps.length === 2 &&
      caps[0] === DEFAULT_OUTPUT_BUDGET_TOKENS.orchestrator &&
      caps[1] === DEFAULT_OUTPUT_BUDGET_TOKENS.orchestrator * 2,
  );
}

console.log("\nWhen the budget is NOT what ran out, nothing is raised:");
{
  const shape = describeModelCall({ prompt: [], tools: [], maxOutputTokens: 8192 });
  const ranOut = { finishReason: "length", finishReasonRaw: "length", empty: true };
  const stopped = { finishReason: "stop", finishReasonRaw: "stop", empty: true };
  check("a `length` finish doubles it", raisedOutputBudget(shape, ranOut) === 16_384);
  check(
    "…on the RAW provider reason too, which is the word Workers AI actually sends",
    raisedOutputBudget(shape, { finishReason: "other", finishReasonRaw: "length" }) === 16_384,
  );
  check("a model that simply said nothing gets the same room back — more buys nothing", raisedOutputBudget(shape, stopped) === null);
  check(
    "an UNCAPPED call is not given a cap by the recovery: that would make the retry a different experiment from the call it retries",
    raisedOutputBudget(describeModelCall({ prompt: [], tools: [] }), ranOut) === null,
  );
  check(
    "and the doubling stops at the ceiling rather than climbing forever",
    raisedOutputBudget(describeModelCall({ prompt: [], tools: [], maxOutputTokens: MAX_OUTPUT_BUDGET_TOKENS }), ranOut) === null &&
      raisedOutputBudget(describeModelCall({ prompt: [], tools: [], maxOutputTokens: MAX_OUTPUT_BUDGET_TOKENS - 1 }), ranOut) ===
        MAX_OUTPUT_BUDGET_TOKENS,
  );
  check(
    "a null raise leaves the call byte for byte alone, uncapped included",
    withOutputBudget({ prompt: [] }, null).maxOutputTokens === undefined && withOutputBudget({ prompt: [] }, 99).maxOutputTokens === 99,
  );
}

/* ═══ 5. THE LADDER'S OTHER GUARDS STILL HOLD ═══════════════════════════ */

console.log("\nThe raise does not weaken the vision guard:");
{
  const image = describeModelCall({
    prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: "AAAA" }] }],
    tools: [],
    maxOutputTokens: 16_384,
  });
  const ranOut = { finishReason: "length", finishReasonRaw: "length", empty: true };
  const plan = (over) => planRecovery({ attempt: 1, shape: image, outcome: ranOut, fallbackAvailable: true, fallbackUsed: false, ...over });
  check("a turn carrying an image retries on its OWN model, with more room", plan({}).action === "retry" && plan({}).outputBudget === 32_768);
  check(
    "…and still never falls back to the text-only model once the raise has been tried",
    plan({ attempt: 2 }).action === "explain" && plan({ attempt: 2 }).reason === "vision-required",
  );
  check("…and that explanation raises nothing, because nothing is going to be called", plan({ attempt: 2 }).outputBudget === null);
  check(
    "a text-only turn still gets the second model, and gets it with the raised budget rather than the one that was too small",
    (() => {
      const text = describeModelCall({ prompt: [], tools: [], maxOutputTokens: 8192 });
      const step = planRecovery({ attempt: 2, shape: text, outcome: ranOut, fallbackAvailable: true, fallbackUsed: false });
      return step.action === "fallback" && step.outputBudget === 16_384;
    })(),
  );
}

/* ═══ 6. THE ROW ════════════════════════════════════════════════════════ */

console.log("\nThe empty-response row names the budget, not `none`:");
{
  const row = {
    id: "r1",
    attempt: 1,
    modelId: "@cf/moonshotai/kimi-k2.6",
    path: "generate",
    messages: 2,
    tools: 59,
    approxBytes: 2048,
    outputCap: 16_384,
    hasImageInput: true,
    empty: true,
    finishReason: "length",
    finishReasonRaw: "length",
    promptTokens: 2999,
    completionTokens: 16_384,
    reasoningTokens: 16_384,
    hadToolCalls: false,
    next: "retry",
    nextReason: null,
    nextOutputCap: 32_768,
  };
  const detail = formatEmptyResponseDetail(row);
  check("the budget in force is on the row as a number", /cap=16384/.test(detail));
  check("…and so is the one the retry was given, so 'does raising it help?' is answerable from the feed", /next_cap=32768/.test(detail));
  check("a row whose next attempt reuses the budget says so by saying nothing", !/next_cap=/.test(formatEmptyResponseDetail({ ...row, nextOutputCap: null })));
  check("`cap=none` still exists, and now means a call nothing budgeted at all", /cap=none/.test(formatEmptyResponseDetail({ ...row, outputCap: null, nextOutputCap: null })));
  check("the detail still fits the 400 characters the telemetry route accepts", detail.length <= 400);
}

/* ═══ 7. THE ONE CALL SITE THAT SET ITS OWN ════════════════════════════ */

console.log("\nThe 1,500 is gone from the file that set it:");
{
  const vision = src("agent/lib/vision-tools.ts");
  check(
    // `^const` — the removal is a DECLARATION going away. The number still appears
    // in the comment that explains what it cost, which is the point of the comment.
    "agent/lib/vision-tools.ts no longer hardcodes an output budget",
    !/^const MAX_OUTPUT_TOKENS\s*=/m.test(vision) && !/maxOutputTokens: MAX_OUTPUT_TOKENS/.test(vision),
  );
  check("…it asks for the vision ROLE's budget, the same one the chat path gets", /maxOutputTokens: modelOutputBudgetTokens\("vision"\)/.test(vision));
  check(
    "…which is passed explicitly, because the middleware only exists in cloudflare mode and read_image must be budgeted on the gateway too",
    modelOutputBudgetTokens("vision") === DEFAULT_OUTPUT_BUDGET_TOKENS.vision,
  );
  const model = src("agent/lib/model.ts");
  check(
    "the budget middleware sits between the id rewriter and the empty-response recovery, so the recovery sees the budget it must report and raise",
    /middleware: \[\s*uniqueToolCallIds,\s*createOutputBudget\(\{[^}]*\}\),\s*createEmptyResponseRecovery/.test(model),
  );
}

modelServer?.kill("SIGKILL");
console.log(`\n${passed} checks passed.`);
