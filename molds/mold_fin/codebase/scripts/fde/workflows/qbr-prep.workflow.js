export const meta = {
  name: "qbr-prep",
  description: "Prepare a customer QBR: interactions, tickets, health, value realization into a report.",
};

const c = (args && args.customerId) || "";

phase("Gather");
const gathered = await agent(
  "Gather the QBR inputs for customer " + c + ": recent interactions, open + resolved tickets, health/status, SLA posture, and value-realization (target vs realized annual value, success criteria). Return a structured summary.",
  { subagent: "customer-context" },
);

phase("Compose");
const deck = await agent(
  "Compose a QBR report for customer " + c + " from these inputs: where they are, wins, open risks, SLA/health, value delivered vs target, and the next-quarter plan. Publish it as an artifact. Inputs follow.\n\n" + gathered,
  { subagent: "follow-ups" },
);

log("qbr-prep complete for " + c);
return { gathered, deck };
