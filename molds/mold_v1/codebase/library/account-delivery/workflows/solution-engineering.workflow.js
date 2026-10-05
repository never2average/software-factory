export const meta = {
  name: "solution-engineering",
  description: "Scope and design a reusable solution for a {account}: research, design, seed evals, package.",
};

const c = (args && args.customerId) || "";
const ask = (args && args.request) || "the {account}'s stated needs";

phase("Research");
const research = await agent(
  "Research {account} " + c + " for a new solution. Ground on the system of record and recent interactions. Return: their use case, data sources, scale (users/volume/throughput), regulatory constraints, and the requirements for " + ask + ". Keep it tight.",
  { subagent: "research" },
);

phase("Design");
const design = await agent(
  "Design a solution for {account} " + c + " from this research. Pick the platform version, define the schema contract and the agent/pipeline recipe, and write them under {folder:solutions}/{ver}/. Flag any risky/irreversible choices for human approval. Research follows.\n\n" + research,
  { subagent: "configuration" },
);

phase("Evals");
const evals = await agent(
  "Seed acceptance evals (dataset + benchmark) for the solution just designed for " + c + ". Place them under the solution's evals/ folder. Summarize what they check.",
  { subagent: "evals" },
);

phase("Package");
const report = await agent(
  "Validate the " + c + " solution (schema parses, recipe filled, evals seeded) and publish a one-page solution design doc summarizing the design decisions, the recipe, and the eval coverage. Return the artifact link.",
  { subagent: "configuration" },
);

log("solution-engineering complete for " + c);
return { research, design, evals, report };
