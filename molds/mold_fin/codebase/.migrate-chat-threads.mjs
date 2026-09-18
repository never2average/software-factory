// Migration: multiplayer chat sharing. Three additive tables:
//   - chat_threads         (server-authoritative shared thread + token custody)
//   - chat_thread_members  (owner/participant/viewer membership + invite status)
//   - chat_turn_authors    (per-turn attribution by event offset)
// Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
//
// RUN THIS BEFORE deploying the front-end — the ORM selects these tables.
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
  CREATE TABLE IF NOT EXISTS chat_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_key text,
    eve_session_id text NOT NULL,
    title text NOT NULL,
    preview text,
    customers jsonb,
    forked_from jsonb,
    owner_email text NOT NULL,
    continuation_token text,
    turn_holder text,
    turn_claimed_at timestamptz,
    client_events jsonb,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS chat_threads_owner_idx ON chat_threads (owner_email)`;
await sql`CREATE INDEX IF NOT EXISTS chat_threads_session_idx ON chat_threads (eve_session_id)`;

await sql`
  CREATE TABLE IF NOT EXISTS chat_thread_members (
    thread_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    status text NOT NULL DEFAULT 'invited',
    invited_by text NOT NULL,
    invited_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    revoked_at timestamptz,
    PRIMARY KEY (thread_id, email)
  )
`;
await sql`CREATE INDEX IF NOT EXISTS chat_thread_members_email_idx ON chat_thread_members (email, status)`;

await sql`
  CREATE TABLE IF NOT EXISTS chat_turn_authors (
    thread_id uuid NOT NULL,
    event_offset integer NOT NULL,
    author_email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, event_offset)
  )
`;

for (const t of ["chat_threads", "chat_thread_members", "chat_turn_authors"]) {
  const [row] = await sql`SELECT to_regclass(${"public." + t}) AS reg`;
  console.log(`${t}:`, row.reg ? "OK" : "MISSING");
}

await sql.end();
