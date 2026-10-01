// operator:configure-infra — scaffold a customer deployment's infrastructure substrate
// under Deployments/{customer}/{ver}/infrastructure/ across the eight domains, plus
// the 4-party signoff skeleton, and upsert the deployments row. This is the
// per-deployment substrate a solution runs on — not a solution itself.
//
//   npm run operator:configure-infra -- --customer contoso-bank --org <workspace id> --version v2.4.0 \
//     [--region ap-south-1] [--cloud aws] [--environment prod]
//
// See docs/OPERATOR_WORKFLOW.md (stage 4). Signoffs seed as PENDING — the deployment is
// not done until the four parties sign.
import { getDb, closeDb, dataroom, workspaceFor, writeIfAbsent, checkValues, fixedOr } from "./lib/customer.mjs";
import { getCustomer as getRecord, upsertCustomer } from "../../agent/lib/system-of-record.ts";
import { deploymentSchema } from "../../agent/lib/customer-schema.ts";
import { glyph, flag, resolveIdentity, isOnfinance } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";

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
  if (!record) {
    console.error(`${glyph.bad} ${W.Account} "${customerId}" not found in ${orgId}. Create it first (operator:new-customer).`);
    await closeDb();
    process.exit(1);
  }

  console.log(`Configure infra: ${customerId} @ ${version}\n`);

  // 1. The deployments row (the runtime instance), through the system of record: the schema and the profile's
  // own-field validator apply, the row is stamped with the account's workspace, and on a row that exists only the
  // status and owner change. It was a raw INSERT with no workspace and values the schema refuses ("production",
  // "unknown", "configuring").
  const stored = record.deployments?.some((d) => d.deploymentId === version);
  const row = stored
    ? { deploymentId: version, releaseStatus: "in-progress", deployOwnerEmail: me }
    : {
        deploymentId: version,
        environment: flag("environment").trim() || fixedOr("environment", "prod"),
        region: flag("region").trim() || fixedOr("region", ""),
        ...(flag("cloud").trim() ? { cloudProvider: flag("cloud").trim() } : {}),
        deployedVersion: version,
        releaseStatus: "in-progress",
        healthStatus: "unknown",
        deployOwnerEmail: me,
      };
  const refused = checkValues(deploymentSchema, row);
  if (refused) {
    console.error(`${glyph.bad} Nothing was written. ${refused}`);
    await closeDb();
    process.exit(1);
  }
  await upsertCustomer({ id: customerId, deployments: [row] }, orgId);
  console.log(`${glyph.ok} ${stored ? "Updated" : "Created"} ${W.deployments} row (${customerId}, ${version}).`);

  // 2. The infra domain scaffold (blob). Never clobber authored infra.
  const store = dataroom(orgId);
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
