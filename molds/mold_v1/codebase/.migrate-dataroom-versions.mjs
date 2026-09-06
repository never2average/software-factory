// Migration: data-room version control.
//
// Two new tables. A CHANGESET is one intentional batch of writes (a backfill),
// and a FILE VERSION records what a single write replaced — including a blob
// key pointing at the previous bytes, which is the thing that makes revert
// possible at all. The audit trail could always say a file changed; nothing
// anywhere kept what it used to be.
//
// Additive. Creates nothing destructive and touches no existing table, so it is
// safe to run before deploying — the app simply doesn't use them yet.
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

await sql`
  CREATE TABLE IF NOT EXISTS dataroom_changesets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    label text NOT NULL,
    actor text NOT NULL,
    source text NOT NULL DEFAULT 'web',
    rationale text,
    unattended boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    committed_at timestamptz,
    reverted_at timestamptz,
    reverted_by text
  )`;
await sql`CREATE INDEX IF NOT EXISTS dataroom_changesets_org_idx
          ON dataroom_changesets (org_id, created_at DESC)`;

await sql`
  CREATE TABLE IF NOT EXISTS dataroom_file_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    changeset_id uuid REFERENCES dataroom_changesets(id) ON DELETE SET NULL,
    path text NOT NULL,
    action text NOT NULL,
    prev_blob_key text,
    prev_bytes integer,
    new_bytes integer,
    actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS dataroom_file_versions_changeset_idx
          ON dataroom_file_versions (changeset_id)`;
await sql`CREATE INDEX IF NOT EXISTS dataroom_file_versions_path_idx
          ON dataroom_file_versions (org_id, path, created_at DESC)`;

/**
 * Tenant isolation, matching the 13 permissive tables rather than the strict
 * credential one: these hold document history, not secrets, and every reader
 * goes through withOrgRls with an explicit org filter anyway.
 */
const PRED = `(
  nullif(current_setting('app.org_id', true), '') IS NULL
  OR org_id = current_setting('app.org_id', true)
)`;
for (const table of ["dataroom_changesets", "dataroom_file_versions"]) {
  await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON ${table}`);
  await sql.unsafe(`CREATE POLICY org_isolation ON ${table} USING ${PRED} WITH CHECK ${PRED}`);
  // app_rw is the role the application connects as; without these it sees a
  // table it cannot touch, which fails at runtime rather than here.
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_rw`);
}

/* ------------------------------- verify ---------------------------------- */

const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('dataroom_changesets', 'dataroom_file_versions')`;
console.log(`tables created: ${tables.map((t) => t.table_name).join(", ") || "NONE"}`);

// DATABASE_URL is the app role now (app_rw on Supabase). DATABASE_URL_APP_RW
// was a Neon URL left behind by the migration off that provider — it still
// CONNECTED, to a database ten customers out of date, which is the worst kind
// of stale credential: it fails silently rather than loudly.
const appUrl = env.DATABASE_URL;
if (appUrl) {
  const app = postgres(appUrl, { ssl: "require" });
  let ok = true;
  for (const t of ["dataroom_changesets", "dataroom_file_versions"]) {
    try {
      await app.unsafe(`SELECT 1 FROM ${t} LIMIT 1`);
    } catch (e) {
      ok = false;
      console.error(`app_rw cannot read ${t}: ${e.message.slice(0, 120)}`);
    }
  }
  await app.end();
  console.log(ok ? "app_rw can read both tables." : "GRANTS MISSING — see above.");
} else {
  console.log("No DATABASE_URL — could not verify the app role's access.");
}

console.log(tables.length === 2 ? "OK — data-room version control ready." : "CHECK THE OUTPUT ABOVE.");

await sql.end();
