-- Built-in sign-in (mold_v0-004; src/builtin-auth.ts, src/people.ts, molds/mold_v0/MOLD.md "Sign-in"). With
-- AUTH_PROVIDER=builtin (the default when no Clerk key is set) the shell is its own system of record for people: an
-- emailed one-time code or Google signs a person in, a session lives here, and workspaces, members, roles and
-- invitations live here. With Clerk (AUTH_PROVIDER=clerk, or a Clerk key and no AUTH_PROVIDER) these tables stay empty.
--
--   auth_users        one row per person (an address, lower-cased); public_metadata holds the platform role, as Clerk's did
--   auth_sessions     a signed-in browser: only the sha256 of the cookie's value is stored; revoked_at ends it at once
--   auth_codes        emailed sign-in codes: an HMAC of the code, ten minutes, five tries, used once (ip_hash: a hash of the requesting address, for the per-address-and-IP limit)
--   auth_oauth_states a Google sign-in in flight (state, PKCE verifier, nonce), used once, ten minutes
--   auth_memberships  a person in a workspace, with their account role (src/account-roles.ts) and suspension
--   auth_invitations  an invitation by email to a workspace with a role: seven days, used once, revocable
--
-- organizations.clerk_org_id keeps its name and meaning: the people directory's id for the workspace (a Clerk
-- organization id under Clerk; under builtin the id builtin minted, org_b…), so every join that names it is unchanged.
-- None of these tables is open to the tenant role (sql/migrations/0003): sign-in and team changes run as the platform.
CREATE TABLE IF NOT EXISTS auth_users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  email_verified_at TIMESTAMPTZ,
  first_name        TEXT,
  last_name         TEXT,
  google_sub        TEXT UNIQUE,
  public_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sign_in_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  active_org_id INT REFERENCES organizations(id) ON DELETE SET NULL,
  method        TEXT NOT NULL CHECK (method IN ('email_code', 'google')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoked_why   TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  deliverable  BOOLEAN NOT NULL,
  ip_hash      TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_codes_email_idx ON auth_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_oauth_states (
  state_hash  TEXT PRIMARY KEY,
  verifier    TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  redirect    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_memberships (
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'billing', 'owner')),
  suspended   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS auth_memberships_user_idx ON auth_memberships (user_id);

CREATE TABLE IF NOT EXISTS auth_invitations (
  id           TEXT PRIMARY KEY,
  org_id       INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (email = lower(email)),
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'billing', 'owner')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  TEXT
);
CREATE INDEX IF NOT EXISTS auth_invitations_email_idx ON auth_invitations (email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS auth_invitations_org_idx ON auth_invitations (org_id, created_at DESC);

-- The two tables that carry org_id are workspace tables to the row-level-security check (src/rls.ts): RLS on, no policy
-- and no grant, so the tenant role reaches none of their rows.
ALTER TABLE auth_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_invitations ENABLE ROW LEVEL SECURITY;
