-- What the shell's own scheduled work last did (mold_v0-204; src/scheduler-jobs.ts, the staff console's Health ›
-- Scheduled work). One row per job the build runs (the schedules and due-date check, record clocks, the mail intake, the
-- event outbox relay, webhook deliveries, signed checkpoints, encrypted-field batches, audit and workspace retention, run
-- charges): when it last ran, last succeeded and last failed, how long it took, and the last error, cut short and with
-- addresses, links and anything key-like taken out before it is written. Written by whichever process runs the job (a
-- server's loops, the Vercel cron entry), so the page sees every instance's last run.
--
-- Platform bookkeeping, no workspace's data: closed to tenant work.
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  job            TEXT PRIMARY KEY,
  last_run_at    TIMESTAMPTZ NOT NULL,
  last_ok_at     TIMESTAMPTZ,
  last_error_at  TIMESTAMPTZ,
  last_error     TEXT,
  last_ms        INT,
  runs           BIGINT NOT NULL DEFAULT 0,
  failures       BIGINT NOT NULL DEFAULT 0
);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  EXECUTE format('REVOKE ALL ON scheduler_jobs FROM %I', r);
END $mig$;
