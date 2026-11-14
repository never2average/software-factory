-- An upload's bytes kept in the database when the app has no object store (mold_v0-305; src/agent-profiles.ts
-- storeUploadBytes): a pack's declared recipe files (src/recipes.ts syncDeclaredRecipes: their bytes are the build's
-- own, inline in pack.json) and an agent's recipe proposal, up to one part (4 MiB) each. NULL (every row before, and
-- every upload with an object store): the bytes are the object store's, under agent-profiles/uploads/<id>/, as before.
-- Staff uploads (the parts the console sends) always go to the object store. A column of a platform table that no
-- workspace reads (src/rls.ts NO_ACCESS): nothing to grant.

ALTER TABLE agent_profile_uploads ADD COLUMN IF NOT EXISTS inline_data BYTEA;
ALTER TABLE agent_profile_uploads DROP CONSTRAINT IF EXISTS agent_profile_uploads_inline_check;
ALTER TABLE agent_profile_uploads ADD CONSTRAINT agent_profile_uploads_inline_check
  CHECK (inline_data IS NULL OR (parts = 1 AND octet_length(inline_data) = bytes));
