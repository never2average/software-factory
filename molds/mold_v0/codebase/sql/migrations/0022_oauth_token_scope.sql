-- A token's own scope (mold_v0-087; src/mcp-oauth.ts). A client refreshing its tokens may ask for less than it was
-- granted (RFC 6749 section 6, OAuth 2.1 section 4.3): the new access token then carries only what it asked for, and
-- /mcp checks the token's scope, not the grant's. A refresh token keeps the scope of the one it replaces, so a later
-- refresh may ask for the whole grant again, never more.
--
-- NULL is the grant's scope: every token issued before this release, and an access token whose refresh named no scope.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS scope TEXT;
