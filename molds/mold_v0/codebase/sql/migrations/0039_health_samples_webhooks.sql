-- Health › Status's webhook graph (mold_v0-215; src/health-samples.ts, web/src/features/admin/health-tabs.tsx): webhooks
-- got their own Health tab (Webhook Delivery) and their own failure-rate graph, apart from email's. Each sample now
-- counts the webhook deliveries settled (succeeded or failed) in its window and those that failed; deliveries_total and
-- deliveries_failed count emails only from here on. NULL: the app has no developer surface (no webhooks).
--
-- Samples taken before this migration in an app with a developer surface counted both in deliveries_*; they age out
-- with the 35-day retention. Numbers only, like the rest of the table (still closed to tenant work: 0038's revoke
-- covers every column).
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS webhooks_total INT CHECK (webhooks_total >= 0);
ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS webhooks_failed INT CHECK (webhooks_failed >= 0);
