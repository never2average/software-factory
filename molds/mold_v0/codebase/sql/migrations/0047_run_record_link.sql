-- A run started on a record carries the record (mold_v0-254; src/runs.ts startRun, src/record-page-routes.ts): the
-- record page's start_run action (a re-run of a build, a scan of an application) writes the area and the key of the
-- record it was started on, so the record's page lists its runs (its "runs" section). Before this, nothing tied a run
-- to a record but an asset target in `targets` (an asset area's record, the start tools' target_asset), which the page
-- reads too. Both NULL for a run started anywhere else (a tool, a schedule, a list's action, the developer API).
--   record_area   the record area's name (the build's; a record of the run's own workspace, or a shared one)
--   record_key    the record's key in that area
-- The workspace's own rows only, as every column of `runs`: the tenant role's SELECT on the table (0005) covers them.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS record_area TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS record_key TEXT;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_record_both;
ALTER TABLE runs ADD CONSTRAINT runs_record_both CHECK ((record_area IS NULL) = (record_key IS NULL));
-- A record's runs, newest first, inside its workspace.
CREATE INDEX IF NOT EXISTS runs_record_idx ON runs (org_id, record_area, record_key, created_at DESC) WHERE record_area IS NOT NULL;
