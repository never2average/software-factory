// Migration: rename org #1's slug  'onfinance' → 'org-onfinance'  so every
// workspace id follows the `org-{slug}` convention.
//
// This rewrites the tenant key, so it does three things IN ONE TRANSACTION:
//   1. every table with an `org_id` column: 'onfinance' → 'org-onfinance'
//      (discovered from information_schema, so a new table can't be missed);
//   2. every `org_id` column DEFAULT retargeted to the new id;
//   3. the orgs row's own primary key + its blob_prefix.
//
// RLS policies compare org_id to a GUC (no literal), so they need no change.
// There are no FKs referencing orgs.org_id, so update order doesn't matter.
//
// PAIRED CODE CHANGE (already applied, deploy right after this runs):
//   DEFAULT_ORG      lib/org-context.ts, agent/lib/org-context.ts
//   LEGACY_ROOT_ORG  lib/dataroom-blob.ts, agent/lib/org-blob.ts,
//                    agent/lib/dataroom-store.ts   ← governs data-room blob keys
// If those disagree with the DB, the workspace reads empty and the data room
// looks under the wrong prefix. Run this, then deploy both apps immediately.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const OLD = "onfinance";
const NEW = "org-onfinance";

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

const tables = (
  await sql`SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'org_id' ORDER BY table_name`
).map((r) => r.table_name);

console.log(`tables with org_id: ${tables.length}`);

const already = await sql`SELECT count(*)::int AS n FROM orgs WHERE org_id = ${NEW}`;
if (already[0].n > 0) {
  console.log(`'${NEW}' already exists — nothing to do.`);
  await sql.end();
  process.exit(0);
}

let moved = 0;
await sql.begin(async (tx) => {
  for (const t of tables) {
    // Identifiers can't be parameterized — these come from information_schema,
    // not user input, so interpolation here is safe.
    const res = await tx.unsafe(`UPDATE "${t}" SET org_id = $1 WHERE org_id = $2`, [NEW, OLD]);
    if (res.count) {
      console.log(`  ${t}: ${res.count}`);
      moved += res.count;
    }
    // Retarget the column default when it still points at the old id.
    const [d] = await tx`SELECT column_default FROM information_schema.columns
                         WHERE table_schema='public' AND table_name=${t} AND column_name='org_id'`;
    if (d?.column_default?.includes(`'${OLD}'`)) {
      await tx.unsafe(`ALTER TABLE "${t}" ALTER COLUMN org_id SET DEFAULT '${NEW}'`);
    }
  }
  // The data room's physical layout is keyed off LEGACY_ROOT_ORG in code (org #1
  // lives at the blob root), so blob_prefix is descriptive only — keep it truthful.
  await tx`UPDATE orgs SET blob_prefix = ${`orgs/${NEW}`} WHERE org_id = ${NEW} AND blob_prefix IS NOT NULL`;
});

console.log(`rows updated: ${moved}`);
const [row] = await sql`SELECT org_id, name, blob_prefix FROM orgs`;
console.log("orgs now:", row);
const [stray] = await sql`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${OLD}`;
console.log(`stray '${OLD}' member rows: ${stray.n}`);

await sql.end();
