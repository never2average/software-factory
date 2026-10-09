/**
 * THE OWNER-ONLY POLICIES — re-established by every bootstrap, not just by the migration that introduced them.
 *
 * `chat_queue_items` and `push_subscriptions` are one PERSON's rows inside a workspace, so besides the
 * `org_isolation` every scoped table gets, each carries a RESTRICTIVE policy (ANDed with it) that keeps a colleague
 * in the same workspace out whenever a request names its person (`app.principal_email`, set by
 * withOrgRls({ orgId, principal })).
 *
 * WHY HERE. A deploy runs `drizzle-kit push --force` (which drops policies the schema file does not declare and can
 * leave RLS disabled), then the migration journal (0021 is already recorded, so it does NOT run again), then the
 * bootstrap — which used to restore only `org_isolation`. The owner policies were therefore gone after the first
 * redeploy (review of #63). Both bootstraps (.bootstrap-supabase.mjs for deployments, scripts/bootstrap-test-db.mjs
 * for CI) call `applyOwnerOnlyPolicies`, and scripts/test-chat-queue-db.mjs simulates push --force → bootstrap and
 * asserts both policies are back.
 *
 * Idempotent; a table that does not exist yet is skipped (reported). `sql` is a postgres.js client on an admin URL.
 */
export const OWNER_ONLY_TABLES = [
  { table: "chat_queue_items", policy: "chat_queue_owner" },
  { table: "push_subscriptions", policy: "push_subscriptions_owner" },
];

export const OWNER_PREDICATE = `(NULLIF(current_setting('app.principal_email', true), '') IS NULL OR owner_email = current_setting('app.principal_email', true))`;

export async function applyOwnerOnlyPolicies(sql) {
  const applied = [];
  const skipped = [];
  for (const { table, policy } of OWNER_ONLY_TABLES) {
    const [t] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
    if (!t) {
      skipped.push(table);
      continue;
    }
    await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await sql.unsafe(`DROP POLICY IF EXISTS ${policy} ON ${table}`);
    await sql.unsafe(`CREATE POLICY ${policy} ON ${table} AS RESTRICTIVE USING ${OWNER_PREDICATE} WITH CHECK ${OWNER_PREDICATE}`);
    applied.push(`${table}.${policy}`);
  }
  return { applied, skipped };
}
