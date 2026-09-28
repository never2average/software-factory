/**
 * Build a throwaway Postgres into a faithful copy of the tenancy model, so the
 * isolation test can run in CI against a database nobody has to provision.
 *
 * Why not point CI at the real database: the test writes probe rows, and a
 * secret that reaches production from every PR is a worse trade than the thing
 * it verifies. An ephemeral service container needs no credentials, works on
 * forks, and can be freely written to.
 *
 * This is the vanilla-Postgres sibling of .bootstrap-supabase.mjs. That script
 * is full of Supabase specifics — supautils rejecting ALTER ROLE with
 * NOBYPASSRLS, Supavisor's tenant-qualified usernames, a pooler that caches
 * credentials — none of which apply here, and all of which would fail on a
 * plain server. The SECURITY MODEL is the part that must match:
 *
 *   * app_rw is NOBYPASSRLS. A role that bypasses RLS makes every assertion in
 *     the isolation test vacuous, which is the one way this could pass while
 *     proving nothing.
 *   * org_isolation is permissive when the GUC is unset, so the non-request
 *     paths (crons, agent tools) keep working.
 *   * connector_secrets is STRICT — it denies when the GUC is unset.
 *
 * Schema comes from drizzle-kit push, so this tracks schema.ts automatically:
 * a new table with an org_id gets a policy here and is then checked by the
 * test, with no list to maintain.
 *
 * Usage:  DATABASE_URL=postgres://…  node scripts/bootstrap-test-db.mjs
 *         (expects an ADMIN url; prints the app_rw url to stdout's last line)
 */
import postgres from "postgres";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("✗ Set DATABASE_URL to an admin connection.");
  process.exit(1);
}

const APP_PASSWORD = process.env.APP_RW_PASSWORD || "app_rw_test_password";
const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const sql = postgres(adminUrl, { ssl: local ? false : "require", prepare: false });

const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}`);

/* 1. The app role — NOBYPASSRLS is the whole point. ---------------------- */
const pw = `'${APP_PASSWORD.replace(/'/g, "''")}'`;
const [exists] = await sql`SELECT 1 AS x FROM pg_roles WHERE rolname = 'app_rw'`;
await sql.unsafe(
  exists
    ? `ALTER ROLE app_rw WITH LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD ${pw}`
    : `CREATE ROLE app_rw WITH LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD ${pw}`,
);
const dbName = new URL(adminUrl).pathname.replace(/^\//, "") || "postgres";
await sql.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO app_rw`);
await sql`GRANT USAGE ON SCHEMA public TO app_rw`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw`;
await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw`;
console.log("✓ role app_rw (NOBYPASSRLS) + grants");

/* 2. RLS on every table that carries a tenant. --------------------------- */
const PREDICATE = `(
  current_setting('app.org_id', true) IS NULL
  OR current_setting('app.org_id', true) = ''
  OR org_id = current_setting('app.org_id', true)
)`;
const STRICT = `(
  current_setting('app.org_id', true) IS NOT NULL
  AND current_setting('app.org_id', true) <> ''
  AND org_id = current_setting('app.org_id', true)
)`;

// Identity resolution legitimately spans workspaces, and the recipe catalog's
// global rows (org_id NULL) would be hidden by the predicate. Mirrors the
// EXEMPT set the isolation test uses.
const EXEMPT = new Set(["orgs", "org_members", "org_invites", "recipes"]);

const scoped = (
  await sql`SELECT c.table_name FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema='public' AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
            WHERE c.table_schema='public' AND c.column_name='org_id'
            ORDER BY 1`
).map((r) => r.table_name);

let n = 0;
for (const table of scoped) {
  if (EXEMPT.has(table)) continue;
  const strict = table === "connector_secrets";
  const predicate = strict ? STRICT : PREDICATE;
  const policy = strict ? "org_isolation_strict" : "org_isolation";
  await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON ${table}`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation_strict ON ${table}`);
  await sql.unsafe(`CREATE POLICY ${policy} ON ${table} USING ${predicate} WITH CHECK ${predicate}`);
  n++;
}
console.log(`✓ RLS on ${n} scoped tables (${scoped.length - n} exempt)`);

/* 2b. Owner-only rows: the RESTRICTIVE policies, exactly as .bootstrap-supabase.mjs applies them on a deploy. */
{
  const { applyOwnerOnlyPolicies } = await import("./lib/owner-only-policies.mjs");
  const { applied } = await applyOwnerOnlyPolicies(sql);
  console.log(`✓ owner-only policies: ${applied.join(", ") || "none"}`);
}

/* 3. Prove the premise before anyone relies on it. ----------------------- */
const [role] = await sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='app_rw'`;
if (role.rolbypassrls || role.rolsuper) {
  console.error("✗ app_rw can bypass RLS — the isolation test would pass vacuously.");
  process.exit(1);
}

const appUrl = new URL(adminUrl);
appUrl.username = "app_rw";
appUrl.password = APP_PASSWORD;
await sql.end();

console.log("✓ ready");
// Last line is the app_rw connection string, for `$(… | tail -1)`.
console.log(appUrl.toString());
