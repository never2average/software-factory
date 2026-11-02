-- Rolling back past 0033_developer_surface (mold_v0-193), for a release from before it (and before rolling back an
-- earlier migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0033_developer_surface.sql
-- The developer surface's tables go, and the ledger row. An older release has no developer surface: its workspaces'
-- API keys, client sessions, webhook endpoints (with their sealed secrets) and delivery logs are deleted with them, so
-- the integrations built on them stop; tell the workspaces first. Found by its name, so it also undoes it where it was
-- recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'developer_surface');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'developer_surface is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (developer_surface): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS developer_marks;
  DROP TABLE IF EXISTS idempotency_keys;
  DROP TABLE IF EXISTS webhook_sources;
  DROP TABLE IF EXISTS webhook_deliveries;
  DROP TABLE IF EXISTS webhook_endpoints;
  DROP TABLE IF EXISTS developer_origins;
  DROP TABLE IF EXISTS developer_client_sessions;
  DROP TABLE IF EXISTS developer_keys;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
