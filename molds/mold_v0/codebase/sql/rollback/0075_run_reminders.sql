-- Rolling back past 0075_run_reminders (mold_v0-334), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0075_run_reminders.sql
-- The run reminders go (an older release knows only due-date and clock notices) and workspace_notices takes back the kind
-- check 0032 gave it. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'run_reminders');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'run_reminders is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (run_reminders): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DELETE FROM workspace_notices WHERE kind = 'run';
  ALTER TABLE workspace_notices DROP CONSTRAINT IF EXISTS workspace_notices_kind_check;
  ALTER TABLE workspace_notices ADD CONSTRAINT workspace_notices_kind_check CHECK (kind IN ('due', 'clock'));
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
