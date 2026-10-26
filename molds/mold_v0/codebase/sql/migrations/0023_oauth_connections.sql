-- Credential fields connected through OAuth (mold_v0-014; src/oauth-connections.ts, src/oauth-state.ts,
-- molds/mold_v0/MOLD.md "Credentials connected through OAuth"). A pack declares OAuth providers (pack.json
-- oauth_providers) and a credential field names one (`oauth`); a workspace's owner connects the field from the console,
-- the provider's tokens are kept sealed and refreshed before they expire, and a run receives the access token as it would
-- a pasted value.
--
--   oauth_states                  every sign-in in flight, of any kind (a GitHub App's install, an OAuth provider's
--                                 authorization): the sha256 of the signed state's one-time nonce, the workspace and person
--                                 it was made for, what it is for and what its return needs (the field's slot, the PKCE
--                                 verifier sealed with the workspace's data key), ten minutes, used once. Replaces
--                                 github_app_states (0021): an install in flight when this is applied is started again.
--   workspace_oauth_connections   one connection per field slot (workspace, pack, field, asset, environment): the provider's
--                                 tokens sealed with the workspace's data key and bound to the slot, when the access token
--                                 expires, its status (active, or needs_reconnect once the provider refused a refresh), who
--                                 connected it. Removing the row is the disconnect: nothing is sent from then on.
--   run_oauth_tokens              every access token a run received (sealed, with its sha256 to keep one row per token), so
--                                 everything the run writes is redacted of each of them, refreshed ones included.
--   vault_providers               oauth_clients: the platform's client ids and secrets for the packs' providers, by the
--                                 label each provider names (direct mode with no environment names: never a run's).
--
-- Tenant work has no access to any of them.

CREATE TABLE IF NOT EXISTS oauth_states (
  nonce_sha256  TEXT PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);
DROP TABLE IF EXISTS github_app_states;

CREATE TABLE IF NOT EXISTS workspace_oauth_connections (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack               TEXT NOT NULL,
  name               TEXT NOT NULL,
  bound_to           TEXT NOT NULL CHECK (bound_to IN ('workspace', 'asset', 'environment')),
  asset_area         TEXT,
  asset_key          TEXT,
  environment        TEXT,
  provider           TEXT NOT NULL,
  sealed             TEXT NOT NULL,                    -- base64 of sealBytes(...): never a token
  scopes             TEXT,
  access_expires_at  TIMESTAMPTZ,                      -- null: the provider gave no expiry
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  last_error         TEXT,
  connected_by       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at       TIMESTAMPTZ,
  CHECK ((bound_to = 'workspace') = (asset_key IS NULL)),
  CHECK ((bound_to = 'environment') = (environment IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_oauth_connections_slot_idx
  ON workspace_oauth_connections (org_id, pack, name, coalesce(asset_key, ''), coalesce(environment, ''));

CREATE TABLE IF NOT EXISTS run_oauth_tokens (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_sha256  TEXT NOT NULL,
  sealed        TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, token_sha256)
);

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('oauth_clients', 'direct', NULL, 'authorization', '', '{}')
ON CONFLICT (slug) DO NOTHING;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['oauth_states', 'workspace_oauth_connections', 'run_oauth_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
