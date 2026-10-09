import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Deploy and operate {account} platforms on Vercel: releases, rollbacks, and health checks. Delegate here to ship or diagnose a {account} environment.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
