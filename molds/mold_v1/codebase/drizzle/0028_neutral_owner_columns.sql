-- Neutral owner columns (mold_v1-103, PR 4): customers.account_owner beside customers.fde_owner, and
-- solutions.solution_owner beside solutions.solution_fde_owner.
--
-- The original columns carry the base product's role word in their names, and something outside this repository
-- already writes them by name (the software factory's workspace seeding writes customers.fde_owner in raw SQL), so
-- they are never dropped or renamed here. Each gets a neutral twin, and the two are kept EQUAL by a trigger whichever
-- side a statement writes:
--
--   * INSERT: a side left NULL takes the other's value; when both are given and differ, the neutral side wins.
--   * UPDATE: the side the statement changed is copied onto the other; when both changed and differ, the neutral
--     side wins. A NULL written to either side clears both (an account with no owner).
--
-- The app reads the neutral column first and the original as a fallback (a database built by `drizzle-kit push`
-- alone, as CI's is, has the columns but not this trigger), and writes both.
--
-- THIS MIGRATION DOES THE WHOLE CHANGE ON ITS OWN. The deploy runs the journal and then a read-only drift dry run of
-- `drizzle-kit push` against schema.ts, which refuses DROP COLUMN, an unknown DROP INDEX and truncate. schema.ts
-- declares both new columns (nullable) and both indexes (customers_fde_owner_idx stays; customers_account_owner_idx is
-- added), so after this the plan is EMPTY: scripts/test-owner-columns-migration-db.mjs asserts it on a database
-- shaped like production. drizzle-kit does not model triggers or functions, so they are invisible to that plan.
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
-- The copy. Until this migration the original column was the only one any writer knew, so it is the source; a
-- neutral value is copied back only onto an original left NULL (a database pushed from the new schema.ts, where the
-- app wrote both, never differs).
UPDATE "customers" SET "account_owner" = "fde_owner" WHERE "fde_owner" IS NOT NULL AND "account_owner" IS DISTINCT FROM "fde_owner";
--> statement-breakpoint
UPDATE "customers" SET "fde_owner" = "account_owner" WHERE "fde_owner" IS NULL AND "account_owner" IS NOT NULL;
--> statement-breakpoint
UPDATE "solutions" SET "solution_owner" = "solution_fde_owner" WHERE "solution_owner" IS DISTINCT FROM "solution_fde_owner";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_account_owner_idx" ON "customers" USING btree ("account_owner");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "customers_owner_pair"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.account_owner IS NULL THEN
      NEW.account_owner := NEW.fde_owner;
    ELSE
      NEW.fde_owner := NEW.account_owner;
    END IF;
  ELSIF NEW.account_owner IS DISTINCT FROM OLD.account_owner THEN
    NEW.fde_owner := NEW.account_owner;
  ELSIF NEW.fde_owner IS DISTINCT FROM OLD.fde_owner THEN
    NEW.account_owner := NEW.fde_owner;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "solutions_owner_pair"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.solution_owner IS NULL THEN
      NEW.solution_owner := NEW.solution_fde_owner;
    ELSE
      NEW.solution_fde_owner := NEW.solution_owner;
    END IF;
  ELSIF NEW.solution_owner IS DISTINCT FROM OLD.solution_owner THEN
    NEW.solution_fde_owner := NEW.solution_owner;
  ELSIF NEW.solution_fde_owner IS DISTINCT FROM OLD.solution_fde_owner THEN
    NEW.solution_owner := NEW.solution_fde_owner;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_owner_pair" ON "customers";
--> statement-breakpoint
CREATE TRIGGER "customers_owner_pair" BEFORE INSERT OR UPDATE OF "account_owner", "fde_owner" ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "customers_owner_pair"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "solutions_owner_pair" ON "solutions";
--> statement-breakpoint
CREATE TRIGGER "solutions_owner_pair" BEFORE INSERT OR UPDATE OF "solution_owner", "solution_fde_owner" ON "solutions"
  FOR EACH ROW EXECUTE FUNCTION "solutions_owner_pair"();
