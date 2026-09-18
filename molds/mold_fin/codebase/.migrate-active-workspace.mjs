/**
 * Migration: remember which workspace a person is working in.
 *
 * The switcher was client-side only — a localStorage value riding along as an
 * X-Ops-Org header on Ops API calls. The AGENT never saw that header: it
 * re-resolves your workspace from your identity on every turn, off an
 * UNORDERED membership query. So for anyone in two workspaces the console
 * could show one tenant while chat answered from the other, with no way to
 * steer it. Both halves look authoritative, which is what makes it dangerous.
 *
 * One nullable column, no backfill. NULL means "never explicitly chosen",
 * which both resolvers order last — falling back to the oldest membership,
 * tie-broken by id. So existing users keep exactly the workspace they have
 * today until the moment they pick a different one.
 *
 *   last_selected_at  when this member last chose this workspace
 *
 * Review the DDL, then run:  ! node .migrate-active-workspace.mjs
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

// DDL needs the ADMIN connection: app_rw owns no tables and fails with
// "must be owner of table".
const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

await sql.unsafe(`
  ALTER TABLE org_members
    ADD COLUMN IF NOT EXISTS last_selected_at timestamptz
`);
console.log("✓ column added");

// Verify by NAME. A count would pass with the right number of wrong columns,
// and a sibling of this script got that wrong once already.
const found = (
  await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'org_members'`
).map((r) => r.column_name);
const ok = found.includes("last_selected_at");
console.log(`\n${ok ? "✓ ready" : "✗ missing: last_selected_at"}`);
await sql.end();
process.exit(ok ? 0 : 1);
