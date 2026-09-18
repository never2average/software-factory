// Migration: browser persistent contexts. One additive table:
//   - browser_contexts (customer_id PK, provider, provider_context_id, ...)
// Additive + idempotent.
//
// RUN THIS BEFORE deploying the agent — browser_open selects this table.
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
  CREATE TABLE IF NOT EXISTS browser_contexts (
    customer_id text PRIMARY KEY,
    provider text NOT NULL,
    provider_context_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
  )
`;

const [row] = await sql`SELECT to_regclass('public.browser_contexts') AS reg`;
console.log("browser_contexts:", row.reg ? "OK" : "MISSING");

await sql.end();
