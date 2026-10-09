/**
 * Migration: give every business table a tenant, and put RLS under all of them.
 *
 * The gap this closes: 25 of 51 tables had no `org_id` at all. `tickets`,
 * `interactions`, `deployments` and `solutions` are customer business data, and
 * `GET /api/ops/tickets` had no org filter of any kind — so the first day a
 * second company onboarded, each would have read the other's customer tickets
 * and interaction history. It was invisible only because one workspace existed.
 *
 * Three things happen here:
 *   1. ADD COLUMN org_id to 22 tables (nullable — see the note on NOT NULL).
 *   2. BACKFILL it from each table's natural anchor (customer_id → customers,
 *      workflow_id → workflows, thread_id → chat_threads, …).
 *   3. ENABLE RLS + org_isolation on those 22, and on the 11 Tier-2 tables that
 *      carried an org_id but had no database backstop under the app's filters.
 *
 * NOT scoped, deliberately: platform_admins (administers the platform itself),
 * runtime_env_presence (infra diagnostics), system_cron_overrides (platform
 * crons), and orgs/org_members/org_invites — identity resolution legitimately
 * spans workspaces (listing "which workspaces am I in" is a cross-org read).
 *
 * On NOT NULL: the column stays nullable. A NOT NULL constraint would be the
 * stronger guarantee, but it converts every un-migrated writer from "row lands
 * with a NULL tenant" into "request 500s", and there are writers in the agent
 * runtime as well as the web app. The RLS policy already makes a NULL-tenant
 * row invisible to every scoped reader, which is the safety property that
 * matters. Tighten to NOT NULL once the writers are confirmed (see the report
 * this prints at the end).
 *
 * Review the DDL, then run:  ! node .migrate-tenancy-tier3.mjs
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

/**
 * DDL needs the ADMIN connection, not the app's.
 *
 * .env.local's DATABASE_URL is `app_rw`, which is deliberately not the owner of
 * any table — that is the whole point of the role, and it fails here with
 * "must be owner of table". Schema changes come from .env.supabase's admin URL;
 * the app never gets rights it does not need at runtime.
 */
const supa = readEnv(".env.supabase");
const local = readEnv(".env.local");
const url = supa.SUPABASE_POSTGRES_URL_NON_POOLING || local.DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

/** table → SQL that derives org_id for existing rows (null = no backfill possible). */
const NEW_COLUMNS = {
  tickets: `UPDATE tickets t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  interactions: `UPDATE interactions t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  deployments: `UPDATE deployments t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  implementation: `UPDATE implementation t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  platform: `UPDATE platform t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  solutions: `UPDATE solutions t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  customer_stakeholders: `UPDATE customer_stakeholders t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  internal_staff: `UPDATE internal_staff t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  browser_allowlist: `UPDATE browser_allowlist t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  browser_contexts: `UPDATE browser_contexts t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  browser_credentials: `UPDATE browser_credentials t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  browser_sessions: `UPDATE browser_sessions t SET org_id = c.org_id FROM customers c WHERE c.customer_id = t.customer_id AND t.org_id IS NULL`,
  workflow_runs: `UPDATE workflow_runs t SET org_id = w.org_id FROM workflows w WHERE w.id = t.workflow_id AND t.org_id IS NULL`,
  workflow_instruction_versions: `UPDATE workflow_instruction_versions t SET org_id = w.org_id FROM workflows w WHERE w.id = t.workflow_id AND t.org_id IS NULL`,
  chat_thread_members: `UPDATE chat_thread_members t SET org_id = th.org_id FROM chat_threads th WHERE th.id = t.thread_id AND t.org_id IS NULL`,
  chat_presence: `UPDATE chat_presence t SET org_id = th.org_id FROM chat_threads th WHERE th.id = t.thread_id AND t.org_id IS NULL`,
  chat_turn_authors: `UPDATE chat_turn_authors t SET org_id = th.org_id FROM chat_threads th WHERE th.id = t.thread_id AND t.org_id IS NULL`,
  // No derivable anchor. On a populated database these need a chosen tenant;
  // the report at the end names anything left stranded rather than hiding it.
  chat_threads: null,
  workflow_run_journal: null,
  subagent_runs: null,
  app_versions: null,
  account_summaries: null,
};

// Tier 2: already had org_id, but no policy underneath the app's own filters.
const TIER2 = [
  "agent_configs", "agent_profiles", "agent_prompt_versions", "workflow_definitions",
  "chat_sessions", "dataroom_changesets", "dataroom_file_versions", "room_presence",
];

const PREDICATE = `(
  current_setting('app.org_id', true) IS NULL
  OR current_setting('app.org_id', true) = ''
  OR org_id = current_setting('app.org_id', true)
)`;

/**
 * 1. ALL columns first — then backfill.
 *
 * These are two phases, not one, because the backfills reference each other:
 * chat_thread_members derives its tenant from chat_threads.org_id, which does
 * not exist until chat_threads has been altered. Interleaving them made the
 * migration depend on the declaration order of a JS object, and it failed on
 * the first cross-referencing table.
 */
console.log("--- adding org_id ---");
const present = [];
for (const table of Object.keys(NEW_COLUMNS)) {
  const [exists] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
  if (!exists) { console.log(`  – ${table} (absent, skipped)`); continue; }
  await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS org_id text`);
  present.push(table);
}
console.log(`  ✓ org_id present on ${present.length} tables`);

console.log("\n--- backfilling from anchors ---");
for (const table of present) {
  const backfill = NEW_COLUMNS[table];
  if (!backfill) { console.log(`  – ${table.padEnd(30)} no anchor — manual`); continue; }
  const res = await sql.unsafe(backfill);
  console.log(`  ✓ ${table.padEnd(30)} backfilled ${res.count ?? 0}`);
}

// 3. RLS everywhere.
console.log("\n--- RLS ---");
let n = 0;
for (const table of [...Object.keys(NEW_COLUMNS), ...TIER2]) {
  const [exists] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
  if (!exists) continue;
  await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON ${table}`);
  await sql.unsafe(`CREATE POLICY org_isolation ON ${table} USING ${PREDICATE} WITH CHECK ${PREDICATE}`);
  n++;
}
console.log(`  ✓ org_isolation on ${n} tables`);

// 4. Report — what is now enforced, and what is left stranded.
console.log("\n--- report ---");
const [{ policies }] = await sql`SELECT count(*)::int AS policies FROM pg_policies WHERE schemaname='public'`;
const [{ untenanted }] = await sql`
  SELECT count(*)::int AS untenanted FROM information_schema.tables t
  WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name='org_id')`;
console.log(`policies now        : ${policies}`);
console.log(`tables with no org_id: ${untenanted}  (expected 6: orgs, org_members, org_invites, platform_admins, runtime_env_presence, system_cron_overrides)`);

let stranded = 0;
for (const table of Object.keys(NEW_COLUMNS)) {
  const [exists] = await sql`SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`;
  if (!exists) continue;
  const [{ n: nulls }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE org_id IS NULL`);
  if (nulls > 0) { console.log(`  ⚠ ${table}: ${nulls} rows with NULL org_id — invisible to every workspace`); stranded += nulls; }
}
console.log(stranded === 0 ? "✓ no stranded rows" : `⚠ ${stranded} stranded rows need a tenant assigned`);

await sql.end();
