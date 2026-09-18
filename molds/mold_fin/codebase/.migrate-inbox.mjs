/**
 * Migration: the Inbox staging table.
 *
 * `inbox_items` holds off-platform conversations (email, Granola, Slack) after
 * a sync pulls them and before a human promotes them into the data room. It is
 * deliberately NOT `interactions` with a draft flag: that record is what the
 * account report and QBR workflows read, and un-reviewed raw material should
 * not be sitting inside it.
 *
 * Carries org_id and gets org_isolation like every other tenanted table. That
 * is not optional — scripts/test-org-isolation.mjs discovers scoped tables from
 * information_schema and FAILS CI if one has no policy, which is exactly the
 * check that should catch a new table added without one.
 *
 * Review the DDL, then run:  ! node .migrate-inbox.mjs
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

// DDL needs the ADMIN connection: app_rw is deliberately not the owner of any
// table, so it fails here with "must be owner of table".
const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS inbox_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text,
    source text NOT NULL,
    external_id text NOT NULL,
    thread_key text NOT NULL,
    subject text,
    preview text,
    body text,
    participants jsonb,
    occurred_at timestamptz NOT NULL,
    customer_id text,
    status text NOT NULL DEFAULT 'new',
    promoted_interaction_id text,
    promoted_ticket_id text,
    promoted_by text,
    promoted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`);
console.log("✓ table inbox_items");

// Idempotent ingestion depends on this: a re-sync of the same mailbox must
// update rather than duplicate.
await sql.unsafe(
  `CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_dedupe_uidx ON inbox_items (org_id, source, external_id)`,
);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS inbox_items_org_status_idx ON inbox_items (org_id, status)`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS inbox_items_thread_idx ON inbox_items (org_id, thread_key)`);
console.log("✓ indexes (dedupe + list + grouping)");

// Same predicate as every other scoped table: permissive when the GUC is unset
// so crons and agent tools keep working, enforced on request paths.
const PREDICATE = `(
  current_setting('app.org_id', true) IS NULL
  OR current_setting('app.org_id', true) = ''
  OR org_id = current_setting('app.org_id', true)
)`;
await sql.unsafe(`ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY`);
await sql.unsafe(`ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY`);
await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON inbox_items`);
await sql.unsafe(`CREATE POLICY org_isolation ON inbox_items USING ${PREDICATE} WITH CHECK ${PREDICATE}`);
console.log("✓ RLS + org_isolation");

// app_rw needs DML on it; it is not the owner and gets nothing by default.
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_items TO app_rw`;
console.log("✓ granted to app_rw");

const [{ n }] = await sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='inbox_items'`;
console.log(`\n${n === 1 ? "✓ ready" : "✗ expected exactly 1 policy, found " + n}`);
await sql.end();
process.exit(n === 1 ? 0 : 1);
