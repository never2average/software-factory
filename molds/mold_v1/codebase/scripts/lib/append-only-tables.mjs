/**
 * APPEND-ONLY TABLES: app_rw may read and add rows, never change or remove them. Re-established by every bootstrap,
 * not just by the migration that made the table.
 *
 * Both bootstraps grant app_rw SELECT, INSERT, UPDATE, DELETE on ALL TABLES (and as the default for new ones), so a
 * REVOKE in a migration alone would be undone by the next deploy's bootstrap. Each bootstrap (.bootstrap-supabase.mjs
 * for deployments, scripts/bootstrap-test-db.mjs for CI) calls `applyAppendOnlyGrants` after its grants, the way it
 * calls applyOwnerOnlyPolicies (scripts/lib/owner-only-policies.mjs).
 *
 *   record_workflow_events — a record workflow's history (drizzle/0047, lib/record-workflow-store.ts): an audit trail.
 *
 * Idempotent; a table that does not exist yet is skipped (reported). `sql` is a postgres.js client on an admin URL.
 */
export const APPEND_ONLY_TABLES = ["record_workflow_events"];

export async function applyAppendOnlyGrants(sql) {
  const applied = [];
  const skipped = [];
  for (const table of APPEND_ONLY_TABLES) {
    const [t] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
    if (!t) {
      skipped.push(table);
      continue;
    }
    await sql.unsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON "${table}" FROM app_rw`);
    await sql.unsafe(`GRANT SELECT, INSERT ON "${table}" TO app_rw`);
    applied.push(table);
  }
  return { applied, skipped };
}
