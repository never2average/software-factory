-- The data trail's two new actions (mold_v0-322; src/audit-trail.ts DataAction, src/record-areas.ts auditMembers):
--   grant    a workspace owner let sessions members start receive a connection record's keys (a connection_env
--            entry's members_field turned on; src/secret-binding.ts membersFlagWrite)
--   revoke   that consent ended: an owner turned it off, or someone else changed where the record's secrets go
-- Each names the record (its area and key), never a value. Only the action's CHECK changes; the table, its chain and
-- its rows stay as they are. Rollback: sql/rollback/0073_audit_members_keys.sql.
ALTER TABLE audit_data_events DROP CONSTRAINT IF EXISTS audit_data_events_action_check;
ALTER TABLE audit_data_events ADD CONSTRAINT audit_data_events_action_check
  CHECK (action IN ('list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete', 'grant', 'revoke'));
