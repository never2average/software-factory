/**
 * THE ACCOUNT RECORD'S OWN FIELDS, AGAINST A REAL POSTGRES.
 *
 * scripts/test-custom-fields.mjs holds the rules (the validator, the write path, the migration's text). Two things
 * it cannot assert from source are database facts:
 *
 *   · that drizzle/0019_account_custom_fields.sql APPLIES to a customers table that already holds rows, the way
 *     it will on the live database: additive, re-runnable, every existing row left exactly as it was (custom NULL),
 *     and the table's row-level security (the org_isolation policy, ENABLE + FORCE) untouched;
 *   · that a note written through the agent's write path (applyCustomFields + writeCustomerToPostgres, what
 *     upsertCustomer runs) comes back VERBATIM from getCustomer, as the restricted app_rw role under RLS, and is
 *     invisible from another workspace;
 *   · that concurrent writes do not lose values (review of #57): upsert_customer({ id, healthReason }) racing a
 *     scoped UPDATE of `custom` for 40 rounds never overwrites the note with the one it read earlier (it did in 39
 *     of 40 rounds when the upsert wrote the whole column back), and writes that each name `custom` (two appends
 *     and a pick at once) all land, because each is merged in SQL onto what is stored at write time.
 *
 * It is run in CI's `isolation` job, after drizzle-kit push and scripts/bootstrap-test-db.mjs. To test the
 * MIGRATION rather than the push, it first puts the table back the way the live database has it today (no
 * column, as the superuser), writes a legacy row, and then applies the migration file twice with the same
 * statement split scripts/migrate-production.mjs uses. NON-DESTRUCTIVE otherwise: its rows live under a throwaway
 * workspace carrying this process's pid, removed in a finally block.
 *
 * Needs ADMIN_URL (DDL) and DATABASE_URL (the app_rw url); without them it skips, so the offline job is unaffected.
 *
 * Run:  ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/fde_test \
 *       DATABASE_URL=postgres://app_rw:…@127.0.0.1:5432/fde_test npm run test:account-custom-fields-db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-account-custom-fields-db: SKIPPED — needs ADMIN_URL (DDL) and DATABASE_URL (the app_rw url).");
  process.exit(0);
}

let passed = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ok   ${label}`);
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const ORG = `acctcf-test-${process.pid}`;
const OTHER = `acctcf-other-${process.pid}`;
const LEGACY = `acctcf-legacy-${process.pid}`;
const COMPANY = `acctcf-co-${process.pid}`;
const RACE = `acctcf-race-${process.pid}`;
const ROUNDS = 40;

const column = async () =>
  (await admin`select data_type, is_nullable, column_default from information_schema.columns
               where table_schema = 'public' and table_name = 'customers' and column_name = 'custom'`)[0] ?? null;
const security = async () => {
  const [rel] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.customers'::regclass`;
  const policies = await admin`select policyname, permissive, roles::text, cmd, qual, with_check from pg_policies
                               where schemaname = 'public' and tablename = 'customers' order by policyname`;
  const grants = await admin`select grantee, privilege_type from information_schema.role_table_grants
                             where table_schema = 'public' and table_name = 'customers' order by grantee, privilege_type`;
  return JSON.stringify({ rel, policies, grants });
};

let db = null;
try {
  await admin`insert into orgs (org_id, name, status) values (${ORG}, 'Account custom fields probe', 'active'), (${OTHER}, 'Other probe', 'active')`;

  console.log("\n1. The migration, applied to a customers table that already holds rows (the live shape)");
  // The live database today: no column. The superuser drops the one drizzle-kit push created from schema.ts.
  await admin.unsafe(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "custom"`);
  const before = await security();
  await admin`insert into customers (customer_id, org_id, customer_name, health_reason) values (${LEGACY}, ${ORG}, 'Legacy Co', 'written before the column')`;
  check("the table has no custom column before", (await column()) === null);
  const sqlText = readFileSync("drizzle/0019_account_custom_fields.sql", "utf8");
  // Exactly scripts/migrate-production.mjs's split: each statement run as written, in one transaction.
  const statements = sqlText.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  for (let run = 1; run <= 2; run++) await admin.begin(async (tx) => { for (const s of statements) await tx.unsafe(s); });
  const col = await column();
  check("applies, and applies again (IF NOT EXISTS): a re-run is harmless", col !== null);
  check("the column is jsonb, NULLABLE, with no default (no row is rewritten)", col.data_type === "jsonb" && col.is_nullable === "YES" && col.column_default === null, col);
  const [legacy] = await admin`select customer_name, health_reason, custom from customers where customer_id = ${LEGACY}`;
  check("an existing row is untouched: its values as they were, custom NULL", legacy.customer_name === "Legacy Co" && legacy.health_reason === "written before the column" && legacy.custom === null, legacy);
  check("row-level security on customers is exactly as it was (RLS on + forced, the policy, the grants)", (await security()) === before, { before, after: await security() });

  console.log("\n2. A note round-trips through the agent's write path, as app_rw, under RLS");
  const { getDb, closeDb } = await import("../agent/lib/db/index.ts");
  const sor = await import("../agent/lib/system-of-record.ts");
  const { customerSchema } = await import("../agent/lib/customer-schema.ts");
  db = { closeDb };
  const { sql } = await import("drizzle-orm");
  const [{ current_user: role }] = await getDb().execute(sql`select current_user`);
  check("the app connects as app_rw (NOBYPASSRLS), not as the owner", role === "app_rw", role);
  const { withOrgDb } = await import("../agent/lib/db/index.ts");
  const { customers } = await import("../agent/lib/db/schema.ts");
  const { eq } = await import("drizzle-orm");

  // THE RACE (review of #57): the agent's upsert read the whole record, then wrote the whole row back, `custom`
  // included, from what it had read. A note saved in between by a scoped UPDATE (what the ops API does) was lost:
  // 39 of 40 rounds against this database. A write that does not name `custom` must leave the column alone.
  await admin`insert into customers (customer_id, org_id, customer_name, custom) values (${RACE}, ${ORG}, 'Race Co', ${admin.json({ notes: "n0" })})`;
  let lost = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const note = `note written in round ${i}`;
    await Promise.all([
      sor.upsertCustomer({ id: RACE, healthReason: `round ${i}` }, ORG),
      withOrgDb(ORG, (tx) => tx.update(customers).set({ custom: { notes: note } }).where(eq(customers.customerId, RACE))),
    ]);
    const [r] = await admin`select custom, health_reason from customers where customer_id = ${RACE}`;
    if (r.custom?.notes !== note) lost++;
  }
  check(`a note saved while upsert_customer rewrites the record is never lost (${ROUNDS} rounds, lost ${lost})`, lost === 0, `lost in ${lost} of ${ROUNDS} rounds`);
  const declared = { account: [{ key: "notes", label: "Notes", type: "long_text" }, { key: "house_view", label: "House view", type: "pick_list", options: ["Positive", "Neutral", "Negative"] }] };
  // Text a person writes: line breaks, folder names and the base product's words are data, never the product's.
  const NOTE = "Read Customers/acme/filings/q1.pdf and Deployments/acme/v1.\nThe deployment of the rights-issue money is the open question; customer_id stays as is.";
  // What upsertCustomer runs, with a profile that declares the fields (this build's declares none).
  const write = async (patch) => {
    const existing = await sor.getCustomer(patch.id, ORG);
    const { patch: valid, accountDelta } = sor.applyCustomFieldsWithDelta(patch, existing, declared);
    const merged = existing ? customerSchema.parse({ ...existing, ...valid }) : customerSchema.parse({ name: valid.id, ...valid });
    await sor.writeCustomerToPostgres(getDb(), merged, ORG, { accountCustom: accountDelta });
  };
  await write({ id: COMPANY, name: "Notes Co", custom: { notes: NOTE, house_view: "neutral" } });
  const read = await sor.getCustomer(COMPANY, ORG);
  check("read back verbatim under the declared keys", JSON.stringify(read?.custom) === JSON.stringify({ notes: NOTE, house_view: "Neutral" }), read?.custom);
  const [raw] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  check("stored as jsonb keyed by field key, the text as written", raw.custom.notes === NOTE && raw.custom.house_view === "Neutral", raw.custom);
  await write({ id: COMPANY, custom: { house_view: "Positive" } });
  check("a partial change merges: the note it did not name is kept", JSON.stringify((await sor.getCustomer(COMPANY, ORG)).custom) === JSON.stringify({ notes: NOTE, house_view: "Positive" }));
  await assert.rejects(write({ id: COMPANY, custom: { rating: "Buy" } }), /There is no custom field "rating" here/);
  check("an undeclared key is refused, and nothing was written", JSON.stringify((await sor.getCustomer(COMPANY, ORG)).custom) === JSON.stringify({ notes: NOTE, house_view: "Positive" }));
  // RLS itself: the row (and so its custom) is not visible from another workspace's scope.
  const fromOther = await withOrgDb(OTHER, (tx) => tx.select({ custom: customers.custom }).from(customers).where(eq(customers.customerId, COMPANY)));
  const fromOwn = await withOrgDb(ORG, (tx) => tx.select({ custom: customers.custom }).from(customers).where(eq(customers.customerId, COMPANY)));
  check("another workspace's scope cannot read the row or its custom; its own can", fromOther.length === 0 && fromOwn.length === 1, { fromOther, fromOwn });
  await write({ id: COMPANY, custom: { notes: null, house_view: null } });
  const [cleared] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  check("clearing every value stores NULL, and the record reads without custom", cleared.custom === null && !("custom" in (await sor.getCustomer(COMPANY, ORG))), cleared);
  check("the legacy row reads as before: no custom key at all", !("custom" in (await sor.getCustomer(LEGACY, ORG))));

  console.log("\n3. Concurrent writes that each name `custom` merge, in SQL, onto what is stored at write time");
  await write({ id: COMPANY, custom: { notes: "Start." } });
  let merges = 0;
  for (let i = 1; i <= 20; i++) {
    await Promise.all([
      write({ id: COMPANY, custom_append: { notes: `A${i}.` } }),
      write({ id: COMPANY, custom_append: { notes: `B${i}.` } }),
      write({ id: COMPANY, custom: { house_view: i % 2 ? "Positive" : "Negative" } }),
    ]);
    const [r] = await admin`select custom from customers where customer_id = ${COMPANY}`;
    if (r.custom.notes.includes(`A${i}.`) && r.custom.notes.includes(`B${i}.`) && r.custom.house_view) merges++;
  }
  const [final] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  check("two appends and a pick written at once all land, every round (20 rounds)", merges === 20, `${merges} of 20`);
  check("the appended note keeps its start and joins additions with a blank line", final.custom.notes.startsWith("Start.\n\n") && final.custom.notes.split("\n\n").length === 41, final.custom.notes.slice(0, 80));
  // Second review of #57: the 20,000-character cap holds at WRITE time. 18,000 stored, two 1,500-character
  // appends at once: each passed the check against the text it read; together they would store 21,004.
  await write({ id: COMPANY, custom: { notes: "n".repeat(18000) } });
  const settled = await Promise.allSettled([
    write({ id: COMPANY, custom_append: { notes: "a".repeat(1500) } }),
    write({ id: COMPANY, custom_append: { notes: "b".repeat(1500) } }),
  ]);
  const [capped] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  const refusals = settled.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  check("two appends at once never store past 20,000 characters", capped.custom.notes.length <= 20000, `${capped.custom.notes.length} characters stored`);
  check("the one that would pass it is refused with a sentence, nothing written", refusals.length === 1 && /nothing was written\. .*: the own field "notes" would be 21,004 characters with this addition, over the 20,000-character limit/.test(refusals[0]), refusals);
  // …and the way out is one call: null in `custom` + the new text in `custom_append` REPLACES the note in one write.
  await write({ id: COMPANY, custom: { notes: null }, custom_append: { notes: "Rewritten, shorter." } });
  const [replaced] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  check("null in custom + text in custom_append replaces the note in one write", replaced.custom.notes === "Rewritten, shorter.", replaced.custom.notes.slice(0, 60));

  await write({ id: COMPANY, custom: { notes: null, house_view: null } });
  const [gone] = await admin`select custom from customers where customer_id = ${COMPANY}`;
  check("clearing every key in SQL stores NULL", gone.custom === null, gone);
} finally {
  await admin`delete from customers where customer_id in (${LEGACY}, ${COMPANY}, ${RACE})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG}, ${OTHER})`.catch(() => {});
  // Leave the schema as schema.ts declares it, whatever happened above.
  await admin.unsafe(`ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "custom" jsonb`).catch(() => {});
  await admin.end();
  if (db) await db.closeDb();
}

console.log(`\naccount custom fields (db): ${passed} check(s) passed`);
