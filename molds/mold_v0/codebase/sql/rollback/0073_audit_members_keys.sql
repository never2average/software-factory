-- Rolling back past 0073_audit_members_keys (mold_v0-322), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0073_audit_members_keys.sql
-- Puts the data trail's action CHECK back to the eight actions before it: exactly as 0072 left it when the trail holds
-- no grant or revoke line; NOT VALID when it does (the trail is append-only and chained, so those lines stay; the older
-- release never writes another, and reads them as words from their action). Found by its name, so it also undoes it where it was recorded under another number. Refused when a
-- later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'audit_members_keys');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'audit_members_keys is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (audit_members_keys): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE audit_data_events DROP CONSTRAINT IF EXISTS audit_data_events_action_check;
  IF EXISTS (SELECT 1 FROM audit_data_events WHERE action IN ('grant', 'revoke')) THEN
    ALTER TABLE audit_data_events ADD CONSTRAINT audit_data_events_action_check
      CHECK (action IN ('list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete')) NOT VALID;
  ELSE
    ALTER TABLE audit_data_events ADD CONSTRAINT audit_data_events_action_check
      CHECK (action IN ('list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete'));
  END IF;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
