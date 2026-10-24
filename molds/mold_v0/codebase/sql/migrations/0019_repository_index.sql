-- The upstream catalogs' index state (mold_v0-128; src/repository-index.ts, molds/mold_v0/MOLD.md "Upstream catalogs index
-- themselves"). One row per upstream_catalog repository of the build (pack, name): the pin last indexed whole and when,
-- the rows per area that index left, the last attempt and its error (shown on the admin console's Repositories page and
-- Health), and a short lease so that one instance indexes at a time (claimed under a transaction-level advisory lock,
-- which a transaction-pooling proxy keeps; the lease outlives the transaction while the fetch runs).
-- Platform state: no org_id, nothing granted to the tenant role (every query runs as the platform).
CREATE TABLE IF NOT EXISTS repository_index (
  pack             TEXT NOT NULL,
  name             TEXT NOT NULL,
  pin              TEXT,
  indexed_at       TIMESTAMPTZ,
  rows             JSONB NOT NULL DEFAULT '{}'::jsonb,
  report           JSONB,
  attempted_at     TIMESTAMPTZ,
  attempted_pin    TEXT,
  attempted_by     TEXT,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  lease_until      TIMESTAMPTZ,
  lease_owner      TEXT,
  PRIMARY KEY (pack, name)
);
