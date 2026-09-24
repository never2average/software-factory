import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";
import { speak } from "#lib/agent-vocabulary.js";

export default defineAgent({
  // The roster line the parent delegates on, in the deployment's words (identity under the default profile).
  description: speak(
    "Generate an APP's document — a standing, read-only Markdown report the platform re-renders on a cadence (portfolio digests, on-call boards, workload/health snapshots). Delegate here whenever the task is to PRODUCE a document from the data room's current state: it gathers the relevant read-only signals (customers, tickets, FDEs, on-call, SLAs, interactions) and returns GitHub-flavored Markdown and nothing else. It reads and writes prose — it never mutates state, pages anyone, or files a ticket.",
  ),
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
