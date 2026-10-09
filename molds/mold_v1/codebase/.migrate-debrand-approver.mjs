/**
 * Migration: take one tenant's brand out of every other tenant's schema.
 *
 * `implementation.onfinance_launch_approver_email` is the PROVIDER-side signer
 * in the four-party launch signoff, sitting beside `customer_launch_approver_
 * email`. Naming it after the vendor was fine while there was exactly one
 * vendor. It is not fine now: the column name reaches a tenant three ways —
 * the data-room detail view, the exported workbook's column header, and the
 * customer JSON schema the agent writes — so every workspace on the platform
 * reads "onfinance launch approver" on their own customers.
 *
 *   onfinance_launch_approver_email  →  provider_launch_approver_email
 *
 * Checked before writing this: NO row in ANY workspace has the column set, so
 * there is nothing to preserve and no window where the two names disagree.
 * (That check had to be run per-workspace with app.org_id set — under the
 * fail-closed policy an unscoped count returns 0 and would have "confirmed"
 * emptiness for a column that was full.)
 *
 * Idempotent: renames only if the old name is still there, and treats the job
 * as already done if the new one exists.
 *
 * Review, then run:  ! node .migrate-debrand-approver.mjs
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

/**
 * Fail with an explanation, not a stack trace. Two ways this goes wrong and
 * neither is obvious from the raw error: a Supabase DB-password reset rotates
 * `postgres` (so .env.supabase goes stale), or the URL resolves to app_rw,
 * which owns no tables and cannot run DDL.
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
  const [{ can }] = await sql`
    SELECT bool_or(pg_has_role(current_user, c.relowner, 'USAGE')) AS can
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`;
  if (!can) {
    console.error(
      `✗ Connected as ${who}, which owns no tables — the ALTER would fail with\n` +
        '  "must be owner of table". Point SUPABASE_POSTGRES_URL_NON_POOLING at the\n' +
        "  admin role in .env.supabase; app_rw is the runtime role, not the migrator.",
    );
    process.exit(1);
  }
  console.log(`connected as ${who}\n`);
}

const sql = postgres(url, { ssl: "require", prepare: false });
await preflight(sql);

const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'implementation'
    AND column_name IN ('onfinance_launch_approver_email', 'provider_launch_approver_email')`;
const names = new Set(cols.map((c) => c.column_name));

if (names.has("provider_launch_approver_email") && !names.has("onfinance_launch_approver_email")) {
  console.log("✓ already renamed — nothing to do");
  await sql.end();
  process.exit(0);
}
if (!names.has("onfinance_launch_approver_email")) {
  console.log("✗ neither column exists on `implementation` — is this the right database?");
  await sql.end();
  process.exit(1);
}
if (names.size === 2) {
  console.log(
    "✗ BOTH columns exist. A half-applied rename needs a human: pick which one holds\n" +
      "  the real values, copy it across, and drop the other. Refusing to guess.",
  );
  await sql.end();
  process.exit(1);
}

/**
 * Say what would be lost before losing it. Nothing should be set — that was
 * verified per-workspace beforehand — but "should" is what a check is for, and
 * a rename is cheap to do loudly.
 */
const [{ n }] = await sql`
  SELECT count(*)::int AS n FROM implementation WHERE onfinance_launch_approver_email IS NOT NULL`;
console.log(`rows with a value in the old column: ${n} (a rename preserves them either way)`);

await sql`ALTER TABLE implementation
          RENAME COLUMN onfinance_launch_approver_email TO provider_launch_approver_email`;

const [check] = await sql`
  SELECT count(*)::int AS n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'implementation'
    AND column_name = 'provider_launch_approver_email'`;
console.log(check.n ? "✓ provider_launch_approver_email is in place" : "✗ rename did not take");

await sql.end();
