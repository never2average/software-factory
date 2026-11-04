-- Record files from the mail intake (mold_v0-220; src/email-intake.ts, src/record-files.ts): a message's body and
-- attachments kept as files on its record (email.intake.fields.body_file and attachment_files), and a one-off backfill
-- for messages taken in before that.
--
--   workspace_email_messages.files        what the ledger row's record holds of the message as files: 'kept' (taken in
--                                         with them), 'backfilled' (read again from its mailbox and kept), 'not_found'
--                                         (the backfill's window no longer held it: never looked for again). NULL: taken
--                                         in before this migration, or by an intake that keeps no files (the backfill
--                                         looks for these once an intake does).
--   workspace_email_inboxes.files_backfill_at   the backfill's claim on a mailbox (30 minutes; two pollers never read one
--                                         at once), NULL until it first ran.
--
-- No value of a message is held here: the files are sealed objects in the workspace's store, named by the record. Like
-- the rest of the two tables, closed to tenant work (0034's revoke covers every column).
ALTER TABLE workspace_email_messages ADD COLUMN IF NOT EXISTS files TEXT CHECK (files IN ('kept', 'backfilled', 'not_found'));
ALTER TABLE workspace_email_inboxes ADD COLUMN IF NOT EXISTS files_backfill_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS workspace_email_messages_files_waiting ON workspace_email_messages (org_id, inbox_id) WHERE files IS NULL;
