-- Run spend in the month figures, usage per run, member and workspace, and rate limits (mold_v0-053, 008, 018;
-- src/run-spend.ts, src/usage-report.ts, src/rate-limits.ts, molds/mold_v0/MOLD.md).

-- 053: a workspace's own runs' gateway usage, readable by its tenant work, so the month figures and spend pages it
-- reads count a running run's live cost. The policy stays the session rule (octillion_session_org, 0003; mold_v0-049),
-- widened to runs of the same workspace (runs is itself under tenant_isolation, so the subquery sees only the
-- workspace's own runs). The function is defined again here for a database whose 0003 ran before mold_v0-049.
CREATE OR REPLACE FUNCTION octillion_session_org(sid TEXT) RETURNS INT LANGUAGE plpgsql STABLE AS $$
DECLARE o INT;
BEGIN
  IF sid IS NULL OR to_regclass('public.agent_sessions') IS NULL THEN RETURN NULL; END IF;
  -- Static SQL, planned on first use (never while the table is missing) and cached: as cheap as the EXISTS it replaces.
  SELECT s.org_id INTO o FROM public.agent_sessions s WHERE s.id = sid;
  RETURN o;
END $$;
DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON gateway_usage;
  EXECUTE format('CREATE POLICY tenant_isolation ON gateway_usage TO %I USING ('
    || 'octillion_session_org(session_id) = octillion_tenant_org()'
    || ' OR (run_id IS NOT NULL AND EXISTS (SELECT 1 FROM runs x WHERE x.id = run_id AND x.org_id = octillion_tenant_org())))', r);
END $mig$;
-- A run's month: the month it was queued in (as a session's is its queued_at month).
CREATE INDEX IF NOT EXISTS runs_org_month_idx ON runs (org_id, pack, kind, created_at);

-- 008: what each MCP request recorded beyond method, tool, outcome and latency: the client's name and version as
-- the request named it (client keeps its old meaning, the handshake's clientInfo, read by the existing pages), the
-- error's class (never its arguments), the request's and the answer's sizes in bytes, and which key it came with (an
-- id, never the key). Arguments and results are still never stored.
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS client_name TEXT;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS client_version TEXT;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS error_class TEXT;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS req_bytes INT;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS res_bytes INT;
ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS key_id INT;
CREATE INDEX IF NOT EXISTS mcp_events_calls_idx ON mcp_events (at) WHERE method = 'tools/call';

-- 018: fixed-window counters for rate limits (per key, member, workspace and address, and the sign-up, invite and
-- key endpoints). Platform rows: a bucket names what it counts (a key id, a member id, a workspace id, a hashed
-- address), never a secret. Tenant work can neither read nor write them.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  bucket        TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_window_idx ON rate_limit_hits (window_start);

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON rate_limit_hits FROM %I', r);
END $mig$;
