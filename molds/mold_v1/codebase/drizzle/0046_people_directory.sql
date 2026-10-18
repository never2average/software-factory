-- PEOPLE DATA FOR THE DIRECTORY (docs/WORKFLOW_ENGINE.md, phase 4): what a workspace's owner records about each person
-- on its roster, beside the name, team and reporting line (manager_email, the person's supervisor) it already has. Two
-- jsonb columns: the department keys the person is in, and typed attributes by key, both from the deployment profile's
-- `people` catalogue (a profile changes what the keys are, never the schema). Every write is checked against the
-- profile first, and the supervisor against the workspace's own people and reporting lines (agent/lib/people-data.ts).
-- Existing rows get [] and {}. Additive: two columns with defaults, safe to apply twice. Adding a column touches no
-- policy: org_isolation on people_roster is row-level and stays exactly as it is, so another workspace reads none of it.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "people_roster" ADD COLUMN IF NOT EXISTS "departments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "people_roster" ADD COLUMN IF NOT EXISTS "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;
