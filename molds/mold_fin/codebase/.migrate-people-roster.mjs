// Migration: FDE org roster. Adds `people_roster` (email PK, name, team,
// manager_email) that powers the "me / my reportees / my team / everyone"
// scope filters. Backfills distinct (email, name) from internal_staff so the
// roster isn't empty — team + manager_email start null for an operator (or the
// agent via upsert_roster_member) to fill in. Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM will select this table.
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
  CREATE TABLE IF NOT EXISTS people_roster (
    email text PRIMARY KEY,
    name text,
    team text,
    manager_email text,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS people_roster_team_idx ON people_roster (team)`;
await sql`CREATE INDEX IF NOT EXISTS people_roster_manager_idx ON people_roster (manager_email)`;

// Backfill the FDE emails we already know about (internal_staff), lowercased,
// so the scope dropdown has people to resolve against. Don't clobber teams/
// managers already set.
const backfill = await sql`
  INSERT INTO people_roster (email, name)
  SELECT DISTINCT lower(email), min(name)
  FROM internal_staff
  WHERE email IS NOT NULL AND email <> ''
  GROUP BY lower(email)
  ON CONFLICT (email) DO NOTHING`;

const t = await sql`select to_regclass('public.people_roster') as t`;
const n = await sql`select count(*)::int as n from people_roster`;
console.log("people_roster table:", t[0].t ? "OK" : "MISSING");
console.log("rows (backfilled from internal_staff):", n[0].n);

await sql.end();
