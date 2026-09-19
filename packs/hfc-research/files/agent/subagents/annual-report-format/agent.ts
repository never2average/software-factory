import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Navigate and extract an Indian housing finance company's annual report (SEBI LODR Reg 34) section by section: Directors' Report, Management Discussion and Analysis, standalone versus consolidated statements, Ind AS 109 expected-credit-loss notes, the RBI HFC Directions disclosures (asset-liability maturity, exposures, concentration, capital adequacy schedule), related-party transactions, BRSR, and the auditor's report with CARO. Delegate here when an analyst needs a specific annual-report section located, extracted into a consistent structure, or compared across years. Works only from annual reports already in the data room.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
