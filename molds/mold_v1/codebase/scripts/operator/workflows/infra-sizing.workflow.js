export const meta = {
  name: "infra-sizing",
  description: "Size a {account} {deployment}'s infrastructure across the 8 components and emit customizations.tf + rationale.",
};

const c = (args && args.customerId) || "";
const ver = (args && args.platformVersionId) || "v2.0";

phase("Gather");
const scale = await agent(
  "Read the scale signals for {account} " + c + " from their context.md and the system of record: expected users, request volume/throughput, data size, availability target, regulatory/data-residency constraints, and {deployment} substrate (AWS/Azure/GCP/on-prem/bare-metal). Return a concise scale profile.",
  { subagent: "research" },
);

phase("Size");
const sizing = await agent(
  "Size the {deployment} infrastructure for {account} " + c + " platform " + ver + " from this scale profile. For EACH of the 8 components — network, compute, storage, inference, agents, database, observability, autoscale — specify the sizing (instance classes, counts, storage, autoscale bounds) and write customizations.tf + rationale.md under Deployments/" + c + "/" + ver + "/infrastructure/{component}/. Keep infra-tier SLA targets (uptime/RTO/RPO) in mind. Scale profile follows.\n\n" + scale,
  { subagent: "deployment" },
);

phase("Emit");
const report = await agent(
  "Publish a one-page infra sizing report for {account} " + c + " platform " + ver + ": the per-component sizing, the rationale, and any cost/scale risks. Return the artifact link.",
  { subagent: "deployment" },
);

log("infra-sizing complete for " + c);
return { scale, sizing, report };
