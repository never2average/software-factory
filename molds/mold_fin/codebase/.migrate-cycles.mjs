// Migration: TODO cycles (sprints). Adds the `cycles` table and a nullable
// `cycle_id` on `todos`. Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM will select these.
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
  CREATE TABLE IF NOT EXISTS cycles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    starts_at timestamptz,
    ends_at timestamptz,
    created_by text NOT NULL,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`ALTER TABLE todos ADD COLUMN IF NOT EXISTS cycle_id uuid`;
await sql`CREATE INDEX IF NOT EXISTS todos_cycle_idx ON todos (cycle_id)`;

const c = await sql`select to_regclass('public.cycles') as t`;
const col = await sql`select column_name from information_schema.columns where table_name='todos' and column_name='cycle_id'`;
console.log("cycles table:", c[0].t ? "OK" : "MISSING");
console.log("todos.cycle_id:", col.length ? "OK" : "MISSING");

await sql.end();
