-- The record an agent session made (mold_v0-333; src/session-records.ts): a record's Cancel finds the session that made
-- it, and a Cancel or a time limit the session's link to its children, by the record (policy.creates.area and key, the
-- session's frozen policy). An expression index only, partial to the sessions that made a record: nothing else changes.
-- Rollback: sql/rollback/0076_session_created_records.sql.
CREATE INDEX IF NOT EXISTS harness_sessions_created_record_idx
  ON harness_sessions (org_id, (policy->'creates'->>'area'), (policy->'creates'->>'key'))
  WHERE policy ? 'creates';
