-- What the specialist sweep did, and the right to do it (agent/lib/specialist-sweep.ts, agent/lib/sweep-ledger.ts;
-- mold_v1-196). One row per delegation of a main thread the sweep acted on or surfaced; the INSERT is the claim that
-- lets exactly one sweep, on whichever instance, act on it. See `specialistSweeps` in agent/lib/db/schema.ts. Additive:
-- a new table and nothing else.
--
-- DEPLOY ORDER: apply this BEFORE deploying the agent that writes it. Without the table the sweep claims nothing and so
-- does nothing (it fails closed: nothing is delivered or stopped unclaimed), and the chat shows no sweep notes.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "specialist_sweeps" (
	"org_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"call_id" text NOT NULL,
	"child_session_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"since" timestamp with time zone,
	"ended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_sweeps_pk" PRIMARY KEY("parent_session_id","call_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_sweeps_org_idx" ON "specialist_sweeps" USING btree ("org_id","status");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs rewrites
-- every org_isolation policy in one sweep).
ALTER TABLE "specialist_sweeps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_sweeps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "specialist_sweeps";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "specialist_sweeps"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "specialist_sweeps" TO app_rw;
  END IF;
END $$;
