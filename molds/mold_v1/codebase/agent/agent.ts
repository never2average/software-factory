import { defineAgent } from "eve";
// Notes a person sends a running specialist are read at its next step (mold_v1-235): registered for the eve patch.
import "#lib/steering-reader.js";
import { agentModel, agentReasoning, compactionFor, modelContextWindowTokens } from "#lib/model.js";

// Model is resolved centrally (Kimi K2.7 via OpenCode Zen by default, or Claude
// via the AI Gateway) — see agent/lib/model.ts.
//
// Long-term memory wiring: eve's dynamic-instructions slot is the
// `agent/instructions/` directory, not `defineAgent` (which carries no
// instructions/hooks field). The `turn.started` resolver in
// `agent/instructions/memory.ts` loads shared team + per-entity memories
// from `agent/lib/memory-store.ts` (Postgres `memories` table when
// configured, in-process fallback otherwise) into the system context each
// turn; the `remember` / `list_memories` / `forget` tools in `agent/tools/`
// write to the same store.
export default defineAgent({
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
  // The main agent compacts at eve's own threshold (90% of the window) unless the profile's
  // agent.compaction.orchestrator_tokens names one: its steps resend the conversation and the specialists' results,
  // not the specialists' own tool steps, which is where the input went (mold_v1-220, docs/SPECIALIST_CONTEXT.md).
  compaction: compactionFor(null, "orchestrator"),
  // Stream extended-thinking (reasoning) tokens on the gateway Claude models.
  // On Workers AI only when CLOUDFLARE_REASONING_EFFORT names a level. See model.ts.
  reasoning: agentReasoning(),
  // Specialists called in one step report one at a time (mold_v1-184; patches/eve+0.25.1.patch, the readable source
  // in scripts/eve-patch/): once one is back and another waits on the person's answer, or after 10 s, the main agent
  // gets what is in and each one still out as "reports later"; that one's result arrives as its own tool result, in a
  // turn of its own, when it finishes. docs/SPECIALIST_HANDBACK.md "Per-result delegation".
  // The main thread does not stop for a specialist (mold_v1-197): when nothing is back yet, the batch is handed over
  // all the same — 10 s after the call when the same step also ran tools of its own (there is independent work to go
  // on with), 45 s after it otherwise — so the main agent does what does not need the specialist, replies with what it
  // has, and folds the result in when it arrives. docs/SPECIALIST_HANDBACK.md "The main thread keeps working".
  subagents: { batch: "detach", detachIdleAfterMs: 45_000 },
  // NOTE: eve 0.25 dropped limits.maxSubagentDepth (0.20 had it as
  // orchestrator -> specialist -> one more fan-out); depth is framework-managed
  // now. Token budgets via limits.* remain available if we want caps later.
});
