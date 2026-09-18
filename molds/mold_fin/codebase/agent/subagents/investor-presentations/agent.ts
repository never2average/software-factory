import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Read a housing finance company's investor presentations and earnings-call transcripts: slide-by-slide operational metrics (branches, employees, disbursements, AUM mix, sell down and buy out), management guidance and how it changed from the previous quarter, and the company's own metric definitions. For an unlisted HFC it reads the parent company's presentation. Delegate here to fetch or summarise a quarter's deck or concall, to track guidance, or to supply the operational inputs the KPI table needs.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
