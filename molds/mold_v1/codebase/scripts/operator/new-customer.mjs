// operator:new-customer — create a customer and seed its context in the data room.
//
//   npm run operator:new-customer -- --name "Contoso Bank" --tier Enterprise --org <workspace id> \
//     [--id contoso-bank] [--vertical banking] [--region APAC] \
//     [--business-owner cfo@contoso.com] [--technical-owner cto@contoso.com]
//
// Writes ONE `customers` row in the workspace (idempotent by (id, workspace): another workspace may hold the
// same id, mold_v1-118) + assigns you as the solution
// engineer in `internal_staff`, and seeds `{folder:accounts}/{id}/context.md` +
// `interactions.jsonl` in the data room. See docs/OPERATOR_WORKFLOW.md (stage 1).
import { getDb, closeDb, slugify, dataroom, getCustomer, nowIso, appendInteraction, workspaceFor, withOrgDb } from "./lib/customer.mjs";
import { customers, internalStaff } from "../../agent/lib/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { glyph, flag, hasFlag, resolveIdentity, isOperatorIdentity, ALLOWED_DOMAIN, OPERATOR_COMPANY } from "./lib/operator.mjs";
import { W } from "./lib/words.mjs";
import { DEPLOYMENT_PROFILE } from "../../lib/deployment-profile.generated.ts";
import { FOLDER } from "../../agent/lib/dataroom-folders.ts";

async function main() {
  const name = flag("name").trim();
  if (!name) {
    console.error(`${glyph.bad} --name is required (the ${W.account}'s display name).`);
    process.exit(1);
  }
  const id = (flag("id").trim() || slugify(name));
  const { email: me } = resolveIdentity();
  if (!me || !isOperatorIdentity(me)) {
    console.error(`${glyph.bad} No @${ALLOWED_DOMAIN} identity — run \`node setup/workspace-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }

  const orgId = workspaceFor();
  console.log(`New ${W.account}: ${name}  (id: ${id}, workspace: ${orgId})\n`);

  const existing = await getCustomer(db, orgId, id);
  if (existing && !hasFlag("force")) {
    console.error(`${glyph.bad} ${W.Account} "${id}" already exists in ${orgId}. Pass --force to update it, or choose --id.`);
    await closeDb();
    process.exit(1);
  }

  const row = {
    orgId,
    customerId: id,
    customerName: name,
    tier: flag("tier").trim() || null,
    vertical: flag("vertical").trim() || null,
    accountRegion: flag("region").trim() || null,
    lifecycleStage: "Onboarding",
    status: "On Track",
    // The owner under both names (drizzle/0028_neutral_owner_columns.sql; agent/lib/db/owner-columns.ts).
    accountOwner: me,
    fdeOwner: me,
    businessOwnerEmail: flag("business-owner").trim() || null,
    technicalOwnerEmail: flag("technical-owner").trim() || null,
  };

  if (existing) {
    await withOrgDb(orgId, (tx) => tx.update(customers).set(row).where(and(eq(customers.orgId, orgId), eq(customers.customerId, id))));
    console.log(`${glyph.ok} Updated ${W.account} row "${id}" in ${orgId}.`);
  } else {
    await withOrgDb(orgId, (tx) => tx.insert(customers).values(row));
    console.log(`${glyph.ok} Created ${W.account} row "${id}" in ${orgId} (lifecycle: Onboarding, owner: ${me}).`);
  }

  // Assign yourself as the solution engineer (idempotent on the composite PK, which carries the workspace).
  await withOrgDb(orgId, (tx) =>
    tx
      .insert(internalStaff)
      .values({ orgId, customerId: id, staffRole: "solution_engineer", name: me.split("@")[0], employerOrg: OPERATOR_COMPANY, email: me })
      .onConflictDoNothing({ target: [internalStaff.orgId, internalStaff.customerId, internalStaff.staffRole, internalStaff.email] }),
  );
  console.log(`${glyph.ok} Assigned you (${me}) as solution_engineer.`);

  // Seed the data-room context. Only create context.md if absent — never clobber.
  const store = dataroom(orgId);
  const ctxPath = `${FOLDER.accounts}/${id}/context.md`;
  const present = await store.list(`${FOLDER.accounts}/${id}`);
  if (!present.includes(ctxPath) || hasFlag("force")) {
    await store.write(ctxPath, contextTemplate(name, id, me, row));
    console.log(`${glyph.ok} Seeded ${ctxPath}.`);
  } else {
    console.log(`${glyph.info} ${ctxPath} already exists — left as is.`);
  }
  await appendInteraction(store, `${FOLDER.accounts}/${id}/interactions.jsonl`, {
    ts: nowIso(),
    type: "account_created",
    actor: me,
    summary: `${W.Account} "${name}" onboarded by ${me}.`,
  });
  console.log(`${glyph.ok} Logged account_created to ${FOLDER.accounts}/${id}/interactions.jsonl.`);

  await closeDb();
  console.log(`\n${glyph.info} Next: research the account, then use backfill-customization-history / backfill-integration-history for prior state.`);
}

function contextTemplate(name, id, me, row) {
  return `# ${name}

- **${W.Account} ID:** ${id}
- **Tier:** ${row.tier ?? "TODO"}
- **Vertical:** ${row.vertical ?? "TODO"}
- **Region:** ${row.accountRegion ?? "TODO"}
- **${DEPLOYMENT_PROFILE.vocabulary.owner}:** ${me}
- **Business owner:** ${row.businessOwnerEmail ?? "TODO"}
- **Technical owner:** ${row.technicalOwnerEmail ?? "TODO"}

## Background

_TODO: who they are, why they bought, the business function in scope._

## Compliance / regulatory profile

_TODO._

## Scale drivers

_TODO: what volume/axis drives the deployment._

## Open questions

- _TODO_
`;
}

main().catch(async (e) => {
  console.error(`${glyph.bad} new-customer failed: ${e instanceof Error ? e.message : String(e)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
