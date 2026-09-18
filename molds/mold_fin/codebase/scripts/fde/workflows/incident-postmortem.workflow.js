export const meta = {
  name: "incident-postmortem",
  description: "Build a postmortem from an incident ticket and timeline.",
};

const c = (args && args.customerId) || "";
const ticket = (args && args.ticketId) || "the most recent P0/P1 incident";

phase("Reconstruct");
const timeline = await agent(
  "Reconstruct the timeline for incident " + ticket + " (customer " + c + "): detection, mitigation, resolution, and the interactions/tickets along the way. Return the timeline and the customer impact.",
  { subagent: "deployment" },
);

phase("Postmortem");
const postmortem = await agent(
  "Write a blameless postmortem for incident " + ticket + " (customer " + c + ") from this timeline: root cause, contributing factors, remediation done, preventive actions with owners, and whether an SLA was breached. Record it into the ticket's postmortem fields and publish the doc. Timeline follows.\n\n" + timeline,
  { subagent: "follow-ups" },
);

log("incident-postmortem complete for " + ticket);
return { timeline, postmortem };
