-- The agent page's dock (mold_v0-292, flag nested_runs; src/agent-dock.ts): a workspace's results by program, newest first, read on
-- every poll of the dock's counts. An index only: nothing is written or changed, and with the flag off nothing reads it.

CREATE INDEX IF NOT EXISTS harness_children_program_idx ON harness_children (org_id, program_id, created_at DESC) WHERE program_id IS NOT NULL AND step_of IS NULL;
