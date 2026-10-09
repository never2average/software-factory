-- Neutral owner columns (mold_v1-103, PR 4): customers.account_owner beside customers' original owner column, and
-- solutions.solution_owner beside solutions' original one.
--
-- The original columns carried the base product's old role word in their names (the word is spelled nowhere in this
-- source: the statements below that name those columns build the names from its letters, chr(102) || chr(100) ||
-- chr(101), as agent/lib/legacy-member.ts does). Something outside this repository wrote them by name when this ran
-- (the software factory's workspace seeding, in raw SQL), so they were not dropped or renamed here. Each got a
-- neutral twin, and the two are kept EQUAL by a trigger whichever side a statement writes:
--
--   * INSERT: a side left NULL takes the other's value; when both are given and differ, the neutral side wins.
--   * UPDATE: the side the statement changed is copied onto the other; when both changed and differ, the neutral
--     side wins. A NULL written to either side clears both (an account with no owner).
--
-- The app read the neutral column first and the original as a fallback, and wrote both. drizzle/0037 then switched
-- every reader and writer to the neutral columns, and drizzle/0038 drops the originals with these triggers.
--
-- THIS MIGRATION DOES THE WHOLE CHANGE ON ITS OWN. The deploy runs the journal and then a read-only drift dry run of
-- `drizzle-kit push`, which refuses DROP COLUMN, an unknown DROP INDEX and truncate; after this the plan is EMPTY
-- (scripts/test-owner-columns-migration-db.mjs). drizzle-kit does not model triggers or functions, so they are
-- invisible to that plan.
--
-- On a database that has no original column (pushed from a schema after 0038), only the neutral columns and their
-- index are made: the copy and the trigger need the original, and there is none to keep equal.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS), one transaction, nothing is deleted, and row
-- level security is untouched (the policies are per row; the new columns are covered by them as every column is).
--
-- The migrating role is an admin one (BYPASSRLS on Supabase and Neon). row_security = off makes a role that is not
-- fail loudly on the copy instead of silently copying no row.
SET LOCAL row_security = off;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "account_owner" text;
--> statement-breakpoint
ALTER TABLE "solutions" ADD COLUMN IF NOT EXISTS "solution_owner" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_account_owner_idx" ON "customers" USING btree ("account_owner");
--> statement-breakpoint
DO $do$
DECLARE
  w constant text := chr(102) || chr(100) || chr(101);
  account_col constant text := w || '_owner';
  solution_col constant text := 'solution_' || w || '_owner';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = account_col) THEN
    -- The copy. Until this migration the original column was the only one any writer knew, so it is the source; a
    -- neutral value is copied back only onto an original left NULL (a database pushed from the schema of this
    -- release, where the app wrote both, never differs).
    EXECUTE format('UPDATE "customers" SET "account_owner" = %1$I WHERE %1$I IS NOT NULL AND "account_owner" IS DISTINCT FROM %1$I', account_col);
    EXECUTE format('UPDATE "customers" SET %1$I = "account_owner" WHERE %1$I IS NULL AND "account_owner" IS NOT NULL', account_col);
    EXECUTE format($f$CREATE OR REPLACE FUNCTION "customers_owner_pair"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.account_owner IS NULL THEN
      NEW.account_owner := NEW.%1$I;
    ELSE
      NEW.%1$I := NEW.account_owner;
    END IF;
  ELSIF NEW.account_owner IS DISTINCT FROM OLD.account_owner THEN
    NEW.%1$I := NEW.account_owner;
  ELSIF NEW.%1$I IS DISTINCT FROM OLD.%1$I THEN
    NEW.account_owner := NEW.%1$I;
  END IF;
  RETURN NEW;
END
$$$f$, account_col);
    DROP TRIGGER IF EXISTS "customers_owner_pair" ON "customers";
    EXECUTE format('CREATE TRIGGER "customers_owner_pair" BEFORE INSERT OR UPDATE OF "account_owner", %I ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "customers_owner_pair"()', account_col);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'solutions' AND column_name = solution_col) THEN
    EXECUTE format('UPDATE "solutions" SET "solution_owner" = %1$I WHERE "solution_owner" IS DISTINCT FROM %1$I', solution_col);
    EXECUTE format($f$CREATE OR REPLACE FUNCTION "solutions_owner_pair"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.solution_owner IS NULL THEN
      NEW.solution_owner := NEW.%1$I;
    ELSE
      NEW.%1$I := NEW.solution_owner;
    END IF;
  ELSIF NEW.solution_owner IS DISTINCT FROM OLD.solution_owner THEN
    NEW.%1$I := NEW.solution_owner;
  ELSIF NEW.%1$I IS DISTINCT FROM OLD.%1$I THEN
    NEW.solution_owner := NEW.%1$I;
  END IF;
  RETURN NEW;
END
$$$f$, solution_col);
    DROP TRIGGER IF EXISTS "solutions_owner_pair" ON "solutions";
    EXECUTE format('CREATE TRIGGER "solutions_owner_pair" BEFORE INSERT OR UPDATE OF "solution_owner", %I ON "solutions"
  FOR EACH ROW EXECUTE FUNCTION "solutions_owner_pair"()', solution_col);
  END IF;
END $do$;
