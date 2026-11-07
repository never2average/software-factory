-- Workspace recipes (mold_v0-271, flag workspace_recipes; src/recipes.ts, the only writer; molds/mold_v0/docs/agent-harness.md
-- "Workspace recipes"): reusable bundles of files and runtime binaries an agent works with, kept by platform staff at
-- /admin/recipes and picked by an agent profile's workspace.
--   workspace_recipes           one row per recipe: its name, description, active or archived, and its latest version
--   workspace_recipe_uploads    one file's bytes in the object store, in 4 MiB parts under recipes/uploads/<id>/: its
--                               size, parts, sha256 once finished, who uploaded it (staff, or an agent session's proposal)
--   workspace_recipe_versions   every version, never changed: its files ({path, upload, bytes, sha256, executable}),
--                               its note, who made it and whether staff saved it or accepted an agent's proposal
--   workspace_recipe_proposals  an agent's proposed next version (self-improvement): against which version, its files,
--                               what it changed and removed and why, the workspace, session and wake it came from;
--                               pending until staff accept it (the version it became) or decline it (the reason)
-- The platform's own tables: no workspace reads or writes them (src/rls.ts NO_ACCESS), so they carry no org_id; a
-- proposal names the workspace it came from as proposed_by_org, for staff.

CREATE TABLE IF NOT EXISTS workspace_recipes (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version      INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workspace_recipe_uploads (
  id            TEXT PRIMARY KEY CHECK (id ~ '^rup_[0-9a-f]{24}$'),
  bytes         BIGINT NOT NULL CHECK (bytes >= 0),
  parts         INT NOT NULL CHECK (parts >= 1),
  sha256        TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  CHECK ((completed_at IS NULL) OR (sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS workspace_recipe_versions (
  recipe_id    TEXT NOT NULL REFERENCES workspace_recipes (id) ON DELETE CASCADE,
  version      INT NOT NULL CHECK (version >= 1),
  files        JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  source       TEXT NOT NULL CHECK (source IN ('staff', 'agent')),
  proposal_id  TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, version),
  CHECK ((source = 'agent') = (proposal_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS workspace_recipe_proposals (
  id                TEXT PRIMARY KEY CHECK (id ~ '^rpp_[0-9a-f]{24}$'),
  recipe_id         TEXT NOT NULL REFERENCES workspace_recipes (id) ON DELETE CASCADE,
  base_version      INT NOT NULL CHECK (base_version >= 1),
  files             JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  changed           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(changed) = 'array'),
  removed           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(removed) = 'array'),
  note              TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 4000),
  proposed_by_org   INT REFERENCES organizations (id) ON DELETE SET NULL,
  session_id        TEXT,
  run_id            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  decided_by        TEXT,
  decided_at        TIMESTAMPTZ,
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  accepted_version  INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'accepted') = (accepted_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workspace_recipe_proposals_recipe_idx ON workspace_recipe_proposals (recipe_id, status, created_at DESC);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  -- Staff bookkeeping: no workspace's work reads them; the shell's code alone writes them.
  FOREACH t IN ARRAY ARRAY['workspace_recipes', 'workspace_recipe_uploads', 'workspace_recipe_versions', 'workspace_recipe_proposals'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
END $mig$;
