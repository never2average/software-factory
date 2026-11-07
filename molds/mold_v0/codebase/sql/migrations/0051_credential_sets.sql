-- Credential sets and tenants, and private catalogs' access (mold_v0-260; src/credentials.ts, src/catalog-access.ts).
--
-- workspace_credentials (0007) takes two more shapes, each written only while the app's flag credential_sets is on:
--   entry     a labelled value of a credential that holds several (pack.json credentials[].entries: a list of hosts,
--             each with its token): one row per label, each sealed on its own (the label is bound into the sealing,
--             so a value moved to another label does not open). NULL for every value written before (one per slot).
--   tenant    bound_to 'tenant': a value bound to a record of the build's tenant area (record_areas[].tenant), kept as
--             an asset binding is (asset_area, asset_key) and delivered to a run that targets that record.
-- The slot's unique index takes the entry. The table keeps its grants (the tenant role has none) and its row-level
-- security; nothing is backfilled.
--
-- The key vault's provider catalog_access holds each private catalog's access (a deploy key and its host's public key,
-- or the platform's GitHub App installation), one sealed entry per repository, set by staff (Admin › Key vault).
ALTER TABLE workspace_credentials ADD COLUMN IF NOT EXISTS entry TEXT CHECK (entry IS NULL OR (length(entry) BETWEEN 1 AND 100));
ALTER TABLE workspace_credentials DROP CONSTRAINT IF EXISTS workspace_credentials_bound_to_check;
ALTER TABLE workspace_credentials ADD CONSTRAINT workspace_credentials_bound_to_check CHECK (bound_to IN ('workspace', 'asset', 'environment', 'tenant'));
DROP INDEX IF EXISTS workspace_credentials_slot_idx;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_credentials_slot_idx
  ON workspace_credentials (org_id, pack, name, coalesce(asset_key, ''), coalesce(environment, ''), coalesce(entry, ''));

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('catalog_access', 'direct', NULL, 'authorization', '', '{}')
ON CONFLICT (slug) DO NOTHING;
