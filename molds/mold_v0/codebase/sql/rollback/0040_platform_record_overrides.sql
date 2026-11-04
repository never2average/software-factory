-- Rolling back past 0040_platform_record_overrides (mold_v0-221), for a release from before it (and before rolling back
-- 0039_health_samples_webhooks, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0040_platform_record_overrides.sql
-- Drops the repository versions kept behind staff overrides on shared areas. The overrides themselves stay, as rows
-- written by hand, which the older release keeps over its index as it always did (a forced index there takes the
-- repository's row back). Found by its name, so it also undoes it where it was recorded under another number. Refused
-- when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'platform_record_overrides');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'platform_record_overrides is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (platform_record_overrides): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE platform_records DROP COLUMN IF EXISTS upstream;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
