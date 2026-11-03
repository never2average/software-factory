-- The staff console's Health › Status history (mold_v0-210; src/health-samples.ts, web/src/features/admin/health-tabs.tsx).
-- One row per sample, taken every few minutes by whichever process runs the scheduler (a server's loop, the Vercel cron
-- entry), so the Status tab's graphs have a history without the long-running server. Only numbers and states: no
-- address, no secret, no person's data, no workspace's name or id. Kept 35 days (pruned by the same job).
--
-- Each figure covers the window since the sample before (window_seconds), except the two *_day counters: the Claude
-- provider's requests and errors so far that UTC day (gateway_model_usage), which the graph turns into differences.
--
-- Platform bookkeeping, no workspace's data: closed to tenant work, like scheduler_jobs.
CREATE TABLE IF NOT EXISTS health_samples (
  id                 BIGSERIAL PRIMARY KEY,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_seconds     INT NOT NULL CHECK (window_seconds > 0),
  up                 BOOLEAN NOT NULL,
  db_ms              INT CHECK (db_ms >= 0),
  api_p50_ms         INT CHECK (api_p50_ms >= 0),
  api_p95_ms         INT CHECK (api_p95_ms >= 0),
  api_requests       INT NOT NULL DEFAULT 0 CHECK (api_requests >= 0),
  rls                TEXT NOT NULL CHECK (rls IN ('ok', 'failed', 'error', 'not run')),
  storage            TEXT NOT NULL CHECK (storage IN ('env', 'vault', 'dir', 'none')),
  vault_set          INT NOT NULL DEFAULT 0 CHECK (vault_set >= 0),
  vault_missing      INT NOT NULL DEFAULT 0 CHECK (vault_missing >= 0),
  claude_requests_day INT NOT NULL DEFAULT 0 CHECK (claude_requests_day >= 0),
  claude_errors_day  INT NOT NULL DEFAULT 0 CHECK (claude_errors_day >= 0),
  claude_refusals    INT NOT NULL DEFAULT 0 CHECK (claude_refusals >= 0),
  scheduler_lag_s    INT CHECK (scheduler_lag_s >= 0),
  runs_ended         INT NOT NULL DEFAULT 0 CHECK (runs_ended >= 0),
  runs_failed        INT NOT NULL DEFAULT 0 CHECK (runs_failed >= 0),
  deliveries_total   INT CHECK (deliveries_total >= 0),
  deliveries_failed  INT CHECK (deliveries_failed >= 0)
);
CREATE INDEX IF NOT EXISTS health_samples_at_idx ON health_samples (at);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  EXECUTE format('REVOKE ALL ON health_samples FROM %I', r);
  EXECUTE format('REVOKE ALL ON SEQUENCE health_samples_id_seq FROM %I', r);
END $mig$;
