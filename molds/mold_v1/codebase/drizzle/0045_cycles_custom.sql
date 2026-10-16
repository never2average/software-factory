-- A PERIOD'S OWN FIELDS (the deployment profile's records.areas.periods, docs/DEPLOYMENT_PROFILE.md "records"): ONE
-- jsonb column keyed by the field's key, as todos (0041), deployments and implementation (0017) have. A profile changes
-- what the keys are, never the schema. Every write is checked against the profile's definition first
-- (agent/lib/period-area.ts) and merged per key in SQL, so a key nobody names is never touched. Existing rows get '{}'.
-- One GIN jsonb_path_ops index over the column itself (not an expression, so drizzle-kit compares it as schema.ts
-- states it and the drift plan stays empty), as 0043. Additive: one column with a default and one index, safe to apply
-- twice. Adding a column touches no policy: org_isolation on cycles is row-level and stays exactly as it is.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "cycles" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cycles_custom_idx" ON "cycles" USING gin ("custom" jsonb_path_ops);
