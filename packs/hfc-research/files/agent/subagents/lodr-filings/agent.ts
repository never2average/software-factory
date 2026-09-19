import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Find, file and read a housing finance company's SEBI LODR disclosures, indexed by regulation: financial results (Reg 33 equity, Reg 52 debt), material events and rating actions (Reg 30, 51, 55), shareholding and pledges (Reg 31), related-party transactions (Reg 23(9)), security cover (Reg 54), deviation in use of proceeds (Reg 32), governance and secretarial compliance (Reg 27, 24A), and the annual report (Reg 34). Delegate here to fetch a company's latest filings into its data room, to keep its dated filing log current, or to answer what a company disclosed to the exchanges and when. Uses web search against BSE, NSE and the company's investor-relations page when web search is enabled.",
  model: agentModel("specialist"),
  modelContextWindowTokens: modelContextWindowTokens("specialist"),
});
