export const meta = {
  name: "integration-wiring",
  description: "Wire a customer's pipelines / Integromat integrations and land the config.",
};

const c = (args && args.customerId) || "";

phase("Wire");
const wiring = await agent(
  "Wire the pipeline / Integromat integrations for customer " + c + ". Define the pipeline_config and integromat scenario, land them under Implementation/" + c + "/pipelines/ and Implementation/" + c + "/integromat.json. Put any credentials in private.integromat.json (never publish those). Flag risky changes for approval. Summarize what was wired.",
  { subagent: "configuration" },
);

log("integration-wiring complete for " + c);
return { wiring };
