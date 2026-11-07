-- The platform account (mold_v0-276; src/platform-account.ts, the only writer of the mark): the one account the
-- platform's own staff use the portal in. A platform admin who signs in to /app with no account of their own is made an
-- owner of it (other platform roles join with a lesser role), and the factory ensures it after every deploy. Marked here
-- rather than found by its slug or name, so renaming it, or a customer account that took the slug first, never makes a
-- second one: at most one row carries the mark (the partial unique index).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS platform_account BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_one_platform_account ON organizations (platform_account) WHERE platform_account;
