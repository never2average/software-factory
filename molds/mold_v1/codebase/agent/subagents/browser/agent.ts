import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Drive a real web browser to verify and interact with web pages: load a deployed {account} UI and confirm a change rendered, scrape a console the platform has no API for, capture screenshots as signoff evidence, and — with human approval — click/type/fill/select to complete a flow. Delegate here for any 'open this page and tell me / show me / do X on it' task. Page actions are approval-gated; it cannot log in with stored credentials yet.",
  ),
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
});
