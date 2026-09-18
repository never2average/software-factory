// redacted:new-customer — create a customer and seed its context in the data room.
//
//   npm run redacted:new-customer -- --name "Contoso Bank" --tier Enterprise \
//     [--id contoso-bank] [--vertical banking] [--region APAC] \
//     [--business-owner cfo@contoso.com] [--technical-owner cto@contoso.com]
//
// Writes ONE `customers` row (idempotent by id) + assigns you as the solution
// engineer in `internal_staff`, and seeds `Customers/{id}/context.md` +
// `interactions.jsonl` in the data room. See docs/redacted_WORKFLOW.md (stage 1).
import { getDb, closeDb, slugify, dataroom, getCustomer, nowIso, appendInteraction } from "./lib/customer.mjs";
import { customers, internalStaff } from "../../agent/lib/db/schema.ts";
import { eq } from "drizzle-orm";
import { glyph, flag, hasFlag, resolveIdentity, isredacted } from "./lib/redacted.mjs";

async function main() {
  const name = flag("name").trim();
  if (!name) {
    console.error(`${glyph.bad} --name is required (the customer's display name).`);
    process.exit(1);
  }
  const id = (flag("id").trim() || slugify(name));
  const { email: redacted } = resolveIdentity();
  if (!redacted || !isredacted(redacted)) {
    console.error(`${glyph.bad} No @redacted identity — run \`node setup/redacted-login.mjs\` or pass --email.`);
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error(`${glyph.bad} No DATABASE_URL — run with --env-file=.env.local.`);
    process.exit(1);
  }

  console.log(`New customer: ${name}  (id: ${id})\n`);

  const existing = await getCustomer(db, id);
  if (existing && !hasFlag("force")) {
    console.error(`${glyph.bad} Customer "${id}" already exists. Pass --force to update it, or choose --id.`);
    await closeDb();
    process.exit(1);
  }

  const row = {
    customerId: id,
    customerName: name,
    tier: flag("tier").trim() || null,
    vertical: flag("vertical").trim() || null,
    accountRegion: flag("region").trim() || null,
    lifecycleStage: "Onboarding",
    status: "On Track",
    fdeOwner: redacted,
    businessOwnerEmail: flag("business-owner").trim() || null,
    technicalOwnerEmail: flag("technical-owner").trim() || null,
  };

  if (existing) {
    await db.update(customers).set(row).where(eq(customers.customerId, id));
    console.log(`${glyph.ok} Updated customer row "${id}".`);
  } else {
    await db.insert(customers).values(row);
    console.log(`${glyph.ok} Created customer row "${id}" (lifecycle: Onboarding, owner: ${redacted}).`);
  }

  // Assign yourself as the solution engineer (idempotent on the composite PK).
  await db
    .insert(internalStaff)
    .values({ customerId: id, staffRole: "solution_engineer", name: redacted.split("@")[0], employerOrg: "redacted", email: redacted })
    .onConflictDoNothing();
  console.log(`${glyph.ok} Assigned you (${redacted}) as solution_engineer.`);

  // Seed the data-room context. Only create context.md if absent — never clobber.
  const store = dataroom();
  const ctxPath = `Customers/${id}/context.md`;
  const present = await store.list(`Customers/${id}`);
  if (!present.includes(ctxPath) || hasFlag("force")) {
    await store.write(ctxPath, contextTemplate(name, id, redacted, row));
    console.log(`${glyph.ok} Seeded ${ctxPath}.`);
  } else {
    console.log(`${glyph.info} ${ctxPath} already exists — left as is.`);
  }
  await appendInteraction(store, `Customers/${id}/interactions.jsonl`, {
    ts: nowIso(),
    type: "account_created",
    actor: redacted,
    summary: `Customer "${name}" onboarded by ${redacted}.`,
  });
  console.log(`${glyph.ok} Logged account_created to Customers/${id}/interactions.jsonl.`);

  await closeDb();
  console.log(`\n${glyph.info} Next: research the account, then use backfill-customization-history / backfill-integration-history for prior state.`);
}

function contextTemplate(name, id, redacted, row) {
  return `# ${name}

- **Customer ID:** ${id}
- **Tier:** ${row.tier ?? "TODO"}
- **Vertical:** ${row.vertical ?? "TODO"}
- **Region:** ${row.accountRegion ?? "TODO"}
- **redacted owner:** ${redacted}
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
