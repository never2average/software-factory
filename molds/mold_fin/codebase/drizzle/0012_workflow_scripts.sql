ALTER TABLE "workflow_instruction_versions" ADD COLUMN "kind" text DEFAULT 'instructions' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "script" text;