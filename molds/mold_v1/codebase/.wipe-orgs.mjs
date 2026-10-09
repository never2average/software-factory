/**
 * Delete both workspaces and everything under them, after taking a full dump.
 *
 * This is the irreversible one. It removes every row carrying an `org_id` for
 * the named orgs across all 52 tenanted tables — roster, workflows, apps,
 * memories, chats, connectors, invites, members — and then the org rows.
 *
 * SAFETY, in order:
 *   1. DUMPS everything it is about to delete to a timestamped JSON file first,
 *      and refuses to continue if the dump cannot be written. A backup you
 *      discover was never written is worse than no backup.
 *   2. Dry run by default; nothing is deleted without --apply.
 *   3. Deletes in REPEATED PASSES. Foreign keys between tenanted tables mean
 *      there is no single correct order, so it keeps sweeping until a pass
 *      deletes nothing, then reports anything that would not go.
 *
 * Customers with a NULL org_id are NOT touched. They belong to no workspace, so
 * they are not part of either one — and there are 65 of them.
 *
 *   node .wipe-orgs.mjs           # dump + show what would go
 *   node .wipe-orgs.mjs --apply   # dump + delete
 */
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const TARGETS = ["org-desk-a", "org-customer-c"];

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

const scoped = (
  await sql`select table_name from information_schema.columns
            where column_name = 'org_id' and table_schema = 'public'
            order by table_name`
).map((r) => r.table_name);

/* ---- 1. dump ------------------------------------------------------------- */

const dump = { takenAt: new Date().toISOString(), orgs: TARGETS, tables: {} };
let total = 0;
for (const table of scoped) {
  try {
    const rows = await sql.unsafe(`select * from ${table} where org_id = any($1)`, [TARGETS]);
    if (rows.length) {
      dump.tables[table] = rows;
      total += rows.length;
    }
  } catch (e) {
    console.error(`✗ could not read ${table}: ${e.message}`);
    process.exit(1);
  }
}
const path = `./.org-wipe-backup-${dump.takenAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(path, JSON.stringify(dump, null, 2));
const written = JSON.parse(readFileSync(path, "utf8"));
if (Object.keys(written.tables).length !== Object.keys(dump.tables).length) {
  console.error("✗ the dump did not read back intact — refusing to delete");
  process.exit(1);
}
console.log(`✓ dumped ${total} row(s) across ${Object.keys(dump.tables).length} table(s)`);
console.log(`  ${path}\n`);

for (const [table, rows] of Object.entries(dump.tables)) {
  console.log(`  ${table.padEnd(28)} ${rows.length}`);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to delete. The dump above is already written.");
  await sql.end();
  process.exit(0);
}

/* ---- 2. delete, in repeated passes --------------------------------------- */

console.log("\ndeleting…");
let remaining = new Set(Object.keys(dump.tables).filter((t) => t !== "orgs"));
for (let pass = 1; pass <= 8 && remaining.size; pass++) {
  let progress = 0;
  for (const table of [...remaining]) {
    try {
      const gone = await sql.unsafe(`delete from ${table} where org_id = any($1)`, [TARGETS]);
      progress += gone.count ?? 0;
      remaining.delete(table);
    } catch {
      // Almost certainly a foreign key from a table not yet swept. Leave it for
      // the next pass rather than guessing at an order.
    }
  }
  console.log(`  pass ${pass}: ${progress} row(s), ${remaining.size} table(s) left`);
  if (progress === 0) break;
}
if (remaining.size) {
  console.error(`✗ could not clear: ${[...remaining].join(", ")}`);
  console.error("  Nothing else was rolled back; the dump has everything.");
  await sql.end();
  process.exit(1);
}
await sql.unsafe(`delete from orgs where org_id = any($1)`, [TARGETS]);

/* ---- 3. verify ----------------------------------------------------------- */

let leftover = 0;
for (const table of scoped) {
  const [{ n }] = await sql.unsafe(`select count(*)::int n from ${table} where org_id = any($1)`, [TARGETS]);
  if (n) {
    console.error(`✗ ${table} still has ${n} row(s)`);
    leftover += n;
  }
}
const [{ n: orphans }] = await sql`select count(*)::int n from customers where org_id is null`;
console.log(`\n${leftover === 0 ? "✓ both workspaces removed" : `✗ ${leftover} row(s) left`}`);
console.log(`  org-less customers, untouched: ${orphans}`);
await sql.end();
process.exit(leftover === 0 ? 0 : 1);
