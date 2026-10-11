import { defineAgent } from "eve";
import { agentModel, compactionFor, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Thoroughly research an {account} and build out its schema-specific system of record across {domain:accounts}, {domain:platform}, {domain:deliveries}, {domain:solutions}, {domain:projects}, {domain:tickets}, Interactions, Internal Staff, and Customer Stakeholders. Delegate here to enrich or (re)build a {account}'s data room: it pulls the current record, meeting notes, and the web, writes findings back, and produces the six per-section Excel workbooks ({domain:accounts}, {domain:platform}, {domain:deliveries}, {domain:solutions}, {domain:projects}, {domain:tickets}).",
  ),
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
  // Summarised past the profile's specialist threshold, so a long run does not resend its whole history (mold_v1-220).
  compaction: compactionFor("research", "orchestrator"),
});
