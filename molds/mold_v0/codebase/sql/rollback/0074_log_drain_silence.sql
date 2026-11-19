-- Rolling back past 0074_log_drain_silence (mold_v0-325), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0074_log_drain_silence.sql
-- Drops the column that marks a log-drain source silent (the older release never reads it; a source's deliveries, its
-- count and its last delivery stay). Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'log_drain_silence');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'log_drain_silence is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (log_drain_silence): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE webhook_sources DROP COLUMN IF EXISTS silent_since;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
