import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Chase open customer follow-ups and prepare the daily stand-up summary. Delegate here to draft follow-up emails/Slack nudges and to produce the ranked, per-customer stand-up brief.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
