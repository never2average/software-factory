-- The workspace agent's tool tokens (mold_v0-250; src/harness-reach.ts, the only writer; molds/mold_v0/docs/agent-harness.md):
-- each wake of a session gets one short-lived token that opens the app's own customer MCP server (/mcp) as the person
-- who started the session, with their role (re-read on every call), for that session's workspace only. Written only
-- while the app's profile turns the `agent_harness` feature on.
--
-- The token itself is never stored, only its sha256. It works while its wake is the session's current one and is
-- running, and the session is not paused, stopping or out of budget; it is revoked (revoked_at, and why) when its wake
-- ends (parked, paused, stopped, awaiting a decision, budget, a crash) and expires with the wake's own deadline. Rows go
-- with their session's conversation at retention, and a day after they expired.

CREATE TABLE IF NOT EXISTS harness_session_tokens (
  token_hash     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  org_id         INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL,
  acts_as        TEXT,          -- the person's user id; empty: the account (a session an account key started)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  last_used_at   TIMESTAMPTZ,
  calls          INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS harness_session_tokens_session_idx ON harness_session_tokens (session_id, created_at);
CREATE INDEX IF NOT EXISTS harness_session_tokens_run_idx ON harness_session_tokens (run_id);
CREATE INDEX IF NOT EXISTS harness_session_tokens_expiry_idx ON harness_session_tokens (expires_at);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE harness_session_tokens ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON harness_session_tokens;
  EXECUTE format('CREATE POLICY tenant_isolation ON harness_session_tokens TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  -- Not even a workspace's own work reads them (src/rls.ts NO_ACCESS): only the shell's code mints and checks a token.
  EXECUTE format('REVOKE ALL ON harness_session_tokens FROM %I', r);
END $mig$;
