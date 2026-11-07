-- Rolling back past 0055_access_pages (mold_v0-266), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0055_access_pages.sql
-- Drops the edited early-access form and sign-in words and their history: the older release shows the build's own form
-- and words (what the defaults are), and every stored request keeps its answers (access_requests is not touched). Found
-- by its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'access_pages');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'access_pages is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (access_pages): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS access_page_changes;
  DROP TABLE IF EXISTS access_pages;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
