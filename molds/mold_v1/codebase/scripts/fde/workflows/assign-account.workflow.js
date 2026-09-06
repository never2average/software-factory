export const meta = {
  name: "assign-account",
  description: "Propose and (on confirmation) set the durable FDE owner for a new or unowned customer.",
};

const c = (args && args.customerId) || "";

phase("Propose");
const proposal = await agent(
  "Choose the best FDE owner for customer " + c + ". Call list_fdes for the roster with live load; pick the least-loaded FDE (accounts owned + open tickets vs their capacity target) whose skills match this account's product/regime. Present the recommendation with rationale and the runner-up. Do NOT reassign yet — this is a proposal for a human to confirm.",
  { subagent: "customer-context" },
);

log("assign-account proposed an owner for " + c);
return { proposal };
