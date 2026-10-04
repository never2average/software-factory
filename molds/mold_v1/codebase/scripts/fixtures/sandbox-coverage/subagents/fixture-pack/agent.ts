import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

// A specialist with a pack-shaped sandbox (scripts/fixtures/sandbox-coverage/README.md).
export default defineAgent({
  description: "Fixture: a specialist that ships a bootstrap and seed files, and names no backend.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
});
