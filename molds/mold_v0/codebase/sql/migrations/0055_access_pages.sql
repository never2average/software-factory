-- The early-access form and the sign-in pages' words, edited by platform staff (mold_v0-266; src/access-pages.ts, the
-- only writer; molds/mold_v0/MOLD.md "Early access and sign-in editor"): Admin › Access requests, its Request form and
-- Sign-in page tabs. Live without a redeploy: the public pages read what is in force on each request.
--   access_pages         one row per page (request_form: the access-request form's fields, submit button and thank-you
--                        words; sign_in: the sign-in and sign-up pages' words, legal line and hidden methods): the version
--                        in force and its config, NULL for the build's own defaults (nothing saved, or reset)
--   access_page_changes  every version as it was saved, with who, when and the config before and after (edited, or
--                        reset to the defaults): the history and the audit trail
-- The platform's own tables: no workspace reads or writes them (src/rls.ts NO_ACCESS), so they carry no org_id.

CREATE TABLE IF NOT EXISTS access_pages (
  id          TEXT PRIMARY KEY CHECK (id IN ('request_form', 'sign_in')),
  version     INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  config      JSONB CHECK (config IS NULL OR jsonb_typeof(config) = 'object'),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_page_changes (
  id          BIGSERIAL PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES access_pages (id) ON DELETE CASCADE,
  version     INT NOT NULL CHECK (version >= 1),
  action      TEXT NOT NULL CHECK (action IN ('edited', 'reset')),
  changed_by  TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);
CREATE INDEX IF NOT EXISTS access_page_changes_page_idx ON access_page_changes (page_id, changed_at DESC, id DESC);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  -- Staff bookkeeping: no workspace's work reads them; the shell's code alone writes them.
  FOREACH t IN ARRAY ARRAY['access_pages', 'access_page_changes'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
  EXECUTE format('REVOKE ALL ON SEQUENCE access_page_changes_id_seq FROM %I', r);
END $mig$;
