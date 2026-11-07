-- Team roles in the app's words (mold_v0-262; src/teams.ts), behind the app's flag `teams` (off, the default: nothing
-- writes this column). An app (its profile.json, or a pack's pack.json) may name its team roles, lead / dev / viewer,
-- each mapped onto one of the two levels 0050 keeps in `role` (a lead also changes who sees the team's records; a
-- member sees them). The level stays the one thing the visibility rule and the Share check read; the name is what
-- people read:
--   workspace_team_members.role_name   the role's id in the app's words (NULL: the level's own word, Lead or Member)
--   workspace_team_changes.action       also 'role_set': a person given another role of the same level
ALTER TABLE workspace_team_members ADD COLUMN IF NOT EXISTS role_name TEXT CHECK (role_name ~ '^[a-z][a-z0-9_]{0,23}$');
ALTER TABLE workspace_team_changes DROP CONSTRAINT IF EXISTS workspace_team_changes_action_check;
ALTER TABLE workspace_team_changes ADD CONSTRAINT workspace_team_changes_action_check
  CHECK (action IN ('created', 'renamed', 'deleted', 'member_added', 'member_removed', 'lead_set', 'lead_unset', 'role_set'));
