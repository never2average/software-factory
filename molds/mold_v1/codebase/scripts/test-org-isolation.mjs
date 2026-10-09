/**
 * Cross-tenant isolation test for the org (workspace) layer.
 *
 * Runs against the LIVE database and proves, at the data layer:
 *   0. we are connected as a role RLS actually applies to,
 *   1. the tenancy migration ran,
 *   2. EVERY org-scoped table has an org_isolation policy,
 *   3. no rows are stranded with a NULL tenant,
 *   4. a scoped read returns only the caller's rows,
 *   5. a cross-tenant WRITE is refused by the database.
 *
 * Two things it deliberately does differently from the version it replaces.
 *
 * It DISCOVERS the scoped tables from information_schema instead of carrying a
 * hard-coded list. The old list named 14 tables and was written before 22 more
 * gained an org_id — so it passed while checking none of tickets, interactions,
 * deployments or browser_credentials. A test that reads "tenant isolation
 * verified" while silently skipping the tables you just secured is worse than
 * no test, and a hand-maintained list guarantees the drift comes back.
 *
 * And it tests the POLICY, not SQL equality. The old step 3 inserted a row
 * under org A, selected `WHERE org_id = <org #1>`, and asserted it wasn't
 * returned — which is true of any database with a working WHERE clause,
 * whether or not RLS exists at all. This sets the request GUC and checks what
 * the database itself permits.
 *
 * NON-DESTRUCTIVE: probe rows live under throwaway orgs and are removed in a
 * finally block. SKIPS cleanly if the migration hasn't run.
 *
 * Usage: npm run test:org-isolation   (needs --env-file=.env.local)
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFileSync } from "node:fs";

/**
 * DATABASE_URL from the environment first, then .env.local.
 *
 * The file is OPTIONAL: this used to readFileSync it unconditionally, so the
 * test threw ENOENT anywhere without one — which is precisely CI, and part of
 * why the most important test in the repo never ran there.
 */
function readEnvFile(file) {
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

const url = process.env.DATABASE_URL || readEnvFile(".env.local").DATABASE_URL;
if (!url) {
  console.error("✗ No DATABASE_URL — set it, or run with --env-file=.env.local.");
  process.exit(1);
}

// TLS as the APPLICATION connects (lib/ops-db.ts passes no `ssl`, so postgres.js reads the URL's own `sslmode`):
// a URL that says sslmode is obeyed. A self-hosted server's Postgres listens on loopback AND requires TLS
// (sslmode=require, pg_hba hostssl only), and this test used to force `ssl: false` for every loopback URL, so it
// could not connect as the app there at all ("no pg_hba.conf entry … no encryption"). Without an sslmode the old
// rule stands: `ssl: require` breaks against a plain local Postgres (the CI service container), and a hosted
// Postgres needs it. An explicit `ssl` option would override the URL's sslmode in postgres.js, so none is passed.
const urlSslmode = (() => {
  try {
    return new URL(url).searchParams.get("sslmode");
  } catch {
    return null;
  }
})();
const ssl = urlSslmode ? {} : { ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require" };
const sql = postgres(url, { ...ssl, prepare: false, connect_timeout: 20 });
const ORG_A = "zz-iso-a";
const ORG_B = "zz-iso-b";

/**
 * Every row this test touches is touched WITH A WORKSPACE IN SCOPE, the way the
 * application itself writes. Under a fail-closed policy a statement with no
 * app.org_id set reaches no row at all: an unscoped INSERT is refused and an
 * unscoped DELETE silently deletes nothing, so the old unscoped seed died with
 * "new row violates row-level security policy" and the old cleanup left the
 * throwaway orgs behind. Scoping is not a concession to the test — it is the
 * contract the policies enforce.
 */
async function asWorkspace(org, fn) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  });
}
async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    try {
      await asWorkspace(org, async (tx) => {
        await tx`DELETE FROM customers WHERE org_id = ${org} AND customer_id LIKE 'zz-iso-%'`;
        await tx`DELETE FROM orgs WHERE org_id = ${org}`;
      });
    } catch {
      /* best-effort */
    }
  }
}

try {
  /* 0. Is this test even capable of failing? -------------------------------
   * A role with BYPASSRLS ignores every policy, so everything below would pass
   * against a database with no isolation whatsoever. Assert the premise before
   * asserting anything that depends on it. */
  const [role] = await sql`
    SELECT current_user AS name,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
  assert.equal(
    role.bypass,
    false,
    `connected as ${role.name}, which has BYPASSRLS — this test cannot detect a leak. Point DATABASE_URL at app_rw.`,
  );
  console.log(`✓ Connected as ${role.name} (no BYPASSRLS) — RLS applies to this session.`);

  /* 1. Migration present? -------------------------------------------------- */
  const [{ reg }] = await sql`SELECT to_regclass('public.orgs') AS reg`;
  if (!reg) {
    console.log("• Tenancy not migrated yet (orgs table absent) — SKIPPING.");
    await sql.end();
    process.exit(0);
  }

  /* 2. Every scoped table must have a policy ------------------------------- */
  const scoped = (
    await sql`SELECT c.table_name FROM information_schema.columns c
              JOIN information_schema.tables t
                ON t.table_schema='public' AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
              WHERE c.table_schema='public' AND c.column_name='org_id'
              ORDER BY 1`
  ).map((r) => r.table_name);

  // Identity resolution legitimately spans workspaces ("which workspaces am I
  // in" is a cross-org read), and the recipe catalog's built-in rows are global
  // by design (org_id NULL), which the policy predicate would hide.
  const EXEMPT = new Set(["orgs", "org_members", "org_invites", "recipes"]);
  const checked = scoped.filter((t) => !EXEMPT.has(t));
  const policied = new Set(
    (await sql`SELECT tablename FROM pg_policies WHERE schemaname='public'`).map((r) => r.tablename),
  );
  const unpolicied = checked.filter((t) => !policied.has(t));
  assert.equal(
    unpolicied.length,
    0,
    `these tables carry an org_id but have NO RLS policy: ${unpolicied.join(", ")}`,
  );
  console.log(`✓ Policies: all ${checked.length} scoped tables have org_isolation.`);

  /* 3. Nothing stranded with a NULL tenant --------------------------------- */
  const stranded = [];
  for (const table of checked) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE org_id IS NULL`);
    if (n > 0) stranded.push(`${table} (${n})`);
  }
  assert.equal(
    stranded.length,
    0,
    `rows with a NULL org_id are invisible to every workspace: ${stranded.join(", ")}`,
  );
  console.log(`✓ Tenancy: no stranded rows across ${checked.length} tables.`);

  /* 4 + 5. What the DATABASE permits, not what a WHERE clause returns ------ */
  await cleanup();
  await asWorkspace(ORG_A, async (tx) => {
    await tx`INSERT INTO orgs (org_id, name) VALUES (${ORG_A}, 'A')`;
    await tx`INSERT INTO customers (customer_id, org_id, customer_name) VALUES ('zz-iso-a-c', ${ORG_A}, 'A Corp')`;
  });
  await asWorkspace(ORG_B, async (tx) => {
    await tx`INSERT INTO orgs (org_id, name) VALUES (${ORG_B}, 'B')`;
    await tx`INSERT INTO customers (customer_id, org_id, customer_name) VALUES ('zz-iso-b-c', ${ORG_B}, 'B Corp')`;
  });

  const visible = await sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${ORG_A}, true)`;
    return tx`SELECT customer_id FROM customers WHERE customer_id LIKE 'zz-iso-%'`;
  });
  assert.deepEqual(
    visible.map((r) => r.customer_id),
    ["zz-iso-a-c"],
    `scoped to ${ORG_A} the database returned: ${visible.map((r) => r.customer_id).join(", ") || "(nothing)"}`,
  );
  console.log("✓ Read: scoped to one workspace, only its own rows come back.");

  let refused = false;
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${ORG_A}, true)`;
      await tx`INSERT INTO customers (customer_id, org_id, customer_name)
               VALUES ('zz-iso-evil', ${ORG_B}, 'Stolen')`;
    });
  } catch (e) {
    refused = e.code === "42501"; // insufficient_privilege — the WITH CHECK arm
  }
  assert.ok(refused, `a write into ${ORG_B} while scoped to ${ORG_A} was ALLOWED`);
  console.log("✓ Write: a cross-tenant insert is refused by the database (42501).");

  console.log("\n✓ Org isolation test PASSED.");
} catch (e) {
  console.error(`✗ ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  await sql.end();
}
