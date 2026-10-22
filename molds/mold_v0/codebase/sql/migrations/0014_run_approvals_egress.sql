-- Approval-gated writes and per-company egress (mold_v0-079, mold_v0-075; src/run-approvals.ts, src/egress-hosts.ts,
-- molds/mold_v0/MOLD.md). Platform bookkeeping: tenant work has no access to either table (the shell's own code reads
-- and writes them, with the workspace taken from the caller's session or the run row, never from input).
--
--   run_approvals          a yes to one preview (dry-run) run's output, for one write kind: the sha256 of exactly what
--                          was shown, the preview's scope and targets (the write must have the same), the workspace's
--                          version then (the write must find it unchanged), who said yes and in which role (the
--                          workspace's owner, or the platform's operator, as the write kind declares), when it expires,
--                          and the one write run it started (used once).
--   runs.approval_id       the approval a write run was started with.
--   workspace_egress_hosts the hosts a workspace's owners list for a pack's runs, for the whole workspace or one asset
--                          record; added, each exactly, to the allowlist of the runs of kinds with company_egress.
--   vault_providers        pack_credentials: where the platform's operators keep the packs' operator credentials (label
--                          "<pack>.<name>"; never handed to a session: no environment names, direct mode).

CREATE TABLE IF NOT EXISTS run_approvals (
  id               TEXT PRIMARY KEY,                  -- apr_<random>
  org_id           INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack             TEXT NOT NULL,
  preview_run_id   TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  write_kind       TEXT NOT NULL,
  output_sha256    TEXT NOT NULL,
  scope            JSONB NOT NULL DEFAULT '{}',
  targets          JSONB NOT NULL DEFAULT '{}',
  workspace_version INT,                              -- null: the write kind has no workspace store
  approved_by      TEXT NOT NULL,
  approver_role    TEXT NOT NULL CHECK (approver_role IN ('owner', 'operator')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_by_run_id   TEXT,
  used_at          TIMESTAMPTZ
);
-- One yes per preview and write kind: a preview's output is written at most once.
CREATE UNIQUE INDEX IF NOT EXISTS run_approvals_preview_idx ON run_approvals (preview_run_id, write_kind);
CREATE INDEX IF NOT EXISTS run_approvals_org_idx ON run_approvals (org_id, created_at DESC);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval_id TEXT;

CREATE TABLE IF NOT EXISTS workspace_egress_hosts (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack        TEXT NOT NULL,
  asset_area  TEXT,
  asset_key   TEXT,
  host        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((asset_area IS NULL) = (asset_key IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_egress_hosts_slot_idx
  ON workspace_egress_hosts (org_id, pack, coalesce(asset_area, ''), coalesce(asset_key, ''), host);

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('pack_credentials', 'direct', NULL, 'authorization', '', '{}')
ON CONFLICT (slug) DO NOTHING;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE run_approvals ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON run_approvals;
  EXECUTE format('CREATE POLICY tenant_isolation ON run_approvals TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON run_approvals FROM %I', r);
  ALTER TABLE workspace_egress_hosts ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON workspace_egress_hosts;
  EXECUTE format('CREATE POLICY tenant_isolation ON workspace_egress_hosts TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON workspace_egress_hosts FROM %I', r);
END $mig$;
