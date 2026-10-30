-- Rolling back past 0028_object_storage_vault (mold_v0-181), for a release from before it (and before rolling back an
-- earlier migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0028_object_storage_vault.sql
-- Refused, changing nothing, while the key vault holds an Object storage entry and the older release would therefore
-- lose its bucket (it reads only R2_* from the environment): set those four variables on the server, delete the entry
-- on Key vault, then roll back. Otherwise the provider row goes, and the ledger row. Found by its name, so it also
-- undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'object_storage_vault');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'object_storage_vault is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (object_storage_vault): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT count(*) FROM vault_credentials WHERE provider = 'object_storage' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'the key vault holds an Object storage entry the older release cannot read: set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY on the server, delete the entry on Key vault, then roll back';
  END IF;
  DELETE FROM vault_providers WHERE slug = 'object_storage';
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
