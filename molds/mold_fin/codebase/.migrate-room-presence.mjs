// Migration: workspace-scoped presence — one additive table `room_presence`.
// Generalizes chat presence to arbitrary rooms (e.g. `readiness:acme-bank`) so
// teammates can watch each other get a data room V1-ready live. Polled
// heartbeats; "online" = seen in the last ~25s.
//
// Additive + idempotent. Safe to run before deploy (APIs fail safe if absent).
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
  CREATE TABLE IF NOT EXISTS room_presence (
    org_id text NOT NULL DEFAULT 'onfinance',
    room text NOT NULL,
    email text NOT NULL,
    activity text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, room, email)
  )`;

await sql`ALTER TABLE room_presence ENABLE ROW LEVEL SECURITY`;
await sql`ALTER TABLE room_presence FORCE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS org_isolation ON room_presence`;
await sql`CREATE POLICY org_isolation ON room_presence
  USING (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON room_presence TO app_rw`.catch(() => {});

const [t] = await sql`SELECT to_regclass('public.room_presence') AS reg`;
console.log("room_presence:", t.reg ? "OK" : "MISSING");

await sql.end();
