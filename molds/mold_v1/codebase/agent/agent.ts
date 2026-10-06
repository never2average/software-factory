import { defineAgent } from "eve";
import { agentModel, agentReasoning, modelContextWindowTokens } from "#lib/model.js";

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
  // Stream extended-thinking (reasoning) tokens on the gateway Claude models.
  // On Workers AI only when CLOUDFLARE_REASONING_EFFORT names a level. See model.ts.
  reasoning: agentReasoning(),
  // Specialists called in one step report one at a time (mold_v1-184; patches/eve+0.25.1.patch, the readable source
  // in scripts/eve-patch/): once one is back and another waits on the person's answer, or after 10 s, the main agent
  // gets what is in and each one still out as "reports later"; that one's result arrives as its own tool result, in a
  // turn of its own, when it finishes. docs/SPECIALIST_HANDBACK.md "Per-result delegation".
  subagents: { batch: "detach" },
  // NOTE: eve 0.25 dropped limits.maxSubagentDepth (0.20 had it as
  // orchestrator -> specialist -> one more fan-out); depth is framework-managed
  // now. Token budgets via limits.* remain available if we want caps later.
});
