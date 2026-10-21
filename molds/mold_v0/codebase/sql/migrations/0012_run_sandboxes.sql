-- Runs in sandboxes (mold_v0-055; src/run-sandboxes.ts, molds/mold_v0/MOLD.md "Runs in sandboxes"). The autoscaler
-- launches one sandbox per queued run (the product's sandbox provider, or a local container per run on a server of
-- its own), whose runner claims exactly that run with a token bound to it, carries it out with the run's egress
-- firewalled, and is torn down when the run's attempt ends. Platform bookkeeping: tenant work has no access.
--
--   run_sandboxes   one row per sandbox launched for a run: the attempt it was launched for, the provider, its state,
--                   when its runner claimed the run (once: a sandbox carries out one run), and why it ended
--   worker_tokens   run_sandbox_id: a run-bound token's sandbox (a token minted for a run, job_id = run_...), revoked
--                   with it. Kept apart from sandbox_row_id, which names orchestrator_sandboxes rows.

CREATE TABLE IF NOT EXISTS run_sandboxes (
  id            SERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  attempt       INT NOT NULL,                       -- the attempt it was launched for (the run's attempt + 1 then)
  provider      TEXT NOT NULL,                      -- boat | docker | process
  sandbox_id    TEXT,
  state         TEXT NOT NULL DEFAULT 'booting' CHECK (state IN ('booting', 'running', 'draining', 'deleted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at      TIMESTAMPTZ,
  claimed_at    TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  launch_step   TEXT,
  launch_error  TEXT,
  reap_reason   TEXT
);
CREATE INDEX IF NOT EXISTS run_sandboxes_live_idx ON run_sandboxes (state) WHERE state <> 'deleted';
CREATE INDEX IF NOT EXISTS run_sandboxes_run_idx ON run_sandboxes (run_id);
-- At most one live sandbox per run, whatever two leaders decide at once.
CREATE UNIQUE INDEX IF NOT EXISTS run_sandboxes_one_live_idx ON run_sandboxes (run_id) WHERE state <> 'deleted';

ALTER TABLE worker_tokens ADD COLUMN IF NOT EXISTS run_sandbox_id INT;
CREATE INDEX IF NOT EXISTS worker_tokens_run_sandbox_idx ON worker_tokens (run_sandbox_id) WHERE revoked_at IS NULL;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE run_sandboxes ENABLE ROW LEVEL SECURITY;
  EXECUTE format('REVOKE ALL ON run_sandboxes FROM %I', r);
END $mig$;
