-- The developer surface of an embedded app (mold_v0-193; src/developer-*.ts, molds/mold_v0/MOLD.md "Developer surface").
-- Only a build whose pack (or profile) declares `developer_surface` reads or writes these tables; in every other build
-- they stay empty. Every table is the platform's bookkeeping for one workspace (org_id): tenant work never reads or
-- writes them (row-level security on, the tenant role's grants revoked), the shell's developer modules do, each query
-- naming its workspace.
--
--   developer_keys            a workspace's API keys for its own servers: shown once (only the sha256 is kept), a
--                             visible prefix, scopes, an expiry, rotation (the old key lives on for a grace period)
--   developer_client_sessions short-lived tokens a workspace's backend mints with its key for one of its signed-in
--                             users, for browsers and phones (never a key in a client): narrow scopes, minutes to hours
--   developer_origins         the browser origins a workspace's client sessions may call the API from (CORS)
--   webhook_endpoints         where a workspace's events go: an address, the events it takes, its signing secret
--                             (Standard Webhooks, whsec_..., sealed with the workspace's data key), its state
--   webhook_deliveries        each event for each endpoint: the payload, the attempts, retries with backoff, the log
--   webhook_sources           a workspace's inbound receivers: a pack-declared mapping into one of its record areas,
--                             with a signing secret of their own (sealed)
--   idempotency_keys          a write's Idempotency-Key and its answer, replayed for the same request (24 hours)
--   developer_marks           the run-finished scan's watermark (platform, no workspace)

CREATE TABLE IF NOT EXISTS developer_keys (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('secret', 'integration')),
  scopes        TEXT[] NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  api_version   TEXT NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  rotated_from  BIGINT REFERENCES developer_keys (id) ON DELETE SET NULL,
  CHECK (kind <> 'integration' OR cardinality(scopes) = 1)
);
CREATE INDEX IF NOT EXISTS developer_keys_org_idx ON developer_keys (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS developer_client_sessions (
  id            TEXT PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key_id        BIGINT REFERENCES developer_keys (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  subject       TEXT NOT NULL,
  scopes        TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS developer_client_sessions_org_idx ON developer_client_sessions (org_id, expires_at);

CREATE TABLE IF NOT EXISTS developer_origins (
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  origin        TEXT NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, origin)
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                    TEXT PRIMARY KEY,
  org_id                INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  description           TEXT,
  events                TEXT[] NOT NULL DEFAULT '{}',
  secret_sealed         TEXT NOT NULL,
  previous_secret_sealed TEXT,
  previous_secret_until TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  disabled_reason       TEXT,
  failure_streak        INT NOT NULL DEFAULT 0,
  first_failure_at      TIMESTAMPTZ,
  secret_revealed_at    TIMESTAMPTZ,
  secret_revealed_by    TEXT,
  secret_reveals        INT NOT NULL DEFAULT 0,
  secret_rotated_at     TIMESTAMPTZ,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx ON webhook_endpoints (org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts        INT NOT NULL DEFAULT 0,
  attempt_log     JSONB NOT NULL DEFAULT '[]',
  next_attempt_at TIMESTAMPTZ,
  last_status     INT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (endpoint_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_sources (
  id               TEXT PRIMARY KEY,
  org_id           INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  receiver         TEXT NOT NULL,
  description      TEXT,
  secret_sealed    TEXT NOT NULL,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at      TIMESTAMPTZ,
  last_received_at TIMESTAMPTZ,
  received         INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS webhook_sources_org_idx ON webhook_sources (org_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  status_code   INT,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, idem_key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS developer_marks (
  name   TEXT PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL
);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['developer_keys', 'developer_client_sessions', 'developer_origins', 'webhook_endpoints',
                           'webhook_deliveries', 'webhook_sources', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
  EXECUTE format('REVOKE ALL ON developer_marks FROM %I', r);
END $mig$;
