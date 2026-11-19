-- A log drain's silence (mold_v0-325; src/log-drain-health.ts): when the drain's health check last found a log-drain
-- source silent (no delivery for its receiver's `silent_hours` while the drain is set up), set once per silence so the
-- check never repeats itself; a delivery clears it (src/developer-inbound.ts touch). A new nullable column only: every
-- existing row reads as not silent. Rollback: sql/rollback/0074_log_drain_silence.sql.
ALTER TABLE webhook_sources ADD COLUMN IF NOT EXISTS silent_since TIMESTAMPTZ;
