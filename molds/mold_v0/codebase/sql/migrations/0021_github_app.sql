-- Repository access by a GitHub App per workspace (mold_v0-014; src/github-app.ts, src/github-app-routes.ts,
-- molds/mold_v0/MOLD.md "Repository access by a GitHub App"). A pack's credential field may say `github_app: true`: when
-- the platform holds a GitHub App (key vault provider github_app) and a workspace has connected an installation of it,
-- the runs that receive that field get a short-lived installation token instead of a pasted one.
--
--   workspace_github_installations  one installation of the platform's app connected to one workspace: GitHub's
--                                   installation id (at most one live workspace per installation, and one live
--                                   installation per workspace), the account it is on, the repositories it was given
--                                   (kept current by the app's webhook), the repositories an owner narrowed each asset
--                                   record to, and when and why it ended (uninstalled, suspended, disconnected,
--                                   the workspace removed). Ended rows stay for the audit trail until the workspace goes.
--   github_app_states               an install in flight: the sha256 of the one-time nonce of the signed state the
--                                   install redirect carries, the workspace and person it was made for, ten minutes,
--                                   used once.
--   run_github_app_tokens           every installation token minted for a run: sealed with the workspace's data key
--                                   (never the value in clear), the repositories and permission it was scoped to, when
--                                   it expires, when the platform revoked it and when GitHub confirmed the revocation.
--                                   Kept so everything the run writes can be redacted of each one.
--   vault_providers                 github_app: where the platform's operators keep the app's id, keys and secrets
--                                   (direct mode with no environment names, so no session or run is ever handed them).
--
-- Tenant work has no access to any of them (the shell's own code reads and writes them, with the workspace taken from
-- the caller's session, the signed state or the run row, never from input).

CREATE TABLE IF NOT EXISTS workspace_github_installations (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  installation_id       BIGINT NOT NULL,
  account_login         TEXT NOT NULL,
  account_type          TEXT NOT NULL DEFAULT 'Organization',
  repository_selection  TEXT NOT NULL DEFAULT 'selected' CHECK (repository_selection IN ('all', 'selected')),
  repositories          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{id, full_name}]
  asset_repositories    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"<area>/<key>": ["owner/name", ...]}
  suspended_at          TIMESTAMPTZ,
  connected_by          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at            TIMESTAMPTZ,
  removed_reason        TEXT CHECK (removed_reason IN ('uninstalled', 'disconnected', 'workspace_removed', 'revoked_by_staff'))
);
-- An installation serves at most one workspace at a time, and a workspace has at most one live installation.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_github_installations_live_idx ON workspace_github_installations (installation_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_github_installations_org_idx ON workspace_github_installations (org_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS github_app_states (
  nonce_sha256  TEXT PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS github_app_states_expiry_idx ON github_app_states (expires_at);

CREATE TABLE IF NOT EXISTS run_github_app_tokens (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  org_id             INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  installation_id    BIGINT NOT NULL,
  name               TEXT NOT NULL,                    -- the credential field it was delivered as
  scope_key          TEXT NOT NULL DEFAULT '',          -- the asset ("<area>/<key>") it was narrowed for, '' for none
  sealed             TEXT NOT NULL,                    -- base64 of sealBytes(...): never the token
  repositories       JSONB NOT NULL DEFAULT '[]'::jsonb,
  permissions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  github_revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS run_github_app_tokens_run_idx ON run_github_app_tokens (run_id, name);
CREATE INDEX IF NOT EXISTS run_github_app_tokens_pending_idx ON run_github_app_tokens (revoked_at) WHERE github_revoked_at IS NULL;

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('github_app', 'direct', NULL, 'authorization', '', '{}')
ON CONFLICT (slug) DO NOTHING;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_github_installations', 'github_app_states', 'run_github_app_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    -- No access for tenant work, not even its own rows: a pack's code never sees an installation, a state or a token.
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
