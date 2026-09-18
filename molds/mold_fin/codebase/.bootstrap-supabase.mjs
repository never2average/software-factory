/**
 * Bootstrap a FRESH Postgres (Supabase) to run this app.
 *
 * Why this exists instead of replaying the 28 staged `.migrate-*.mjs` scripts:
 * those are incremental ALTERs written against whatever the schema was that
 * day, and several assume state a sibling script left behind. On an empty
 * database the schema in `agent/lib/db/schema.ts` is the source of truth, so
 * `drizzle-kit push` materialises all 51 tables in one correct shot.
 *
 * What Drizzle does NOT model, and this script therefore does:
 *   1. Row-Level Security — the org-isolation backstop under the app filters.
 *   2. The `app_rw` login role (NOBYPASSRLS), which is the thing that makes
 *      RLS actually bite. A role with BYPASSRLS silently ignores every policy,
 *      and FORCE ROW LEVEL SECURITY does not override it.
 *
 * ORDER MATTERS: push the schema first (via `npm run db:push`), then this.
 *
 * Reads the admin connection from .env.supabase (pulled from Vercel); the app's
 * own .env.local still points at the OLD database until this succeeds.
 *
 * Run:  ! node .bootstrap-supabase.mjs
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.supabase", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

// Session-mode (5432) connection for DDL and role management.
const url = env.SUPABASE_POSTGRES_URL_NON_POOLING;
if (!url) throw new Error("No SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");
// Generated, not typed: this password is never seen by a human and never
// pasted into a chat window, it only travels .env.local → vercel env.
const password = process.env.APP_RW_PASSWORD || randomBytes(24).toString("base64url");
const dbName = new URL(url).pathname.replace(/^\//, "") || "postgres";
const sql = postgres(url, { ssl: "require" });

const [{ current_user: adminUser }] = await sql`SELECT current_user`;
console.log(`connected to ${dbName} as ${adminUser}`);

/**
 * Guard: the schema must be COMPLETE before we build security on top of it.
 *
 * This used to check "are there any tables at all", which is worthless: a push
 * that dies partway leaves a prefix of the schema behind, and the later checks
 * all pass vacuously (a table that does not exist is not a table app_rw cannot
 * read). It printed READY over a database missing 41 of 51 tables. So compare
 * against the real expected set, parsed from the schema module itself.
 */
const expected = [
  ...readFileSync("agent/lib/db/schema.ts", "utf8").matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g),
].map((m) => m[1]);
const actual = new Set(
  (await sql`SELECT table_name FROM information_schema.tables
             WHERE table_schema='public' AND table_type='BASE TABLE'`).map((r) => r.table_name),
);
const missingTables = expected.filter((t) => !actual.has(t));
if (missingTables.length) {
  console.error(`✗ Schema INCOMPLETE — ${missingTables.length} of ${expected.length} tables missing:`);
  console.error("  " + missingTables.join(", "));
  console.error("\n  A partial push is usually a schema error that aborted mid-run.");
  console.error("  Re-run the push, read its LAST line, and fix what it reports:");
  console.error(`    DATABASE_URL="$(grep -m1 '^SUPABASE_POSTGRES_URL_NON_POOLING=' .env.supabase | cut -d= -f2- | tr -d '"')" npx drizzle-kit push --force`);
  process.exit(1);
}
console.log(`✓ schema complete: all ${expected.length} tables present`);

/* ------------------------------------------------------------------ *
 * 1. RLS on the org-scoped tables.
 * ------------------------------------------------------------------ */
const SCOPED = [
  "customers", "connectors", "workflows", "apps", "cycles",
  "todos", "people_roster", "memories", "schedule_rules", "automation_runs",
  "automation_audit", "entity_activity", "comments",
];

// Permissive when the GUC is unset: the many non-request paths (agent tools,
// crons, the dispatcher, these scripts) never set it and must keep working.
// Request paths go through `withOrgRls`, and there the policy is enforced.
const PREDICATE = `(
  current_setting('app.org_id', true) IS NULL
  OR current_setting('app.org_id', true) = ''
  OR org_id = current_setting('app.org_id', true)
)`;

let done = 0;
for (const table of SCOPED) {
  const [t] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
  if (!t) throw new Error(`org-scoped table ${table} is absent — schema is incomplete`);
  const [c] = await sql`SELECT 1 AS x FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name='org_id'`;
  if (!c) { console.log(`  – ${table} (no org_id, skipped)`); continue; }
  await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON ${table}`);
  await sql.unsafe(
    `CREATE POLICY org_isolation ON ${table} USING ${PREDICATE} WITH CHECK ${PREDICATE}`,
  );
  done++;
}
console.log(`✓ RLS + org_isolation on ${done} tables`);

/* ------------------------------------------------------------------ *
 * 2. connector_secrets: STRICT — denies when the GUC is unset.
 *    Credentials are the one table where "permissive by default" is wrong.
 * ------------------------------------------------------------------ */
const [hasSecrets] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name='connector_secrets'`;
if (hasSecrets) {
  await sql.unsafe(`ALTER TABLE connector_secrets ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`ALTER TABLE connector_secrets FORCE ROW LEVEL SECURITY`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON connector_secrets`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation_strict ON connector_secrets`);
  const STRICT = `(
    current_setting('app.org_id', true) IS NOT NULL
    AND current_setting('app.org_id', true) <> ''
    AND org_id = current_setting('app.org_id', true)
  )`;
  await sql.unsafe(
    `CREATE POLICY org_isolation_strict ON connector_secrets USING ${STRICT} WITH CHECK ${STRICT}`,
  );
  console.log("✓ connector_secrets: org_isolation_strict (denies when GUC unset)");
}

/* ------------------------------------------------------------------ *
 * 3. The app_rw role.
 * ------------------------------------------------------------------ */
const pwLit = `'${password.replace(/'/g, "''")}'`;
const [existing] = await sql`
  SELECT rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = 'app_rw'`;
if (existing) {
  /**
   * Re-running: change ONLY the password.
   *
   * Managed Postgres (Supabase's supautils) rejects any ALTER ROLE carrying
   * BYPASSRLS or SUPERUSER — they are superuser-only attributes and the
   * platform's admin role is not a superuser. Restating "NOBYPASSRLS" on a
   * role that is already NOBYPASSRLS is therefore both pointless and fatal.
   * So assert the attributes instead of re-asserting them, and fail loudly if
   * they ever drift, since we would have no way to correct them here.
   */
  if (existing.rolbypassrls || existing.rolsuper) {
    console.error("✗ app_rw has BYPASSRLS or SUPERUSER — it would ignore every RLS policy.");
    console.error("  This cannot be repaired without a superuser. Drop the role and re-run.");
    process.exit(1);
  }
  await sql.unsafe(`ALTER ROLE app_rw WITH PASSWORD ${pwLit}`);
  console.log("✓ Rotated password for existing role app_rw (attributes verified, untouched)");
} else {
  await sql.unsafe(`CREATE ROLE app_rw WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pwLit}`);
  console.log("✓ Created role app_rw (NOBYPASSRLS)");
}
await sql.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO app_rw`);
await sql`GRANT USAGE ON SCHEMA public TO app_rw`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw`;
await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw`;
await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw`);
await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw`);
console.log("✓ Grants applied (incl. default privileges for future tables)");

/* ------------------------------------------------------------------ *
 * 4. Verify — the checks that caught real mistakes before.
 * ------------------------------------------------------------------ */
const [role] = await sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='app_rw'`;
const [{ policies }] = await sql`SELECT count(*)::int AS policies FROM pg_policies WHERE schemaname='public'`;
const [{ missing }] = await sql`
  SELECT count(*)::int AS missing FROM information_schema.tables t
  WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
    AND NOT has_table_privilege('app_rw', format('%I.%I', t.table_schema, t.table_name), 'SELECT')`;

console.log("\n--- verification ---");
console.log(`app_rw BYPASSRLS : ${role.rolbypassrls}  (must be false — true silently disables every policy)`);
console.log(`app_rw SUPERUSER : ${role.rolsuper}  (must be false)`);
console.log(`policies         : ${policies}`);
console.log(`tables app_rw cannot SELECT: ${missing}  (must be 0)`);

const ok = role.rolbypassrls === false && role.rolsuper === false && policies > 0 && missing === 0;
if (!ok) {
  console.log("\n✗ NOT READY — fix the above before swapping DATABASE_URL.");
  await sql.end();
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 5. Compose the app's connection string and install it locally.
 *
 * Supabase fronts BOTH ports with its pooler and expects a TENANT-QUALIFIED
 * username — `app_rw.<project-ref>`, not `app_rw`. Connecting as plain app_rw
 * fails authentication in a way that reads like a wrong password.
 *
 * Runtime uses 6543 (transaction pooling): safe here because withOrgRls sets
 * app.org_id via set_config(..., true), which is transaction-LOCAL, and both
 * clients already run prepare:false.
 * ------------------------------------------------------------------ */
const ref = decodeURIComponent(new URL(url).username).split(".")[1]; // postgres.<ref>
const appUrl = new URL(url);
appUrl.port = "6543";
appUrl.username = ref ? `app_rw.${ref}` : "app_rw";
appUrl.password = password;

/**
 * PERSIST BEFORE VERIFYING.
 *
 * The password is generated here and exists nowhere else. An earlier version
 * tested the connection first and wrote the file second — when the test failed,
 * the only copy of a password that had already been set on the live role went
 * with the process, leaving an account nobody could log into. Write it down,
 * then check it.
 */
const local = readFileSync(".env.local", "utf8");
const line = `DATABASE_URL="${appUrl.toString()}"`;
writeFileSync(
  ".env.local",
  /^DATABASE_URL=/m.test(local) ? local.replace(/^DATABASE_URL=.*$/m, line) : `${local.trimEnd()}\n${line}\n`,
);
console.log("✓ .env.local DATABASE_URL now points at Supabase as app_rw");

/**
 * Now prove it works — with retries.
 *
 * Supabase fronts Postgres with Supavisor, which caches tenant credentials.
 * A freshly rotated password is rejected at the pooler for up to a minute
 * after the database itself has accepted it, so a single immediate attempt
 * reports a failure that is not real.
 */
let who = null;
for (let attempt = 1; attempt <= 6; attempt++) {
  const appSql = postgres(appUrl.toString(), { max: 1, prepare: false, connect_timeout: 10 });
  try {
    [who] = await appSql`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`;
    await appSql.end();
    break;
  } catch (e) {
    await appSql.end().catch(() => {});
    if (e?.code !== "28P01" || attempt === 6) throw e;
    console.log(`  pooler still has the old credential cached (attempt ${attempt}/6) — waiting 10s`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
console.log(`\napp_rw connection test: current_user=${who.current_user} bypassrls=${who.bypass}`);
console.log("\n✓ READY. Next: push the same value to both Vercel projects (see chat).");
await sql.end();
process.exit(0);
