export const meta = {
  name: "infosec-checklist",
  description: "Generate a {account}'s information-security checklist from their regulatory profile and map it to the infosec signoff.",
};

const c = (args && args.customerId) || "";
const ver = (args && args.platformVersionId) || "v2.0";

phase("Profile");
const profile = await agent(
  "Read {account} " + c + " regulatory + security profile from context.md and the system of record: their regime (RBI/SEBI/IRDAI/other), data-residency requirements, {deployment} substrate, and any stated security asks. Return a concise profile.",
  { subagent: "research" },
);

phase("Generate");
const checklist = await agent(
  "Generate the information-security checklist/questionnaire for {account} " + c + " (platform " + ver + ") from this profile and the platform security schemas. Cover: SBOM, RBAC/least-privilege, encryption at rest + in transit, key management, data residency, audit logging, vulnerability management + pen-test, access reviews, DR/BCP (RTO/RPO), and incident response. Mark each item required/optional for their regime, and write it to the {deployment}'s security/ folder. Profile follows.\n\n" + profile,
  { subagent: "configuration" },
);

phase("Signoff");
const signoff = await agent(
  "Record the customer.infosec signoff item for {account} " + c + " platform " + ver + " referencing the infosec checklist just generated, set to PENDING, and publish the checklist as a shareable artifact. Return the artifact link and signoff status.",
  { subagent: "deployment" },
);

log("infosec-checklist complete for " + c);
return { profile, checklist, signoff };
