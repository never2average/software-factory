CREATE TABLE "workflow_run_journal" (
	"run_id" text NOT NULL,
	"call_index" integer NOT NULL,
	"subagent" text,
	"prompt" text NOT NULL,
	"result" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_journal_run_id_call_index_pk" PRIMARY KEY("run_id","call_index")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"workflow_id" uuid,
	"workflow_name" text NOT NULL,
	"args" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status","updated_at");