-- Rolling back past 0048_harness_session_tokens (mold_v0-250), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0048_harness_session_tokens.sql
-- The agent sessions' tool tokens go: each was good for one wake only, and an older release neither makes nor reads them
-- (its sessions reach nothing of the workspace). A wake running across the rollback loses its workspace tools.
-- Found by its name. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'harness_session_tokens');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'harness_session_tokens is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (harness_session_tokens): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS harness_session_tokens;
  DELETE FROM schema_migrations WHERE version = v;
END
$rb$;
