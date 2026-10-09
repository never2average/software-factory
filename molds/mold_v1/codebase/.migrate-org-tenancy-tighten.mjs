// Migration: Phase-3 org tenancy TIGHTENING. Run AFTER `.migrate-org-tenancy.mjs`
// and after the org-permeation code is deployed (every write path now stamps
// org_id, and the DB DEFAULT 'onfinance' remains as a safety net).
//
// Two changes, both safe because org_id is fully backfilled (zero NULLs) and
// people_roster has zero duplicate emails:
//   1. org_id → NOT NULL on every scoped table. The DEFAULT 'onfinance' is KEPT
//      (NOT NULL + DEFAULT together = integrity without a prod-crash footgun for
//      any internal insert path that doesn't stamp org_id yet, e.g. automation
//      runs / memories / seed scripts).
//   2. people_roster PK → (org_id, email), so the same person can exist in two
//      workspaces. Enables the agent's upsert_roster_member ON CONFLICT target.
//
// Review the DDL, then run:  ! node .migrate-org-tenancy-tighten.mjs
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

// Guard: refuse to tighten if any NULLs remain (would fail the SET NOT NULL and
// signals the base migration didn't run / backfill).
for (const table of SCOPED) {
  const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE org_id IS NULL`);
  if (Number(n) > 0) {
    console.error(`✗ ${table} has ${n} NULL org_id rows — run .migrate-org-tenancy.mjs first.`);
    await sql.end();
    process.exit(1);
  }
}

// 1. NOT NULL (keep the DEFAULT).
for (const table of SCOPED) {
  await sql.unsafe(`ALTER TABLE ${table} ALTER COLUMN org_id SET NOT NULL`);
}
console.log(`✓ org_id SET NOT NULL on ${SCOPED.length} tables (DEFAULT 'onfinance' kept).`);

// 2. people_roster composite PK (org_id, email).
const [{ dups }] = await sql`
  SELECT count(*)::int AS dups FROM (SELECT email FROM people_roster GROUP BY email HAVING count(*)>1) x`;
if (Number(dups) > 0) {
  console.error(`✗ people_roster has ${dups} duplicate emails — cannot form (org_id,email) PK.`);
  await sql.end();
  process.exit(1);
}
// Find and drop the existing PK (usually people_roster_pkey), then add composite.
const [{ conname }] = await sql`
  SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.people_roster'::regclass AND contype = 'p' LIMIT 1`;
if (conname) {
  await sql.unsafe(`ALTER TABLE people_roster DROP CONSTRAINT ${conname}`);
}
// Add the composite PK only if it isn't already there.
const [{ has }] = await sql`
  SELECT count(*)::int AS has FROM pg_constraint
  WHERE conrelid='public.people_roster'::regclass AND contype='p'`;
if (Number(has) === 0) {
  await sql.unsafe(`ALTER TABLE people_roster ADD PRIMARY KEY (org_id, email)`);
}
console.log("✓ people_roster PK is now (org_id, email).");

// Verify.
const [check] = await sql`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns
       WHERE table_name='todos' AND column_name='org_id' AND is_nullable='NO') AS todos_notnull,
    (SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
       FROM pg_constraint c JOIN pg_attribute a
         ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conrelid='public.people_roster'::regclass AND c.contype='p') AS roster_pk`;
console.log("todos.org_id NOT NULL:", check.todos_notnull ? "OK" : "MISSING");
console.log("people_roster PK columns:", check.roster_pk);

await sql.end();
