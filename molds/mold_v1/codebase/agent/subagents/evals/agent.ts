import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Build, run, and improve eval suites and interpret regressions for a {account}. Delegate here to check quality before/after a change or to investigate an eval score drop.",
  ),
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
  // Summarised past the profile's specialist threshold, so a long run does not resend its whole history (mold_v1-220).
  compaction: compactionFor("evals", "orchestrator"),
});
