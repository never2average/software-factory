-- Neutral second-owner column (mold_v1-103, PR 7c): customers.secondary_owner beside customers.ae_owner.
--
-- `ae_owner` names one line of work's role (a sales team's account executive) in the base schema. It gets a neutral
-- twin exactly as `fde_owner` did in 0028: the original column is never dropped or renamed here, because a writer
-- outside this repository may name it in raw SQL, and a trigger keeps the two EQUAL whichever side a statement writes:
--
--   * INSERT: a side left NULL takes the other's value; when both are given and differ, the neutral side wins.
--   * UPDATE: the side the statement changed is copied onto the other; when both changed and differ, the neutral
--     side wins. A NULL written to either side clears both (an account with no second owner).
--
-- The name: `secondary_owner` says only what the column is in every deployment, the account's second owner beside
-- `account_owner`, and names no trade. What that person is called (an account executive, a relationship manager, a
-- second analyst) is the deployment profile's word (`vocabulary.secondary_owner`), never the schema's.
--
-- The app reads the neutral column first and the original as a fallback (a database built by `drizzle-kit push`
-- alone, as CI's is, has the columns but not this trigger), and writes both (agent/lib/db/owner-columns.ts).
--
-- THIS MIGRATION DOES THE WHOLE CHANGE ON ITS OWN. The deploy runs the journal and then a read-only drift dry run of
-- `drizzle-kit push` against schema.ts, which refuses DROP COLUMN, an unknown DROP INDEX and truncate. schema.ts
-- declares the new column (nullable, no index: `ae_owner` never had one), so after this the plan is EMPTY:
-- scripts/test-secondary-owner-migration-db.mjs asserts it on a database shaped like production. drizzle-kit does not
-- model triggers or functions, so they are invisible to that plan.
--
-- Its own function and trigger, beside 0028's `customers_owner_pair`, which is untouched: each fires only for a
-- statement that names one of its own two columns, and neither writes the other's.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS), one transaction, nothing is deleted, and row
-- level security is untouched (the policies are per row; the new column is covered by them as every column is).
--
-- The migrating role is an admin one (BYPASSRLS on Supabase and Neon). row_security = off makes a role that is not
-- fail loudly on the copy instead of silently copying no row.
SET LOCAL row_security = off;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "secondary_owner" text;
--> statement-breakpoint
-- The copy. Until this migration the original column was the only one any writer knew, so it is the source; a
-- neutral value is copied back only onto an original left NULL (a database pushed from the new schema.ts, where the
-- app wrote both, never differs).
UPDATE "customers" SET "secondary_owner" = "ae_owner" WHERE "ae_owner" IS NOT NULL AND "secondary_owner" IS DISTINCT FROM "ae_owner";
--> statement-breakpoint
UPDATE "customers" SET "ae_owner" = "secondary_owner" WHERE "ae_owner" IS NULL AND "secondary_owner" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "customers_secondary_owner_pair"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.secondary_owner IS NULL THEN
      NEW.secondary_owner := NEW.ae_owner;
    ELSE
      NEW.ae_owner := NEW.secondary_owner;
    END IF;
  ELSIF NEW.secondary_owner IS DISTINCT FROM OLD.secondary_owner THEN
    NEW.ae_owner := NEW.secondary_owner;
  ELSIF NEW.ae_owner IS DISTINCT FROM OLD.ae_owner THEN
    NEW.secondary_owner := NEW.ae_owner;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_secondary_owner_pair" ON "customers";
--> statement-breakpoint
CREATE TRIGGER "customers_secondary_owner_pair" BEFORE INSERT OR UPDATE OF "secondary_owner", "ae_owner" ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "customers_secondary_owner_pair"();
