-- The workspace agent's profiles (mold_v0-261; src/agent-profiles.ts, the only writer; molds/mold_v0/docs/agent-harness.md
-- "Agent profiles"): named sets of a session's instructions, model, budget, turns, tools, web access, files and who may
-- start it, edited by platform staff in Admin › Agent profiles. Written only while the app's profile turns the
-- `agent_harness` feature on.
--   agent_profiles          one row per profile: its id (its address), name, description, the version in force, active or
--                           archived, where it came from (the platform, or the pack that brought it) and its config (each
--                           setting it leaves unset is the platform setting in force; "default" leaves them all unset)
--   agent_profile_versions  every version as it was saved: a session freezes the version it started with
--   agent_profile_changes   every change, with who made it, the profile before and after (created, edited, archived,
--                           restored): the audit trail
-- A session carries the profile and version it started with, and the record it was started from (a record page's
-- start_agent action): harness_sessions.profile_id, profile_version, record_area, record_key, all NULL for a session from
-- before (the platform settings, as the Default profile has them).
-- The platform's own tables: no workspace reads or writes them (src/rls.ts NO_ACCESS), so they carry no org_id.

CREATE TABLE IF NOT EXISTS agent_profiles (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '',
  version      INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  source       TEXT NOT NULL DEFAULT 'platform',   -- platform, or pack:<pack id>
  config       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_profile_versions (
  profile_id   TEXT NOT NULL REFERENCES agent_profiles (id) ON DELETE CASCADE,
  version      INT NOT NULL CHECK (version >= 1),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  config       JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, version)
);

CREATE TABLE IF NOT EXISTS agent_profile_changes (
  id           BIGSERIAL PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES agent_profiles (id) ON DELETE CASCADE,
  version      INT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('created', 'edited', 'archived', 'restored')),
  changed_by   TEXT NOT NULL,
  before       JSONB,
  after        JSONB NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_profile_changes_profile_idx ON agent_profile_changes (profile_id, changed_at DESC, id DESC);

ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS profile_id TEXT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS profile_version INT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_area TEXT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS record_key TEXT;
ALTER TABLE harness_sessions DROP CONSTRAINT IF EXISTS harness_sessions_profile_both;
ALTER TABLE harness_sessions ADD CONSTRAINT harness_sessions_profile_both CHECK ((profile_id IS NULL) = (profile_version IS NULL));
ALTER TABLE harness_sessions DROP CONSTRAINT IF EXISTS harness_sessions_record_both;
ALTER TABLE harness_sessions ADD CONSTRAINT harness_sessions_record_both CHECK ((record_area IS NULL) = (record_key IS NULL));
-- A record's sessions, newest first, inside its workspace (its page's runs section).
CREATE INDEX IF NOT EXISTS harness_sessions_record_idx ON harness_sessions (org_id, record_area, record_key, created_at DESC) WHERE record_area IS NOT NULL;

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  -- Staff bookkeeping: not even a workspace's own work reads them; the shell's code alone writes them.
  FOREACH t IN ARRAY ARRAY['agent_profiles', 'agent_profile_versions', 'agent_profile_changes'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
  EXECUTE format('REVOKE ALL ON SEQUENCE agent_profile_changes_id_seq FROM %I', r);
END $mig$;
