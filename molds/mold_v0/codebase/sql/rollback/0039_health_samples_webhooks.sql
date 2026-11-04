-- Rolling back past 0039_health_samples_webhooks (mold_v0-215), for a release from before it (and before rolling back
-- 0038_health_samples, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0039_health_samples_webhooks.sql
-- Drops the two webhook columns of Health › Status's samples (numbers only, platform bookkeeping): the older release
-- graphs emails and webhooks together again from its next sample. Found by its name, so it also undoes it where it was
-- recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'health_samples_webhooks');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'health_samples_webhooks is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (health_samples_webhooks): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS webhooks_failed;
  ALTER TABLE health_samples DROP COLUMN IF EXISTS webhooks_total;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
