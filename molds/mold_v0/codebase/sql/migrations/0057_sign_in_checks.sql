-- Health › Sign-in (mold_v0-270; src/sign-in-check.ts, the only writer): does every sign-in and connection the app sends
-- people through come back to its CURRENT front door? One row per key:
--   report               the last check's results (each flow's provider, the exact return address, pass / fail / unknown,
--                        and where to fix it), at most an hour old when staff open the tab; the front door it was made
--                        for and since when that front door holds (a callback seen before then says nothing about now)
--   callback:<flow>      what the app last saw come back at a flow's return address: the origin it came to, when, and an
--                        error code a provider sent back (redirect_uri_mismatch), only for a state this server signed.
--                        Never a person, a code, a token or a query string.
-- Platform bookkeeping, no workspace's data: closed to tenant work (src/rls.ts NO_ACCESS), so it carries no org_id.
CREATE TABLE IF NOT EXISTS sign_in_checks (
  key         TEXT PRIMARY KEY CHECK (key = 'report' OR key ~ '^callback:[a-z0-9_.-]{1,120}$'),
  value       JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  EXECUTE format('REVOKE ALL ON sign_in_checks FROM %I', r);
END $mig$;
