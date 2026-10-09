import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

// A specialist with NO sandbox file (scripts/fixtures/sandbox-coverage/README.md).
export default defineAgent({
  description: "Fixture: a specialist that authors no sandbox definition.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
});
