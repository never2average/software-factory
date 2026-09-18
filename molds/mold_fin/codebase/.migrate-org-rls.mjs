// Migration: Row-Level Security backstop for org (workspace) isolation.
// Run AFTER `.migrate-org-tenancy.mjs` (+ optionally the tighten migration).
//
// Enables RLS + FORCE on every org-scoped table with a policy keyed on the
// per-request GUC `app.org_id` (set by lib/ops-db.ts `withOrgRls`). The policy
// is PERMISSIVE WHEN THE GUC IS UNSET, so:
//   * the many non-request DB paths (agent tools, crons, dispatcher, scripts)
//     that don't set the GUC keep working exactly as before — NON-BREAKING;
//   * HTTP request paths wrapped in `withOrgRls(orgId, …)` are ENFORCED at the
//     database level: a query that forgot its `WHERE org_id = …` still cannot
//     read or write another workspace's rows.
//
// This is a belt-and-braces layer UNDER the application-level filters, not a
// replacement for them. Safe to enable on the live single-org system: with the
// GUC unset everywhere today, every policy evaluates permissive.
//
// Review the DDL, then run:  ! node .migrate-org-rls.mjs
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

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

const SCOPED = [
  "customers", "connectors", "connector_secrets", "workflows", "apps", "cycles",
  "todos", "people_roster", "memories", "schedule_rules", "automation_runs",
  "automation_audit", "entity_activity", "comments",
];

// The predicate: permissive when the GUC is empty/unset, else org_id must match.
// `current_setting('app.org_id', true)` returns NULL (not error) when unset.
const PRED = `(
  nullif(current_setting('app.org_id', true), '') IS NULL
  OR org_id = current_setting('app.org_id', true)
)`;

for (const table of SCOPED) {
  await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  // FORCE so the table OWNER (the app's connection role) is subject to policies
  // too — without it, owner connections bypass RLS entirely.
  await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  // Idempotent: drop then recreate the policy.
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON ${table}`);
  await sql.unsafe(
    `CREATE POLICY org_isolation ON ${table}
       USING ${PRED}
       WITH CHECK ${PRED}`,
  );
}
console.log(`✓ RLS enabled + FORCE + org_isolation policy on ${SCOPED.length} tables (permissive when GUC unset).`);

// Verify one table, and prove the permissive-when-unset behaviour: with no GUC,
// a plain count still sees rows (non-breaking).
const [{ relrowsecurity }] = await sql`
  SELECT relrowsecurity FROM pg_class WHERE oid = 'public.todos'::regclass`;
console.log("todos RLS enabled:", relrowsecurity ? "OK" : "MISSING");
const [{ n }] = await sql`SELECT count(*)::int AS n FROM todos`;
console.log("todos visible with GUC unset (permissive):", n, "rows");

// And prove enforcement WHEN set: set a bogus org, expect zero rows, in a tx.
await sql.begin(async (tx) => {
  await tx`select set_config('app.org_id', 'zz-nonexistent-org', true)`;
  const [{ n: scoped }] = await tx`SELECT count(*)::int AS n FROM todos`;
  console.log("todos visible under a foreign org GUC (should be 0):", scoped);
});

await sql.end();
