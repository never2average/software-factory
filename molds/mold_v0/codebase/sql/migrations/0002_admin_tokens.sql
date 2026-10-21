-- Admin API tokens (src/admin-tokens.ts), replacing the static OCTILLION_ADMIN_TOKEN (2026-10-20): one per script or
-- person, minted by `npm run admin:token` (or by an owner on /api/admin/tokens), shown once, stored as a hash, scoped
-- to a platform role, always expiring (90 days at most), revocable, and named in the admin access log.
CREATE TABLE IF NOT EXISTS admin_tokens (
  id            BIGSERIAL PRIMARY KEY,
  label         TEXT NOT NULL,                  -- what it is for: "ci deploy", "alice laptop"
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'support', 'operator', 'owner')),
  token_prefix  TEXT NOT NULL,                  -- adm_ plus 6 characters, to tell tokens apart in lists and logs
  token_hash    TEXT NOT NULL UNIQUE,           -- sha256 of the token; the token itself is never stored
  created_by    TEXT NOT NULL,                  -- the owner (email) or "cli" (npm run admin:token on the server)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);
