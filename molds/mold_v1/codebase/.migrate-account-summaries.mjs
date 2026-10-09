// Migration: cached account briefings. Adds the `account_summaries` table —
// one AI briefing per (person, account), served for an hour before refresh.
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

await sql`
  CREATE TABLE IF NOT EXISTS account_summaries (
    key text PRIMARY KEY,
    summary text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

const t = await sql`select to_regclass('public.account_summaries') as t`;
console.log("account_summaries table:", t[0].t ? "OK" : "MISSING");

await sql.end();
