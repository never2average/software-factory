-- Which workspace (and person) an agent session belongs to, so a subagent's child session — which eve runs with
-- no identity at all — can resolve the workspace of the root session that delegated to it instead of falling
-- back to the default workspace (and having its writes refused by RLS). See agent/lib/session-scope.ts.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "agent_session_scopes" (
	"session_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_scopes_org_idx" ON "agent_session_scopes" USING btree ("org_id","updated_at");--> statement-breakpoint

-- Same tenant boundary as every other org-scoped table (fail-open form here; .migrate-rls-fail-closed.mjs
-- rewrites every org_isolation policy in one sweep, this one included). The lookup is by an unguessable
-- session id and sweeps the workspaces, each inside its own scope — it never reads unscoped.
ALTER TABLE "agent_session_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_session_scopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "agent_session_scopes";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "agent_session_scopes"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_session_scopes" TO app_rw;
  END IF;
END $$;
