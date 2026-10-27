-- Journeys and in-chat tips (mold_v0-143; src/journeys.ts, src/tips.ts, molds/mold_v0/MOLD.md "Journeys and tips"): the
-- shell's two components any app turns on from pack.json `journeys` and `tips`. Journeys are step-by-step pipelines a
-- customer replicates in their AI client, one prompt at a time: templates the platform writes and promotes (a pack's
-- built-in ones seeded once, through a ledger), an account's own use cases, each stage marked done from real tool calls
-- or by hand, and help requests between teammates. Tips are a delivery queue for short suggestions shown at the end of
-- the next tool result, on /app Setup and on the admin console, queued by a workflow's webhook or by hand.
--
-- Adopted, never rebuilt (src/migrate.ts ADOPTING_MIGRATIONS), as 0025 adopted the account context tables. These six
-- tables were a host pack's (and, before mold_v0-049, the shell's own base schema's) under exactly these statements:
-- each statement below is that DDL byte for byte, in the same order, and the security block gives them the same
-- policies and grants that pack's row-level security migration gave them (the template table shared: the platform's
-- rows, org_id NULL, readable by every workspace; the seed ledger read-only), through the names
-- 0024_neutral_database_names gave the functions and the role. A database that already has all six, in exactly this
-- shape, records this migration as adopted without running it (schema_adoptions): no statement touches those tables
-- or their rows. A database with none of them runs it. One that has them all in this structure but not yet secured as
-- this migration secures them, because the shell's 0003 secured them in this same run (a database from before 0003:
-- the schema-on-boot path, or one recorded only up to 0001), runs it too: its statements are idempotent and give the
-- tables their own rules, as that host pack's security migration did. Anything else: refused, nothing changed.

-- Tips (src/tips.ts): a delivery queue. One row per account (user_id '') or person and sequence step; a step that
-- fires again replaces its row.
CREATE TABLE IF NOT EXISTS nudges (
  id             BIGSERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL DEFAULT '',     -- WorkOS user, or '' for everyone in the account
  journey        TEXT NOT NULL,
  step           TEXT NOT NULL,
  message        TEXT NOT NULL,
  prompt         TEXT,                         -- what to type to try it
  link           TEXT,
  source         TEXT NOT NULL DEFAULT 'posthog' CHECK (source IN ('posthog', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  shown_count    INT NOT NULL DEFAULT 0,
  first_shown_at TIMESTAMPTZ,
  last_shown_at  TIMESTAMPTZ,
  dismissed_at   TIMESTAMPTZ,
  UNIQUE (org_id, user_id, journey, step)
);
CREATE INDEX IF NOT EXISTS nudges_active_idx ON nudges (org_id, user_id, created_at DESC) WHERE dismissed_at IS NULL;
CREATE TABLE IF NOT EXISTS nudge_prefs (
  org_id         INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL DEFAULT '',
  muted          BOOLEAN NOT NULL DEFAULT false,  -- the person turned tips off on /app
  last_shown_at  TIMESTAMPTZ,                     -- for the one-a-day limit in chat
  PRIMARY KEY (org_id, user_id)
);


-- Journeys (src/journeys.ts): templates (org_id NULL: the platform's, managed on /admin, `promoted` ones shown in
-- `position` order; else one account's own use case), progress per account, help requests between teammates.
CREATE TABLE IF NOT EXISTS journey_templates (
  id              TEXT PRIMARY KEY,               -- slug
  name            TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  who             TEXT NOT NULL DEFAULT '',
  time            TEXT NOT NULL DEFAULT '',
  example_title   TEXT NOT NULL DEFAULT '',
  example_result  TEXT NOT NULL DEFAULT '',
  stages          JSONB NOT NULL,                 -- [{id, title, why, prompt, tools[], expect, manual?}]
  promoted        BOOLEAN NOT NULL DEFAULT false,
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);

-- Journey progress per account (src/playbooks.ts): when each stage of a customer journey was first done, by a tool
-- call or marked by hand. Drives the per-journey funnel on /admin and the journey_* PostHog events (sent once).
CREATE TABLE IF NOT EXISTS journey_progress (
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journey_id  TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL CHECK (source IN ('tool', 'manual')),
  user_id     TEXT,                              -- who marked it, for manual stages
  PRIMARY KEY (org_id, journey_id, stage_id)
);

-- Use cases an account adds for itself on /app/adoption (src/playbooks.ts): journey templates owned by one account.
-- NULL: a global template managed on /admin.
ALTER TABLE journey_templates ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id) ON DELETE CASCADE;

-- Help requests on /app/adoption (src/playbooks.ts): someone stuck on a use case asks; a teammate picks it up.
CREATE TABLE IF NOT EXISTS adoption_help (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journey_id  TEXT NOT NULL,
  requester   TEXT NOT NULL,                     -- Clerk user id
  helper      TEXT,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picked', 'done')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at   TIMESTAMPTZ,
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS adoption_help_org ON adoption_help (org_id, status, created_at DESC);

-- The built-in templates already seeded (src/journeys.ts): each is added once, so one an admin deleted stays gone.
CREATE TABLE IF NOT EXISTS journey_seed (
  id         TEXT PRIMARY KEY,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-level security, as the host pack's security migration gave these tables: the workspace policy on the four with
-- one owner, the shared rule on the templates (the platform's rows readable by every workspace, a workspace's own
-- changed only by it), read-only on the seed ledger, nextval for the tenant's inserts.
DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['nudges', 'nudge_prefs', 'journey_templates', 'journey_progress', 'adoption_help', 'journey_seed'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
  EXECUTE format('GRANT SELECT ON journey_seed TO %I', r);
  FOREACH t IN ARRAY ARRAY['nudges', 'nudge_prefs', 'journey_progress', 'adoption_help'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
  END LOOP;
  ALTER TABLE journey_templates ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON journey_templates;
  DROP POLICY IF EXISTS tenant_read ON journey_templates;
  DROP POLICY IF EXISTS tenant_write ON journey_templates;
  EXECUTE format('CREATE POLICY tenant_read ON journey_templates FOR SELECT TO %I USING (org_id IS NULL OR org_id = app_tenant_org())', r);
  EXECUTE format('CREATE POLICY tenant_write ON journey_templates TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON journey_templates TO %I', r);
  EXECUTE format('GRANT USAGE ON SEQUENCE nudges_id_seq, adoption_help_id_seq TO %I', r);
END $mig$;
