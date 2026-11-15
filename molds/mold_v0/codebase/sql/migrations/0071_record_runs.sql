-- Which run or agent session a workspace record's write happened in (mold_v0-310; src/record-runs.ts reads it, src/record-
-- areas.ts and src/record-history.ts write it). A write's writer ("<kind>:<who>": workspace_records.written_by and
-- updated_by since 0042, record_changes.by since 0049) already names a job run (run:run_<id>, and its workspace hook's
-- run:run:run_<id>) and a program's result (run:program:<program>:<handle>): those are linked from it, as they are. What
-- it cannot say is the workspace agent's session behind a person's write: an agent session acts as the person who started
-- it (people:<id>) or calls a pack's tool (run:tool:<name>). `via` says it, beside the writer, never instead of it:
--
--   via   "run:<run id>" of the agent session's wake whose tool call made the write (the run names its session:
--         runs.harness_session_id), NULL for every other write and every row written before this migration
--
--   workspace_records.written_via   the first write's, as written_by
--   workspace_records.updated_via   the latest write's, as updated_by
--   record_changes.via              the line's, as by
--
-- Nullable columns of tables the tenant role already reads and writes under row-level security (0004, 0049): no grant,
-- no policy. A run's or session's records are looked up by these columns and the writer columns, within a workspace.
-- Rollback: sql/rollback/0071_record_runs.sql.
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS written_via TEXT CHECK (length(written_via) <= 200);
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS updated_via TEXT CHECK (length(updated_via) <= 200);
ALTER TABLE record_changes ADD COLUMN IF NOT EXISTS via TEXT CHECK (length(via) <= 200);

-- A run's or session's records, inside its workspace: only the rows a run or a session wrote are indexed.
CREATE INDEX IF NOT EXISTS workspace_records_written_run_idx ON workspace_records (org_id, written_by text_pattern_ops) WHERE written_by LIKE 'run:%';
CREATE INDEX IF NOT EXISTS workspace_records_updated_run_idx ON workspace_records (org_id, updated_by text_pattern_ops) WHERE updated_by LIKE 'run:%';
CREATE INDEX IF NOT EXISTS workspace_records_via_idx ON workspace_records (org_id, updated_via) WHERE updated_via IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_records_written_via_idx ON workspace_records (org_id, written_via) WHERE written_via IS NOT NULL;
CREATE INDEX IF NOT EXISTS record_changes_run_idx ON record_changes (org_id, by text_pattern_ops) WHERE by LIKE 'run:%';
CREATE INDEX IF NOT EXISTS record_changes_via_idx ON record_changes (org_id, via) WHERE via IS NOT NULL;
