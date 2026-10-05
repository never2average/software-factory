export const meta = {
  name: "eval-regression-triage",
  description: "Run a {account}'s eval suite, interpret regressions, and file fix tickets.",
};

const c = (args && args.customerId) || "";

phase("Run + interpret");
const findings = await agent(
  "Run the eval suite for {account} " + c + " (or the latest run's outputs), compare against the benchmark, and identify regressions: which cases got worse, by how much, and the likely cause. Return the regressions ranked by severity.",
  { subagent: "evals" },
);

phase("Triage");
const triage = await agent(
  "From these eval regressions for " + c + ", file a fix ticket per real regression (owned by the {account}'s fde_owner, priority by severity) and post a short triage summary. Regressions follow.\n\n" + findings,
  { subagent: "follow-ups" },
);

log("eval-regression-triage complete for " + c);
return { findings, triage };
