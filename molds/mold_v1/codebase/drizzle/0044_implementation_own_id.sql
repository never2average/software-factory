-- AN IMPLEMENTATION ROW HAS ITS OWN ID (records.areas.implementations `per_account`). The key was (org_id, customer_id):
-- one implementation per account, so a second one (a second compliance framework for one regulator) overwrote the first.
-- Now the key is (org_id, implementation_id), and the account's rows are found by an index on (org_id, customer_id).
--
-- ADDITIVE AND SAFE ON EXISTING DATA: one column is added and every existing row is given its account id as its id, so
-- every row keeps its values and is found exactly as before; no column, value or policy is dropped (org_isolation on
-- `implementation` is row-level and stays as it is). A profile that keeps one per account (the default) goes on writing
-- the account id as the id, so (org_id, implementation_id) still holds one row per account; one that declares
-- `per_account: "many"` gives each row its own id (agent/lib/implementation-ids.ts).
--
-- A row inserted without an id (code that predates this column, still serving during a deploy) gets its account id
-- from a BEFORE INSERT trigger, as the backfill gave the rows that existed. The trigger is created before the backfill,
-- so no row written between the two is left without one when the column becomes NOT NULL.
--
-- Safe to apply twice: IF NOT EXISTS / OR REPLACE, and the key is swapped only when the new one is not there yet.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "implementation" ADD COLUMN IF NOT EXISTS "implementation_id" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "implementation_fill_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."implementation_id" IS NULL THEN
    NEW."implementation_id" := NEW."customer_id";
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "implementation_fill_id" ON "implementation";--> statement-breakpoint
CREATE TRIGGER "implementation_fill_id" BEFORE INSERT ON "implementation" FOR EACH ROW EXECUTE FUNCTION "implementation_fill_id"();--> statement-breakpoint
UPDATE "implementation" SET "implementation_id" = "customer_id" WHERE "implementation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "implementation" ALTER COLUMN "implementation_id" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'implementation_org_id_implementation_id_pk') THEN
    ALTER TABLE "implementation" DROP CONSTRAINT IF EXISTS "implementation_org_id_customer_id_pk";
    ALTER TABLE "implementation" ADD CONSTRAINT "implementation_org_id_implementation_id_pk" PRIMARY KEY ("org_id", "implementation_id");
  END IF;
END
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "implementation_org_id_customer_id_idx" ON "implementation" USING btree ("org_id","customer_id");
