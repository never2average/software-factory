export const meta = {
  name: "onboard-account",
  description: "End-to-end onboard a new {account}: seed context, research, and assign an owner.",
};

const c = (args && args.customerId) || "";
const name = (args && args.customerName) || c;

phase("Seed");
const seeded = await agent(
  "Onboard new {account} " + c + " (" + name + "): confirm/create the {account} record at lifecycle Onboarding, seed {folder:accounts}/" + c + "/context.md from what's known, and log an account-created interaction. Return what was seeded.",
  { subagent: "customer-context" },
);

phase("Research");
const research = await agent(
  "Research the newly onboarded {account} " + c + " to enrich its system of record and context: use case, org map, scale, regulatory profile. Return a concise {account} brief.",
  { subagent: "research" },
);

phase("Assign owner");
const assignment = await agent(
  "Recommend the best {owner} for {account} " + c + ": call list_members, pick the least-loaded {member} whose skills match this {account}'s product/regime, and propose the assignment with rationale for a human to confirm (do not force it). Return the recommendation.",
  { subagent: "customer-context" },
);

log("onboard-account complete for " + c);
return { seeded, research, assignment };
