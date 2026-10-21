-- A run result's identity includes its finding fingerprint (mold_v0-065; src/runs.ts checkResults): several findings on
-- one check x asset x source stay separate rows when their fingerprints differ. A result without a fingerprint keeps
-- the old identity (check x asset x source), so a run listing the same triple twice without telling the findings apart
-- is still refused. No new table: run_results keeps its row-level security (0005).
DROP INDEX IF EXISTS run_results_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS run_results_identity_idx ON run_results (run_id, check_area, check_key, coalesce(asset_area, ''), coalesce(asset_key, ''),
  coalesce(source_area, ''), coalesce(source_key, ''), coalesce(finding_fingerprint, ''));
