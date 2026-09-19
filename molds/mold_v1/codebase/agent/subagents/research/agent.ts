import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description:
    "Thoroughly research an account and build out its schema-specific system of record across Customers, Platform, Deployments, Solutions, Implementation, Tickets, Interactions, Internal Staff, and Customer Stakeholders. Delegate here to enrich or (re)build a customer's data room: it pulls the current record, meeting notes, and the web, writes findings back, and produces the six per-section Excel workbooks (Customers, Platform, Deployments, Solutions, Implementation, Tickets).",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens("orchestrator"),
});
