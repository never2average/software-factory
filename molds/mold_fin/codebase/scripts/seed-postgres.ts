/**
 * Seed Postgres (the system of record) from the bundled seed JSON:
 *
 *   data/customers.json -> customers, platform, deployments, solutions,
 *                          implementation, tickets, interactions
 *   data/people.json    -> internal_staff, customer_stakeholders
 *
 * Usage: `npm run seed:postgres` with DATABASE_URL (or POSTGRES_URL) set.
 * Without a URL this script NO-OPS with a clear message — no live database is
 * required (or contacted) in dev/CI, where the system of record falls back to
 * the bundled JSON. Run migrations first (`npx drizzle-kit migrate`) so the
 * tables in ./drizzle exist.
 *
 * Idempotent: customers are UPSERTed (nested domains replaced wholesale), and
 * the people tables are re-seeded via delete + insert.
 */
import { readFileSync } from "node:fs";
import { customerStoreSchema, peopleStoreSchema } from "../agent/lib/customer-schema.ts";
import { closeDb, getDatabaseUrl, getDb } from "../agent/lib/db/index.ts";
import { customerStakeholders, internalStaff } from "../agent/lib/db/schema.ts";
import { writeCustomerToPostgres } from "../agent/lib/system-of-record.ts";

/**
 * Which workspace the seed lands in. Overridable, because a seed that can only
 * ever fill workspace #1 is no use to anyone setting up a second one.
 */
const SEED_ORG = process.env.SEED_ORG_ID ?? "org-onfinance-ai";

const url = getDatabaseUrl();
if (!url) {
  console.log(
    "seed:postgres: no DATABASE_URL or POSTGRES_URL set — nothing to do.\n" +
      "The system of record is using the bundled JSON fallback (data/customers.json).\n" +
      "Set a Postgres URL (and run `npx drizzle-kit migrate` once) to seed a real database.",
  );
  process.exit(0);
}

const customersUrl = new URL("../data/customers.json", import.meta.url);
const peopleUrl = new URL("../data/people.json", import.meta.url);
const customerStore = customerStoreSchema.parse(JSON.parse(readFileSync(customersUrl, "utf8")));
const peopleStore = peopleStoreSchema.parse(JSON.parse(readFileSync(peopleUrl, "utf8")));

const db = getDb();
if (!db) throw new Error("seed:postgres: getDb() returned null despite a configured URL");

try {
  for (const customer of customerStore.customers) {
    await writeCustomerToPostgres(db, customer);
    console.log(`seed:postgres: upserted customer ${customer.id}`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(internalStaff);
    await tx.delete(customerStakeholders);
    if (peopleStore.internalStaffAssignments.length > 0) {
      await tx.insert(internalStaff).values(
        peopleStore.internalStaffAssignments.map((p) => ({
          orgId: SEED_ORG,
          customerId: p.customer_id,
          staffRole: p.staffRole,
          name: p.name,
          title: p.title ?? null,
          employerOrg: p.employerOrg,
          email: p.email,
          lastContact: p.lastContact ?? null,
        })),
      );
    }
    if (peopleStore.customerStakeholders.length > 0) {
      await tx.insert(customerStakeholders).values(
        peopleStore.customerStakeholders.map((p) => ({
          orgId: SEED_ORG,
          customerId: p.customer_id,
          stakeholderRole: p.stakeholderRole,
          name: p.name,
          title: p.title ?? null,
          employerOrg: p.employerOrg,
          email: p.email,
          lastContact: p.lastContact ?? null,
        })),
      );
    }
  });
  console.log(
    `seed:postgres: seeded ${customerStore.customers.length} customers, ` +
      `${peopleStore.internalStaffAssignments.length} internal staff assignments, ` +
      `${peopleStore.customerStakeholders.length} customer stakeholders`,
  );
} finally {
  await closeDb();
}
