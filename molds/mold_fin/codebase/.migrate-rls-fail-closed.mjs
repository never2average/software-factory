/**
 * Migration 2 of 2 for hard tenancy: the policy stops failing open.
 *
 * Today every `org_isolation` policy reads:
 *
 *   current_setting('app.org_id', true) IS NULL OR org_id = current_setting(...)
 *
 * The first clause is an escape hatch big enough to drive the whole product
 * through: any query that does not set the GUC sees EVERY workspace. That is
 * not a backstop, it is a decoration — isolation rests entirely on hand-written
 * filters, and this session alone found five places where one was missing.
 *
 * After this migration a query with no workspace in scope returns ZERO rows.
 * That is the "hard" in hard separation, and it is also why this runs LAST:
 *
 *   ┌─ DO NOT RUN THIS UNTIL BOTH ARE TRUE ─────────────────────────────────┐
 *   │ 1. `npm run check:tenancy` reports 0 pending routes.                  │
 *   │ 2. Production DATABASE_URL uses app_rw (NOBYPASSRLS), not postgres.   │
 *   │    While prod runs as a BYPASSRLS role this migration changes         │
 *   │    NOTHING in production — the policies are skipped entirely.         │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Run it with a route still unconverted and that route returns empty results —
 * silently, because an empty list is a valid answer. Hence the refusal below:
 * it will not run without --force, and it prints exactly what it is about to do.
 *
 * Rollback is symmetric and included:  ! node .migrate-rls-fail-closed.mjs --revert
 *
 * Review, then run:  ! node .migrate-rls-fail-closed.mjs --force
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

const revert = process.argv.includes("--revert");
const force = process.argv.includes("--force");

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

const policies = await sql`
  SELECT tablename FROM pg_policies
  WHERE schemaname = 'public' AND policyname = 'org_isolation'
  ORDER BY tablename`;

// Any column still accepting NULL is a row that can exist owned by nobody, and
// under a fail-closed policy nobody can ever read it again.
const nullable = await sql`
  SELECT table_name FROM information_schema.columns
  WHERE column_name = 'org_id' AND table_schema = 'public' AND is_nullable = 'YES'`;

console.log(`${policies.length} table(s) carry an org_isolation policy`);
if (nullable.length && !revert) {
  console.log(
    `\n✗ ${nullable.length} org_id column(s) still accept NULL — run .migrate-org-not-null.mjs first.` +
      `\n  A NULL-owned row becomes permanently unreadable under a fail-closed policy.`,
  );
  await sql.end();
  process.exit(1);
}

/**
 * BOTH PROJECTS MUST ACTUALLY USE THEIR SCOPE.
 *
 * This is the precondition I asserted was met, then checked wrongly, twice.
 *
 * First I did not check it at all: the web app was fully converted, the agent
 * is a SEPARATE project with its own database layer, and flipping made every
 * agent tool read zero rows. The console looked healthy while the product was
 * blind — the exact asymmetry that makes "the app still works" insufficient.
 *
 * Then I checked whether agent/lib/db/index.ts *mentions* app.org_id. It does:
 * withOrgDb() has existed all along. Nothing called it. Presence of a helper
 * says nothing about whether callers reach for it, so count the callers.
 *
 * That counting used to live HERE, inline — a guard that ran once, on the day
 * of the migration, and never again. Meanwhile the identical web-side check ran
 * on every commit, and when its file-vs-statement flaw was fixed, this copy was
 * not: two versions of one rule, drifting. The rule now lives in exactly one
 * place, scripts/check-tenancy.mjs, which covers both surfaces and runs in CI.
 * This calls that, so the migration and the pipeline can never disagree.
 */
if (!revert) {
  const { execSync } = await import("node:child_process");
  try {
    execSync("node scripts/check-tenancy.mjs", { stdio: "inherit" });
  } catch {
    console.log(
      "\n✗ Some code still reads tenant data outside a workspace scope, so those reads" +
        "\n  return zero rows once the policy fails closed. Fix them before flipping;" +
        "\n  `npm run check:tenancy -- --list` names the files.",
    );
    await sql.end();
    process.exit(1);
  }
}

if (!force && !revert) {
  console.log(
    "\nThis would make every org_isolation policy FAIL CLOSED: a query that does" +
      "\nnot set app.org_id returns zero rows instead of every workspace's." +
      "\n\nConfirm first:" +
      "\n  • npm run check:tenancy   → must report 0 pending" +
      "\n  • production DATABASE_URL → must be app_rw, not postgres" +
      "\n\nThen re-run with --force.",
  );
  await sql.end();
  process.exit(1);
}

for (const { tablename: t } of policies) {
  /**
   * "Unset" is NULL *or* the empty string, and that distinction cost an outage.
   *
   * On a POOLED connection a transaction-local set_config does not reset the
   * GUC to unset — it resets it to ''. `IS NULL` is false for '', so
   * `org_id = ''` matched nothing and any server connection that had ever run
   * withOrgRls silently saw ZERO rows from then on, under a policy that was
   * supposed to be failing open. It looked like the fail-closed flip breaking
   * things; it was the fail-OPEN clause having quietly stopped working.
   */
  const using = revert
    ? `(coalesce(current_setting('app.org_id', true), '') = '' OR org_id = current_setting('app.org_id', true))`
    : `(org_id = current_setting('app.org_id', true))`;
  await sql.unsafe(`
    ALTER POLICY org_isolation ON ${t}
      USING ${using}
      WITH CHECK ${using}
  `);
}
console.log(`\n✓ ${policies.length} policies now fail ${revert ? "OPEN (reverted)" : "CLOSED"}`);

/**
 * Prove it rather than assert it — over a REAL app_rw connection.
 *
 * `SET LOCAL ROLE app_rw` was the obvious way and it does not work: Supabase's
 * `postgres` is not a member of app_rw, so the probe threw AFTER the policies
 * had already changed. A migration whose verification cannot run is a
 * migration you have to verify by hand, at exactly the moment you are least
 * inclined to.
 */
const appRwUrl = readEnv(".env.local").DATABASE_URL;
if (appRwUrl && /:\/\/app_rw/.test(appRwUrl) && policies.length) {
  /**
   * A table that actually HAS rows. The first policy alphabetically was
   * account_summaries, which is empty — so the revert probe read 0 and
   * reported failure for a database that was perfectly fine.
   */
  const probe =
    (
      await sql`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.reltuples > 0
                  AND c.relname IN ${sql(policies.map((p) => p.tablename))}
                ORDER BY c.reltuples DESC LIMIT 1`
    )[0]?.relname ?? policies[0].tablename;
  const asApp = postgres(appRwUrl, { ssl: "require", prepare: false, max: 1 });
  try {
    const [{ n }] = await asApp.unsafe(`SELECT count(*)::int n FROM ${probe}`);
    const ok = revert ? n > 0 : n === 0;
    console.log(
      `  probe: app_rw with no workspace reads ${n} row(s) from ${probe} — ` +
        (ok ? "correct" : `✗ EXPECTED ${revert ? "> 0" : "0"}`),
    );
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.log(`  probe skipped: ${String(e.message).slice(0, 90)}`);
  } finally {
    await asApp.end();
  }
} else {
  console.log("  probe skipped: no app_rw DATABASE_URL in .env.local to verify with");
}
await sql.end();
