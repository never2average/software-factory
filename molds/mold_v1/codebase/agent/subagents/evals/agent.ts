import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Build, run, and improve eval suites and interpret regressions for a {account}. Delegate here to check quality before/after a change or to investigate an eval score drop.",
  ),
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
});
