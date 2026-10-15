-- THE TWO ACCOUNT RECORD AREAS' OWN FIELDS, FILTERED IN THE DATABASE (agent/lib/record-query.ts): a list filtered on an
-- own field asks `custom @> '{"key": value}'`, which a GIN jsonb_path_ops index on `custom` serves, as todos.custom has
-- had since 0041. One index per table, over the column itself (not an expression, so drizzle-kit compares it as
-- schema.ts states it and the drift plan stays empty). Additive: no column, value or policy changes; org_isolation on
-- both tables is row-level and stays as it is. IF NOT EXISTS, safe to apply twice.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE INDEX IF NOT EXISTS "deployments_custom_idx" ON "deployments" USING gin ("custom" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "implementation_custom_idx" ON "implementation" USING gin ("custom" jsonb_path_ops);
