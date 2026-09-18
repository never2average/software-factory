// Migration: escalation contacts. Adds a nullable `escalations` jsonb column to
// `people_roster` — a list of { email, reason } (multiple managers, each pinged
// under a condition), distinct from the single reporting `manager_email`.
// Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM selects the whole row.
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

await sql`ALTER TABLE people_roster ADD COLUMN IF NOT EXISTS escalations jsonb`;

const col = await sql`select column_name from information_schema.columns where table_name='people_roster' and column_name='escalations'`;
console.log("people_roster.escalations:", col.length ? "OK" : "MISSING");

await sql.end();
