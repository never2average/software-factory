-- A company's own email, per workspace (mold_v0-192; src/company-email.ts, src/email-intake.ts, molds/mold_v0/MOLD.md
-- "The company's own email"). A pack turns it on (pack.json `email`); a workspace's owners configure it on the console's
-- Settings › Email page.
--
--   workspace_email_senders    one per workspace: SMTP, Microsoft 365 (Graph) or Google Workspace (Gmail API), through
--                              which the app's emails to that workspace's people go out while it is on
--   workspace_email_inboxes    mailboxes the intake reads (IMAP, Graph, Gmail), each for one pack's declared intake,
--                              with its read position (cursor: an IMAP folder's UIDVALIDITY and last UID, a Graph delta
--                              link, a Gmail history id: never message content) and its poll schedule and back-off
--   workspace_email_messages   the intake's ledger: one row per message taken in, keyed by the sha256 of its Message-ID
--                              in the workspace's area (never fetched or stored twice), the record it became, and its
--                              attachments' objects (sealed list: names, sizes, hashes, object keys)
--
-- `settings` holds what a person typed that is not a secret (host, port, security, user name, mailbox, tenant and client
-- ids, the sender's From and Reply-to). `sealed` is the secret (a password, a client secret, a service-account key),
-- sealed with the workspace's data key (src/orgcrypto.ts sealBytes, AES-256-GCM) and bound to its workspace and `slot`;
-- no answer ever carries it. Tenant work has no grant on any of the three tables (a pack's code never reads them); only
-- the shell's own code does, with the workspace taken from the caller's session or the row itself.

CREATE TABLE IF NOT EXISTS workspace_email_senders (
  org_id          INT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('smtp', 'graph', 'gmail')),
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  slot            TEXT NOT NULL,
  sealed          TEXT,
  secret_set_at   TIMESTAMPTZ,
  secret_set_by   TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'connected', 'error')),
  last_error      TEXT,
  last_error_kind TEXT,
  last_tested_at  TIMESTAMPTZ,
  last_sent_at    TIMESTAMPTZ,
  sent_count      INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_email_inboxes (
  id              BIGSERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack            TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('smtp', 'graph', 'gmail')),
  label           TEXT NOT NULL,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  slot            TEXT NOT NULL,
  sealed          TEXT,
  secret_set_at   TIMESTAMPTZ,
  secret_set_by   TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'connected', 'error')),
  last_error      TEXT,
  last_error_kind TEXT,
  last_poll_at    TIMESTAMPTZ,
  next_poll_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  failures        INT NOT NULL DEFAULT 0,
  poll_minutes    INT NOT NULL DEFAULT 5 CHECK (poll_minutes BETWEEN 1 AND 1440),
  cursor          JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_count  INT NOT NULL DEFAULT 0,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_email_inboxes_due_idx ON workspace_email_inboxes (next_poll_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS workspace_email_inboxes_org_idx ON workspace_email_inboxes (org_id);

CREATE TABLE IF NOT EXISTS workspace_email_messages (
  id              BIGSERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  inbox_id        BIGINT REFERENCES workspace_email_inboxes (id) ON DELETE SET NULL,
  pack            TEXT NOT NULL,
  area            TEXT NOT NULL,
  message_hash    TEXT NOT NULL,
  record_key      TEXT NOT NULL,
  attachments     TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, pack, area, message_hash)
);
CREATE INDEX IF NOT EXISTS workspace_email_messages_record_idx ON workspace_email_messages (org_id, area, record_key);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_email_senders', 'workspace_email_inboxes', 'workspace_email_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    -- No access for tenant work, not even its own rows: a pack's code never sees a mailbox's settings or a sealed secret.
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
