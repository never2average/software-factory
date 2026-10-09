// Setup: a dedicated NON-BYPASS Postgres role for the app runtime, so ROW-LEVEL
// SECURITY actually enforces (the default Neon role `neondb_owner` has
// BYPASSRLS and ignores every policy).
//
// This connects as your OWNER role (the DATABASE_URL in .env.local, i.e.
// neondb_owner — which has CREATEROLE) and creates `app_rw`:
//   * LOGIN, NOBYPASSRLS (a freshly-created role never gets BYPASSRLS)
//   * SELECT/INSERT/UPDATE/DELETE on every table in `public` + USAGE/SELECT on
//     sequences, and DEFAULT PRIVILEGES so future tables are covered too
//   * NO CREATE on the schema → it cannot run DDL. **Migrations keep using
//     neondb_owner** (this script, .env.local); only the DEPLOYED APP swaps to
//     app_rw.
//
// The password comes from the APP_RW_PASSWORD env var so it never lands in this
// file or the logs. Run it like:
//
//   ! APP_RW_PASSWORD='<a-strong-password>' node .setup-app-role.mjs
//
// Then, on BOTH Vercel projects (agent-workspace + agent-workspace-api), set DATABASE_URL to
// the SAME Neon connection string but with the username/password swapped to
// app_rw / <that password>. Test on a preview deployment BEFORE prod — a missing
// GRANT would break every query. Reverting is just: point DATABASE_URL back at
// neondb_owner.
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

const password = process.env.APP_RW_PASSWORD || env.APP_RW_PASSWORD;
if (!password || password.length < 12) {
  console.error("✗ Set APP_RW_PASSWORD (env var or .env.local) to a strong (12+ char) password.");
  process.exit(1);
}

const url = env.DATABASE_URL;
const dbName = new URL(url).pathname.replace(/^\//, "") || "neondb";
const sql = postgres(url, { ssl: "require" });

// 1. Create (or update the password of) the role. Idempotent.
const pwLit = `'${password.replace(/'/g, "''")}'`; // escaped SQL string literal
const [exists] = await sql`SELECT 1 AS x FROM pg_roles WHERE rolname = 'app_rw'`;
if (exists) {
  await sql.unsafe(`ALTER ROLE app_rw WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pwLit}`);
  console.log("• app_rw already existed — password/attributes updated.");
} else {
  await sql.unsafe(`CREATE ROLE app_rw WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pwLit}`);
  console.log("✓ Created role app_rw (NOBYPASSRLS).");
}

// 2. Privileges. CONNECT + schema USAGE, DML on all current tables/sequences.
await sql.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO app_rw`);
await sql`GRANT USAGE ON SCHEMA public TO app_rw`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw`;
await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw`;

// 3. DEFAULT PRIVILEGES so tables/sequences neondb_owner creates LATER are
//    automatically readable/writable by app_rw (future migrations).
await sql`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw`;
await sql`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
          GRANT USAGE, SELECT ON SEQUENCES TO app_rw`;
console.log("✓ Granted DML on all tables/sequences + default privileges for future ones.");

// 4. Verify: app_rw is non-bypass, and RLS enforces for it.
const [r] = await sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='app_rw'`;
console.log("app_rw bypassrls:", r.rolbypassrls, "| superuser:", r.rolsuper, r.rolbypassrls ? "  ✗ UNEXPECTED" : "  ✓");

// Prove enforcement AS app_rw: connect as it and check the foreign-org GUC gives
// zero rows (real RLS), and the unset GUC gives all rows (permissive).
await sql.end();

const appUrl = (() => {
  const u = new URL(url);
  u.username = "app_rw";
  u.password = password;
  return u.toString();
})();
const app = postgres(appUrl, { ssl: "require" });
try {
  const [{ n: all }] = await app`SELECT count(*)::int n FROM todos`;
  let scoped = -1;
  await app.begin(async (tx) => {
    await tx`select set_config('app.org_id','zz-nonexistent-org',true)`;
    const [{ n }] = await tx`SELECT count(*)::int n FROM todos`;
    scoped = n;
  });
  console.log(`\nAS app_rw → todos (GUC unset, permissive): ${all} rows`);
  console.log(`AS app_rw → todos (foreign-org GUC, should be 0): ${scoped}`, scoped === 0 ? "  ✓ RLS ENFORCES" : "  ✗ still leaking");
  console.log("\nNext: set DATABASE_URL on both Vercel projects to the app_rw connection string (same host/db, username=app_rw). Test on a preview first.");
} catch (e) {
  console.error("✗ app_rw connectivity/permission check failed:", e?.message ?? e);
  console.error("  Fix the missing GRANT before swapping DATABASE_URL.");
  process.exitCode = 1;
} finally {
  await app.end();
}
