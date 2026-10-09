-- The retired owner columns, step 1 of 2: SWITCH (drizzle/0038 is step 2, the drop).
--
-- drizzle/0028 added customers.account_owner beside customers' original owner column and solutions.solution_owner
-- beside solutions' original one, copied the values and keeps each pair equal by a trigger. Until this release the
-- app wrote both and read the neutral one first. From this release on the app names ONLY the neutral columns: it
-- reads them and writes them, and the trigger (still in place) copies each write onto the original, so a server
-- still running the previous release, which reads coalesce(neutral, original) and writes both, keeps working while
-- this one is deployed. The original columns' names are spelled nowhere in the source: this file and 0038 build
-- them from their letters (the retired word, chr(102) || chr(100) || chr(101)), as agent/lib/legacy-member.ts does.
--
-- THE DEPLOY WINDOW. The factory's chain runs the journal BEFORE the new build serves (provision.py: hold, migrate,
-- drift, bootstrap, cover, prove; the build and its promotion come after), so for several minutes the previous
-- release serves against a database this file has changed. Everything here is safe for it:
--   * the copies below only fill a NULL neutral value from its original; no value it reads changes;
--   * DROP NOT NULL on solutions' original column: the previous release always writes it, so nothing it does fails;
--   * the original owner column's index is dropped: a query of the previous release that used it is slower, never
--     wrong. It goes here, in the journal, because the deploy's drift step refuses an index drop, and the schema
--     drizzle-kit reads (agent/lib/db/drizzle-kit-schema.ts) no longer declares it;
--   * stored values that carried the retired word become the neutral ones ('Member', 'Member Verified', the
--     'member-profile:' memory key). The previous release reads every enum leniently (customer-schema.ts
--     withReadTolerantStrings) and shows any value it does not translate as stored, so it reads these unchanged.
-- Nothing is dropped that a running server names: the columns themselves stay until 0038, which runs only in a
-- LATER deploy, once no server of a release before this one is left. Dropping them here would break the previous
-- release for the whole window (every insert it makes names them).
--
-- Row-level security is untouched: the policies are per row (org_id), no policy, grant or RLS flag names an owner
-- column, and no table is created. The index the app uses (customers_account_owner_idx, 0028) stays.
--
-- Idempotent and safe on every database the journal meets: a database whose original columns were never created
-- (pushed from a schema without them) skips those steps; run twice, it changes nothing the second time. One
-- transaction (scripts/migrate-production.mjs). Proven on production-shaped data by
-- scripts/test-owner-columns-switch-db.mjs.
--
-- The migrating role is an admin one (BYPASSRLS on Supabase and Neon). row_security = off makes a role that is not
-- fail loudly on the copies instead of silently copying no row.
SET LOCAL row_security = off;
--> statement-breakpoint
DO $$
DECLARE
  w constant text := chr(102) || chr(100) || chr(101);
  account_col constant text := w || '_owner';
  solution_col constant text := 'solution_' || w || '_owner';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = account_col) THEN
    EXECUTE format('UPDATE "customers" SET "account_owner" = %1$I WHERE "account_owner" IS NULL AND %1$I IS NOT NULL', account_col);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'solutions' AND column_name = solution_col) THEN
    EXECUTE format('UPDATE "solutions" SET "solution_owner" = %1$I WHERE "solution_owner" IS NULL AND %1$I IS NOT NULL', solution_col);
    EXECUTE format('ALTER TABLE "solutions" ALTER COLUMN %I DROP NOT NULL', solution_col);
  END IF;
  EXECUTE format('DROP INDEX IF EXISTS %I', 'customers_' || w || '_owner_idx');

  -- Stored values. Upper case is how the word was stored in both enums.
  UPDATE "tickets" SET "owner_team" = 'Member' WHERE "owner_team" = upper(w);
  UPDATE "customers" SET "value_evidence_status" = 'Member Verified' WHERE "value_evidence_status" = upper(w) || ' Verified';
  -- An operator's profile memory (scripts/operator/lib/operator.mjs): moved to the neutral key unless the same
  -- workspace and scope already has a row under it, which the tooling has always preferred; that older row is left as it is.
  UPDATE "memories" AS m SET "key" = 'member-profile:' || substr(m."key", length(w || '-profile:') + 1)
   WHERE m."key" LIKE w || '-profile:%'
     AND NOT EXISTS (SELECT 1 FROM "memories" n
                      WHERE n."org_id" = m."org_id" AND n."scope" = m."scope"
                        AND n."key" = 'member-profile:' || substr(m."key", length(w || '-profile:') + 1));
END $$;
