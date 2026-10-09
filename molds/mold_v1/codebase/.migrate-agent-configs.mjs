// Migration: per-subagent workspace config — one additive table `agent_configs`.
// paused (orchestrator won't delegate to it) + per-agent instructions (injected
// when it runs). One row per (org, agentKey). Powers the Agents tab pause/resume
// + per-agent personalization.
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
  CREATE TABLE IF NOT EXISTS agent_configs (
    org_id text NOT NULL DEFAULT 'onfinance',
    agent_key text NOT NULL,
    paused boolean NOT NULL DEFAULT false,
    instructions text,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, agent_key)
  )`;

await sql`ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY`;
await sql`ALTER TABLE agent_configs FORCE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS org_isolation ON agent_configs`;
await sql`CREATE POLICY org_isolation ON agent_configs
  USING (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON agent_configs TO app_rw`.catch(() => {});

const [t] = await sql`SELECT to_regclass('public.agent_configs') AS reg`;
console.log("agent_configs:", t.reg ? "OK" : "MISSING");

await sql.end();
