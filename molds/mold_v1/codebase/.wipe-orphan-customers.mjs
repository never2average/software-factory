/**
 * Delete the customers that belong to no workspace, and everything hanging off
 * them.
 *
 * After both orgs were wiped, 65 customers remained with a NULL `org_id` —
 * pre-tenancy rows that were never backfilled. They belong to nothing, render
 * for nobody, and would sit in the way of a clean re-onboard.
 *
 * The cascade is the point. Customer-scoped tables (tickets, deployments,
 * interactions, implementation, solutions…) carry no `org_id` of their own;
 * they inherit tenancy through `customers.customer_id`. Deleting a customer
 * without them leaves rows pointing at an account that no longer exists.
 *
 * Same safety as the org wipe:
 *   1. Dumps everything first, and verifies the dump reads back.
 *   2. Dry run unless --apply.
 *   3. Children before parents, then a verification sweep.
 *
 * ONLY org-less customers. A customer belonging to a real workspace is never
 * touched, so this stays safe to run after re-onboarding.
 *
 *   node .wipe-orphan-customers.mjs           # dump + show
 *   node .wipe-orphan-customers.mjs --apply   # dump + delete
 */
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const sql = postgres(env.DATABASE_URL, { ssl: "require", prepare: false, connect_timeout: 20 });

const ids = (await sql`select customer_id from customers where org_id is null`).map((r) => r.customer_id);
if (ids.length === 0) {
  console.log("✓ no org-less customers");
  await sql.end();
  process.exit(0);
}
console.log(`${ids.length} org-less customer(s)\n`);

// Every table that references a customer, discovered rather than listed — a
// hand-written list is how one gets missed and leaves dangling rows.
const childTables = (
  await sql`select table_name from information_schema.columns
            where column_name = 'customer_id' and table_schema = 'public'
              and table_name <> 'customers'
            order by table_name`
).map((r) => r.table_name);

const dump = { takenAt: new Date().toISOString(), customerIds: ids, tables: {} };
let total = 0;
for (const table of [...childTables, "customers"]) {
  const where = table === "customers" ? "org_id is null" : "customer_id = any($1)";
  const params = table === "customers" ? [] : [ids];
  try {
    const rows = await sql.unsafe(`select * from ${table} where ${where}`, params);
    if (rows.length) {
      dump.tables[table] = rows;
      total += rows.length;
    }
  } catch (e) {
    console.error(`✗ could not read ${table}: ${e.message}`);
    process.exit(1);
  }
}
const path = `./.org-wipe-backup-customers-${dump.takenAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, JSON.stringify(dump, null, 2));
if (JSON.parse(readFileSync(path, "utf8")).customerIds.length !== ids.length) {
  console.error("✗ the dump did not read back intact — refusing to delete");
  process.exit(1);
}
console.log(`✓ dumped ${total} row(s) across ${Object.keys(dump.tables).length} table(s)`);
console.log(`  ${path}\n`);
for (const [table, rows] of Object.entries(dump.tables)) {
  console.log(`  ${table.padEnd(30)} ${rows.length}`);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to delete. The dump above is already written.");
  await sql.end();
  process.exit(0);
}

console.log("\ndeleting…");
let remaining = new Set(Object.keys(dump.tables).filter((t) => t !== "customers"));
for (let pass = 1; pass <= 8 && remaining.size; pass++) {
  let progress = 0;
  for (const table of [...remaining]) {
    try {
      const gone = await sql.unsafe(`delete from ${table} where customer_id = any($1)`, [ids]);
      progress += gone.count ?? 0;
      remaining.delete(table);
    } catch {
      /* foreign key from a table not yet swept — next pass */
    }
  }
  console.log(`  pass ${pass}: ${progress} row(s), ${remaining.size} table(s) left`);
  if (progress === 0) break;
}
if (remaining.size) {
  console.error(`✗ could not clear: ${[...remaining].join(", ")}`);
  await sql.end();
  process.exit(1);
}
await sql`delete from customers where org_id is null`;

const [{ n }] = await sql`select count(*)::int n from customers`;
let dangling = 0;
for (const table of childTables) {
  const [{ d }] = await sql.unsafe(
    `select count(*)::int d from ${table} t
      where t.customer_id is not null
        and not exists (select 1 from customers c where c.customer_id = t.customer_id)`,
  );
  if (d) {
    console.error(`✗ ${table} has ${d} row(s) pointing at a customer that no longer exists`);
    dangling += d;
  }
}
console.log(`\n✓ removed the org-less customers — ${n} customer(s) remain`);
console.log(dangling === 0 ? "✓ no dangling customer references anywhere" : `✗ ${dangling} dangling reference(s)`);
await sql.end();
process.exit(dangling === 0 ? 0 : 1);
