import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Deploy and operate customer platforms: Vercel deployments, releases, rollbacks, and health checks. Delegate here to ship or diagnose a customer environment.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
