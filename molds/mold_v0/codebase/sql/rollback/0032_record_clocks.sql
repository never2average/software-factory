-- Rolling back past 0032_record_clocks (mold_v0-191), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0032_record_clocks.sql
-- The clock notices go (an older release knows only due-date notices), workspace_notices takes back the kind check 0008
-- gave it, and the two clock tables go with their rows: what a clock remembered (pauses it saw, when it stopped) and its
-- events. Keep a copy first if the history matters (pg_dump -t workspace_record_clocks -t workspace_clock_events); an
-- older release never reads them. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'record_clocks');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'record_clocks is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (record_clocks): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DELETE FROM workspace_notices WHERE kind <> 'due';
  ALTER TABLE workspace_notices DROP CONSTRAINT IF EXISTS workspace_notices_kind_check;
  ALTER TABLE workspace_notices ADD CONSTRAINT workspace_notices_kind_check CHECK (kind IN ('due'));
  DROP TABLE IF EXISTS workspace_clock_events, workspace_record_clocks;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
