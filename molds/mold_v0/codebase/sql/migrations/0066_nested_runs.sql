-- Nested agent runs and Programs (mold_v0-291, flag nested_runs with agent_harness; src/nested-runs.ts, src/programs.ts,
-- src/program-acceptance.ts, their only writers; molds/mold_v0/docs/agent-harness.md "Nested runs and Programs").
-- Written only while the app's profile turns `nested_runs` on; with it off the tables stay empty and the columns at their defaults.
--
--   harness_sessions (+)     parent_id, root_id, depth: where a session sits in its tree; ref: its number (AGI-001, a child
--                            AGI-001.2); carved_usd: reserved for children not yet settled; children_spent_usd: what settled
--                            children cost. A session may spend budget - spent - reserve - carved - children_spent.
--   harness_children         one row per spawn (a handle): its parent, its child session, the program or prompt, what was
--                            carved for it, and how it settled: status, answer, typed outputs, error. A machine's handle
--                            has no session of its own: its steps are handles of their own under it.
--   harness_gateway_holds    a model request in flight of a run in a tree: the most it can cost, held from the run's budget
--                            until its cost is recorded, so concurrent requests can never pass the budget. Expires by itself.
--   harness_programs,
--   harness_program_versions a program and its versions, never changed (a change is the next version): the platform's own,
--                            no workspace reads them.
--   harness_evaluations      each acceptance decision, server-owned: the hypothesis, the candidate, the frozen test it ran
--                            against, the metrics, the outcome and every reason. A workspace may read its own.
--   harness_champions        the versions a workspace's programs promoted for a target (a recipe, a harness policy, a mold
--                            ref), the current champion among them, with rollback. Applying one to anything live is a person's.

ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES harness_sessions (id) ON DELETE SET NULL;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS root_id TEXT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 8);
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS carved_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (carved_usd >= 0);
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS children_spent_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (children_spent_usd >= 0);
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS program_id TEXT;
ALTER TABLE harness_sessions ADD COLUMN IF NOT EXISTS program_version INT;
CREATE INDEX IF NOT EXISTS harness_sessions_tree_idx ON harness_sessions (org_id, root_id, depth) WHERE root_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harness_sessions_ref_uq ON harness_sessions (org_id, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_children (
  id                TEXT PRIMARY KEY CHECK (id ~ '^hch_[A-Za-z0-9_-]{8,40}$'),
  org_id            INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  root_id           TEXT NOT NULL,
  parent_id         TEXT NOT NULL REFERENCES harness_sessions (id) ON DELETE CASCADE,
  session_id        TEXT REFERENCES harness_sessions (id) ON DELETE SET NULL,
  step_of           TEXT REFERENCES harness_children (id) ON DELETE CASCADE,
  state_id          TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('prompt', 'program', 'machine', 'step', 'acceptance')),
  program_id        TEXT,
  program_version   INT,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  child_no          INT NOT NULL CHECK (child_no >= 1),
  inputs            JSONB NOT NULL DEFAULT '{}'::jsonb,
  outputs_schema    JSONB,
  budget_usd        NUMERIC(12, 6) NOT NULL CHECK (budget_usd >= 0),
  pool_used_usd     NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (pool_used_usd >= 0),
  spent_usd         NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  queue_reason      TEXT,
  answer            TEXT,
  outputs           JSONB,
  error             TEXT,
  failure_policy    TEXT NOT NULL DEFAULT 'continue' CHECK (failure_policy IN ('fail_fast', 'continue', 'escalate')),
  retries           INT NOT NULL DEFAULT 1 CHECK (retries BETWEEN 0 AND 3),
  retries_used      INT NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
  attention         BOOLEAN NOT NULL DEFAULT false,
  machine           JSONB,
  candidate         JSONB,
  cancel_requested_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ,
  CHECK ((settled_at IS NULL) = (status IN ('queued', 'running')))
);
CREATE INDEX IF NOT EXISTS harness_children_parent_idx ON harness_children (org_id, parent_id, created_at);
CREATE INDEX IF NOT EXISTS harness_children_root_idx ON harness_children (org_id, root_id, status);
CREATE INDEX IF NOT EXISTS harness_children_open_idx ON harness_children (status, updated_at) WHERE settled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harness_children_session_uq ON harness_children (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_gateway_holds (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  usd         NUMERIC(12, 6) NOT NULL CHECK (usd >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_gateway_holds_run_idx ON harness_gateway_holds (run_id, expires_at);

CREATE TABLE IF NOT EXISTS harness_programs (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  icon         TEXT NOT NULL DEFAULT 'sparkles',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version      INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  source       TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'pack')),
  pack_sha     TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS harness_program_versions (
  program_id  TEXT NOT NULL REFERENCES harness_programs (id) ON DELETE CASCADE,
  version     INT NOT NULL CHECK (version >= 1),
  config      JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  note        TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, version)
);

CREATE TABLE IF NOT EXISTS harness_champions (
  id             TEXT PRIMARY KEY CHECK (id ~ '^hcv_[A-Za-z0-9_-]{8,40}$'),
  org_id         INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('recipe', 'harness_policy', 'mold_ref')),
  target_id      TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  version        INT NOT NULL CHECK (version >= 1),
  status         TEXT NOT NULL CHECK (status IN ('champion', 'superseded', 'rolled_back')),
  evaluation_id  TEXT,
  program_id     TEXT,
  candidate      JSONB NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at     TIMESTAMPTZ,
  applied_by     TEXT,
  applied_ref    TEXT,
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by TEXT,
  rollback_reason TEXT,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, target_kind, target_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS harness_champions_one_uq ON harness_champions (org_id, target_kind, target_id) WHERE status = 'champion';

CREATE TABLE IF NOT EXISTS harness_evaluations (
  id              TEXT PRIMARY KEY CHECK (id ~ '^hev_[A-Za-z0-9_-]{8,40}$'),
  org_id          INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  program_id      TEXT NOT NULL,
  program_version INT NOT NULL CHECK (program_version >= 1),
  root_id         TEXT NOT NULL,
  session_id      TEXT,
  handle_id       TEXT REFERENCES harness_children (id) ON DELETE SET NULL,
  run_id          TEXT,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('recipe', 'harness_policy', 'mold_ref')),
  target_id       TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  hypothesis      TEXT NOT NULL DEFAULT '',
  candidate       JSONB NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  champion_id     TEXT,
  acceptance      JSONB NOT NULL CHECK (jsonb_typeof(acceptance) = 'object'),
  contract_sha256 TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'decided')),
  outcome         TEXT CHECK (outcome IN ('accepted', 'refused', 'needs_review')),
  reasons         JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  cases           JSONB,
  promoted_id     TEXT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_decision TEXT CHECK (review_decision IN ('accept', 'decline')),
  review_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'decided') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS harness_evaluations_org_idx ON harness_evaluations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_evaluations_open_idx ON harness_evaluations (status, created_at) WHERE status <> 'decided';
CREATE INDEX IF NOT EXISTS harness_evaluations_target_idx ON harness_evaluations (org_id, target_kind, target_id, created_at DESC);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  -- A workspace reads its own tree, decisions and champions; only the shell's code writes them (the tenant role never does).
  FOREACH t IN ARRAY ARRAY['harness_children', 'harness_evaluations', 'harness_champions', 'harness_gateway_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM %I', t, r);
  END LOOP;
  -- The platform's own: no workspace's work reads them.
  EXECUTE format('REVOKE ALL ON harness_gateway_holds FROM %I', r);
  FOREACH t IN ARRAY ARRAY['harness_programs', 'harness_program_versions'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
