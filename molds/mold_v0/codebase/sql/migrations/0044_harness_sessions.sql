-- The workspace agent (mold_v0-243; src/harness-sessions.ts, the only writer; molds/mold_v0/docs/agent-harness.md): a
-- long-lived agent a person talks to, run through a harness. Written only while the app's profile turns the
-- `agent_harness` feature on (off by default, and then nothing is written here at all).
--
--   harness_sessions        one row per session (a conversation; named apart from the session engine's own agent_sessions,
--                           a host pack's table): its state, the policy frozen at its start (harness,
--                           model, provider, limits, web tools, the resolved hooks), its budget and spend, the harness's
--                           own session id and its last checkpoint, its retention deadline. Each wake of a session is a
--                           row of `runs` (the built-in kind _agent/session), linked by runs.harness_session_id.
--   harness_session_messages  the conversation: a person's messages (pending until a wake delivers them, delivered,
--                           discarded and carried to the next wake, answered) and the agent's turns.
--   harness_session_requests  what the agent asked for that its policy does not allow (a web host, a tool) and stops on
--                           its budget: pending until approved, declined or expired.
--   harness_budget_grants     each raise of a session's budget: from, to, why and who. Kept past retention.
--   platform_setting_changes every change of the workspace agent's platform settings (src/settings.ts, group "agent"):
--                           the key, the value before and after, who and when. Platform bookkeeping: no tenant reaches it.
--   harness_wake_spend        per wake: the high-water mark of the harness's cumulative reports and the baseline a
--                           resumed session's reports start from, so a session's spend is counted once.
--
-- Every table carries the workspace (org_id) under row-level security: the tenant role may only read its own rows.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS harness_session_id TEXT;
CREATE INDEX IF NOT EXISTS runs_harness_session_idx ON runs (harness_session_id, created_at) WHERE harness_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_sessions (
  id                 TEXT PRIMARY KEY,
  org_id             INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  started_by         TEXT,
  started_by_name    TEXT,
  state              TEXT NOT NULL DEFAULT 'starting'
                     CHECK (state IN ('starting', 'live', 'parked', 'waking', 'paused', 'awaiting', 'stopped', 'failed')),
  in_turn            BOOLEAN NOT NULL DEFAULT false,
  state_reason       TEXT,
  pause_requested_at TIMESTAMPTZ,
  stop_requested_at  TIMESTAMPTZ,
  flavour            TEXT NOT NULL,
  model              TEXT NOT NULL,
  provider           TEXT NOT NULL,
  policy             JSONB NOT NULL DEFAULT '{}'::jsonb,
  harness_session    TEXT,
  checkpoint         JSONB,
  checkpoint_seq     INT NOT NULL DEFAULT 0,
  budget_usd         NUMERIC(12, 4) NOT NULL CHECK (budget_usd > 0),
  spent_usd          NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reserve_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (reserve_usd >= 0),
  crash_spent_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (crash_spent_usd >= 0),
  wakes              INT NOT NULL DEFAULT 0,
  crashes            INT NOT NULL DEFAULT 0,
  web_calls          INT NOT NULL DEFAULT 0,
  current_run_id     TEXT,
  last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  archived_at        TIMESTAMPTZ,
  retention_until    TIMESTAMPTZ,
  pruned_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS harness_sessions_org_idx ON harness_sessions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_sessions_open_idx ON harness_sessions (state, last_activity_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS harness_sessions_retention_idx ON harness_sessions (retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_session_messages (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  org_id       INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('person', 'agent', 'system')),
  body         TEXT NOT NULL,
  status       TEXT CHECK (status IS NULL OR status IN ('pending', 'delivered', 'discarded', 'answered')),
  uuid         TEXT,
  run_id       TEXT,
  by_user      TEXT,
  by_name      TEXT,
  cost_usd     NUMERIC(12, 6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS harness_session_messages_session_idx ON harness_session_messages (session_id, id);
CREATE INDEX IF NOT EXISTS harness_session_messages_pending_idx ON harness_session_messages (session_id) WHERE status IN ('pending', 'discarded');

CREATE TABLE IF NOT EXISTS harness_session_requests (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id      TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('web', 'tool', 'budget')),
  subject     TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harness_session_requests_session_idx ON harness_session_requests (session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS harness_session_requests_one_pending ON harness_session_requests (session_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS harness_budget_grants (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  from_usd    NUMERIC(12, 4) NOT NULL,
  to_usd      NUMERIC(12, 4) NOT NULL CHECK (to_usd > from_usd),
  reason      TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  granted_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harness_budget_grants_session_idx ON harness_budget_grants (session_id, created_at);

CREATE TABLE IF NOT EXISTS harness_wake_spend (
  run_id       TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  org_id       INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  baseline_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (baseline_usd >= 0),
  reported_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (reported_usd >= 0),
  charged_usd  NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (charged_usd >= 0),
  end_reason   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_setting_changes (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  from_value  JSONB,
  to_value    JSONB,
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_setting_changes_key_idx ON platform_setting_changes (key, changed_at DESC);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['harness_sessions', 'harness_session_messages', 'harness_session_requests', 'harness_budget_grants', 'harness_wake_spend'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
  EXECUTE format('REVOKE ALL ON platform_setting_changes FROM %I', r);
END $mig$;
