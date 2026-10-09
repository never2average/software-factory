-- Starter apps: the apps a new workspace is created with, named by the deployment profile's library
-- (`<library>/apps.json`, scripts/lib/profile-library.mjs), never by base code.
--
-- `apps.starter_key` is `<library id>/<key>` of the library entry a row was created from, and NULL for every app a
-- person or the agent made (so every row that exists today is untouched and stays NULL). The unique index is what
-- makes provisioning idempotent: agent/lib/provision-workspace.ts inserts with ON CONFLICT DO NOTHING, so a retry, a
-- second run or `npm run operator:library-apply` cannot create a starter app twice. NULLs are distinct in a unique
-- index, so it constrains starter apps only. A deleted app is soft-deleted (deleted_at) and keeps its key, which is
-- how a starter app a person deleted is never created again.
--
-- Additive and idempotent (IF NOT EXISTS). schema.ts declares the same column and index, so the deploy's drift dry
-- run after this is empty. Row level security is untouched: the policy is per row and covers every column.
-- Applied by `npm run db:migrate:production` before the deploy's code reads the column.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "starter_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_org_starter_key_uq" ON "apps" USING btree ("org_id","starter_key");
