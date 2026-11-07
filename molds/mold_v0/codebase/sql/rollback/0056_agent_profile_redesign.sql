-- Rolling back past 0056_agent_profile_redesign (mold_v0-267), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0056_agent_profile_redesign.sql
-- Puts each profile back in the earlier shape as its next version: one this migration rewrote and nobody changed since
-- gets exactly its config from before (the 'migrated' change's `before`); any other is mapped back (inference -> model and
-- provider, workspace keys -> credentials, governance.web -> web {tools, hosts}); platform keys, uploads, the harness
-- and the rest of the governance policy have no place in the earlier shape and go. The 'migrated' changes are kept as
-- 'edited'. The uploads' table goes (their bytes stay in the object store under agent-profiles/uploads/, unread). The
-- sessions keep their frozen policy. Found by its name, so it also undoes it where it was recorded under another number.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'agent_profile_redesign');
  p RECORD;
  c JSONB;
  o JSONB;
  last_change RECORD;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'agent_profile_redesign is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (agent_profile_redesign): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  FOR p IN SELECT id, name, description, status, version, config FROM agent_profiles
            WHERE config ?| ARRAY['harness', 'inference', 'keys', 'uploads', 'governance'] ORDER BY id FOR UPDATE LOOP
    c := p.config;
    SELECT action, before INTO last_change FROM agent_profile_changes WHERE profile_id = p.id AND action IN ('created', 'edited', 'migrated') ORDER BY id DESC LIMIT 1;
    IF last_change.action = 'migrated' THEN
      o := coalesce(last_change.before->'config', '{}'::jsonb);
    ELSE
      o := '{}'::jsonb;
      IF jsonb_typeof(c->'inference') = 'object' THEN
        o := o || jsonb_build_object('model', c->'inference'->>'model', 'provider', c->'inference'->>'provider');
      END IF;
      IF jsonb_typeof(c->'keys') = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c->'keys') k WHERE k->>'kind' = 'workspace') THEN
        o := o || jsonb_build_object('credentials', (SELECT jsonb_agg(k->>'name') FROM jsonb_array_elements(c->'keys') k WHERE k->>'kind' = 'workspace'));
      END IF;
      IF jsonb_typeof(c->'governance'->'web') = 'object' THEN
        o := o || jsonb_build_object('web', CASE
          WHEN (c->'governance'->'web'->>'enabled')::boolean AND (c->'governance'->'web'->>'web_fetch_enabled')::boolean
            THEN jsonb_build_object('tools', CASE WHEN (c->'governance'->'web'->>'web_search_enabled')::boolean THEN 'search' ELSE 'fetch' END,
                                    'hosts', (SELECT coalesce(jsonb_agg(h), '[]'::jsonb) FROM jsonb_array_elements_text(c->'governance'->'web'->'web_fetch_allowed_domains') h WHERE h <> '*'))
          ELSE jsonb_build_object('tools', 'off') END);
      END IF;
    END IF;
    UPDATE agent_profiles SET config = o, version = version + 1, updated_by = 'the platform (rollback of mold_v0-267)', updated_at = now() WHERE id = p.id;
    INSERT INTO agent_profile_versions (profile_id, version, name, description, config, created_by)
      VALUES (p.id, p.version + 1, p.name, p.description, o, 'the platform (rollback of mold_v0-267)');
    INSERT INTO agent_profile_changes (profile_id, version, action, changed_by, before, after)
      VALUES (p.id, p.version + 1, 'edited', 'the platform (rollback of mold_v0-267)',
              jsonb_build_object('name', p.name, 'description', p.description, 'status', p.status, 'config', c),
              jsonb_build_object('name', p.name, 'description', p.description, 'status', p.status, 'config', o));
  END LOOP;
  UPDATE agent_profile_changes SET action = 'edited' WHERE action = 'migrated';
  ALTER TABLE agent_profile_changes DROP CONSTRAINT IF EXISTS agent_profile_changes_action_check;
  ALTER TABLE agent_profile_changes ADD CONSTRAINT agent_profile_changes_action_check CHECK (action IN ('created', 'edited', 'archived', 'restored'));
  DROP TABLE IF EXISTS agent_profile_uploads;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;
