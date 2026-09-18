// Migration: browser runtime sessions. One additive table:
//   - browser_sessions (id, provider, provider_session_id, connect_url,
//     live_view_url, eve_session_id, customer_id, status, created_at, last_used_at)
// Additive + idempotent.
//
// RUN THIS BEFORE deploying the agent — the browser tools select this table.
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
  CREATE TABLE IF NOT EXISTS browser_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    provider_session_id text NOT NULL,
    connect_url text NOT NULL,
    live_view_url text,
    eve_session_id text,
    customer_id text,
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS browser_sessions_eve_idx ON browser_sessions (eve_session_id, status)`;

const [row] = await sql`SELECT to_regclass('public.browser_sessions') AS reg`;
console.log("browser_sessions:", row.reg ? "OK" : "MISSING");

await sql.end();
