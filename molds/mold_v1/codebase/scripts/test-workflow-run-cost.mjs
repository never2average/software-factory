/**
 * WHAT A SPECIALIST RUN COSTS — offline: the step's price, and the model that served the step.
 *
 * A specialist's run row (`automation_runs`, agent/lib/workflow-usage.ts) recorded tokens and `cost_usd = 0` on
 * Cloudflare Workers AI, because the row was opened at 0 and only a provider's own figure was ever added, and Workers
 * AI reports none. Nor did the row say which model ran, so nothing downstream could price the tokens.
 *
 * Two halves, each checked here without a database or a provider:
 *
 *   1. THE PRICE OF ONE STEP (`stepCostUsd`): the provider's figure when it reports one; else the step's tokens
 *      priced at the model that served it with the function chat turns are priced with (lib/inference-pricing.ts);
 *      NULL, never 0, for a model with no price or no recorded model.
 *   2. WHICH MODEL SERVED THE STEP (agent/lib/served-model.ts): the real provider path (`agentModel`, against
 *      scripts/fake-model-server.mjs) notes the model each call went to. A call the empty-response recovery hands to
 *      the other role's model is noted as THAT model, so its tokens are priced at its rate; the recorder takes the
 *      note, so a later step cannot inherit it.
 *
 * The database half (the row's cost and per-model tokens, an unknown that stays unknown, drizzle/0036) is
 * scripts/test-run-history-db.mjs section 9-10, in CI's isolation job.
 *
 * Run:  npm run test:workflow-run-cost
 */
import assert from "node:assert/strict";
import { spawnFakeModel } from "./lib/own-listener.mjs";

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

const ORCHESTRATOR = "@cf/moonshotai/kimi-k2.6";
const SPECIALIST = "@cf/zai-org/glm-5.3";

const workflowUsage = await import("../agent/lib/workflow-usage.ts");
const { estimateCostUsd, priceForModel } = await import("../lib/inference-pricing.ts");
const served = await import("../agent/lib/served-model.ts").catch((e) => ({ missing: String(e) }));

console.log("1. The price of one step");
{
  const { stepCostUsd } = workflowUsage;
  check("the recorder prices a step (stepCostUsd exists)", typeof stepCostUsd === "function");
  if (typeof stepCostUsd === "function") {
    const tokens = { inputTokens: 120_000, outputTokens: 4_000, cacheReadTokens: 20_000 };
    // By hand from the table: 100k uncached at $1.40/M, 20k cached at $0.26/M, 4k out at $4.40/M.
    const byHand = Math.round(((100_000 * 1.4 + 20_000 * 0.26 + 4_000 * 4.4) / 1_000_000) * 10_000) / 10_000;
    check(`a step on a Workers AI model with no provider cost is priced from its tokens: $${byHand}`, priceForModel(SPECIALIST) !== null && stepCostUsd(tokens, SPECIALIST) === byHand, stepCostUsd(tokens, SPECIALIST));
    check("…by the same function chat turns are priced with", stepCostUsd(tokens, SPECIALIST) === estimateCostUsd(SPECIALIST, tokens));
    check("…at the rate of the model that served it (the fallback's, when the fallback answered)", stepCostUsd(tokens, ORCHESTRATOR) === estimateCostUsd(ORCHESTRATOR, tokens) && stepCostUsd(tokens, ORCHESTRATOR) !== stepCostUsd(tokens, SPECIALIST));
    check("a model the price table does not have is unknown (null), never $0", stepCostUsd(tokens, "@cf/example/unpriced") === null);
    check("so is a step whose model was not recorded", stepCostUsd(tokens, null) === null && stepCostUsd(tokens, undefined) === null);
    check("a cost the provider reports is kept as reported", stepCostUsd({ ...tokens, costUsd: 0.5 }, SPECIALIST) === 0.5 && stepCostUsd({ ...tokens, costUsd: 0.5 }, null) === 0.5);
    check("…including a reported $0", stepCostUsd({ ...tokens, costUsd: 0 }, "@cf/example/unpriced") === 0);
  }
}

console.log("\n2. Which model served the step, on the real provider path");
check("there is a served-model note (agent/lib/served-model.ts)", !served.missing, served.missing);
if (!served.missing) {
  const { __useServedModelSlot, noteServedModel, takeServedModel } = served;
  // No eve context in this process: the slot eve scopes to a harness step is replaced by a plain one.
  let value = null;
  const restore = __useServedModelSlot({ get: () => value, update: (fn) => (value = fn(value)) });
  check("outside an eve context the note never throws (the real slot)", (() => {
    const mine = __useServedModelSlot(restore);
    try {
      noteServedModel("x");
      return takeServedModel() === null;
    } catch {
      return false;
    } finally {
      __useServedModelSlot(mine);
    }
  })());

  // Two empties: the first call and its same-model retry come back empty, the fallback answers.
  const fake = await spawnFakeModel(["--script", "empty-then-answer", "--empties", "2"], { cwd: new URL("..", import.meta.url).pathname });
  try {
    process.env.MODEL_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${fake.port}/v1`;
    process.env.CLOUDFLARE_MODEL_ORCHESTRATOR = ORCHESTRATOR;
    process.env.CLOUDFLARE_MODEL_SPECIALIST = SPECIALIST;
    const { streamText, generateText } = await import("ai");
    const { agentModel } = await import("../agent/lib/model.ts");
    const requests = async () => (await fetch(`http://127.0.0.1:${fake.port}/__requests`)).json();

    const run = streamText({ model: agentModel("orchestrator"), prompt: "Summarise the filing." });
    await run.consumeStream();
    const text = await run.text;
    const sent = (await requests()).map((r) => r.model);
    check(`the call was answered by the fallback model after two empties (wire: ${sent.join(", ")})`, text.length > 0 && sent.length === 3 && sent[2] === SPECIALIST, sent);
    check("the step is noted as served by the FALLBACK model, not the configured one", value === SPECIALIST, value);
    check("taking the note returns it…", takeServedModel() === SPECIALIST);
    check("…and clears it, so a later step that notes nothing cannot inherit it", takeServedModel() === null);

    const next = await generateText({ model: agentModel("orchestrator"), prompt: "And the next one?" });
    check("a call the configured model answers is noted as the configured model", next.text.length > 0 && takeServedModel() === ORCHESTRATOR);

    // A model call made from INSIDE a tool (read_image's vision call) happens after the step's own call and before
    // eve reports the step. It must not re-file the step's tokens under its model: its tokens are not in them.
    noteServedModel(SPECIALIST);
    await generateText({ model: agentModel("vision"), prompt: "Describe the page." });
    check("a vision call from inside a tool leaves the step's note alone", takeServedModel() === SPECIALIST);

    // The specialist role's own model, answering first time.
    await generateText({ model: agentModel("specialist"), prompt: "Work." });
    check("each role notes its own model", takeServedModel() === SPECIALIST);

    // The recorder consumes the note even when it writes nothing (no database here), so it never leaks forward.
    noteServedModel(ORCHESTRATOR);
    await workflowUsage.recordWorkflowStep("probe", "turn_0", { inputTokens: 1, outputTokens: 1 }, "s", "org");
    check("recordWorkflowStep takes the step's note", value === null, value);
  } finally {
    fake.child.kill("SIGKILL");
    __useServedModelSlot(restore);
  }
}

console.log(`\ntest-workflow-run-cost: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
assert.ok(passed > 0);
