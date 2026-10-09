-- Who OWNS an agent session, recorded by the agent when the session is created — the record the agent's session
-- guard (agent/lib/session-guard.ts) checks before eve's per-session routes (message, approval, stream, cancel) run
-- for ANY caller. See `agentSessionOwners` in agent/lib/db/schema.ts for why neither agent_session_scopes (its
-- principal is rewritten every turn) nor the web's chat_sessions/chat_threads (caller-written) can answer this.
--
-- DEPLOY ORDER: apply this BEFORE deploying the agent that reads it. The guard fails CLOSED (503) when it cannot
-- read ownership, so an agent deployed first answers 503 on every per-session route until this exists.
--
-- Numbered 0022 so it does not collide with 0021_chat_queue_and_push (PR #63); either may merge first.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "agent_session_owners" (
	"session_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_email" text,
	"owner_principal" text,
	"owner_kind" text NOT NULL,
	"visibility" text DEFAULT 'owner' NOT NULL,
	"root_session_id" text,
	"parent_session_id" text,
	"token_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_owners_org_owner_idx" ON "agent_session_owners" USING btree ("org_id","owner_email");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs rewrites
-- every org_isolation policy in one sweep). Lookups are by an unguessable session id and sweep the workspaces, each
-- inside its own scope — never unscoped.
ALTER TABLE "agent_session_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_session_owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "agent_session_owners";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_session_owners"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_session_owners" TO app_rw;
  END IF;
END $$;
