/**
 * The chat-turn ledger records the right tokens under the right workspace, and
 * NEVER a guessed one.
 *
 * Ordinary chat turns used to be billed nowhere: workflow subagents have a
 * usage hook, the root agent did not. The recorder in agent/lib/chat-usage.ts
 * closes that gap, and these checks pin the ways it could quietly go wrong:
 *   - a step's tokens or the step count not reaching the row
 *   - a turn with no resolvable workspace being filed somewhere anyway
 *   - the workspace lookup (or its warning) repeating on every step
 *   - the closing update overtaking the row's first insert
 *   - a database error escaping into the turn (eve would fail the turn)
 *   - the price table drifting from its documented source
 *
 * Offline: the recorder takes its dependencies as a parameter, so this drives
 * it with fakes and never opens a database.
 *
 * Run:  npm run test:chat-usage
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createChatUsageRecorder, isEmptyUsage } from "../agent/lib/chat-usage.ts";
import { estimateCostUsd, priceForModel } from "../lib/inference-pricing.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* ---- pricing --------------------------------------------------------------- */

console.log("Inference pricing:");
const pricing = readFileSync("lib/inference-pricing.ts", "utf8");
check(
  "the price table cites its source URL and date",
  /developers\.cloudflare\.com\/workers-ai\/platform\/pricing/.test(pricing) && /2026-09-09/.test(pricing),
);
const glm = priceForModel("@cf/zai-org/glm-5.2");
check("GLM 5.2 on Workers AI is priced $1.40 / $0.26 / $4.40 per million", glm && glm.inputPerM === 1.4 && glm.cachedInputPerM === 0.26 && glm.outputPerM === 4.4);
check("an unknown model has no price", priceForModel("anthropic/claude-sonnet-5") === null && priceForModel(null) === null);
check("…and prices to null, never zero", estimateCostUsd("nope", { inputTokens: 1_000_000 }) === null);
check(
  "the measured first turn (32,400 input tokens) is about 4.5 cents",
  estimateCostUsd("@cf/zai-org/glm-5.2", { inputTokens: 32_400 }) === 0.0454,
);
check(
  "output tokens are priced at the output rate",
  estimateCostUsd("@cf/zai-org/glm-5.2", { outputTokens: 1_000_000 }) === 4.4,
);
check(
  "cache reads are a subset of input, billed at the cached rate",
  estimateCostUsd("@cf/zai-org/glm-5.2", { inputTokens: 1_000_000, cacheReadTokens: 500_000 }) === 0.83,
);
check(
  "cache reads beyond the input count cannot go negative",
  estimateCostUsd("@cf/zai-org/glm-5.2", { inputTokens: 100, cacheReadTokens: 1_000_000 }) === 0,
);
check("empty usage costs nothing", estimateCostUsd("@cf/zai-org/glm-5.2", {}) === 0);

/* ---- the recorder ---------------------------------------------------------- */

console.log("\nChat-turn recorder:");

function harness({ org = "org-acme", failWrites = false } = {}) {
  const log = { steps: [], finishes: [], warns: [], errors: [], resolves: 0 };
  const recorder = createChatUsageRecorder({
    async resolveOrg() {
      log.resolves++;
      return org;
    },
    actorEmail: () => "ana@acme.example",
    model: () => "@cf/zai-org/glm-5.2",
    async writeStep(row) {
      if (failWrites) throw new Error("db down");
      log.steps.push(row);
    },
    async writeFinish(row) {
      if (failWrites) throw new Error("db down");
      log.finishes.push(row);
    },
    warn: (m) => log.warns.push(m),
    error: (m, e) => log.errors.push([m, e]),
  });
  return { recorder, log };
}
const ctx = { session: { id: "sess-1", auth: { current: null, initiator: null } } };

{
  const { recorder, log } = harness();
  await recorder.recordStep(ctx, "turn-1", { inputTokens: 32_400, outputTokens: 120, cacheReadTokens: 0 });
  await recorder.recordStep(ctx, "turn-1", { inputTokens: 33_000, outputTokens: 80, cacheReadTokens: 30_000, cacheWriteTokens: 5 });
  await recorder.recordStep(ctx, "turn-1", undefined);
  await recorder.recordStep(ctx, "turn-1", { inputTokens: 0, outputTokens: 0 });
  await recorder.finishTurn(ctx, "turn-1", "success");

  check("each step with usage is written once, steps without usage are not", log.steps.length === 2);
  check("a step write carries the session, turn and workspace", log.steps.every((s) => s.eveSessionId === "sess-1" && s.turnId === "turn-1" && s.orgId === "org-acme"));
  check("…and exactly that step's tokens (the row ADDS them)", log.steps[1].inputTokens === 33_000 && log.steps[1].cacheReadTokens === 30_000 && log.steps[1].cacheWriteTokens === 5);
  check("the actor and model are stamped", log.steps[0].actorEmail === "ana@acme.example" && log.steps[0].model === "@cf/zai-org/glm-5.2");
  check("the workspace is resolved once per turn, not per step", log.resolves === 1);
  check("the turn is closed with its status", log.finishes.length === 1 && log.finishes[0].status === "success" && log.finishes[0].orgId === "org-acme");
  check("nothing was warned or logged as an error", log.warns.length === 0 && log.errors.length === 0);
}

{
  const { recorder, log } = harness({ org: null });
  await recorder.recordStep(ctx, "turn-2", { inputTokens: 10 });
  await recorder.recordStep(ctx, "turn-2", { inputTokens: 10 });
  await recorder.finishTurn(ctx, "turn-2", "failed");
  check("a turn with no resolvable workspace writes NOTHING", log.steps.length === 0 && log.finishes.length === 0);
  check("…and warns exactly once for the turn", log.warns.length === 1 && /turn-2/.test(log.warns[0]));
}

{
  const { recorder, log } = harness();
  await recorder.finishTurn(ctx, "turn-3", "cancelled");
  check("closing a turn that never reported usage writes nothing and asks nothing", log.finishes.length === 0 && log.resolves === 0 && log.warns.length === 0);
}

{
  // Ordering: the hook does not await, so a close can be issued while the
  // step's write is still in flight. It must land AFTER that write.
  const order = [];
  const recorder = createChatUsageRecorder({
    resolveOrg: async () => "org-acme",
    actorEmail: () => null,
    model: () => null,
    writeStep: () => new Promise((r) => setTimeout(() => { order.push("step"); r(); }, 20)),
    writeFinish: async () => { order.push("finish"); },
    warn: () => {},
    error: () => {},
  });
  const a = recorder.recordStep(ctx, "turn-4", { outputTokens: 1 });
  const b = recorder.finishTurn(ctx, "turn-4", "success");
  await Promise.all([a, b]);
  check("the closing update cannot overtake the step insert", order.join(",") === "step,finish");
}

{
  const { recorder, log } = harness({ failWrites: true });
  let threw = false;
  try {
    await recorder.recordStep(ctx, "turn-5", { inputTokens: 1 });
    await recorder.finishTurn(ctx, "turn-5", "success");
  } catch {
    threw = true;
  }
  check("a database error is logged, never thrown into the turn", !threw && log.errors.length === 2);
}

{
  const recorder = createChatUsageRecorder({
    resolveOrg: async () => { throw new Error("tenancy refused"); },
    actorEmail: () => null,
    model: () => null,
    writeStep: async () => { throw new Error("must not write"); },
    writeFinish: async () => { throw new Error("must not write"); },
    warn: () => {},
    error: () => {},
  });
  let threw = false;
  try {
    await recorder.recordStep(ctx, "turn-6", { inputTokens: 1 });
    await recorder.finishTurn(ctx, "turn-6", "success");
  } catch {
    threw = true;
  }
  check("a refused workspace lookup records nothing and throws nothing", !threw);
}

check("isEmptyUsage ignores costUsd — tokens decide", isEmptyUsage({ costUsd: 1 }) && !isEmptyUsage({ cacheReadTokens: 1 }));

/* ---- the production wiring (source-level) ------------------------------------ */

console.log("\nWiring:");
const lib = readFileSync("agent/lib/chat-usage.ts", "utf8");
const hook = readFileSync("agent/hooks/chat-usage.ts", "utf8");
const schema = readFileSync("agent/lib/db/schema.ts", "utf8");
const migration = readFileSync("drizzle/0015_chat_turn_usage.sql", "utf8");
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));

check("the upsert ADDS tokens rather than overwriting", /steps: sql`\$\{chatTurnUsage\.steps\} \+ 1`/.test(lib) && /inputTokens: sql`\$\{chatTurnUsage\.inputTokens\} \+ /.test(lib));
check("…keyed by (eve session, turn)", /target: \[chatTurnUsage\.eveSessionId, chatTurnUsage\.turnId\]/.test(lib));
check("writes enter the workspace's RLS scope", /withOrgDb\(row\.orgId/.test(lib));
check("a session with no identity resolves to no workspace", /if \(!email && !hd\) return null/.test(lib));
check("…and the resolver's placeholder workspace is refused too", /personal:unknown/.test(lib));
check("the hook is a root-agent hook under agent/hooks/", /defineHook\(/.test(hook) && /"step\.completed"/.test(hook) && /"turn\.cancelled"/.test(hook));
check("the hook does not await the database", /void chatUsage\.recordStep/.test(hook) && /void chatUsage\.finishTurn/.test(hook));
check("the table is unique per (eve session, turn)", /uniqueIndex\("chat_turn_usage_turn_uidx"\)\.on\(t\.eveSessionId, t\.turnId\)/.test(schema));
check("the migration enables + forces RLS with org_isolation", /ENABLE ROW LEVEL SECURITY/.test(migration) && /FORCE ROW LEVEL SECURITY/.test(migration) && /CREATE POLICY "org_isolation" ON "chat_turn_usage"/.test(migration));
check("…grants the app role", /GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_turn_usage" TO app_rw/.test(migration));
check("…and is in the journal migrate-production applies", journal.entries.some((e) => e.tag === "0015_chat_turn_usage" && e.idx === 15));

console.log(`\n${passed} checks passed.`);
