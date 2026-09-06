CREATE TABLE IF NOT EXISTS "account_summaries" (
	"org_id" text,
	"key" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_configs" (
	"org_id" text DEFAULT 'org-onfinance' NOT NULL,
	"agent_key" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"instructions" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_configs_org_id_agent_key_pk" PRIMARY KEY("org_id","agent_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'org-onfinance' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"persona_name" text,
	"tone" text,
	"instructions" text,
	"default_mode" text,
	"web_search_default" boolean,
	"browser_default" boolean,
	"model" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"instructions" text,
	"actor" text NOT NULL,
	"kind" text DEFAULT 'edit' NOT NULL,
	"restored_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_versions" (
	"org_id" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"content_md" text,
	"error" text,
	"run_id" text,
	"session_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_kind" text DEFAULT 'prompt' NOT NULL,
	"workflow" text,
	"prompt" text,
	"subagent" text,
	"customer_id" text,
	"refresh_cron" text,
	"content_md" text,
	"content_updated_at" timestamp with time zone,
	"last_run_id" text,
	"last_session_id" text,
	"last_error" text,
	"refreshing_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_allowlist" (
	"org_id" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text,
	"origin" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"created_by" text NOT NULL,
	"provider" text NOT NULL,
	"provider_context_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_credentials" (
	"org_id" text NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"site_origin" text NOT NULL,
	"username" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"secret_hint" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_credentials_org_id_customer_id_site_origin_pk" PRIMARY KEY("org_id","customer_id","site_origin")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_sessions" (
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"capability_key_version" integer DEFAULT 1 NOT NULL,
	"connect_url_ciphertext" text NOT NULL,
	"connect_url_iv" text NOT NULL,
	"connect_url_tag" text NOT NULL,
	"live_view_url_ciphertext" text,
	"live_view_url_iv" text,
	"live_view_url_tag" text,
	"eve_session_id" text,
	"customer_id" text,
	"context_scope" text DEFAULT 'principal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"release_attempts" integer DEFAULT 0 NOT NULL,
	"release_error" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Existing browser tables were originally provisioned by idempotent scripts,
-- so CREATE TABLE IF NOT EXISTS above deliberately coexists with an in-place
-- hardening path. Persisted CDP/live-view URLs are bearer capabilities: expire
-- the old ephemeral rows instead of attempting to preserve plaintext secrets.
ALTER TABLE "browser_allowlist" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
UPDATE "browser_allowlist" SET "org_id" = 'org-onfinance' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "browser_allowlist" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "browser_credentials" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
UPDATE "browser_credentials" SET "org_id" = 'org-onfinance' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "browser_credentials" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
DO $$
DECLARE existing_pk text;
BEGIN
  SELECT conname INTO existing_pk
    FROM pg_constraint
   WHERE conrelid = 'public.browser_credentials'::regclass AND contype = 'p'
   LIMIT 1;
  IF existing_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE browser_credentials DROP CONSTRAINT %I', existing_pk);
  END IF;
  ALTER TABLE "browser_credentials"
    ADD CONSTRAINT "browser_credentials_org_id_customer_id_site_origin_pk"
    PRIMARY KEY ("org_id", "customer_id", "site_origin");
END $$;--> statement-breakpoint

ALTER TABLE "browser_contexts" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "browser_contexts" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "browser_contexts" ADD COLUMN IF NOT EXISTS "scope_type" text;--> statement-breakpoint
ALTER TABLE "browser_contexts" ADD COLUMN IF NOT EXISTS "scope_key" text;--> statement-breakpoint
ALTER TABLE "browser_contexts" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
UPDATE "browser_contexts"
   SET "id" = COALESCE("id", gen_random_uuid()),
       "org_id" = COALESCE("org_id", 'org-onfinance'),
       "scope_type" = COALESCE("scope_type", 'team'),
       "scope_key" = COALESCE("scope_key", 'team'),
       "created_by" = COALESCE("created_by", 'migration:legacy-team-context');--> statement-breakpoint
ALTER TABLE "browser_contexts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_contexts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_contexts" ALTER COLUMN "scope_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_contexts" ALTER COLUMN "scope_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_contexts" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
DO $$
DECLARE existing_pk text;
BEGIN
  SELECT conname INTO existing_pk
    FROM pg_constraint
   WHERE conrelid = 'public.browser_contexts'::regclass AND contype = 'p'
   LIMIT 1;
  IF existing_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE browser_contexts DROP CONSTRAINT %I', existing_pk);
  END IF;
  ALTER TABLE "browser_contexts"
    ADD CONSTRAINT "browser_contexts_id_pk" PRIMARY KEY ("id");
END $$;--> statement-breakpoint

ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "principal_id" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "capability_key_version" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "connect_url_ciphertext" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "connect_url_iv" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "connect_url_tag" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "live_view_url_ciphertext" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "live_view_url_iv" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "live_view_url_tag" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "context_scope" text DEFAULT 'principal';--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "release_attempts" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "release_error" text;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
DELETE FROM "browser_sessions";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN IF EXISTS "connect_url";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN IF EXISTS "live_view_url";--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "capability_key_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "connect_url_ciphertext" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "connect_url_iv" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "connect_url_tag" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "context_scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "release_attempts" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "browser_allowlist_lookup_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "browser_sessions_eve_idx";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_presence" (
	"org_id" text,
	"thread_id" uuid NOT NULL,
	"email" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"typing_until" timestamp with time zone,
	CONSTRAINT "chat_presence_thread_id_email_pk" PRIMARY KEY("thread_id","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'org-onfinance' NOT NULL,
	"owner_email" text NOT NULL,
	"client_key" text,
	"title" text,
	"preview" text,
	"message_count" integer,
	"customers" jsonb,
	"forked_from" jsonb,
	"eve_session_id" text,
	"continuation_token" text,
	"derived_customers" jsonb,
	"tool_counts" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_thread_members" (
	"org_id" text,
	"thread_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "chat_thread_members_thread_id_email_pk" PRIMARY KEY("thread_id","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_threads" (
	"org_id" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_key" text,
	"eve_session_id" text NOT NULL,
	"title" text NOT NULL,
	"preview" text,
	"customers" jsonb,
	"forked_from" jsonb,
	"owner_email" text NOT NULL,
	"continuation_token" text,
	"turn_holder" text,
	"turn_claimed_at" timestamp with time zone,
	"client_events" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_turn_authors" (
	"org_id" text,
	"thread_id" uuid NOT NULL,
	"event_offset" integer NOT NULL,
	"author_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_turn_authors_thread_id_event_offset_pk" PRIMARY KEY("thread_id","event_offset")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"state" text DEFAULT 'planning' NOT NULL,
	"goal" text,
	"lead" text,
	"capacity" integer,
	"created_by" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataroom_changesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"label" text NOT NULL,
	"actor" text NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"rationale" text,
	"unattended" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"reverted_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataroom_file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"changeset_id" uuid,
	"path" text NOT NULL,
	"action" text NOT NULL,
	"prev_blob_key" text,
	"prev_bytes" integer,
	"new_bytes" integer,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_email_pk" PRIMARY KEY("org_id","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orgs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"google_hosted_domain" text,
	"branding" jsonb,
	"plan" text,
	"limits" jsonb,
	"billing" jsonb,
	"blob_prefix" text,
	"data_residency" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_google_hosted_domain_unique" UNIQUE("google_hosted_domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people_roster" (
	"email" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"name" text,
	"team" text,
	"manager_email" text,
	"escalations" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_admins" (
	"email" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"entity" text NOT NULL,
	"stages" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"slug" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text,
	"satisfies_check" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_presence" (
	"org_id" text DEFAULT 'org-onfinance' NOT NULL,
	"room" text NOT NULL,
	"email" text NOT NULL,
	"activity" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_presence_org_id_room_email_pk" PRIMARY KEY("org_id","room","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subagent_runs" (
	"org_id" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"session_id" text,
	"subagent_type" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subagent_runs_run_key_unique" UNIQUE("run_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_workflow_instances" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"automation_state" text DEFAULT 'idle' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_workflow_transition_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"from_stage_id" text,
	"to_stage_id" text NOT NULL,
	"trigger" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"cycle_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"container_type" text,
	"container_id" text,
	"container_label" text,
	"link_type" text,
	"link_id" text,
	"link_label" text,
	"created_by" text NOT NULL,
	"assignee" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text DEFAULT 'org-onfinance' NOT NULL,
	"name" text NOT NULL,
	"entity" text NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "current_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_audit" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "connector_secrets" ADD COLUMN IF NOT EXISTS "org_id" text DEFAULT 'org-onfinance' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_secrets" ADD COLUMN IF NOT EXISTS "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "endpoint_url" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "required_secrets" jsonb;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "auth_secret_name" text;--> statement-breakpoint
ALTER TABLE "customer_stakeholders" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "implementation" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "implementation" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "internal_staff" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "platform" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD COLUMN IF NOT EXISTS "workflow" text;--> statement-breakpoint
ALTER TABLE "solutions" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "workflow_instruction_versions" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ADD COLUMN IF NOT EXISTS "org_id" text DEFAULT 'org-onfinance' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ADD COLUMN IF NOT EXISTS "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ADD COLUMN IF NOT EXISTS "lease_token" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ADD COLUMN IF NOT EXISTS "child_session_id" text;--> statement-breakpoint
UPDATE "workflow_run_journal" SET "org_id" = 'org-onfinance' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ALTER COLUMN "org_id" SET DEFAULT 'org-onfinance';--> statement-breakpoint
ALTER TABLE "workflow_run_journal" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_journal" DROP CONSTRAINT IF EXISTS "workflow_run_journal_run_id_call_index_pk";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.workflow_run_journal'::regclass
       AND conname = 'workflow_run_journal_run_id_attempt_call_index_pk'
  ) THEN
    ALTER TABLE "workflow_run_journal"
      ADD CONSTRAINT "workflow_run_journal_run_id_attempt_call_index_pk"
      PRIMARY KEY ("run_id", "attempt", "call_index");
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "org_id" text DEFAULT 'org-onfinance' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "lease_token" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "worker_id" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancel_requested_by" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "workflow_runs" SET "org_id" = 'org-onfinance' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "org_id" SET DEFAULT 'org-onfinance';--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.task_workflow_instances'::regclass
       AND conname = 'task_workflow_instances_task_id_todos_id_fk'
  ) THEN
    ALTER TABLE "task_workflow_instances"
      ADD CONSTRAINT "task_workflow_instances_task_id_todos_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "public"."todos"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_profiles_org_email_idx" ON "agent_profiles" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_prompt_versions_lookup_idx" ON "agent_prompt_versions" USING btree ("org_id","agent_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_versions_app_id_idx" ON "app_versions" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_slug_idx" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_customer_id_idx" ON "apps" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_allowlist_lookup_idx" ON "browser_allowlist" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_contexts_scope_uidx" ON "browser_contexts" USING btree ("org_id","customer_id","scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_contexts_org_idx" ON "browser_contexts" USING btree ("org_id","last_used_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_sessions_eve_idx" ON "browser_sessions" USING btree ("org_id","principal_id","eve_session_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_sessions_sweep_idx" ON "browser_sessions" USING btree ("status","last_used_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sessions_owner_idx" ON "chat_sessions" USING btree ("owner_email","org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_thread_members_email_idx" ON "chat_thread_members" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_owner_idx" ON "chat_threads" USING btree ("owner_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_session_idx" ON "chat_threads" USING btree ("eve_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_lookup_idx" ON "comments" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataroom_changesets_org_idx" ON "dataroom_changesets" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataroom_file_versions_changeset_idx" ON "dataroom_file_versions" USING btree ("changeset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataroom_file_versions_path_idx" ON "dataroom_file_versions" USING btree ("org_id","path","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_activity_lookup_idx" ON "entity_activity" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invites_org_idx" ON "org_invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invites_token_idx" ON "org_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_email_idx" ON "org_members" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_workflow_versions_number_idx" ON "project_workflow_versions" USING btree ("org_id","workflow_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_workflow_versions_workflow_idx" ON "project_workflow_versions" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipes_org_slug_idx" ON "recipes" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_workflow_instances_org_stage_idx" ON "task_workflow_instances" USING btree ("org_id","workflow_id","stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_workflow_instances_version_idx" ON "task_workflow_instances" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_workflow_events_task_idx" ON "task_workflow_transition_events" USING btree ("org_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_workflow_events_idempotency_idx" ON "task_workflow_transition_events" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_done_idx" ON "todos" USING btree ("done");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_status_idx" ON "todos" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_assignee_idx" ON "todos" USING btree ("assignee");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_container_idx" ON "todos" USING btree ("container_type","container_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_definitions_org_idx" ON "workflow_definitions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_journal_run_call_idx" ON "workflow_run_journal" USING btree ("run_id","call_index","attempt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_lease_idx" ON "workflow_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint

-- The standalone task-workflow service and Eve API use the same tenant
-- boundary. Keep the database backstop active even when a caller forgets an
-- application predicate.
ALTER TABLE "project_workflow_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_workflow_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "project_workflow_versions";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "project_workflow_versions"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE "task_workflow_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_workflow_instances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "task_workflow_instances";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "task_workflow_instances"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE "task_workflow_transition_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_workflow_transition_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "task_workflow_transition_events";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "task_workflow_transition_events"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "workflow_definitions",
      "project_workflow_versions",
      "task_workflow_instances",
      "task_workflow_transition_events"
    TO app_rw;
  END IF;
END $$;
