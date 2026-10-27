-- Rolling back past 0027_on_premises_runners (mold_v0-036), for a release from before it (and before rolling back an
-- earlier migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0027_on_premises_runners.sql
-- Refused, changing nothing, while any workspace has an on-premises runner or a run routed on premises that has not
-- ended: an older release would neither serve those runners nor keep those runs off its hosted sandboxes. Revoke the
-- runners and switch the workspaces back to hosted first (their queued runs move with them). Otherwise the two tables,
-- the two columns and their indexes go, and the ledger row. Found by its name, so it also undoes it where it was
-- recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'on_premises_runners');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'on_premises_runners is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (on_premises_runners): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT (SELECT count(*) FROM onprem_runners WHERE state <> 'revoked')
       + (SELECT count(*) FROM runs WHERE runner_location = 'on_premises' AND status IN ('queued', 'running')) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '% on-premises runner(s) or run(s) routed on premises are live: revoke the runners and switch the workspaces back to hosted first', n;
  END IF;
  ALTER TABLE run_sandboxes DROP COLUMN IF EXISTS onprem_runner_id;
  ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_runner_location_check;
  DROP INDEX IF EXISTS runs_onprem_queued_idx;
  ALTER TABLE runs DROP COLUMN IF EXISTS runner_location;
  DROP TABLE IF EXISTS workspace_runner_settings, onprem_runners;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
