import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Plan and execute {account} data migrations and imports (legacy CRM exports, historical data, bulk records). Delegate here to move a {account}'s data into their platform safely.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
