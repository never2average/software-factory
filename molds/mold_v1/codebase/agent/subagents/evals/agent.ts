import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Build, run, and improve eval suites and interpret regressions for a customer. Delegate here to check quality before/after a change or to investigate an eval score drop.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
