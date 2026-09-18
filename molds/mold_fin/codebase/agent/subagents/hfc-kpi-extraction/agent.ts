import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Extract the standard quarterly KPI table for an Indian housing finance company (HFC) from its SEBI LODR quarterly results and investor presentation: scale (AUM, loan book, disbursements, sell down, buy out), asset quality (GNPA, NNPA, Stage-3 PCR), margin and yield, capital and leverage, efficiency, return and productivity metrics. Delegate here whenever an analyst asks for KPIs, a KPI table, a quarter's numbers, or a peer comparison. It applies the workspace's fixed source-precedence, unit-conversion and formula rules, cites the filing and page for every value, and writes the result to the company's data room.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
