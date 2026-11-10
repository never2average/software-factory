-- The agent composer and session numbers (mold_v0-290; src/agent-composer.ts, src/harness-sessions.ts; molds/mold_v0/docs/agent-harness.md).
--
--   harness_sessions.session_number  a short human number per workspace, in order of creation, kept forever. The console
--                             shows it with the app's prefix (AGI-001; profile.json agent_session_prefix). Backfilled
--                             here by created_at, then id.
--   harness_session_counters  the last number given in each workspace. Taken with one row lock in the transaction that
--                             inserts the session, so two sessions started at once can never get the same number. A number
--                             whose session failed to queue is not given again.
--   harness_session_files     a file a person attached to a message: a draft (session_id NULL, its uploader's alone) until a
--                             message carries it into a session, which delivers it into that session's working directory
--                             on every wake. The bytes are in the object store under the workspace's prefix, sealed with its
--                             data key (src/orgcrypto.ts); this row has the name, size, type, sha256 and object key.
--   harness_session_messages.attachments  what a message carried: {files: [{id, name, path, bytes, sha256}], repositories:
--                             ["owner/name"]}. Names and numbers only; a repository's access is its wake's own short-lived
--                             read-only token (run_github_app_tokens), never kept here.
--
-- Every table carries the workspace (org_id) under row-level security: the tenant role may only read its own rows.

ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS session_number INT;
UPDATE harness_sessions s SET session_number = n.n
  FROM (SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY created_at, id) AS n FROM harness_sessions) n
 WHERE s.id = n.id AND s.session_number IS NULL;
ALTER TABLE harness_sessions ALTER COLUMN session_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harness_sessions_number_idx ON harness_sessions (org_id, session_number);

CREATE TABLE IF NOT EXISTS harness_session_counters (
  org_id       INT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  last_number  INT NOT NULL CHECK (last_number > 0)
);
INSERT INTO harness_session_counters (org_id, last_number)
  SELECT org_id, max(session_number) FROM harness_sessions GROUP BY org_id
  ON CONFLICT (org_id) DO NOTHING;

ALTER TABLE harness_session_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS harness_session_files (
  id            TEXT PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  session_id    TEXT REFERENCES harness_sessions (id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL,
  name          TEXT NOT NULL,
  path          TEXT,
  bytes         BIGINT NOT NULL CHECK (bytes >= 0),
  sha256        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  bound_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS harness_session_files_session_idx ON harness_session_files (org_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS harness_session_files_draft_idx ON harness_session_files (created_at) WHERE session_id IS NULL;

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['harness_session_counters', 'harness_session_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
END $mig$;
