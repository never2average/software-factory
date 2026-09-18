/**
 * Migration 1 of 2 for hard tenancy: every row must belong to a workspace.
 *
 * A NULL org_id is a row that belongs to nobody. It satisfies no equality
 * filter, so it is invisible to the workspace that created it, and under the
 * fail-open policy it is visible to every query that forgets to scope. Both
 * halves of that are wrong.
 *
 * There are only 7 such rows, all written before the second workspace existed,
 * so they belong to org #1.
 *
 * THEN the column stops accepting NULL. This is the part with teeth: after it,
 * an insert that forgets the workspace RAISES instead of quietly creating an
 * unowned row. That is the intent — but it means a code path that omits org_id
 * turns from a silent leak into a 500. Run it when you can watch, not during a
 * demo.
 *
 * Rollback for any single table:
 *   ALTER TABLE <t> ALTER COLUMN org_id DROP NOT NULL;
 *
 * Review the DDL, then run:  ! node .migrate-org-not-null.mjs
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

function readEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

/** Org #1 — the only workspace that existed when these rows were written. */
const HOME_ORG = "org-onfinance-ai";

/**
 * Fail with an explanation, not a stack trace.
 *
 * Two ways this goes wrong and neither is obvious from the raw error:
 *   • the admin password has been rotated (a Supabase DB-password reset
 *     rotates `postgres`), so .env.supabase is stale;
 *   • the URL resolves to app_rw, which owns no tables and cannot run DDL —
 *     "must be owner of table" arrives halfway through, after some statements
 *     have already applied.
 * Both are checked BEFORE anything is written.
 */
async function preflight(sql) {
  let who;
  try {
    [{ current_user: who }] = await sql`SELECT current_user`;
  } catch (e) {
    if (String(e.message).includes("password authentication failed")) {
      console.error(
        "✗ The admin connection was refused.\n" +
          "  A Supabase database-password reset rotates the `postgres` role, which leaves\n" +
          "  SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase stale. Refresh it from\n" +
          "  Supabase → Project Settings → Database, then re-run.\n" +
          "  Production is unaffected: it connects as app_rw, a different role.",
      );
    } else {
      console.error(`✗ Could not connect: ${String(e.message).slice(0, 160)}`);
    }
    process.exit(1);
  }
  // Owning nothing is the app role's whole point — it must not be the one here.
  const [{ can }] = await sql`
    SELECT bool_or(pg_has_role(current_user, c.relowner, 'USAGE')) AS can
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`;
  if (!can) {
    console.error(
      `✗ Connected as ${who}, which owns no tables — every ALTER would fail with\n` +
        "  \"must be owner of table\". Point SUPABASE_POSTGRES_URL_NON_POOLING at the\n" +
        "  admin role in .env.supabase; app_rw is the runtime role, not the migrator.",
    );
    process.exit(1);
  }
  console.log(`connected as ${who}\n`);
}

const sql = postgres(url, { ssl: "require", prepare: false });
await preflight(sql);

// Sanity: the workspace we are about to assign rows to must exist.
const [home] = await sql`SELECT org_id FROM orgs WHERE org_id = ${HOME_ORG}`;
if (!home) {
  console.log(`✗ ${HOME_ORG} is not a workspace — refusing to assign rows to it`);
  await sql.end();
  process.exit(1);
}

const nullable = await sql`
  SELECT table_name FROM information_schema.columns
  WHERE column_name = 'org_id' AND table_schema = 'public' AND is_nullable = 'YES'
  ORDER BY table_name`;

let filled = 0;
const failed = [];

for (const { table_name: t } of nullable) {
  const [{ nulls }] = await sql.unsafe(
    `SELECT count(*) FILTER (WHERE org_id IS NULL)::int AS nulls FROM ${t}`,
  );
  if (nulls > 0) {
    await sql.unsafe(`UPDATE ${t} SET org_id = $1 WHERE org_id IS NULL`, [HOME_ORG]);
    console.log(`  backfilled ${String(nulls).padStart(3)} row(s) in ${t}`);
    filled += nulls;
  }
  try {
    await sql.unsafe(`ALTER TABLE ${t} ALTER COLUMN org_id SET NOT NULL`);
  } catch (e) {
    // A table that refuses is reported, not swallowed: leaving one column
    // nullable while claiming the migration succeeded is how the fail-closed
    // flip later finds a hole nobody knew about.
    failed.push(`${t}: ${String(e.message).split("\n")[0]}`);
  }
}

console.log(`\nbackfilled ${filled} row(s) across ${nullable.length} table(s)`);

const still = await sql`
  SELECT table_name FROM information_schema.columns
  WHERE column_name = 'org_id' AND table_schema = 'public' AND is_nullable = 'YES'
  ORDER BY table_name`;

if (failed.length) {
  console.log("\ncould not constrain:");
  for (const f of failed) console.log("  " + f);
}
console.log(`\n${still.length === 0 ? "✓ every org_id column is NOT NULL" : `✗ still nullable: ${still.map((r) => r.table_name).join(", ")}`}`);
await sql.end();
process.exit(still.length === 0 ? 0 : 1);
