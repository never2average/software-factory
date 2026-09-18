import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Keep the customer system of record current from meetings (Granola), email (Gmail), and Slack. Delegate here to capture what happened with a customer and write it back as interactions, follow-ups, or record updates.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
