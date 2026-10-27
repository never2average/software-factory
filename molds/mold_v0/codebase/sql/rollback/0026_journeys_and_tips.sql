-- Rolling back past 0026_journeys_and_tips (mold_v0-143), for a release from before it (and before rolling back 0025,
-- which refuses while a later migration is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0026_journeys_and_tips.sql
-- Where 0026 was ADOPTED (a host pack made the tables: schema_adoptions has its row) the tables, their rows, policies and
-- grants are left exactly as they are: they are that host pack's again in the older release, whose migration that made
-- them is still recorded at its own checksum. Only 0026's ledger rows go. Where 0026 MADE the tables (or secured ones
-- this database had unsecured), they are dropped, and only when all six are empty (an older release never wrote them);
-- otherwise it refuses and changes nothing. Refused when a later migration is applied.
DO $rb$
DECLARE
  adopted BOOLEAN;
  n BIGINT;
BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 26 THEN
    RAISE EXCEPTION 'this database is at migration %, not 0026: roll back the later migrations first', (SELECT max(version) FROM schema_migrations);
  END IF;
  adopted := to_regclass('public.schema_adoptions') IS NOT NULL
    AND EXISTS (SELECT 1 FROM schema_adoptions WHERE pack = '' AND version = 26);
  IF NOT adopted THEN
    SELECT (SELECT count(*) FROM nudges) + (SELECT count(*) FROM nudge_prefs) + (SELECT count(*) FROM journey_templates)
         + (SELECT count(*) FROM journey_progress) + (SELECT count(*) FROM adoption_help) + (SELECT count(*) FROM journey_seed) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'nudges, nudge_prefs, journey_templates, journey_progress, adoption_help and journey_seed hold % row(s) written by this release: not dropped. Keep them (an older release ignores them) and only delete schema_migrations version 26 if you must start an older release', n;
    END IF;
    DROP TABLE nudges, nudge_prefs, journey_progress, adoption_help, journey_templates, journey_seed;
  END IF;
  IF to_regclass('public.schema_adoptions') IS NOT NULL THEN
    DELETE FROM schema_adoptions WHERE pack = '' AND version = 26;
  END IF;
  DELETE FROM schema_migrations WHERE version = 26;
END $rb$;
