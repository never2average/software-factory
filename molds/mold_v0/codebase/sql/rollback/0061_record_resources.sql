-- Rolling back past 0061_record_resources (mold_v0-282), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0061_record_resources.sql
-- Refused, changing nothing, while a record still has a database (a row of record_resources: the older release could
-- neither show it nor delete it with its record, and its sealed connection string would be lost) or the key vault holds
-- a Neon key (the older release could not list or delete it): delete those records (each deletes its Neon project) or
-- take the database fields out with features.record_resources off, delete the Neon key on Key vault, then roll back.
-- Otherwise the table goes, the provider row and the ledger row. Found by its name, so it also undoes it where it was
-- recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'record_resources');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'record_resources is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (record_resources): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  SELECT count(*) FROM record_resources INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '% record database(s) still exist (record_resources): delete their records first (each deletes its Neon project), then roll back', n;
  END IF;
  SELECT count(*) FROM vault_credentials WHERE provider = 'neon' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'the key vault holds a Neon key the older release cannot use: delete it on Key vault, then roll back';
  END IF;
  DROP TABLE IF EXISTS record_resources;
  DELETE FROM vault_providers WHERE slug = 'neon';
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
