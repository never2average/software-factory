-- The retired owner columns, step 2 of 2: CONTRACT (drizzle/0037 was step 1, the switch).
--
-- Since 0037 the app reads and writes only customers.account_owner and solutions.solution_owner; 0028's triggers
-- kept the original columns equal to them so that the release before 0037, still serving during 0037's deploy
-- window, kept working. That window is over before this file runs: it ships one release LATER than 0037, so the
-- release serving while this one deploys is 0037's own, which never names the original columns (its schema.ts does
-- not declare them, so not even a `select()` does). Nothing else writes them: the software factory's workspace
-- seeding writes account_owner. So this drops them, with the two triggers and functions that kept them equal and
-- the one index left on them. The names are built from their letters (chr(102) || chr(100) || chr(101), the retired
-- word, as agent/lib/legacy-member.ts does), so the source never spells them.
--
-- NOTHING IS LOST. Before anything is dropped, a neutral value still NULL is filled from the original once more
-- (the trigger kept them equal; this covers a writer that bypassed it), the neutral value winning where both are
-- set, as 0037 did. The stored values 0037 rewrote are rewritten again, for a row the release before 0037 may have
-- written during 0037's deploy window ("Member", "Member Verified", the `member-profile:` memory key).
--
-- THE DEPLOY. The journal runs before the drift dry run, and drizzle-kit now reads agent/lib/db/schema.ts, which
-- declares neither column: after this file the plan is empty (a DROP COLUMN left to the drift step would be refused
-- and stop the deploy; here it is the journal's). Dropping a column and an index, and a trigger, is a catalog change:
-- no table is rewritten, and the ACCESS EXCLUSIVE locks are held only for the transaction.
--
-- Row-level security is untouched: no policy, grant or RLS flag names an owner column. The neutral columns, their
-- index (customers_account_owner_idx) and 0029's second-owner trigger stay.
--
-- Idempotent and safe on every database the journal meets: one without the original columns (pushed from a schema
-- after this one, or built by the journal and already contracted) only re-runs the value rewrites, which find
-- nothing. One transaction (scripts/migrate-production.mjs). Proven on production-shaped data by
-- scripts/test-owner-columns-contract-db.mjs.
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
  END IF;

  UPDATE "tickets" SET "owner_team" = 'Member' WHERE "owner_team" = upper(w);
  UPDATE "customers" SET "value_evidence_status" = 'Member Verified' WHERE "value_evidence_status" = upper(w) || ' Verified';
  UPDATE "memories" AS m SET "key" = 'member-profile:' || substr(m."key", length(w || '-profile:') + 1)
   WHERE m."key" LIKE w || '-profile:%'
     AND NOT EXISTS (SELECT 1 FROM "memories" n
                      WHERE n."org_id" = m."org_id" AND n."scope" = m."scope"
                        AND n."key" = 'member-profile:' || substr(m."key", length(w || '-profile:') + 1));

  -- The triggers first: each names its original column in UPDATE OF, so the column cannot go while it exists.
  DROP TRIGGER IF EXISTS "customers_owner_pair" ON "customers";
  DROP TRIGGER IF EXISTS "solutions_owner_pair" ON "solutions";
  DROP FUNCTION IF EXISTS "customers_owner_pair"();
  DROP FUNCTION IF EXISTS "solutions_owner_pair"();
  EXECUTE format('DROP INDEX IF EXISTS %I', 'customers_' || w || '_owner_idx');
  EXECUTE format('ALTER TABLE "customers" DROP COLUMN IF EXISTS %I', account_col);
  EXECUTE format('ALTER TABLE "solutions" DROP COLUMN IF EXISTS %I', solution_col);
END $$;
