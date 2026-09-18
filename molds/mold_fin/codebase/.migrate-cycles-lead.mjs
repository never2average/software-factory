// Migration: sprint lead. Adds a nullable `lead` (email) column to `cycles`.
// Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM will select it.
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

await sql`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS lead text`;

const col = await sql`select column_name from information_schema.columns where table_name='cycles' and column_name='lead'`;
console.log("cycles.lead:", col.length ? "OK" : "MISSING");

await sql.end();
