-- One person's own goal for one period: what they mean to get done in it and how many items they planned. Read and
-- written only when the deployment profile says work_periods.mode is "individual" (agent/lib/work-periods.ts); the
-- period is still a `cycles` row and the items are still the `todos` filed into it, by assignee, so this adds only
-- what neither of them holds. Purely additive: no existing table, column or row is touched.
-- Org-scoped by org_isolation, the fail-open form every table ships with, which .migrate-rls-fail-closed.mjs rewrites
-- in its sweep (scripts/bootstrap-test-db.mjs does the same for a test database).
-- IF NOT EXISTS / DROP POLICY IF EXISTS: applying this twice is harmless.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "cycle_member_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"cycle_id" uuid NOT NULL,
	"member" text NOT NULL,
	"goal" text,
	"target_count" integer,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cycle_member_goals_member_uidx" ON "cycle_member_goals" USING btree ("org_id","cycle_id","member");--> statement-breakpoint
ALTER TABLE "cycle_member_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_member_goals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "cycle_member_goals";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "cycle_member_goals"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "cycle_member_goals" TO app_rw;
  END IF;
END $$;
