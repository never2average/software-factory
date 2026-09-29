-- implementation.onfinance_launch_approver_email -> provider_launch_approver_email, IN THE JOURNAL.
--
-- The rename was made in agent/lib/db/schema.ts and applied to the live database by a one-off script
-- (.migrate-debrand-approver.mjs), but never entered drizzle/meta/_journal.json. So a database built from the
-- journal (a new deployment: `npm run db:migrate:production`) still had the vendor-named column and no
-- provider_launch_approver_email, and every read of the implementation table the app makes (`select *` through
-- drizzle) failed with "column provider_launch_approver_email does not exist".
--
-- Idempotent, for every state a database can be in:
--   · only the old column (built from the journal): renamed, values kept;
--   · only the new column (the live database, or one built with drizzle-kit push): nothing to do;
--   · both (pushed after being built from the journal): the old values copied into empty new cells; the old column
--     is left in place, never dropped here;
--   · neither: the new column added.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'implementation' AND column_name = 'onfinance_launch_approver_email') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'implementation' AND column_name = 'provider_launch_approver_email') THEN
      UPDATE "implementation" SET "provider_launch_approver_email" = "onfinance_launch_approver_email"
       WHERE "provider_launch_approver_email" IS NULL AND "onfinance_launch_approver_email" IS NOT NULL;
    ELSE
      ALTER TABLE "implementation" RENAME COLUMN "onfinance_launch_approver_email" TO "provider_launch_approver_email";
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'implementation' AND column_name = 'provider_launch_approver_email') THEN
    ALTER TABLE "implementation" ADD COLUMN "provider_launch_approver_email" text;
  END IF;
END $$;
