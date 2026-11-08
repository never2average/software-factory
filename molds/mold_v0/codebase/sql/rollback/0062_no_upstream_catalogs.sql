-- Rolling back past 0062_no_upstream_catalogs (mold_v0-283), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0062_no_upstream_catalogs.sql
-- Puts back the empty index state table (0019) and the key vault's provider for private catalogs (0051), as they were
-- made. The rows the migration made staff rows stay staff rows: an older release whose pack still declares a catalog
-- indexes it again and finds them as staff overrides of its own rows (the catalog's version kept behind each). A private
-- catalog's access is set again by staff. Found by its name, so it also undoes it where it was recorded under another
-- number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'no_upstream_catalogs');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'no_upstream_catalogs is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (no_upstream_catalogs): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  CREATE TABLE IF NOT EXISTS repository_index (
    pack             TEXT NOT NULL,
    name             TEXT NOT NULL,
    pin              TEXT,
    indexed_at       TIMESTAMPTZ,
    rows             JSONB NOT NULL DEFAULT '{}'::jsonb,
    report           JSONB,
    attempted_at     TIMESTAMPTZ,
    attempted_pin    TEXT,
    attempted_by     TEXT,
    last_error       TEXT,
    last_error_at    TIMESTAMPTZ,
    lease_until      TIMESTAMPTZ,
    lease_owner      TEXT,
    PRIMARY KEY (pack, name)
  );
  INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
    ('catalog_access', 'direct', NULL, 'authorization', '', '{}')
  ON CONFLICT (slug) DO NOTHING;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
