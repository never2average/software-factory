-- Record-owned resources (mold_v0-282, flag record_resources; src/record-resources.ts, the only writer;
-- molds/mold_v0/MOLD.md "Record-owned resources"): a shared record's own database, created for it in Neon when the
-- record is created and deleted with it.
--   record_resources   one row per record and database field: its provider (neon), its status (provisioning, ready,
--                      failed with the reason), the provider's id of it (the Neon project), what is not secret about it
--                      (region, host, database, role) and its connection string, sealed with the key vault's master key
--                      (AES-256-GCM: ciphertext, iv, tag and the key's id, as vault_credentials keeps a key; re-sealed by
--                      src/keyvault.ts rekey). The connection string is never in the record's fields.
--   vault_providers    neon: direct mode (the server's own key, no gateway), never given to a session or a run;
--                      NEON_API_KEY on the server is imported into the vault once, as every provider's key is
--                      (src/keyvault-env.ts).
-- The platform's own table: no workspace reads or writes it (src/rls.ts NO_ACCESS), so it carries no org_id.

CREATE TABLE IF NOT EXISTS record_resources (
  id                 BIGSERIAL PRIMARY KEY,
  pack               TEXT NOT NULL,
  area               TEXT NOT NULL,
  record_key         TEXT NOT NULL,
  field              TEXT NOT NULL CHECK (field ~ '^[a-z][a-z0-9_]{0,62}$'),
  provider           TEXT NOT NULL CHECK (provider IN ('neon')),
  status             TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed')),
  reason             TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  external_id        TEXT CHECK (external_id IS NULL OR external_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  details            JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  secret_ciphertext  TEXT,
  secret_iv          TEXT,
  secret_tag         TEXT,
  secret_key_id      TEXT,
  attempts           INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at           TIMESTAMPTZ,
  UNIQUE (pack, area, record_key, field),
  -- A ready database has its project and its sealed connection string; a failed one says why.
  CHECK ((status = 'ready') = (secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL AND secret_tag IS NOT NULL AND secret_key_id IS NOT NULL)),
  CHECK (status <> 'ready' OR external_id IS NOT NULL),
  CHECK (status <> 'failed' OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS record_resources_status_idx ON record_resources (status, updated_at);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  -- Platform bookkeeping: no workspace's work reads it; the shell's code alone writes it.
  EXECUTE format('REVOKE ALL ON record_resources FROM %I', r);
  EXECUTE format('REVOKE ALL ON SEQUENCE record_resources_id_seq FROM %I', r);
END $mig$;

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('neon', 'direct', 'https://console.neon.tech/api/v2', 'authorization', 'Bearer ', '{NEON_API_KEY}')
ON CONFLICT (slug) DO NOTHING;
