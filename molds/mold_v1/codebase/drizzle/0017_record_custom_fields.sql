-- A deployment profile may declare its OWN fields on the two record areas it can redefine
-- (`domains.<area>.custom_fields`, docs/DEPLOYMENT_PROFILE.md). Their values live in ONE jsonb column per table,
-- keyed by the field's key: a profile changes what the keys are, never the schema, so no per-field DDL.
-- Values are validated on every write by agent/lib/custom-fields.ts. Existing rows get '{}'.
-- Adding a column touches no policy: org_isolation on both tables is row-level and stays exactly as it is.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "implementation" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;
