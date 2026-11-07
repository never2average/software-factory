-- Rolling back past 0059_platform_account (mold_v0-276), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0059_platform_account.sql
-- Drops only the mark: the platform account itself, its members and everything in it stay, an ordinary account to the
-- older release (staff manage it on Accounts like any other). A later release finds no mark and, as it cannot tell the
-- old account from a customer's, makes a new one under a free slug; staff may delete the old one there.
-- Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'platform_account');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'platform_account is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (platform_account): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS organizations_one_platform_account;
  ALTER TABLE organizations DROP COLUMN IF EXISTS platform_account;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
