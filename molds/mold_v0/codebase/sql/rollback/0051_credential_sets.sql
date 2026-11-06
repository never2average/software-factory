-- Rolling back past 0051_credential_sets (mold_v0-260), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0051_credential_sets.sql
-- Removes what the older release cannot read: every labelled value (entry) and every value bound to a tenant (they are
-- set again after a later upgrade), and the private catalogs' access in the key vault (staff set it again). Every other
-- credential stays as it is. Found by its name, so it also undoes it where it was recorded under another number. Refused
-- when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'credential_sets');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'credential_sets is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (credential_sets): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DELETE FROM workspace_credentials WHERE entry IS NOT NULL OR bound_to = 'tenant';
  DROP INDEX IF EXISTS workspace_credentials_slot_idx;
  CREATE UNIQUE INDEX workspace_credentials_slot_idx ON workspace_credentials (org_id, pack, name, coalesce(asset_key, ''), coalesce(environment, ''));
  ALTER TABLE workspace_credentials DROP CONSTRAINT IF EXISTS workspace_credentials_bound_to_check;
  ALTER TABLE workspace_credentials ADD CONSTRAINT workspace_credentials_bound_to_check CHECK (bound_to IN ('workspace', 'asset', 'environment'));
  ALTER TABLE workspace_credentials DROP COLUMN IF EXISTS entry;
  DELETE FROM vault_credentials WHERE provider = 'catalog_access';
  DELETE FROM vault_providers WHERE slug = 'catalog_access';
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
