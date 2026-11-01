-- A run that did not write a required output of its kind (mold_v0-188; src/required-outputs.ts): it fails with
-- error_kind 'output_missing', beside 'infrastructure', 'run', 'validation', 'timeout' and 'cancelled'. No status is
-- added: such a run is 'failed' for every reader, its cost counted as a failed run's (0014_run_charges.sql charges it
-- as price.on_failure says, never as an infrastructure failure).

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_error_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_error_kind_check
  CHECK (error_kind IN ('infrastructure', 'run', 'validation', 'timeout', 'cancelled', 'output_missing'));
