-- The built-in MCP authorization server (mold_v0-013; src/mcp-oauth.ts). With built-in sign-in (AUTH_PROVIDER=builtin)
-- this server is its own OAuth 2.1 authorization server for /mcp, so connector apps that can only sign in (Claude,
-- ChatGPT, VS Code) reach apps without Clerk. With Clerk these tables stay empty: Clerk's OAuth is unchanged.
--
--   oauth_clients   a registered client: dynamic client registration (RFC 7591, kind 'dcr', a random id) or a client ID
--                   metadata document (kind 'cimd', the id is the document's https URL; the row is a cache of it). Only
--                   the sha256 of a confidential client's secret is kept
--   oauth_requests  an authorization request waiting for the person's consent: ten minutes, used once (the id is a
--                   random value; only its sha256 is kept)
--   oauth_grants    what a person allowed: one client, one workspace (org_id), one resource (the token audience), the scope
--   oauth_codes     an authorization code (its sha256), with the PKCE challenge and the redirect URI it was issued for:
--                   two minutes, used once; a second use revokes the grant
--   oauth_tokens    access tokens (short-lived) and refresh tokens (rotated: each is used once; a replay revokes the
--                   grant), only their sha256
--
-- None is open to the tenant role (sql/migrations/0003 grants nothing on them): every query runs as the platform.
-- oauth_grants carries org_id, so it is a workspace table to the row-level-security check (src/rls.ts): RLS on, no policy.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  name          TEXT,
  redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
  auth_method   TEXT NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_clients_ip_idx ON oauth_clients (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_requests (
  id_hash        TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  state          TEXT,
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  resource    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  revoked_why TEXT
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_org_idx ON oauth_grants (org_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);

ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
