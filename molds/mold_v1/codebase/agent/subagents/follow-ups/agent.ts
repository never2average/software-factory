import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Chase open {account} follow-ups and prepare the daily stand-up summary. Delegate here to draft follow-up emails/Slack nudges and to produce the ranked, per-{account} stand-up brief.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
