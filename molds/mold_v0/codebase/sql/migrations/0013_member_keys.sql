-- Per-member MCP keys (mold_v0-007; src/member-keys.ts, molds/mold_v0/MOLD.md "Per-member MCP keys"). A member key is
-- a person's own, named, with an expiry, accepted only in a header, and acts with that person's current role in the
-- workspace (looked up on every call: a removed or suspended member's keys stop working). Only its sha256 is stored,
-- as for every key. Existing keys (the account's own, and the older keys staff issued for a person) keep working
-- exactly as before: scoped is false for them.
--
--   api_keys.scoped      true for a member key: user_id and expires_at are set, the key is refused in a URL, and its
--                        calls carry the member's role (a viewer's key cannot write)
--   api_keys.expires_at  when the key stops working (a member key always has one; older keys none)
--   api_keys.revoked_by  who revoked it: "member:<user id>" for the person themselves, "owner:<user id>" for an owner
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scoped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_by TEXT;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_member_key') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_member_key CHECK (NOT scoped OR (user_id IS NOT NULL AND expires_at IS NOT NULL));
  END IF;
END $mig$;
CREATE INDEX IF NOT EXISTS api_keys_member_idx ON api_keys (org_id, user_id) WHERE scoped;
