-- Dictation usage beside chat usage (lib/dictation.ts, app/api/ops/dictation): each clip the chat composer's
-- microphone turns into prompt text is one `chat_turn_usage` row of kind 'dictation', filed under the workspace and
-- person who recorded it, with the audio's length in milliseconds. The read API (GET /api/ops/usage) prices it from
-- lib/inference-pricing.ts per audio minute, as it prices a chat turn's tokens. No audio is stored anywhere.
--
-- Two columns with defaults on a table that already carries the workspace boundary (org_id, row-level security
-- ENABLED and FORCED, the org_isolation policy): a column inherits the table's policy, so who may read or write a row
-- does not change and no policy is touched. Every existing row reads kind 'chat', audio_ms 0, which is what it is.
-- Additive: no row is rewritten by hand, nothing else is altered or dropped.
--
-- DEPLOY ORDER: apply this BEFORE deploying the web app that reads and writes the columns (the factory's deploy runs
-- the journal first). Idempotent (IF NOT EXISTS). Applied by `npm run db:migrate:production`
-- (scripts/migrate-production.mjs).
ALTER TABLE "chat_turn_usage" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_turn_usage" ADD COLUMN IF NOT EXISTS "audio_ms" bigint DEFAULT 0 NOT NULL;
