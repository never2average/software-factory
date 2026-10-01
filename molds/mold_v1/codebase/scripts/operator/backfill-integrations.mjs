// operator:backfill-integrations — reconstruct a customer's pipeline/integration
// history into the canonical Implementation/ layout + the `implementation` row.
//
//   npm run operator:backfill-integrations -- --customer contoso-bank --org <workspace id> \
//     [--pipeline pl-collections] [--summary "Collections ETL via Integromat"] \
//     [--from-file integrations.json]
//
// Writes/updates ONE `implementation` row (idempotent by customer) and materialises
// Implementation/{id}/pipelines/{pid}/pipeline_config.json + integromat.json.
// --from-file takes an array of { pipelineId, summary, config }. See
// docs/OPERATOR_WORKFLOW.md (stage 5).
import { getDb, closeDb, dataroom, workspaceFor, nowIso, appendInteraction, readFromFile, checkValues } from "./lib/customer.mjs";
import { getCustomer as getRecord, upsertCustomer } from "../../agent/lib/system-of-record.ts";
import { implementationSchema } from "../../agent/lib/customer-schema.ts";
import { glyph, flag, resolveIdentity, isOnfinance } from "./lib/operator.mjs";

async function main() {
  const customerId = flag("customer").trim();
  if (!customerId) {
    console.error(`${glyph.bad} --customer <id> is required.`);
    process.exit(1);
  }
  const { email: me } = resolveIdentity();
  if (!me || !isOnfinance(me)) {
    console.error(`${glyph.bad} No @onfinance.in identity — run \`node setup/workspace-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }
  // The workspace, named (--org): a company id names a company only within a workspace (mold_v1-118).
  const orgId = workspaceFor();
  const record = await getRecord(customerId, orgId);
  const customer = record ? { customerName: record.name } : null;
  if (!customer) {
    console.error(`${glyph.bad} Customer "${customerId}" not found in ${orgId}. Create it first (operator:new-customer).`);
    await closeDb();
    process.exit(1);
  }

  // Resolve the pipeline set: --from-file array, or a single --pipeline.
  const fromFile = readFromFile();
  const pipelines = Array.isArray(fromFile)
    ? fromFile
    : [{ pipelineId: flag("pipeline").trim() || "pl-001", summary: flag("summary").trim() || "Backfilled pipeline", config: null }];

  console.log(`Backfill integrations: ${customerId}  (${pipelines.length} pipeline(s))\n`);

  // 1. The implementation row (integration-readiness bearing), through the system of record (see
  // backfill-customizations): schema, own-field validator, the account's workspace, only these fields on an
  // existing row. The raw INSERT it replaces wrote values the schema does not allow ("integration", "medium",
  // "backfilled", an email as the blocker owner) and no workspace.
  const fields = {
    connectorProvisioningStatus: "Connected",
    launchScopeSolutionIds: pipelines.map((p) => p.pipelineId),
    implementationOwnerEmail: me,
    implementationLastUpdatedAt: nowIso(),
  };
  const row = record.implementation
    ? fields
    : { implementationStage: "Integration", implementationProgressPct: 0, implementationRiskLevel: "Yellow", blockerOwner: "None", ...fields };
  const refused = checkValues(implementationSchema, row);
  if (refused) {
    console.error(`${glyph.bad} Nothing was written. ${refused}`);
    await closeDb();
    process.exit(1);
  }
  await upsertCustomer({ id: customerId, implementation: row }, orgId);
  console.log(`${glyph.ok} ${record.implementation ? "Updated" : "Created"} implementation row (${customerId}).`);

  // 2. Canonical data-room artifacts per pipeline.
  const store = dataroom(orgId);
  for (const p of pipelines) {
    const pid = p.pipelineId || "pl-001";
    const cfg = p.config ?? {
      pipeline_id: pid,
      summary: p.summary ?? "TODO",
      steps: [],
      integromat: false,
    };
    await store.write(
      `Implementation/${customerId}/pipelines/${pid}/pipeline_config.json`,
      JSON.stringify(cfg, null, 2) + "\n",
    );
    console.log(`${glyph.ok} Wrote Implementation/${customerId}/pipelines/${pid}/pipeline_config.json`);
  }

  // 3. The account-level integromat manifest (list of pipelines wired to it).
  await store.write(
    `Implementation/${customerId}/integromat.json`,
    JSON.stringify({ customer: customerId, pipelines: pipelines.map((p) => p.pipelineId), updatedAt: nowIso() }, null, 2) + "\n",
  );
  console.log(`${glyph.ok} Wrote Implementation/${customerId}/integromat.json`);

  await appendInteraction(store, `Customers/${customerId}/interactions.jsonl`, {
    ts: nowIso(),
    type: "integration_backfilled",
    actor: me,
    summary: `Backfilled ${pipelines.length} pipeline(s): ${pipelines.map((p) => p.pipelineId).join(", ")}.`,
  });

  await closeDb();
  console.log(`\n${glyph.info} Next: fill each pipeline_config.json's steps, then run evals before go-live.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} backfill-integrations failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
