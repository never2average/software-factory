// operator:configure-agents — scaffold a reusable AGENT solution under
// {folder:solutions}/{ver}/agents/{id}/ (the agents sibling of configure-solution): its data
// schema, run-config contract, recipe + recipe seed folder, and eval dataset/benchmark.
// Optionally, with --customer, upsert the solutions row and seed the customer's
// Deployments agent recipe folder.
//
//   npm run operator:configure-agents -- --version v2.4.0 --id collections-agent \
//     --use-case "Autonomous collections triage" [--customer contoso-bank --org <workspace id>]
//
// See docs/OPERATOR_WORKFLOW.md. Agents are solutions too — same validate + eval gate.
import { getDb, closeDb, dataroom, getCustomer, workspaceFor, withOrgDb, writeIfAbsent, schemaStub } from "./lib/customer.mjs";
import { solutions } from "../../agent/lib/db/schema.ts";
import { glyph, flag, resolveIdentity, isOperatorIdentity, ALLOWED_DOMAIN } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";
import { FOLDER } from "../../agent/lib/dataroom-folders.ts";

async function main() {
  const version = flag("version").trim();
  const id = flag("id").trim();
  if (!version || !id) {
    console.error(`${glyph.bad} --version and --id (agent id) are required.`);
    process.exit(1);
  }
  const useCase = flag("use-case").trim() || "TODO";
  const { email: me } = resolveIdentity();
  if (!me || !isOperatorIdentity(me)) {
    console.error(`${glyph.bad} No @${ALLOWED_DOMAIN} identity — run \`node setup/workspace-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  console.log(`Configure agent solution: ${id} @ ${version}\n`);

  const store = dataroom(workspaceFor());
  const base = `${FOLDER.solutions}/${version}/agents/${id}`;
  const existing = await store.list(base);
  const files = {
    "dataplatform.schemas.json": schemaStub(`dataplatform — ${id}`),
    "run_configs.schema.json": schemaStub(`run_configs — ${id}`),
    "recipe.md": agentRecipe(id, version, useCase),
    "recipe/README.md": `# Recipe seed — ${id}\n\nFiles the agent seeds into its workspace before its first run.\n`,
    "evals/dataset.jsonl": "",
    "evals/benchmark.jsonl": "",
  };
  let wrote = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (await writeIfAbsent(store, existing, `${base}/${rel}`, content)) wrote++;
  }
  console.log(`${glyph.ok} ${base}: ${wrote} file(s) scaffolded (schemas + recipe + recipe/ seed + evals).`);

  const customerId = flag("customer").trim();
  if (customerId) {
    const db = getDb();
    if (!db) {
      console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
      process.exit(1);
    }
    // The workspace, named (--org): a company id names a company only within a workspace (mold_v1-118).
    const orgId = workspaceFor();
    if (!(await getCustomer(db, orgId, customerId))) {
      console.error(`${glyph.bad} ${W.Account} "${customerId}" not found in ${orgId}. Create it first (operator:new-customer).`);
      await closeDb();
      process.exit(1);
    }
    await withOrgDb(orgId, (tx) => tx
      .insert(solutions)
      .values({ orgId, customerId, solutionId: id, useCase, businessProcess: "agent", modulesEnabled: [], solutionStatus: "configuring", solutionOwner: me, solutionFdeOwner: me })
      .onConflictDoUpdate({ target: [solutions.orgId, solutions.customerId, solutions.solutionId], set: { useCase, businessProcess: "agent", solutionStatus: "configuring", solutionOwner: me, solutionFdeOwner: me } }));
    // Seed the customer's deployment agent recipe folder (dm.md recipe seam).
    const dep = `${FOLDER.deliveries}/${customerId}/${version}/platform/agents/${id}`;
    // In the workspace's own data room: {folder:deliveries}/{customer_id}/… is per company, and so per workspace.
    const customerStore = dataroom(orgId);
    const depExisting = await customerStore.list(dep);
    await writeIfAbsent(customerStore, depExisting, `${dep}/recipe.md`, `# ${id} — seeded for ${customerId}\n\nSeeded from ${base}. Configure before first run.\n`);
    console.log(`${glyph.ok} Registered solutions row (agent) + seeded ${dep}.`);
    await closeDb();
  }

  console.log(`\n${glyph.info} Author recipe.md + the run-config schema, seed evals/, then \`npm run operator:validate-solution -- --version ${version} --id ${id} --kind agent\`.`);
}

function agentRecipe(id, version, useCase) {
  return `# Agent recipe — ${id} (${version})

Use case: **${useCase}**

## Role & scope
_What the agent decides, and what it must never do._

## Tools & data
_Which connectors/data-room paths it reads; run_configs.schema.json is its contract._

## Guardrails
_Policy, human-review threshold, escalation._

## Evals
_Seed evals/dataset.jsonl (cases) + benchmark.jsonl (targets). Automated PASS ≠ sign-off._
`;
}

main().catch(async (e) => {
  console.error(`${glyph.bad} configure-agents failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
