-- Rolling back past 0029_run_transfers (mold_v0-182), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0029_run_transfers.sql
-- The table goes, and the ledger row. Its objects (workspaces/org-<id>/.transfers/) are a running attempt's only: an
-- older release never reads them; remove that prefix from the bucket afterwards if any are left. Found by its name, so
-- it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'run_transfers');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'run_transfers is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (run_transfers): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS run_transfers;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
