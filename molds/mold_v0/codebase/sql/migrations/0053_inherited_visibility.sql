-- Inherited visibility (mold_v0-262; src/visibility.ts, src/record-areas.ts), behind the app's flag `teams` (off, the
-- default: nothing writes these columns, and the policy reads exactly as 0050 left it for every record).
--
-- A child area may declare `visibility: {inherit: <reference field>}`: each of its records is seen by whoever sees the
-- record that field names (a task by whoever sees its project). Such a record is stored with
--   visibility     'inherit'
--   inherit_area   the parent record's area (the reference field's `to`)
--   inherit_key    the parent record's key (the field's value when written; the shell sets both on every write)
-- and the restrictive policy record_visibility (0050) gains one branch: an 'inherit' record is there for a query exactly
-- when its parent is, by the parent's own rule (open to the workspace, its owner, a collaborator, its team), or for "*"
-- (the shell's own work, an owner, an account key). Nothing else of the record counts (its own owner or collaborators
-- do not widen it). A parent that is gone hides its children from everyone but "*". A record whose reference is empty
-- is stored open to the workspace, as one with no parent to follow.
--
-- The parent is read by app_record_visible(), which runs as the function's owner (so the policy does not read the table
-- it guards through itself) and checks only the current tenant's rows against the current viewer.
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS inherit_area TEXT CHECK (length(inherit_area) <= 63);
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS inherit_key TEXT CHECK (length(inherit_key) <= 200);
ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_visibility_check;
ALTER TABLE workspace_records ADD CONSTRAINT workspace_records_visibility_check CHECK (visibility IN ('workspace', 'team', 'private', 'inherit'));
ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_inherit_check;
ALTER TABLE workspace_records ADD CONSTRAINT workspace_records_inherit_check
  CHECK ((visibility = 'inherit') = (inherit_area IS NOT NULL AND inherit_key IS NOT NULL));
-- A parent's lookup (the policy's): by workspace, area and key.
CREATE INDEX IF NOT EXISTS workspace_records_area_key_idx ON workspace_records (org_id, area, key);

-- Whether the current viewer sees the record (area, key) of the current tenant, by its own rule (0050's), one level.
CREATE OR REPLACE FUNCTION app_record_visible(a TEXT, k TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $fn$
  SELECT EXISTS (SELECT 1 FROM workspace_records r WHERE r.org_id = app_tenant_org() AND r.area = a AND r.key = k
    AND (r.visibility IS NULL OR r.visibility = 'workspace' OR app_viewer() = '*'
      OR (r.visibility IN ('team', 'private') AND ((r.owner_id IS NOT NULL AND r.owner_id = app_viewer()) OR app_viewer() = ANY (coalesce(r.collaborators, '{}'::text[]))))
      OR (r.visibility = 'team' AND r.team_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_team_members m
            WHERE m.org_id = r.org_id AND m.team_id = r.team_id AND m.user_id = app_viewer()))))
$fn$;

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  rule TEXT := $rule$((visibility IS DISTINCT FROM 'inherit' AND (visibility IS NULL OR visibility = 'workspace' OR app_viewer() = '*'
    OR (owner_id IS NOT NULL AND owner_id = app_viewer()) OR app_viewer() = ANY (coalesce(collaborators, '{}'::text[]))
    OR (visibility = 'team' AND team_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_team_members m
          WHERE m.org_id = workspace_records.org_id AND m.team_id = workspace_records.team_id AND m.user_id = app_viewer()))))
    OR (visibility = 'inherit' AND (app_viewer() = '*' OR app_record_visible(inherit_area, inherit_key))))$rule$;
BEGIN
  DROP POLICY IF EXISTS record_visibility ON workspace_records;
  EXECUTE format('CREATE POLICY record_visibility ON workspace_records AS RESTRICTIVE TO %I USING %s WITH CHECK %s', r, rule, rule);
  EXECUTE format('REVOKE ALL ON FUNCTION app_record_visible(TEXT, TEXT) FROM PUBLIC');
  EXECUTE format('GRANT EXECUTE ON FUNCTION app_record_visible(TEXT, TEXT) TO %I', r);
END $mig$;
