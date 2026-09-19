import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Configure a customer's platform: models, connections, feature flags, and guardrails. Delegate here to review or change how a customer's deployment is set up.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
