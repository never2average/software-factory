// Migration: per-user chat threads. One additive table `chat_sessions` — the
// durable mirror of the sidebar thread list, so a user's chats follow their
// account across devices (localStorage stays the instant-open cache). Metadata
// only; message history replays from the eve session on open.
//
// Additive + idempotent. Run BEFORE deploying the DB-sync front-end change
// (the API fails safe if the table is absent, so order is flexible).
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
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id text PRIMARY KEY,
    org_id text NOT NULL DEFAULT 'onfinance',
    owner_email text NOT NULL,
    client_key text,
    title text,
    preview text,
    message_count integer,
    customers jsonb,
    forked_from jsonb,
    eve_session_id text,
    continuation_token text,
    derived_customers jsonb,
    tool_counts jsonb,
    archived boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS chat_sessions_owner_idx
          ON chat_sessions (owner_email, org_id, updated_at DESC)`;

// RLS parity with the other org-scoped tables (permissive when the GUC is unset,
// enforcing under withOrgRls). Safe to run repeatedly.
await sql`ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY`;
await sql`ALTER TABLE chat_sessions FORCE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS org_isolation ON chat_sessions`;
await sql`CREATE POLICY org_isolation ON chat_sessions
  USING (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))`;
// app_rw needs DML on the new table (ALL TABLES grant only covered tables that
// existed at grant time).
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON chat_sessions TO app_rw`.catch(() => {});

const [t] = await sql`SELECT to_regclass('public.chat_sessions') AS reg`;
console.log("chat_sessions:", t.reg ? "OK" : "MISSING");

await sql.end();
