-- Health › Scheduled work's sparklines (mold_v0-293; src/health-samples.ts, web/src/features/admin/health-tabs.tsx): each
-- sample also keeps what the scheduled work had done by then (scheduler_jobs, 0037): the jobs this build runs, every
-- job's runs and failures so far (counters; the history turns them into differences, a counter that went down starting
-- again) and the jobs' average last duration. Numbers only, like the rest of the table (still closed to tenant work:
-- 0038's revoke covers every column). NULL: a sample taken before this migration.
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS scheduler_jobs INT CHECK (scheduler_jobs >= 0);
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS scheduler_runs BIGINT CHECK (scheduler_runs >= 0);
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS scheduler_failures BIGINT CHECK (scheduler_failures >= 0);
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS scheduler_ms INT CHECK (scheduler_ms >= 0);
