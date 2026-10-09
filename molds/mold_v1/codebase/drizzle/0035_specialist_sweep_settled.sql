-- The delegations the specialist sweep has nothing more to do with (agent/lib/sweep-ledger.ts `sweepCandidates`,
-- `markSettled`; mold_v1-199). One row per (workspace, main thread, child session) whose call the sweep saw settled
-- on the main thread's own stream; the scheduled sweep reads only main threads with a child that has no row here. See
-- `specialistSweepSettled` in agent/lib/db/schema.ts. Additive: a new table and nothing else.
--
-- DEPLOY ORDER: apply this BEFORE deploying the agent that reads it. Without the table the sweep falls back to reading
-- every main thread that delegated within its window, as before (slow, never wrong). Applied by
-- `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "specialist_sweep_settled" (
	"org_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"child_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_sweep_settled_pk" PRIMARY KEY("org_id","parent_session_id","child_session_id")
);
--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs rewrites
-- every org_isolation policy in one sweep).
ALTER TABLE "specialist_sweep_settled" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_sweep_settled" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "specialist_sweep_settled";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "specialist_sweep_settled"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "specialist_sweep_settled" TO app_rw;
  END IF;
END $$;
