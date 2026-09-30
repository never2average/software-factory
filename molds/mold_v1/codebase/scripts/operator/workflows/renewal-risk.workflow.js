export const meta = {
  name: "renewal-risk",
  description: "Assess a customer's renewal risk and produce a save plan with owner actions.",
};

const c = (args && args.customerId) || "";

phase("Assess");
const assessment = await agent(
  "Assess renewal risk for customer " + c + ": health trend, SLA breaches, ticket load, engagement/interaction recency, value realization vs target, and renewal date proximity. Return a risk level (low/medium/high) with the evidence.",
  { subagent: "customer-context" },
);

phase("Save plan");
const plan = await agent(
  "From this renewal-risk assessment for " + c + ", produce a save plan: the top risks, the specific actions to de-risk (with owners and due dates), and file follow-up tickets for the owner. Publish the plan. Assessment follows.\n\n" + assessment,
  { subagent: "follow-ups" },
);

log("renewal-risk complete for " + c);
return { assessment, plan };
