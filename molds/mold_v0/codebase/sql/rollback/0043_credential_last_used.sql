-- Rolling back past 0043_credential_last_used (mold_v0-239), for a release from before it (and before rolling back
-- 0042_workspace_record_provenance, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0043_credential_last_used.sql
-- Drops when each credential was last used. The values, their slots and when they were set stay exactly as they are;
-- the older release never read the column. Found by its name, so it also undoes it where it was recorded under another
-- number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'credential_last_used');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'credential_last_used is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (credential_last_used): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE workspace_credentials DROP COLUMN IF EXISTS last_used_at;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
