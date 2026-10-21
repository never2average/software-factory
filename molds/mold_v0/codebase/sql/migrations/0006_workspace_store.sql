-- The workspace store (mold_v0-033; src/workspace-store.ts): versioned snapshots of a workspace's files that outlive a
-- run. One store per workspace and pack (`store` is the pack's id). A snapshot's bytes are in object storage
-- (workspaces/org-<id>/<store>/<snapshot id>.wse), sealed with the workspace's data key; its manifest (each file's
-- sha256 and size) and the manifest's own sha256 are here. A run stages its workspace when it ends; the stage becomes
-- the next version only when the run completes as succeeded (its program and its validation exited 0). One writer per
-- workspace store: a run holds workspace_leases for its store from its claim to its end, and a second run of the same
-- store is not claimed until then. Tenant work may read its own snapshots' rows and leases, never write them.

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  org_id           INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store            TEXT NOT NULL,
  version          INT,                                    -- set when committed: 1, 2, 3 ... per (org_id, store)
  status           TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'discarded')),
  base_version     INT NOT NULL,                           -- the version the run checked out (0: an empty workspace)
  run_id           TEXT REFERENCES runs (id) ON DELETE SET NULL,
  attempt          INT,
  manifest         JSONB NOT NULL,
  manifest_sha256  TEXT NOT NULL,
  files            INT NOT NULL,
  bytes            BIGINT NOT NULL,
  object_key       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at     TIMESTAMPTZ,
  CHECK ((status = 'committed') = (version IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_snapshots_version_idx ON workspace_snapshots (org_id, store, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_snapshots_run_idx ON workspace_snapshots (run_id) WHERE status = 'staged';

CREATE TABLE IF NOT EXISTS workspace_leases (
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store       TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  base_version INT,                                       -- the version this run checked out (its write-back's base)
  PRIMARY KEY (org_id, store)
);

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_snapshots', 'workspace_leases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
END $mig$;
