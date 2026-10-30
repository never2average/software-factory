-- A run's transfers through object storage (mold_v0-182; src/run-transfers.ts): a request or an answer of the worker
-- API too large to pass through it (a hosted deployment's functions take at most 4.5 MB per request body and answer).
-- The runner gets a time-limited link for one object key of its run's own workspace, under
-- workspaces/org-<id>/.transfers/<id>.wst, and the bytes go to the bucket (or come from it) directly:
--
--   workspace   a write-back: uploaded by the runner, then staged by POST /api/worker/runs/<id>/workspace/commit
--   completion  a completion too large to post (its results): uploaded, then used by POST .../complete {upload}
--   checkout    a checkout too large to answer: the snapshot's bundle, put there for the runner to download
--
-- Each object is sealed (AES-256-GCM) with a key of its own, made for that transfer and kept here sealed with the
-- workspace's data key: the bucket never holds a workspace's files in the clear. A transfer is the run's attempt's
-- only (org_id, run_id, attempt, checked behind the run's lease token), used once, and removed with its object when
-- used or when the attempt ends. Platform bookkeeping: tenant work never reads or writes it.

CREATE TABLE IF NOT EXISTS run_transfers (
  id           TEXT PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  attempt      INT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('workspace', 'completion', 'checkout')),
  object_key   TEXT NOT NULL,
  bytes        BIGINT NOT NULL CHECK (bytes >= 0),     -- the content's size, before it was sealed for the transfer
  sha256       TEXT NOT NULL,                          -- the content's sha256
  sealed_key   BYTEA NOT NULL,                         -- the transfer's own key, sealed with the workspace's data key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS run_transfers_run_idx ON run_transfers (run_id);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE run_transfers ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON run_transfers;
  EXECUTE format('CREATE POLICY tenant_isolation ON run_transfers TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON run_transfers FROM %I', r);
END $mig$;
