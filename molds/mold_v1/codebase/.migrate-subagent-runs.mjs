// Migration: subagent run codenames. Adds the `subagent_runs` table — a
// persisted, human name per subagent run. Additive + idempotent.
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

await sql`
  CREATE TABLE IF NOT EXISTS subagent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_key text NOT NULL UNIQUE,
    session_id text,
    subagent_type text,
    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

const t = await sql`select to_regclass('public.subagent_runs') as t`;
console.log("subagent_runs table:", t[0].t ? "OK" : "MISSING");

await sql.end();
