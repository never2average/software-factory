-- Teams inside a workspace and per-record visibility (mold_v0-259; src/teams.ts, src/visibility.ts), behind the app's
-- flag `teams` (off, the default: nothing writes these tables or columns, and every record stays open to its whole
-- workspace, exactly as before).
--
--   workspace_teams         a workspace's teams: a name, unique in the workspace (case-insensitive)
--   workspace_team_members  who is in each team, as a member or a lead: a person's sign-in id
--   workspace_team_changes  every change of a team and its membership (append-only): created, renamed, deleted, a
--                           person added or removed, made a lead or a member again, by whom and when
--
-- The tenant role reads its own workspace's rows of all three (row-level security) and writes none: the shell's own code
-- writes them, for a workspace owner (src/teams.ts), so no query run as the tenant can put a person into a team.
--
-- A workspace record (0004) carries its visibility, all NULL for every record written before (open to the workspace):
--   visibility     NULL or 'workspace' (everyone in the workspace), 'team' (team_id's members and leads), or 'private'
--   team_id        the team a 'team' record is shared with (a deleted team leaves it to its owner and collaborators)
--   owner_id       the person who owns it (its creator, unless changed): sees it whatever its visibility
--   collaborators  people named on the record: each sees it whatever its visibility
--
-- The rule is the database's own: a restrictive policy, record_visibility, on top of tenant_isolation, for every query of
-- the tenant role. It reads app.viewer, which src/tenant-scope.ts sets on every tenant transaction: "*" sees every record
-- (the shell's own work, a workspace owner, an account key), a person's id sees the records open to the workspace, theirs,
-- those they collaborate on and those of their teams. A transaction with no app.viewer sees only the records open to the
-- workspace. So every read (a list, a page, a count, an export, a reference check) and every write (an update, a move,
-- a delete) of a record the person may not see finds no row.
CREATE TABLE IF NOT EXISTS workspace_teams (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description TEXT CHECK (length(description) <= 500),
  created_by  TEXT CHECK (length(created_by) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_teams_name_idx ON workspace_teams (org_id, lower(name));

CREATE TABLE IF NOT EXISTS workspace_team_members (
  org_id    INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id   BIGINT NOT NULL REFERENCES workspace_teams (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'lead')),
  added_by  TEXT CHECK (length(added_by) <= 200),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
-- A person's teams in a workspace (the visibility rule's lookup).
CREATE INDEX IF NOT EXISTS workspace_team_members_user_idx ON workspace_team_members (org_id, user_id, team_id);

CREATE TABLE IF NOT EXISTS workspace_team_changes (
  id         BIGSERIAL PRIMARY KEY,
  org_id     INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id    BIGINT,                 -- kept after the team is deleted (no reference)
  team_name  TEXT NOT NULL CHECK (length(team_name) <= 80),
  action     TEXT NOT NULL CHECK (action IN ('created', 'renamed', 'deleted', 'member_added', 'member_removed', 'lead_set', 'lead_unset')),
  user_id    TEXT CHECK (length(user_id) <= 200),
  detail     TEXT CHECK (length(detail) <= 300),
  by         TEXT CHECK (length(by) <= 200),
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_team_changes_team_idx ON workspace_team_changes (org_id, team_id, id DESC);

ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS visibility TEXT;
ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_visibility_check;
ALTER TABLE workspace_records ADD CONSTRAINT workspace_records_visibility_check CHECK (visibility IN ('workspace', 'team', 'private'));
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES workspace_teams (id) ON DELETE SET NULL;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS owner_id TEXT CHECK (length(owner_id) <= 200);
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS collaborators TEXT[] CHECK (cardinality(collaborators) <= 50);
-- A team's records (a team's page, the delete check).
CREATE INDEX IF NOT EXISTS workspace_records_team_idx ON workspace_records (org_id, team_id) WHERE team_id IS NOT NULL;

-- The viewer of the current tenant transaction ('' when none was set: only what is open to the workspace).
CREATE OR REPLACE FUNCTION app_viewer() RETURNS TEXT LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('app.viewer', true), '')
$fn$;

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  rule TEXT := $rule$(visibility IS NULL OR visibility = 'workspace' OR app_viewer() = '*'
    OR (owner_id IS NOT NULL AND owner_id = app_viewer()) OR app_viewer() = ANY (coalesce(collaborators, '{}'::text[]))
    OR (visibility = 'team' AND team_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_team_members m
          WHERE m.org_id = workspace_records.org_id AND m.team_id = workspace_records.team_id AND m.user_id = app_viewer())))$rule$;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_teams', 'workspace_team_members', 'workspace_team_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
  DROP POLICY IF EXISTS record_visibility ON workspace_records;
  EXECUTE format('CREATE POLICY record_visibility ON workspace_records AS RESTRICTIVE TO %I USING %s WITH CHECK %s', r, rule, rule);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app_viewer() TO %I', r);
END $mig$;
