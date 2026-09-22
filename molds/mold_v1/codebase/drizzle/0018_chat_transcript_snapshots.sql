-- Reopening an old chat re-read the WHOLE eve event stream and re-reduced it client-side, so the cost of opening
-- a conversation grew with everything that had ever happened in it — and eve's stream is a live tail that never
-- ends for a parked run, so the browser also sat out a quiet window per segment deciding the backlog had drained.
-- This table is the transcript a thread has already been shown, plus the ABSOLUTE stream index it covers, so an
-- open mounts the prefix and replays only from that index forward. It is a CACHE: lib/chat-snapshot.ts refuses a
-- row on a version bump, a different session, or a seam the stream disagrees with, and the old full replay runs.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "chat_transcript_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"owner_email" text NOT NULL,
	"chat_session_id" text,
	"version" integer NOT NULL,
	"event_index" integer NOT NULL,
	"events" jsonb NOT NULL,
	"client_events" jsonb,
	"bytes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One transcript per session per workspace, and the ON CONFLICT target the upsert names.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_transcript_snapshots_session_uidx" ON "chat_transcript_snapshots" USING btree ("org_id","eve_session_id");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table. The policy is the fail-open form the rest of the schema
-- ships with; .migrate-rls-fail-closed.mjs rewrites every org_isolation policy in one sweep, this one included,
-- because it discovers scoped tables from information_schema. Access to a row is decided ON TOP of this, by
-- thread membership (snapshotAccess, lib/chat-snapshot.ts) — RLS keeps another WORKSPACE out, membership keeps a
-- colleague the thread was never shared with out.
ALTER TABLE "chat_transcript_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_transcript_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "chat_transcript_snapshots";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_transcript_snapshots"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_transcript_snapshots" TO app_rw;
  END IF;
END $$;--> statement-breakpoint

-- The sidebar's own query had no index that matched it: GET /api/ops/threads runs
-- `owner_email = … AND org_id = … AND archived_at IS NULL ORDER BY updated_at DESC` every 20 seconds per tab,
-- and it is phase 1 of opening a chat. chat_threads_owner_idx covers only the first column. Creating an index
-- touches no policy. CONCURRENTLY is not used: this runs inside the migration transaction, and the table holds
-- one row per SHARED thread (tens, not millions), so the lock is momentary.
CREATE INDEX IF NOT EXISTS "chat_threads_org_owner_updated_idx" ON "chat_threads" USING btree ("org_id","owner_email","updated_at" DESC);
