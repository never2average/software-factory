-- Rolling back past 0065_budget_grants_lowered (mold_v0-287), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0065_budget_grants_lowered.sql
-- Puts back the check that a budget change raises it. A database that lowered a budget cannot take that check back
-- whole, and an audit row is never rewritten: it refuses, and names how many rows hold it there.
-- Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration
-- is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'budget_grants_lowered');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'budget_grants_lowered is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (budget_grants_lowered): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  IF EXISTS (SELECT 1 FROM harness_budget_grants WHERE to_usd <= from_usd) THEN
    RAISE EXCEPTION '% budget changes lowered a budget: the older release''s check cannot hold them, and the audit is not rewritten', (SELECT count(*) FROM harness_budget_grants WHERE to_usd <= from_usd);
  END IF;
  ALTER TABLE harness_budget_grants DROP CONSTRAINT IF EXISTS harness_budget_grants_changes;
  ALTER TABLE harness_budget_grants ADD CONSTRAINT harness_budget_grants_check CHECK (to_usd > from_usd);
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
