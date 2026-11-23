-- Rolling back past 0077_billing_month_changes (mold_v0-342), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0077_billing_month_changes.sql
-- Drops this month's seat counts and limits that owners and billing managers set: the older release has no Upgrade plan,
-- and each workspace's allowance is its admin-set one, its plan's or the default again (Budget rules' history keeps the
-- lines saying what was set). Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'billing_month_changes');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'billing_month_changes is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (billing_month_changes): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS billing_month_changes;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
