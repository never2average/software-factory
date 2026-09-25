-- The browser-made markers a chat must carry to every device and every open (lib/chat-turn-state.ts
-- `isPersistedMarker`): `client.turn.stopped` (a Stop — on a parked specialist's question it produces NO eve
-- event at all) and `client.input.responded` (an answered question). They used to live only in this browser's
-- cache and in the transcript snapshot, so a Stop was forgotten wherever neither existed: the question came back
-- live and the specialist's tile back to "Running".
-- NULLABLE with no default: NULL reads as "no markers", adding the column rewrites no row and takes the table
-- lock only for the instant of the ALTER, and code that predates it never names it. IF NOT EXISTS makes a re-run
-- harmless. No policy changes: org_isolation on chat_sessions is row-level and covers every column.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "client_markers" jsonb;
