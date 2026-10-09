// operator:configure-solution — scaffold a reusable pipeline solution as a self-describing
// "minified solution-manager" under {folder:solutions}/{ver}/pipelines/{id}/: its schema
// (contract), its config (artifact), its recipe (staged authoring), plus evals,
// migrations and grounding. Optionally, with --customer, upsert the solutions row
// and seed the customer's Deployments instance from the recipe.
//
//   npm run operator:configure-solution -- --version v2.4.0 --id pl-collections \
//     --use-case "Collections triage" [--customer contoso-bank --org <workspace id>]
//
// See docs/OPERATOR_WORKFLOW.md — a configured solution is validated + eval-gated, not
// PR-gated; the gate is `operator:validate-solution` + the eval acceptance.
import { getDb, closeDb, dataroom, getCustomer, workspaceFor, withOrgDb, writeIfAbsent, schemaStub } from "./lib/customer.mjs";
import { solutions } from "../../agent/lib/db/schema.ts";
import { glyph, flag, resolveIdentity, isOperatorIdentity, ALLOWED_DOMAIN } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";
import { FOLDER } from "../../agent/lib/dataroom-folders.ts";

async function main() {
  const version = flag("version").trim();
  const id = flag("id").trim();
  if (!version || !id) {
    console.error(`${glyph.bad} --version and --id (pipeline id) are required.`);
    process.exit(1);
  }
  const useCase = flag("use-case").trim() || "TODO";
  const { email: me } = resolveIdentity();
  if (!me || !isOperatorIdentity(me)) {
    console.error(`${glyph.bad} No @${ALLOWED_DOMAIN} identity — run \`node setup/workspace-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  console.log(`Configure solution (pipeline): ${id} @ ${version}\n`);

  // The self-contained solution instance (blob). Never clobber authored files.
  // Only the dm.md-valid files: the contract (run_configs + integromat schemas)
  // and the artifact (pipeline_config.json). Evals ({run_id}/…), migrations
  // ({migration_id}/…) and background_research ({person_id}/…) are created per
  // run/change, not pre-seeded empty. The authoring recipe lives in the skill.
  const store = dataroom(workspaceFor());
  const base = `${FOLDER.solutions}/${version}/pipelines/${id}`;
  const existing = await store.list(base);
  const files = {
    "run_configs.schema.json": schemaStub(`run_configs — ${id}`),
    "integromat.schema.json": schemaStub(`integromat — ${id}`),
    "pipeline_config.json": JSON.stringify({ pipeline_id: id, use_case: useCase, steps: [], integromat: false, "x-status": "TODO" }, null, 2) + "\n",
  };
  let wrote = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (await writeIfAbsent(store, existing, `${base}/${rel}`, content)) wrote++;
  }
  console.log(`${glyph.ok} ${base}: ${wrote} file(s) scaffolded (run_configs + integromat schemas + pipeline_config).`);

  // Optional: register the customer instance (solutions row) + seed the deployment.
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
      .values({ orgId, customerId, solutionId: id, useCase, modulesEnabled: [], solutionStatus: "configuring", solutionOwner: me })
      .onConflictDoUpdate({ target: [solutions.orgId, solutions.customerId, solutions.solutionId], set: { useCase, solutionStatus: "configuring", solutionOwner: me } }));
    // Seed the customer's deployment instance from the recipe (dm.md recipe seam).
    const dep = `${FOLDER.deliveries}/${customerId}/${version}/platform/pipelines/${id}`;
    // In the workspace's own data room: {folder:deliveries}/{customer_id}/… is per company, and so per workspace.
    const customerStore = dataroom(orgId);
    const depExisting = await customerStore.list(dep);
    await writeIfAbsent(customerStore, depExisting, `${dep}/pipeline_config.json`, JSON.stringify({ pipeline_id: id, use_case: useCase, seeded_from: base, steps: [] }, null, 2) + "\n");
    console.log(`${glyph.ok} Registered solutions row + seeded ${dep} from the recipe.`);
    await closeDb();
  }

  console.log(`\n${glyph.info} Define run_configs.schema.json, fill pipeline_config.json steps, then \`npm run operator:validate-solution -- --version ${version} --id ${id}\`.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} configure-solution failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
