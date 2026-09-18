// fde:configure-infra — scaffold a customer deployment's infrastructure substrate
// under Deployments/{customer}/{ver}/infrastructure/ across the eight domains, plus
// the 4-party signoff skeleton, and upsert the deployments row. This is the
// per-deployment substrate a solution runs on — not a solution itself.
//
//   npm run fde:configure-infra -- --customer contoso-bank --version v2.4.0 \
//     [--region APAC] [--cloud aws]
//
// See docs/FDE_WORKFLOW.md (stage 4). Signoffs seed as PENDING — the deployment is
// not done until the four parties sign.
import { getDb, closeDb, dataroom, getCustomer, writeIfAbsent } from "./lib/customer.mjs";
import { deployments } from "../../agent/lib/db/schema.ts";
import { glyph, flag, resolveIdentity, isOnfinance } from "./lib/fde.mjs";

// The infrastructure domains under a deployment (dm.md).
const DOMAINS = ["network", "compute", "storage", "inference", "agents", "database", "observability", "autoscale"];
const SIGNOFFS = ["internal.md", "customer.infra.md", "customer.infosec.md", "customer.cloudvendor.md"];

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
  if (!(await getCustomer(db, customerId))) {
    console.error(`${glyph.bad} Customer "${customerId}" not found. Create it first (fde:new-customer).`);
    await closeDb();
    process.exit(1);
  }

  console.log(`Configure infra: ${customerId} @ ${version}\n`);

  // 1. The deployments row (the runtime instance).
  await db
    .insert(deployments)
    .values({
      customerId,
      deploymentId: version,
      environment: flag("environment").trim() || "production",
      region: flag("region").trim() || "unknown",
      cloudProvider: flag("cloud").trim() || null,
      deployedVersion: version,
      releaseStatus: "configuring",
      healthStatus: "unknown",
      deployOwnerEmail: fde,
    })
    .onConflictDoUpdate({ target: [deployments.customerId, deployments.deploymentId], set: { releaseStatus: "configuring", deployOwnerEmail: fde } });
  console.log(`${glyph.ok} Upserted deployments row (${customerId}, ${version}).`);

  // 2. The infra domain scaffold (blob). Never clobber authored infra.
  const store = dataroom();
  const root = `Deployments/${customerId}/${version}/infrastructure`;
  const existing = await store.list(root);
  let wrote = 0;
  // Each domain carries a customizations.tf + rationale.md (dm.md infrastructure
  // template: infrastructure/{component}/{customizations.tf,rationale.md}).
  for (const d of DOMAINS) {
    if (await writeIfAbsent(store, existing, `${root}/${d}/customizations.tf`, `# ${customerId} ${version} — ${d} infrastructure — TODO\n`)) wrote++;
    if (await writeIfAbsent(store, existing, `${root}/${d}/rationale.md`, `# ${d} rationale — ${customerId} @ ${version}\n\n_TODO._\n`)) wrote++;
  }
  for (const s of SIGNOFFS) {
    if (await writeIfAbsent(store, existing, `${root}/inference/signoff/${s}`, `# Signoff: ${s.replace(".md", "")}\n\n- Status: PENDING\n- Reviewer: TODO\n- Date: TODO\n`)) wrote++;
  }
  console.log(`${glyph.ok} ${root}: ${wrote} file(s) scaffolded (${DOMAINS.length} domains + signoff).`);

  await closeDb();
  console.log(`\n${glyph.info} Signoffs are PENDING — drive the 4-party chain before go-live.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} configure-infra failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
