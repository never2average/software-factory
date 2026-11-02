-- Rolling back past 0031_audit_trails (mold_v0-197), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0031_audit_trails.sql
-- The trails' tables, their sequence and the append-only function go, and the ledger row. A trail that holds entries is
-- a record a workspace or the operator may be relying on: refused unless the operator says to drop it anyway
--   psql ... -c "SET app.audit_rollback_drop = 'on'" -f sql/rollback/0031_audit_trails.sql   (one session: use -1)
-- (export it first: the console's Access log, CSV). Found by its name, so it also undoes it where it was recorded under
-- another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'audit_trails');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'audit_trails is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (audit_trails): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  n := (SELECT count(*) FROM audit_data_events) + (SELECT count(*) FROM audit_platform_events);
  IF n > 0 AND coalesce(current_setting('app.audit_rollback_drop', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the audit trails hold % entr(ies): not dropped (export them, then SET app.audit_rollback_drop = ''on'' in the same session to drop them)', n;
  END IF;
  DROP TABLE IF EXISTS audit_data_events;
  DROP TABLE IF EXISTS audit_platform_events;
  DROP TABLE IF EXISTS audit_sequences;
  DROP FUNCTION IF EXISTS app_audit_append_only();
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
