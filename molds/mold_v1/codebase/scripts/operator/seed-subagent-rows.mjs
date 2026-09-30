// operator:seed-subagent-rows — give an EXISTING workspace the "on delegation" workflows row of every declared subagent.
//
//   npm run operator:seed-subagent-rows -- --org onfinance-ai
//
// Idempotent and narrow: it inserts the rows that are missing and touches nothing else (unlike
// `operator:new-org --force`, which rewrites the orgs row). Run it after adding a subagent or applying a subagent
// pack (docs/SUBAGENT_PACKS.md) to a deployment whose workspaces already exist; without the row a subagent's
// runs are not recorded and its operator override has nowhere to live.
import { getDb, closeDb } from "./lib/customer.mjs";
import { withOrgDb } from "../../agent/lib/db/index.ts";
import { orgs } from "../../agent/lib/db/schema.ts";
import { seedSubagentWorkflowRows } from "../../agent/lib/provision-workspace.ts";
import { eq } from "drizzle-orm";
import { glyph, flag, resolveIdentity } from "./lib/operator.mjs";

async function main() {
  const orgId = flag("org").trim();
  if (!orgId) {
    console.error(`${glyph.bad} --org <workspace id> is required.`);
    process.exit(1);
  }
  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }
  const [org] = await db.select({ orgId: orgs.orgId }).from(orgs).where(eq(orgs.orgId, orgId));
  if (!org) {
    console.error(`${glyph.bad} No workspace "${orgId}". Create it first: npm run operator:new-org`);
    await closeDb();
    process.exit(1);
  }
  const actor = resolveIdentity().email || "operator:seed-subagent-rows";
  const { created, skipped } = await withOrgDb(orgId, (tx) => seedSubagentWorkflowRows(tx, orgId, actor));
  console.log(`${glyph.ok} ${orgId}: ${created} subagent row(s) added, ${skipped} already there.`);
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
