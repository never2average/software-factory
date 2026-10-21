-- The workspace credential vault (mold_v0-034; src/credentials.ts, molds/mold_v0/MOLD.md). A pack declares credential
-- fields (definePack credentials); a workspace's people give their values in the console; a run of one of the pack's
-- job kinds receives them, by the names the pack declares, only for the asset (and environment) it targets.
--
-- One row per value: the workspace, the pack and the field, and what it is bound to (the whole workspace; an asset
-- record of the pack's asset area; or one environment of such an asset). The value is sealed with the workspace's data
-- key (src/orgcrypto.ts sealBytes, AES-256-GCM, bound by additional data to this workspace, pack, field, asset and
-- environment, so a sealed value moved to another row or workspace does not open); `last4` is what the console shows.
-- Tenant work cannot reach this table at all (no grant): only the shell's own code reads and writes it, with the
-- workspace taken from the caller's session (the console) or from the run row (a runner's lease), never from input.

CREATE TABLE IF NOT EXISTS workspace_credentials (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack         TEXT NOT NULL,
  name         TEXT NOT NULL,
  bound_to     TEXT NOT NULL CHECK (bound_to IN ('workspace', 'asset', 'environment')),
  asset_area   TEXT,
  asset_key    TEXT,
  environment  TEXT,
  sealed       TEXT NOT NULL,                     -- base64 of sealBytes(...): never the value
  last4        TEXT NOT NULL,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((bound_to = 'workspace') = (asset_key IS NULL)),
  CHECK ((bound_to = 'environment') = (environment IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_credentials_slot_idx
  ON workspace_credentials (org_id, pack, name, coalesce(asset_key, ''), coalesce(environment, ''));

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE workspace_credentials ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON workspace_credentials;
  EXECUTE format('CREATE POLICY tenant_isolation ON workspace_credentials TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  -- No access for tenant work, not even its own rows: a pack's code (which runs as the tenant role) never sees a sealed value.
  EXECUTE format('REVOKE ALL ON workspace_credentials FROM %I', r);
END $mig$;
