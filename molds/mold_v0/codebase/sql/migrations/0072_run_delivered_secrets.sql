-- What a run was given, for redaction on any instance (mold_v0-320; src/connection-env.ts rememberDelivered and
-- connectionSecrets, their only reader and writer; molds/mold_v0/MOLD.md "Connections as an agent's environment").
--
-- A wake of the workspace agent receives its session's connection secrets with its lease (src/credentials.ts
-- runCredentials). Everything the wake writes afterwards (its events, its answers, its results) is redacted of those
-- values on whichever server instance takes the request, so each value delivered is kept here for the life of the
-- attempt: SEALED with the workspace's data key (src/orgcrypto.ts sealBytes, AES-256-GCM, the same key and scheme as
-- encrypted fields), its additional data binding it to its workspace, run and digest. Never a plain value.
--
--   digest   a keyed fingerprint of the value (orgMac, under a key derived from the workspace's data key): one row per
--            value per run, so a value delivered twice is kept once. Says nothing without that key.
--   sealed   base64 of the sealed value
--
-- Rows go when the attempt ends (src/workspace-store.ts endAttempt, inside the transaction that ends it: completed,
-- cancelled, lapsed or retried), and the run sweep (src/runs.ts sweepRuns) removes any left behind: past expires_at, or
-- of a run no longer running. They go with their run and their workspace (cascade).
--
-- Tenant table under row-level security, closed to tenant work entirely (src/rls.ts NO_ACCESS): only the shell's own
-- code reads and writes it. Rollback: sql/rollback/0072_run_delivered_secrets.sql.
CREATE TABLE IF NOT EXISTS run_delivered_secrets (
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) <= 300),
  digest      TEXT NOT NULL CHECK (length(digest) <= 128),
  sealed      TEXT NOT NULL CHECK (length(sealed) <= 65536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, digest)
);
CREATE INDEX IF NOT EXISTS run_delivered_secrets_expiry_idx ON run_delivered_secrets (expires_at);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE run_delivered_secrets ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON run_delivered_secrets;
  EXECUTE format('CREATE POLICY tenant_isolation ON run_delivered_secrets TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  -- Not even a workspace's own work reads them (src/rls.ts NO_ACCESS): only the shell's code keeps and opens them.
  EXECUTE format('REVOKE ALL ON run_delivered_secrets FROM %I', r);
END $mig$;
