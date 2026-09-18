// Migration: project-workflow definitions — one additive table
// `workflow_definitions`. A named state-machine over tasks or implementations
// (stages + per-stage assign rule + transitions), stored as JSON. Powers the
// Workspace "Project workflows" builder and the agent's stage/assign logic.
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
  CREATE TABLE IF NOT EXISTS workflow_definitions (
    id text PRIMARY KEY,
    org_id text NOT NULL DEFAULT 'onfinance',
    name text NOT NULL,
    entity text NOT NULL,
    stages jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS workflow_definitions_org_idx ON workflow_definitions (org_id)`;

await sql`ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY`;
await sql`ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS org_isolation ON workflow_definitions`;
await sql`CREATE POLICY org_isolation ON workflow_definitions
  USING (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (nullif(current_setting('app.org_id', true), '') IS NULL OR org_id = current_setting('app.org_id', true))`;
await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_definitions TO app_rw`.catch(() => {});

const [t] = await sql`SELECT to_regclass('public.workflow_definitions') AS reg`;
console.log("workflow_definitions:", t.reg ? "OK" : "MISSING");

await sql.end();
