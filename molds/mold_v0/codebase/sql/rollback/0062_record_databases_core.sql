-- Rolling back past 0062_record_databases_core (mold_v0-285), for a release from before it (0061: Neon databases).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0062_record_databases_core.sql
-- Refused, changing nothing, while a record still has a database (a schema in this database the older release could
-- neither show nor drop with its record): delete those records first (each drops its schema and role), or take the
-- database fields out with features.record_resources off and drop the schemas by hand. Otherwise the provider check
-- goes back to neon, Neon's key vault provider row comes back, and the ledger row goes. Found by its name, so it also
-- undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'record_databases_core');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'record_databases_core is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (record_databases_core): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT count(*) FROM record_resources INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '% record database(s) still exist (record_resources): delete their records first (each drops its schema and role), then roll back', n;
  END IF;
  ALTER TABLE record_resources ALTER COLUMN provider DROP DEFAULT;
  ALTER TABLE record_resources DROP CONSTRAINT IF EXISTS record_resources_provider_check;
  ALTER TABLE record_resources ADD CONSTRAINT record_resources_provider_check CHECK (provider IN ('neon'));
  INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
    ('neon', 'direct', 'https://console.neon.tech/api/v2', 'authorization', 'Bearer ', '{NEON_API_KEY}')
  ON CONFLICT (slug) DO NOTHING;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
