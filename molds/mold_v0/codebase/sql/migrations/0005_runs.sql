-- The generic run engine (mold_v0-041; src/runs.ts, molds/mold_v0/MOLD.md). Beside the product's own session queue
-- (agent_sessions, simulations), which it does not change: a pack declares job kinds, a workspace starts runs of them,
-- a runner claims one under a lease, heartbeats, sends events, and completes it with results. Every row belongs to one
-- workspace (org_id) under row-level security; the tenant role may read them and nothing else: runs are started,
-- claimed, completed and cancelled by the shell's own code (src/runs.ts), which takes the workspace from the caller's
-- session, never from its input.

CREATE TABLE IF NOT EXISTS runs (
  id                      TEXT PRIMARY KEY,                  -- run_<random>
  org_id                  INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack                    TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  scope                   JSONB NOT NULL DEFAULT '{}'::jsonb, -- what is checked: source and check record keys
  targets                 JSONB NOT NULL DEFAULT '{}'::jsonb, -- what it is checked on: asset record keys
  spec                    JSONB NOT NULL,                    -- the job kind as declared when the run started (frozen)
  attempt                 INT NOT NULL DEFAULT 0,
  max_attempts            INT NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  token_lifetime_seconds  INT NOT NULL CHECK (token_lifetime_seconds BETWEEN 60 AND 86400),
  lease_seconds           INT NOT NULL CHECK (lease_seconds BETWEEN 15 AND 3600),
  budget_usd              NUMERIC(12, 6) NOT NULL CHECK (budget_usd > 0),
  egress                  TEXT[] NOT NULL DEFAULT '{}',      -- hosts the run's sandbox may reach besides the gateway
  worker_id               TEXT,
  lease_token_hash        TEXT,                              -- sha256 of the current attempt's lease token (never the token)
  lease_expires_at        TIMESTAMPTZ,
  heartbeat_at            TIMESTAMPTZ,
  deadline_at             TIMESTAMPTZ,                       -- this attempt's end: its gateway token expires then too
  cancel_requested_at     TIMESTAMPTZ,
  cost_usd                NUMERIC(12, 6) NOT NULL DEFAULT 0, -- from gateway_usage (run_id), summed at completion
  error_kind              TEXT CHECK (error_kind IN ('infrastructure', 'run', 'validation', 'timeout', 'cancelled')),
  error                   TEXT,
  requested_by            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at              TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS runs_lease_idx ON runs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS runs_org_idx ON runs (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  id       BIGSERIAL PRIMARY KEY,
  run_id   TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  org_id   INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  attempt  INT NOT NULL,
  type     TEXT NOT NULL,
  data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id, id);

-- A run's findings: one row per check x asset (x source), each pointing at records of the run's own workspace or at
-- shared (platform) records; src/runs.ts checks every reference before writing.
CREATE TABLE IF NOT EXISTS run_results (
  id                   BIGSERIAL PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  org_id               INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  check_area           TEXT NOT NULL,
  check_key            TEXT NOT NULL,
  asset_area           TEXT,
  asset_key            TEXT,
  source_area          TEXT,
  source_key           TEXT,
  status               TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'not_applicable', 'unknown')),
  finding_fingerprint  TEXT,                                 -- stable across runs: the same finding has the same one
  evidence_ref         TEXT,                                 -- where the evidence is (a path in the workspace snapshot)
  detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_results_unique_idx ON run_results (run_id, check_area, check_key, coalesce(asset_area, ''), coalesce(asset_key, ''), coalesce(source_area, ''), coalesce(source_key, ''));
CREATE INDEX IF NOT EXISTS run_results_org_idx ON run_results (org_id, check_area, check_key);

-- The inference gateway meters a run like a session: its own token kind, and usage rows carry the run, so a run's cost
-- (and its budget) is the sum of its gateway usage across attempts.
ALTER TABLE gateway_tokens ADD COLUMN IF NOT EXISTS run_id TEXT REFERENCES runs (id) ON DELETE CASCADE;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS run_id TEXT;
CREATE INDEX IF NOT EXISTS gateway_tokens_run_idx ON gateway_tokens (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_run_idx ON gateway_usage (run_id) WHERE run_id IS NOT NULL;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  c RECORD;
  t TEXT;
BEGIN
  -- The token kinds: 'run' joins 'session' and 'orchestrator'.
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'gateway_tokens'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE gateway_tokens DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE gateway_tokens ADD CONSTRAINT gateway_tokens_kind_check CHECK (kind IN ('session', 'orchestrator', 'run'));

  -- Read only for tenant work: its own workspace's runs, events and results.
  FOREACH t IN ARRAY ARRAY['runs', 'run_events', 'run_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
END $mig$;
