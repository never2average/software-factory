-- Rolling back past 0068_agent_dock (mold_v0-292), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0068_agent_dock.sql
-- Drops one index: no data is touched. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'agent_dock');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'agent_dock is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (agent_dock): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS harness_children_program_idx;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
