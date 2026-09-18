-- Token usage of ordinary chat turns (the main agent). Workflow turns already
-- land in automation_runs through each subagent's hooks/usage.ts; this is the
-- same ledger for the turns people type. Applied by
-- `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "chat_turn_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"actor_email" text,
	"model" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turn_usage_turn_uidx" ON "chat_turn_usage" USING btree ("eve_session_id","turn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_turn_usage_org_started_idx" ON "chat_turn_usage" USING btree ("org_id","started_at");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table. The policy is the
-- fail-open form the rest of the schema ships with; .migrate-rls-fail-closed.mjs
-- rewrites every org_isolation policy in one sweep, this one included, because
-- it discovers scoped tables from information_schema.
ALTER TABLE "chat_turn_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_turn_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "chat_turn_usage";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_turn_usage"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_turn_usage" TO app_rw;
  END IF;
END $$;
