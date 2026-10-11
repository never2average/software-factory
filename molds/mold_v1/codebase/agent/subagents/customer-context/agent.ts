import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Keep the {account} system of record current from meetings (Granola), email (Gmail), and Slack. Delegate here to capture what happened with a {account} and write it back as interactions, follow-ups, or record updates.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
  // Summarised past the profile's specialist threshold, so a long run does not resend its whole history (mold_v1-220).
  compaction: compactionFor("customer-context", "specialist"),
});
