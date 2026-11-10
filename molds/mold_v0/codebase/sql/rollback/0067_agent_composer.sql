-- Rolling back past 0067_agent_composer (mold_v0-290), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0067_agent_composer.sql
-- Removes the session numbers, the counters, the attached files' rows and what each message carried. The bytes of attached
-- files stay in the object store under the workspace's prefix, unreachable, until the workspace is removed.
-- Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration
-- is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'agent_composer');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'agent_composer is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (agent_composer): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS harness_session_files;
  DROP TABLE IF EXISTS harness_session_counters;
  ALTER TABLE harness_session_messages DROP COLUMN IF EXISTS attachments;
  DROP INDEX IF EXISTS harness_sessions_number_idx;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS session_number;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
