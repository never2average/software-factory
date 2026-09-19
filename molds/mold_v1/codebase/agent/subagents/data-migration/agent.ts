import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Plan and execute customer data migrations and imports (legacy CRM exports, historical data, bulk records). Delegate here to move a customer's data into their platform safely.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
