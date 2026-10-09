export const meta = {
  name: "go-live-sprint",
  description: "Assess a {deployment}'s readiness, build the go-live runbook, and file blocker tickets with owners.",
};

const c = (args && args.customerId) || "";
const ver = (args && args.platformVersionId) || "v2.0";

phase("Assess");
const readiness = await parallel([
  () => agent("Report the {deployment}-tracker phase status and the 4-party signoff chain (internal, customer.infra, customer.infosec, customer.cloudvendor) for {account} " + c + " platform " + ver + ". Name what's incomplete.", { subagent: "deployment" }),
  () => agent("Report the data-migration state for {account} " + c + ": what's migrated, validated, and pending.", { subagent: "data-migration" }),
  () => agent("Report the latest eval/acceptance results for {account} " + c + " and whether they pass the go-live bar.", { subagent: "evals" }),
]);

phase("Runbook");
const runbook = await agent(
  "Build the go-live runbook for {account} " + c + " platform " + ver + " from this readiness assessment. Cover: 4-party signoff complete, data migration validated, evals passed, UAT signoff, DNS/SSO/SMTP/email integration, RBI/SEBI scraper configured, circulars processed, and rollback plan. Mark each item Ready/At-Risk/Blocked with the owner. Publish the runbook artifact. Readiness follows.\n\n" + JSON.stringify(readiness),
  { subagent: "deployment" },
);

phase("Blockers");
const blockers = await agent(
  "From the go-live runbook for " + c + ", file a ticket for each Blocked/At-Risk item (owned by the {account}'s account_owner, priority by go-live impact) and post a ranked blocker list. Runbook follows.\n\n" + runbook,
  { subagent: "follow-ups" },
);

log("go-live-sprint complete for " + c);
return { readiness, runbook, blockers };
