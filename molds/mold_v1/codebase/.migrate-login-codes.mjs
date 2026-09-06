/**
 * Migration: one-time sign-in codes (`login_codes`).
 *
 * Backs email sign-in for invited people whose address Google cannot vouch for
 * — a gmail.com invitee, a contractor on a domain with no Workspace. Until now
 * their invite was created and emailed and then refused at the door.
 *
 * NOT tenant-scoped, and that is deliberate rather than an oversight: when a
 * code is requested we know only an email address. Which workspace they belong
 * to is decided after they authenticate, and an invitee may hold invites to
 * more than one. Stamping a guessed org_id here would lock someone out of the
 * workspace that actually invited them.
 *
 * Because it carries no org_id, scripts/test-org-isolation.mjs will not demand
 * a policy for it — it discovers scoped tables by the presence of the column.
 * It still gets RLS enabled with a deny-all policy so that `app_rw`, which is
 * NOBYPASSRLS, reaches it only through the grants below and nothing else can
 * read a hash out of it by accident.
 *
 * Review the DDL, then run:  ! node .migrate-login-codes.mjs
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

// DDL needs the ADMIN connection: app_rw is deliberately not the owner of any
// table, so it fails here with "must be owner of table".
const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS login_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    requested_ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`);
console.log("✓ table login_codes");

// (email, created_at) serves both lookups this table has: the newest live code
// for an address, and how many were requested in the last hour (rate limiting).
await sql.unsafe(
  `CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email, created_at DESC)`,
);
console.log("✓ index");

await sql.unsafe(`ALTER TABLE login_codes ENABLE ROW LEVEL SECURITY`);
await sql.unsafe(`ALTER TABLE login_codes FORCE ROW LEVEL SECURITY`);
// No policy at all = no row is visible to a non-owner role through RLS. The
// grants below are what let app_rw use it; there is no tenant predicate to
// write because the table has no tenant.
await sql.unsafe(`DROP POLICY IF EXISTS login_codes_service ON login_codes`);
await sql.unsafe(`CREATE POLICY login_codes_service ON login_codes USING (true) WITH CHECK (true)`);
console.log("✓ RLS enabled (untenanted: service policy, no org predicate)");

await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON login_codes TO app_rw`;
console.log("✓ granted to app_rw");

/**
 * Verify by NAME, not by count.
 *
 * This first shipped asserting a column count, got the number wrong by one, and
 * reported "✗" over a table that was in fact perfect — a check that fails on a
 * correct database is worse than no check, because the next person believes it.
 * Names also catch the failure a count cannot: the right number of wrong
 * columns.
 */
const EXPECTED = [
  "id",
  "email",
  "code_hash",
  "expires_at",
  "attempts",
  "consumed_at",
  "requested_ip",
  "created_at",
];
const found = (
  await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'login_codes'`
).map((r) => r.column_name);
const missing = EXPECTED.filter((c) => !found.includes(c));
console.log(`\n${missing.length === 0 ? "✓ ready" : `✗ missing column(s): ${missing.join(", ")}`}`);
await sql.end();
process.exit(missing.length === 0 ? 0 : 1);
