// fde:backfill-customizations — reconstruct a customer's deployment/customization
// history into the canonical Deployments/ layout + the `deployments` row.
//
//   npm run fde:backfill-customizations -- --customer contoso-bank --org <workspace id> --version v2.4.0 \
//     [--region ap-south-1] [--cloud aws] [--summary "GPU inference, custom guardrails"] \
//     [--from-file customizations.json]
//
// Writes/updates ONE `deployments` row (idempotent by customer+deploymentId; through the system of record, so the
// schema and the profile's own-field validator apply; --region must be one of the schema's regions unless the
// profile fixes one; --environment defaults to prod) and
// materialises Deployments/{id}/{ver}/infrastructure/inference/{customizations.tf,
// rationale.md} plus the 4-party signoff skeleton. --from-file takes an array of
// { title, tf, rationale } customizations. See docs/FDE_WORKFLOW.md (stage 4).
import { getDb, closeDb, dataroom, workspaceFor, nowIso, appendInteraction, readFromFile, checkValues, fixedOr } from "./lib/customer.mjs";
import { getCustomer as getRecord, upsertCustomer } from "../../agent/lib/system-of-record.ts";
import { deploymentSchema } from "../../agent/lib/customer-schema.ts";
import { glyph, flag, resolveIdentity, isOnfinance } from "./lib/fde.mjs";

async function main() {
  const customerId = flag("customer").trim();
  const version = flag("version").trim();
  if (!customerId || !version) {
    console.error(`${glyph.bad} --customer <id> and --version <platform_version_id> are required.`);
    process.exit(1);
  }
  const { email: fde } = resolveIdentity();
  if (!fde || !isOnfinance(fde)) {
    console.error(`${glyph.bad} No @onfinance.in identity — run \`node setup/fde-login.mjs\` or pass --email.`);
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
    console.error(`${glyph.bad} Customer "${customerId}" not found in ${orgId}. Create it first (fde:new-customer).`);
    await closeDb();
    process.exit(1);
  }

  console.log(`Backfill customizations: ${customerId} @ ${version}\n`);

  // 1. The deployment row (customization-bearing), written through the system of record: the same schema and
  // own-field validator as every other write path, stamped with the account's workspace, and only the fields named
  // here changed on a row that already exists. It used to be a raw INSERT with no workspace (refused under row-level
  // security) and values the schema does not allow ("production", "unknown"), with no own-field check at all.
  const deploymentId = `${version}`;
  const stored = record.deployments?.some((d) => d.deploymentId === deploymentId);
  const summary = flag("summary").trim();
  const row = stored
    ? { deploymentId, deployedVersion: version, deployOwnerEmail: fde, ...(summary ? { notes: summary } : {}) }
    : {
        deploymentId,
        environment: flag("environment").trim() || fixedOr("environment", "prod"),
        region: flag("region").trim() || fixedOr("region", ""),
        ...(flag("cloud").trim() ? { cloudProvider: flag("cloud").trim() } : {}),
        deployedVersion: version,
        releaseStatus: "deployed",
        healthStatus: "unknown",
        deployOwnerEmail: fde,
        ...(summary ? { notes: summary } : {}),
        lastDeployAt: nowIso(),
      };
  const refused = checkValues(deploymentSchema, row);
  if (refused) {
    console.error(`${glyph.bad} Nothing was written. ${refused}`);
    await closeDb();
    process.exit(1);
  }
  await upsertCustomer({ id: customerId, deployments: [row] }, orgId);
  console.log(`${glyph.ok} ${stored ? "Updated" : "Created"} deployments row (${customerId}, ${deploymentId}).`);

  // 2. The canonical data-room artifacts.
  const store = dataroom(orgId);
  const base = `Deployments/${customerId}/${version}/infrastructure/inference`;
  const items = readFromFile() ?? [
    {
      title: flag("summary").trim() || "Baseline customization",
      tf: `# ${customerId} @ ${version} — inference customizations\n# TODO: terraform for model routing, guardrails, capacity.\n`,
      rationale: `# Rationale — ${customerId} @ ${version}\n\n${flag("summary").trim() || "_TODO: why these customizations._"}\n`,
    },
  ];
  const list = Array.isArray(items) ? items : [items];
  // customizations.tf = concatenated tf blocks; rationale.md = concatenated notes.
  const tf = list.map((c) => `## ${c.title}\n${c.tf ?? ""}`).join("\n\n");
  const rationale =
    `# Customization rationale — ${customer.customerName} @ ${version}\n\n` +
    list.map((c) => `## ${c.title}\n\n${c.rationale ?? "_TODO_"}`).join("\n\n") +
    `\n`;
  await store.write(`${base}/customizations.tf`, tf.endsWith("\n") ? tf : tf + "\n");
  await store.write(`${base}/rationale.md`, rationale);
  console.log(`${glyph.ok} Wrote ${base}/customizations.tf + rationale.md (${list.length} item(s)).`);

  // 3. The 4-party signoff skeleton — never overwrite an existing signoff.
  const signoffs = ["internal.md", "customer.infra.md", "customer.infosec.md", "customer.cloudvendor.md"];
  const existing = await store.list(`${base}/signoff`);
  for (const f of signoffs) {
    const p = `${base}/signoff/${f}`;
    if (!existing.includes(p)) {
      await store.write(p, `# Signoff: ${f.replace(".md", "")}\n\n- Status: PENDING\n- Reviewer: TODO\n- Date: TODO\n`);
    }
  }
  console.log(`${glyph.ok} Ensured 4-party signoff skeleton under ${base}/signoff/.`);

  await appendInteraction(store, `Customers/${customerId}/interactions.jsonl`, {
    ts: nowIso(),
    type: "customization_backfilled",
    actor: fde,
    summary: `Backfilled ${list.length} customization(s) for ${version}.`,
  });

  await closeDb();
  console.log(`\n${glyph.info} Signoffs are PENDING — the deployment isn't done until the 4-party chain is signed.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} backfill-customizations failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
