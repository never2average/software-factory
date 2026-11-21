-- Records moved by the runs started on them, and reminders about runs (mold_v0-334; src/record-outcomes.ts and
-- src/run-reminders.ts, the only writers of what this adds). New nullable or defaulted columns and a wider check only:
-- every existing row reads as before. (Before it merged, this file was named 0075_run_reminders on its branch; no
-- preview or live deploy ran that branch, so no database recorded the old name.)
--   harness_sessions.record_action    the page action (its id) a person started this root session with on its record
--                                      (record_area, record_key); only such a session's outcomes move the record
--   harness_sessions.record_outcomes  the outcomes already applied to its record (each once, never again)
--   harness_sessions.record_swept_at  when the sweep took in this session's end (each end once; a continued session
--                                      is taken in again when it ends next)
--   harness_sessions.record_moved_at  when this session last moved its record (a later move of the record by anyone
--                                      else stands against this session's outcomes)
--   workspace_notices.kind 'run'      an in-app notice about one of the workspace's runs whose result waits: on a staff
--                                      review (area run_review) or to be applied (run_apply); record_key the run's root
--                                      session, due_on the day; one a run and day
-- Rollback: sql/rollback/0075_record_outcomes.sql.
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_action TEXT CHECK (record_action IS NULL OR length(record_action) BETWEEN 1 AND 200);
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_outcomes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_swept_at TIMESTAMPTZ;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_moved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS harness_sessions_record_action_idx ON harness_sessions (org_id, record_area, record_key, created_at DESC) WHERE record_action IS NOT NULL;
ALTER TABLE workspace_notices DROP CONSTRAINT IF EXISTS workspace_notices_kind_check;
ALTER TABLE workspace_notices ADD CONSTRAINT workspace_notices_kind_check CHECK (kind IN ('due', 'clock', 'run'));
