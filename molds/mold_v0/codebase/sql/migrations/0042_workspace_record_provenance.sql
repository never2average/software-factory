-- Who or what wrote each workspace row (mold_v0-236; src/record-areas.ts RecordWriter, writeRow). A shared row keeps its
-- provenance since mold_v0-221 (platform_records.source, upstream); a workspace row now does too, so the provenance a
-- record area's contract declares (docs/RECORDS.md in the factory) is read from the rows themselves, `run` included.
--
--   provenance   where the row came from: people (the workspace's people and their AI clients through the data API,
--                the console and the generated tools), staff (platform staff for the workspace: an admin_only tool),
--                intake (the company email's intake), run (the pack's own code: a run's commit hook, its tools and
--                routes) or repository (the area's repository's index; it also takes over a row it claims). NULL: a
--                row written before this migration, or one only the shell itself wrote.
--   written_by   "<kind>:<who>" of the row's first writer: a sign-in id, a staff pseudonym, the intake's message, a run's
--                id or the pack's tool or route, the repository's name. Never a value of the record.
--   updated_by   "<kind>:<who>" of the latest write, a move included ("shell:clock:<name>" for a clock's step).
--
-- Rows of every workspace, under the table's row-level security (0004): the tenant role's grants cover the new columns
-- and a workspace reads and writes only its own. Nothing is backfilled: what wrote an older row is not known.
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS provenance TEXT CHECK (provenance IN ('staff', 'people', 'repository', 'intake', 'run'));
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS written_by TEXT CHECK (length(written_by) <= 200);
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS updated_by TEXT CHECK (length(updated_by) <= 200);
