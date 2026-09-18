import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Write, lint and review Ops Center workflow scripts. Delegate here whenever someone asks for a workflow script to be written or changed: it authors the TypeScript that the sandbox executes (phase/agent/parallel/pipeline), holds the sandbox's hard limits in its head, and reviews an existing script for the things the validator and the sandbox will refuse. It writes code and nothing else — it never runs a workflow, never touches the data room, and never calls a tool.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
