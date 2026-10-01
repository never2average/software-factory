// operator:configure-platform — author a platform VERSION's design-decision schemas +
// reference architecture (the contract every solution binds to). Optionally, with
// --customer, upsert that customer's platform-governance row.
//
//   npm run operator:configure-platform -- --version v2.4.0
//   npm run operator:configure-platform -- --version v2.4.0 --customer contoso-bank --org <workspace id> \
//     --deployment-model single_tenant --residency in-country --primary-model claude-opus-4.8 \
//     --use-case "collections triage"
//
// Version-scoped writes go to Platform/{ver}/ (shared, blob-only). The per-customer
// governance row is the `platform` table. See docs/OPERATOR_WORKFLOW.md (stage 3).
import { getDb, closeDb, dataroom, getCustomer, workspaceFor, withOrgDb, writeIfAbsent, schemaStub } from "./lib/customer.mjs";
import { platform } from "../../agent/lib/db/schema.ts";
import { glyph, flag, resolveIdentity, isOnfinance } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";

// The seven design-decision schemas that make up the platform contract (dm.md).
const DESIGN_SCHEMAS = [
  "tenancy",
  "organization",
  "dataplatform",
  "dataengineering",
  "agents",
  "pipeline_config",
  "integromat",
];

async function main() {
  const version = flag("version").trim();
  if (!version) {
    console.error(`${glyph.bad} --version <platform_version_id> is required (e.g. v2.4.0).`);
    process.exit(1);
  }
  const { email: me } = resolveIdentity();
  if (!me || !isOnfinance(me)) {
    console.error(`${glyph.bad} No @onfinance.in identity — run \`node setup/workspace-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  console.log(`Configure platform version: ${version}\n`);

  // 1. The version contract (blob, shared). Never clobber authored schemas.
  const store = dataroom(workspaceFor());
  const existing = await store.list(`Platform/${version}`);
  let wrote = 0;
  for (const name of DESIGN_SCHEMAS) {
    const p = `Platform/${version}/design_decisions/${name}.schemas.json`;
    if (await writeIfAbsent(store, existing, p, schemaStub(`${name} — ${version}`))) wrote++;
  }
  if (await writeIfAbsent(store, existing, `Platform/${version}/architecture/helm/values.yaml`, `# ${version} helm values — TODO\n`)) wrote++;
  if (await writeIfAbsent(store, existing, `Platform/${version}/architecture/infrastructure/main.tf`, `# ${version} reference terraform — TODO\n`)) wrote++;
  console.log(`${glyph.ok} Platform/${version} contract: ${wrote} file(s) scaffolded (${DESIGN_SCHEMAS.length} schemas + architecture).`);

  // 2. Optional: the customer's platform-governance row (per-customer instance).
  const customerId = flag("customer").trim();
  if (customerId) {
    const db = getDb();
    if (!db) {
      console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
      process.exit(1);
    }
    const orgId = workspaceFor();
    if (!(await getCustomer(db, orgId, customerId))) {
      console.error(`${glyph.bad} ${W.Account} "${customerId}" not found in ${orgId}. Create it first (operator:new-customer).`);
      await closeDb();
      process.exit(1);
    }
    await withOrgDb(orgId, (tx) => tx
      .insert(platform)
      .values({
        orgId,
        customerId,
        deploymentModel: flag("deployment-model").trim() || "single_tenant",
        dataResidencyConstraint: flag("residency").trim() || "none",
        primaryModel: flag("primary-model").trim() || "claude-opus-4.8",
        primaryUseCase: flag("use-case").trim() || "TODO",
        enabledConnectors: [],
        featureFlags: [],
        platformConfigStatus: "configuring",
      })
      .onConflictDoUpdate({
        // The company's whole key: the same id in another workspace is another company.
        target: [platform.orgId, platform.customerId],
        set: {
          deploymentModel: flag("deployment-model").trim() || "single_tenant",
          dataResidencyConstraint: flag("residency").trim() || "none",
          primaryModel: flag("primary-model").trim() || "claude-opus-4.8",
          platformConfigStatus: "configuring",
        },
      }));
    console.log(`${glyph.ok} Upserted platform-governance row for ${customerId} in ${orgId}.`);
    await closeDb();
  }

  console.log(`\n${glyph.info} Fill the schema stubs, then configure solutions/agents that bind to this contract.`);
}

main().catch(async (e) => {
  console.error(`${glyph.bad} configure-platform failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
