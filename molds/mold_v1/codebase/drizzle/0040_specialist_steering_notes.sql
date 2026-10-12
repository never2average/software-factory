-- Notes a person sends a delegated specialist while it works (mold_v1-235): one row per note, read by the
-- specialist at its next step (agent/lib/steering.ts, the eve patch's harness/steering-notes.js). See
-- `specialistSteeringNotes` in agent/lib/db/schema.ts. Additive: a new table and nothing else.
--
-- DEPLOY ORDER: apply this BEFORE deploying the agent that writes it. Without the table a note is refused (503) and a
-- specialist's step reads nothing (it fails closed: the step goes on without notes).
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "specialist_steering_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"call_id" text NOT NULL,
	"child_session_id" text,
	"author_email" text,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_steering_notes_delegation_idx" ON "specialist_steering_notes" USING btree ("parent_session_id","call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_steering_notes_org_idx" ON "specialist_steering_notes" USING btree ("org_id");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs rewrites
-- every org_isolation policy in one sweep).
ALTER TABLE "specialist_steering_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_steering_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "specialist_steering_notes";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "specialist_steering_notes"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "specialist_steering_notes" TO app_rw;
  END IF;
END $$;
