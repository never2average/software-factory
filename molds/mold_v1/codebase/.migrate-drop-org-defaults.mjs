/**
 * Migration 1b for hard tenancy: remove the org_id defaults that hide a bug.
 *
 * NOT NULL was supposed to make "an insert that forgets the workspace" raise
 * instead of silently creating an unowned row. On seven tables it does not,
 * because the column carries a DEFAULT:
 *
 *   agent_configs · agent_profiles · chat_sessions · room_presence
 *   workflow_definitions · workflow_run_journal · workflow_runs
 *
 * all defaulting to 'org-onfinance' — which IS NOT A WORKSPACE. The real one is
 * 'org-desk-a'. So a forgotten org_id does not fail; it writes a row owned
 * by a workspace that does not exist, invisible to every tenant's filters and,
 * once the policy is fail-closed, unreadable by anyone forever. A default is
 * exactly the wrong tool here: there is no correct workspace to guess.
 *
 * Verified safe before writing this: `tsc` reports zero errors with the defaults
 * removed from schema.ts, so every insert already supplies org_id explicitly,
 * and the one raw-SQL insert (lib/workflow-journal.ts) passes it too. Nothing
 * relies on the default — it is pure hazard.
 *
 * Reversible:  ALTER TABLE <t> ALTER COLUMN org_id SET DEFAULT 'org-onfinance';
 *
 * Review the DDL, then run:  ! node .migrate-drop-org-defaults.mjs
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

const sql = postgres(url, { ssl: "require", prepare: false });

let who;
try {
  [{ current_user: who }] = await sql`SELECT current_user`;
} catch (e) {
  console.error(
    String(e.message).includes("password authentication failed")
      ? "✗ Admin connection refused — refresh SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase."
      : `✗ Could not connect: ${String(e.message).slice(0, 140)}`,
  );
  process.exit(1);
}
console.log(`connected as ${who}\n`);

const withDefault = await sql`
  SELECT table_name FROM information_schema.columns
  WHERE column_name = 'org_id' AND table_schema = 'public' AND column_default IS NOT NULL
  ORDER BY table_name`;

for (const { table_name: t } of withDefault) {
  await sql.unsafe(`ALTER TABLE ${t} ALTER COLUMN org_id DROP DEFAULT`);
  console.log(`  dropped default on ${t}`);
}

const left = await sql`
  SELECT table_name FROM information_schema.columns
  WHERE column_name = 'org_id' AND table_schema = 'public' AND column_default IS NOT NULL`;

// Report any row already owned by a workspace that does not exist. Not deleted
// here: an orphan may hold something worth reading before it goes.
const tables = (
  await sql`SELECT table_name FROM information_schema.columns
            WHERE column_name = 'org_id' AND table_schema = 'public' ORDER BY table_name`
).map((r) => r.table_name);
const real = new Set((await sql`SELECT org_id FROM orgs`).map((o) => o.org_id));
let orphans = 0;
for (const t of tables) {
  for (const r of await sql.unsafe(`SELECT org_id, count(*)::int n FROM ${t} GROUP BY 1`)) {
    if (!real.has(r.org_id)) {
      console.log(`  ! ${t}: ${r.n} row(s) owned by "${r.org_id}", which is not a workspace`);
      orphans += r.n;
    }
  }
}

console.log(
  `\n${left.length === 0 ? "✓ no org_id column defaults remain" : `✗ still defaulted: ${left.map((r) => r.table_name).join(", ")}`}` +
    `${orphans ? `\n  ${orphans} orphaned row(s) reported above — decide before the fail-closed flip` : ""}`,
);
await sql.end();
process.exit(left.length === 0 ? 0 : 1);
