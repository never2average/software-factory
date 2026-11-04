-- Rolling back past 0041_email_files (mold_v0-220), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0041_email_files.sql
-- Drops the mail ledger's `files` mark and the mailboxes' backfill claim (bookkeeping only). The records keep the files
-- they were given (their field values and sealed objects stay; the older release shows them as references). Found by
-- its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'email_files');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'email_files is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (email_files): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS workspace_email_messages_files_waiting;
  ALTER TABLE workspace_email_inboxes DROP COLUMN IF EXISTS files_backfill_at;
  ALTER TABLE workspace_email_messages DROP COLUMN IF EXISTS files;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
