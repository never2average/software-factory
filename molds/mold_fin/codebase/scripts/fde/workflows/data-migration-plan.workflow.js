export const meta = {
  name: "data-migration-plan",
  description: "Plan a customer data migration: source, mapping, volume, validation, rollback.",
};

const c = (args && args.customerId) || "";
const source = (args && args.source) || "the legacy source described by the customer";

phase("Plan");
const plan = await agent(
  "Plan a data migration for customer " + c + " from " + source + ". Produce: source inventory, field mapping, volume estimate, a staging-first execution plan, validation (row counts + spot checks), and a rollback plan. Treat the data as sensitive and irreversible — require human approval before any execution. Write the approach under Implementation/" + c + "/migrations/{id}/.",
  { subagent: "data-migration" },
);

log("data-migration-plan complete for " + c);
return { plan };
