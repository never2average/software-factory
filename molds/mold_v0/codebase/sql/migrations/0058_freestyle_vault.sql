-- Freestyle as a run sandbox provider (mold_v0-274; src/freestyle.ts, src/run-sandboxes.ts freestyleProvider).
-- A platform owner adds the Freestyle API key on the console's Key vault page; the autoscaler reads it to create, list
-- and delete the runs' VMs. Nothing else reads it: it is never handed to a session or a run (src/agent-profiles.ts
-- KEYS_NEVER_INJECTED), and the Key vault page lists the provider only while the runs' sandboxes come from Freestyle
-- (the platform setting APP_RUN_SANDBOX, or the app's profile run_sandbox).
--
--   vault_providers   freestyle: direct mode (the server's own key, no gateway); FREESTYLE_API_KEY on the server is
--                     imported into the vault once, as every provider's key is (src/keyvault-env.ts).

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('freestyle', 'direct', 'https://api.freestyle.sh', 'authorization', 'Bearer ', '{FREESTYLE_API_KEY}')
ON CONFLICT (slug) DO NOTHING;
