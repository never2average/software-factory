-- A task's OWN fields (the deployment profile's records.areas.tasks, docs/DEPLOYMENT_PROFILE.md "records"): ONE jsonb
-- column keyed by the field's key, as deployments and implementation have had since 0017. A profile changes what the
-- keys are, never the schema. Every write is checked against the profile's definition first
-- (agent/lib/record-validate.ts) and merged per key by the task-workflow service, so a key nobody names is never
-- touched. Existing rows get '{}'. Additive: one column with a default and one index, safe to apply twice.
-- Adding a column touches no policy: org_isolation on todos is row-level and stays exactly as it is.
--
-- DEPLOY ORDER: the task-workflow service first (it writes the column only for a body that names `custom`, which only
-- a deployment whose tasks declare own fields sends), then this, then the app.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_custom_idx" ON "todos" USING gin ("custom" jsonb_path_ops);
