// Parses the checked-in data-room fixtures (data/__fixtures__/dataroom/)
// against the dm.md Zod contract in agent/lib/dataroom-schema.ts — one fixture
// per canonical domain. Run via: npm run validate:dataroom
//
// Note: the fixtures live under data/ (not agent/lib/) because `eve build`
// only accepts authored code modules inside agent/lib/.

import { readFileSync } from "node:fs";
import {
  customerFolderSchema,
  deploymentFolderSchema,
  implementationFolderSchema,
  isSignoffChainComplete,
  personFolderSchema,
  platformVersionFolderSchema,
  solutionAgentFolderSchema,
  ticketFileSchema,
} from "../agent/lib/dataroom-schema.ts";

const fixtures = [
  ["Customers", "customers.json", customerFolderSchema],
  ["Platform", "platform.json", platformVersionFolderSchema],
  ["Deployments", "deployments.json", deploymentFolderSchema],
  ["Solutions", "solutions.json", solutionAgentFolderSchema],
  ["Implementation", "implementation.json", implementationFolderSchema],
  ["Tickets", "tickets.json", ticketFileSchema],
  ["People", "person.json", personFolderSchema],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const parsed = new Map();
for (const [domain, fileName, schema] of fixtures) {
  const url = new URL(`../data/__fixtures__/dataroom/${fileName}`, import.meta.url);
  const result = schema.safeParse(JSON.parse(readFileSync(url, "utf8")));
  if (!result.success) {
    console.error(`${domain} fixture failed to parse (${fileName}):`);
    console.error(result.error.issues);
    process.exit(1);
  }
  parsed.set(domain, result.data);
  console.log(`${domain.padEnd(15)} ok (${fileName})`);
}

// A few cross-artifact sanity checks on the fixture content.
const deployment = parsed.get("Deployments");
const signoffs = deployment.infrastructure?.inference?.signoffs;
assert(signoffs, "Deployments fixture must include an inference signoff chain");
assert(
  !isSignoffChainComplete(signoffs),
  "fixture signoff chain has customer.infosec in_review, so it must not read as complete",
);

const solution = parsed.get("Solutions");
assert((solution.evals?.runs?.length ?? 0) >= 1, "Solutions fixture must include an eval run");
for (const run of solution.evals.runs) {
  const caseIds = new Set(solution.evals.dataset.map((record) => record.caseId));
  for (const output of run.outputs) {
    assert(
      caseIds.has(output.caseId),
      `eval output references unknown dataset caseId: ${output.caseId}`,
    );
  }
}

const person = parsed.get("People");
assert(
  person.interactions.every((row) => row.personId === person.personId),
  "Person fixture interactions must share the folder's personId",
);

console.log("dataroom fixture validation ok");
