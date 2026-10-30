-- Object storage settings in the key vault (mold_v0-181; src/storage.ts, src/keyvault.ts OBJECT_STORAGE_PROVIDER).
-- A platform owner who cannot set the server's environment adds the bucket on the console's Key vault page instead of
-- R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY: one entry of four fields (bucket, endpoint, access
-- key id, secret access key), sealed like every vault value. The environment still wins when all four are set there.
--
--   vault_providers   object_storage: where that entry is kept (label "default"; direct mode with no environment
--                     names, so it is never handed to a session or a run and never imported from the environment).

INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES
  ('object_storage', 'direct', NULL, 'authorization', '', '{}')
ON CONFLICT (slug) DO NOTHING;
