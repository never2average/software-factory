-- When each workspace credential was last received (mold_v0-239; src/credentials.ts touched): by a run of the pack's
-- job kinds (runCredentials, at delivery, never while only redacting what a run wrote) or the shell's own use of a
-- workspace value (workspaceCredentialValue: an external API repository's header). The console shows it beside when
-- the value was set ("Last used"), on Settings › Credentials and on a record's own page. Replacing a value clears it.
--
-- A time, never a value or who used it. The table keeps its grants (the tenant role has none: 0007) and its row-level
-- security; nothing is backfilled (a value received before this migration reads "not used yet").
ALTER TABLE workspace_credentials ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
