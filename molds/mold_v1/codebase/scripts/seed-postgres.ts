/**
 * Seed Postgres (the system of record) with the SAMPLE records, for a demo
 * database only (two invented accounts; never a real workspace):
 *
 *   data/sample/customers.json -> customers, platform, deployments, solutions,
 *                                 implementation, tickets, interactions
 *   data/sample/people.json    -> internal_staff, customer_stakeholders
 *
 * Usage: `npm run seed:postgres` with DATABASE_URL (or POSTGRES_URL) set.
 * Without a URL this script NO-OPS with a clear message — no live database is
 * required (or contacted) in dev/CI, where the system of record falls back to
 * an in-memory store (empty unless DEMO_SAMPLE_DATA=1). Run migrations first (`npx drizzle-kit migrate`) so the
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

/**
 * Only when asked. This writes two INVENTED accounts and their people into a database, and a real workspace's
 * database is one `npm run seed:postgres` away (mold_v1-120: sample records reached real users). Refused before
 * anything connects unless the run says it wants the sample.
 */
const wantsSample = process.env.DEMO_SAMPLE_DATA === "1" || process.env.DEMO_SAMPLE_DATA === "true" || process.argv.includes("--sample");
if (!wantsSample) {
  console.error(
    "seed:postgres: refused — this writes the INVENTED sample accounts (data/sample/) into the database.\n" +
      "For a demo database only, run it with DEMO_SAMPLE_DATA=1 or pass --sample (npm run seed:postgres -- --sample).",
  );
  process.exit(2);
}

const url = getDatabaseUrl();
if (!url) {
  console.log(
    "seed:postgres: no DATABASE_URL or POSTGRES_URL set — nothing to do.\n" +
      "The system of record is using its in-memory fallback (empty unless DEMO_SAMPLE_DATA=1 loads data/sample/).\n" +
      "Set a Postgres URL (and run `npx drizzle-kit migrate` once) to seed a real database.",
  );
  process.exit(0);
}

const customersUrl = new URL("../data/sample/customers.json", import.meta.url);
const peopleUrl = new URL("../data/sample/people.json", import.meta.url);
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
