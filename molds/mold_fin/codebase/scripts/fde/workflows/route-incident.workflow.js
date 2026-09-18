export const meta = {
  name: "route-incident",
  description: "Route a genuine incident (SLA breach / P0 / P1) to the on-call via PagerDuty.",
};

const c = (args && args.customerId) || "";
const ticket = (args && args.ticketId) || "";

phase("Route");
const routed = await agent(
  "Route the incident for ticket " + ticket + " (customer " + c + ") to on-call. Confirm it is a genuine P0/P1 or SLA breach; read get_oncall to name the responder; then page_oncall with dedupKey = the ticket id, severity by impact, and a one-line summary. Post a short note of who was paged. If it is not genuinely incident-grade, do not page — say so.",
  { subagent: "follow-ups" },
);

log("route-incident complete for ticket " + ticket);
return { routed };
