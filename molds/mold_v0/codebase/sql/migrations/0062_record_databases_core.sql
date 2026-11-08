-- Record databases in the app's own Postgres (mold_v0-285, flag record_resources; src/record-resources.ts, the only
-- writer; molds/mold_v0/MOLD.md "Record-owned resources"): a shared record's database is a schema of its own inside the
-- app's own database (DATABASE_URL), with a login role limited to it where the database allows one. There is no outside
-- database provider any more (mold_v0-282's Neon is gone: no app used it).
--   record_resources   its provider is `core`; external_id names the record's schema, details its role (or none: the
--                      app's own login is used inside the schema) and what the database refused, in words.
--   vault_providers    neon's row goes, unless the key vault still holds a Neon key (then both stay, unused: never
--                      offered on Key vault, never given to a session or a run; a platform owner deletes the key there).
-- Refused, changing nothing, while a record still has a Neon database (record_resources provider neon): a release from
-- before this one deletes those records (each deletes its Neon project), then this applies.
DO $mig$
DECLARE
  n BIGINT;
BEGIN
  SELECT count(*) FROM record_resources WHERE provider = 'neon' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '% record database(s) are Neon projects: delete their records on the release before this one (each deletes its Neon project), then migrate. Record databases now live in the app''s own database', n;
  END IF;
END $mig$;

ALTER TABLE record_resources DROP CONSTRAINT IF EXISTS record_resources_provider_check;
ALTER TABLE record_resources ADD CONSTRAINT record_resources_provider_check CHECK (provider IN ('core'));
ALTER TABLE record_resources ALTER COLUMN provider SET DEFAULT 'core';

DELETE FROM vault_providers WHERE slug = 'neon' AND NOT EXISTS (SELECT 1 FROM vault_credentials WHERE provider = 'neon');
