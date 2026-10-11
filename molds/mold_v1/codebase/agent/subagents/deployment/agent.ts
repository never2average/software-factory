import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Deploy and operate {account} platforms on Vercel: releases, rollbacks, and health checks. Delegate here to ship or diagnose a {account} environment.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
  // Summarised past the profile's specialist threshold, so a long run does not resend its whole history (mold_v1-220).
  compaction: compactionFor("deployment", "specialist"),
});
