-- One hand-back per stopped specialist: the claim that lets exactly one request, on whichever instance, tell the
-- main agent that a specialist was stopped (agent/lib/specialist-handback.ts). See `specialistHandbacks` in
-- agent/lib/db/schema.ts. Additive: a new table and nothing else.
--
-- DEPLOY ORDER: apply this BEFORE deploying the agent that writes it. Without the table a Stop on a specialist still
-- stops it, and the hand-back is reported as not delivered (the claim fails closed: nothing is sent unclaimed).
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "specialist_handbacks" (
	"org_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"child_session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_handbacks_pk" PRIMARY KEY("parent_session_id","child_session_id","turn_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_handbacks_org_idx" ON "specialist_handbacks" USING btree ("org_id");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs rewrites
-- every org_isolation policy in one sweep).
ALTER TABLE "specialist_handbacks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_handbacks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "specialist_handbacks";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "specialist_handbacks"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "specialist_handbacks" TO app_rw;
  END IF;
END $$;
