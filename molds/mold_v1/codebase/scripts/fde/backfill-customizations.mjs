// fde:backfill-customizations — reconstruct a customer's deployment/customization
// history into the canonical Deployments/ layout + the `deployments` row.
//
//   npm run fde:backfill-customizations -- --customer contoso-bank --version v2.4.0 \
//     [--region APAC] [--cloud aws] [--summary "GPU inference, custom guardrails"] \
//     [--from-file customizations.json]
//
// Writes/updates ONE `deployments` row (idempotent by customer+deploymentId) and
// materialises Deployments/{id}/{ver}/infrastructure/inference/{customizations.tf,
// rationale.md} plus the 4-party signoff skeleton. --from-file takes an array of
// { title, tf, rationale } customizations. See docs/FDE_WORKFLOW.md (stage 4).
import { getDb, closeDb, dataroom, getCustomer, nowIso, appendInteraction, readFromFile } from "./lib/customer.mjs";
import { deployments } from "../../agent/lib/db/schema.ts";
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
  const customer = await getCustomer(db, customerId);
  if (!customer) {
    console.error(`${glyph.bad} Customer "${customerId}" not found. Create it first (fde:new-customer).`);
    await closeDb();
    process.exit(1);
  }

  console.log(`Backfill customizations: ${customerId} @ ${version}\n`);

  // 1. The deployment row (customization-bearing).
  const deploymentId = `${version}`;
  await db
    .insert(deployments)
    .values({
      customerId,
      deploymentId,
      environment: flag("environment").trim() || "production",
      region: flag("region").trim() || "unknown",
      cloudProvider: flag("cloud").trim() || null,
      deployedVersion: version,
      releaseStatus: "deployed",
      healthStatus: "unknown",
      deployOwnerEmail: fde,
      notes: flag("summary").trim() || null,
      lastDeployAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [deployments.customerId, deployments.deploymentId],
      set: { deployedVersion: version, deployOwnerEmail: fde, notes: flag("summary").trim() || null },
    });
  console.log(`${glyph.ok} Upserted deployments row (${customerId}, ${deploymentId}).`);

  // 2. The canonical data-room artifacts.
  const store = dataroom();
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
