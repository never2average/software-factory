-- The workspace agent's profiles redesigned (mold_v0-267; src/agent-profiles.ts, src/agent-profile-spec.ts;
-- molds/mold_v0/docs/agent-harness.md "Agent profiles"): a profile is exactly its harness, its key vault (the keys its
-- sessions receive, and its primary inference provider's model and key), its uploads into the session's workspace and
-- its governance policy. Budgets, turns and limits are the platform settings, never a profile's.
--   agent_profile_uploads   a file uploaded for a profile (its bytes in the object store, in 4 MiB parts, under
--                           agent-profiles/uploads/<id>/): its size, parts, sha256 once finished, who uploaded it
--   agent_profile_changes   takes the action 'migrated': the change this migration makes to each profile it rewrites,
--                           with the profile before (as it was) and after, and `after.dropped`: what had no place
-- Each existing profile in the earlier shape is rewritten as its next version:
--   model (and provider)    -> inference {provider, model} (its key: the provider's, as the gateway picks it)
--   credentials             -> keys [{kind: workspace, name}]
--   web {tools, hosts}      -> governance.web (off: disabled; fetch or search with hosts: enabled, those domains, 20
--                              calls, egress approvals on); with no hosts it asked for every host, which a governance
--                              policy cannot say: dropped (web off)
--   instructions, budget_usd, ceiling_usd, max_turns, wake_max_minutes, tools, files, roles, overrides: dropped (the
--   governance policy has no place for instructions; limits are the platform's; files are uploads now, made in the
--   console; who may start is the role's right to launch). Each is kept in the change's `before`.
-- The platform's own tables: no workspace reads or writes them (src/rls.ts NO_ACCESS), so they carry no org_id.

CREATE TABLE IF NOT EXISTS agent_profile_uploads (
  id            TEXT PRIMARY KEY CHECK (id ~ '^upl_[A-Za-z0-9]{20,40}$'),
  bytes         BIGINT NOT NULL CHECK (bytes >= 0),
  parts         INT NOT NULL CHECK (parts >= 1),
  sha256        TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  CHECK ((completed_at IS NULL) OR (sha256 IS NOT NULL))
);

ALTER TABLE agent_profile_changes DROP CONSTRAINT IF EXISTS agent_profile_changes_action_check;
ALTER TABLE agent_profile_changes ADD CONSTRAINT agent_profile_changes_action_check
  CHECK (action IN ('created', 'edited', 'archived', 'restored', 'migrated'));

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  p RECORD;
  c JSONB;
  n JSONB;
  dropped TEXT[];
  web_tools TEXT;
  hosts JSONB;
BEGIN
  EXECUTE format('REVOKE ALL ON agent_profile_uploads FROM %I', r);
  FOR p IN SELECT id, name, description, status, version, config FROM agent_profiles
            WHERE config ?| ARRAY['instructions', 'model', 'provider', 'budget_usd', 'ceiling_usd', 'max_turns', 'wake_max_minutes', 'tools', 'web', 'files', 'roles', 'credentials', 'overrides']
            ORDER BY id FOR UPDATE LOOP
    c := p.config;
    n := '{}'::jsonb;
    dropped := ARRAY[]::TEXT[];
    IF c ? 'model' AND jsonb_typeof(c->'model') = 'string' THEN
      n := n || jsonb_build_object('inference', jsonb_build_object('provider', coalesce(c->>'provider', 'anthropic'), 'model', c->>'model'));
    ELSIF c ? 'provider' THEN
      dropped := array_append(dropped, 'provider (without a model)');
    END IF;
    IF jsonb_typeof(c->'credentials') = 'array' AND jsonb_array_length(c->'credentials') > 0 THEN
      n := n || jsonb_build_object('keys', (SELECT jsonb_agg(jsonb_build_object('kind', 'workspace', 'name', x)) FROM jsonb_array_elements_text(c->'credentials') x));
    END IF;
    IF c ? 'web' THEN
      web_tools := coalesce(c->'web'->>'tools', 'off');
      hosts := CASE WHEN jsonb_typeof(c->'web'->'hosts') = 'array' THEN c->'web'->'hosts' ELSE '[]'::jsonb END;
      IF web_tools IN ('fetch', 'search') AND jsonb_array_length(hosts) > 0 THEN
        n := n || jsonb_build_object('governance', jsonb_build_object('egress_approvals', true, 'web', jsonb_build_object(
          'enabled', true, 'web_search_enabled', web_tools = 'search', 'web_fetch_enabled', true,
          'web_fetch_allowed_domains', (SELECT jsonb_agg(h ORDER BY h) FROM (SELECT DISTINCT lower(x) AS h FROM jsonb_array_elements_text(hosts) x) d), 'max_calls', 20)));
      ELSIF web_tools = 'off' THEN
        n := n || jsonb_build_object('governance', jsonb_build_object('egress_approvals', true, 'web', jsonb_build_object(
          'enabled', false, 'web_search_enabled', false, 'web_fetch_enabled', false, 'web_fetch_allowed_domains', '[]'::jsonb, 'max_calls', 0)));
      ELSE
        dropped := array_append(dropped, 'web (it asked for every host: a governance policy names its hosts)');
      END IF;
    END IF;
    dropped := dropped || ARRAY(SELECT k FROM unnest(ARRAY['instructions', 'budget_usd', 'ceiling_usd', 'max_turns', 'wake_max_minutes', 'tools', 'files', 'roles', 'overrides']) k WHERE c ? k);
    UPDATE agent_profiles SET config = n, version = version + 1, updated_by = 'the platform (mold_v0-267)', updated_at = now() WHERE id = p.id;
    INSERT INTO agent_profile_versions (profile_id, version, name, description, config, created_by)
      VALUES (p.id, p.version + 1, p.name, p.description, n, 'the platform (mold_v0-267)');
    INSERT INTO agent_profile_changes (profile_id, version, action, changed_by, before, after)
      VALUES (p.id, p.version + 1, 'migrated', 'the platform (mold_v0-267)',
              jsonb_build_object('name', p.name, 'description', p.description, 'status', p.status, 'config', c),
              jsonb_build_object('name', p.name, 'description', p.description, 'status', p.status, 'config', n, 'dropped', to_jsonb(dropped)));
  END LOOP;
END $mig$;
