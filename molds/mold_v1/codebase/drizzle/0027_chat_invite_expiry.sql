-- When an UNOPENED chat invite lapses (lib/guest-invite-rules.ts). A chat shared with someone outside its workspace
-- makes them a read-only guest of that one chat; an invite nobody opens within 14 days of being sent (or sent again)
-- expires, as a workspace invite does. The members route stamps it on every share from now on.
--
-- EXISTING ROWS ARE LEFT NULL, AND A NULL NEVER EXPIRES. The operator decided to let the pending invites stand: a clock
-- started from invited_at would cut off, on deploy, every invite already older than two weeks. Opening an invite
-- (any read of the chat, or signing in from its link) makes it 'accepted', which does not expire either.
--
-- Idempotent (IF NOT EXISTS). Applied by `npm run db:migrate:production` before the deploy's code reads the column.
ALTER TABLE "chat_thread_members" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
