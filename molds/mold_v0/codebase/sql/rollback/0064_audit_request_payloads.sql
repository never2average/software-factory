-- Rolling back past 0064_audit_request_payloads (mold_v0-286), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0064_audit_request_payloads.sql
-- Drops the trails' request column: the entries stay, without the requests they kept (the older release never wrote or
-- read one). Dropping a column fires no row trigger, so the append-only tables allow it. Found by its name, so it also
-- undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'audit_request_payloads');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'audit_request_payloads is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (audit_request_payloads): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE audit_data_events DROP COLUMN IF EXISTS request;
  ALTER TABLE audit_platform_events DROP COLUMN IF EXISTS request;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
