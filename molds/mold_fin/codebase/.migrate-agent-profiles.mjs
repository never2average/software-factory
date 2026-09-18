// Migration: "personalize my agent" — one additive table `agent_profiles`.
// One workspace-default row (email = '') plus optional per-user override rows;
// the effective profile is the user row merged over the org default. Feeds the
// harness (agent/instructions/agent-profile.ts) + seeds composer defaults.
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
  CREATE TABLE IF NOT EXISTS agent_profiles (
    id text PRIMARY KEY,
    org_id text NOT NULL DEFAULT 'onfinance',
    email text NOT NULL DEFAULT '',
    persona_name text,
    tone text,
    instructions text,
    default_mode text,
    web_search_default boolean,
    browser_default boolean,
    model text,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_org_email_idx
          ON agent_profiles (org_id, email)`;

// RLS parity with the other org-scoped tables.
await sql`ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY`;
await sql`ALTER TABLE agent_profiles FORCE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS org_isolation ON agent_profiles`;
await sql`CREATE POLICY org_isolation ON agent_profiles
  USING (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_profiles TO app_rw`.catch(() => {});

const [t] = await sql`SELECT to_regclass('public.agent_profiles') AS reg`;
console.log("agent_profiles:", t.reg ? "OK" : "MISSING");

await sql.end();
