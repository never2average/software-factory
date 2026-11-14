-- Rolling back past 0070_upload_bytes_inline (mold_v0-305), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0070_upload_bytes_inline.sql
-- Drops the column that holds an upload's bytes in the database. Refused while a row holds bytes there: the older release
-- reads every upload from the object store, so those files (a pack's declared recipes, an agent's proposals, kept while
-- the app had no object store) would be gone. Configure an object store and let the app bring the pack's recipes in
-- again, or delete those uploads, first. Found by its name, so it also undoes it where it was recorded under another
-- number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'upload_bytes_inline');
  n INT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'upload_bytes_inline is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (upload_bytes_inline): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT count(*) INTO n FROM agent_profile_uploads WHERE inline_data IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'agent_profile_uploads holds % upload(s) whose bytes are in the database (no object store): the older release cannot read them. Not dropped', n;
  END IF;
  ALTER TABLE agent_profile_uploads DROP CONSTRAINT IF EXISTS agent_profile_uploads_inline_check;
  ALTER TABLE agent_profile_uploads DROP COLUMN IF EXISTS inline_data;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
