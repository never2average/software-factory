// Migration: browser navigation allow-list. One additive table:
//   - browser_allowlist (id, customer_id, origin, added_by, created_at)
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
  CREATE TABLE IF NOT EXISTS browser_allowlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id text,
    origin text NOT NULL,
    added_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS browser_allowlist_lookup_idx ON browser_allowlist (customer_id)`;

const [row] = await sql`SELECT to_regclass('public.browser_allowlist') AS reg`;
console.log("browser_allowlist:", row.reg ? "OK" : "MISSING");

await sql.end();
