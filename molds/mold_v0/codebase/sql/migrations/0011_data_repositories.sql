-- Data repositories (mold_v0-059; src/data-repositories.ts, molds/mold_v0/MOLD.md "Pack and record-area contract"). An
-- area's rows may come from a repository (the workspace store's files, an upstream catalog at a pinned commit): its
-- writer marks each row it writes with the repository's name (`source`) and the fingerprint of what it wrote, so a
-- re-index of the same input writes nothing and a prune removes only rows that repository wrote (a row staff or a
-- workspace wrote by hand has no source and is never pruned). Every write through a door clears both.
-- A sealed area's fingerprint is keyed with the workspace's data key (src/orgcrypto.ts orgMac): it reveals nothing.
-- No grant or policy changes: the columns live in tables already under row-level security (workspace_records) or
-- read-only to the tenant role (platform_records).
ALTER TABLE platform_records ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE platform_records ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS fingerprint TEXT;
