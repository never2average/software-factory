-- Staff rows on shared areas a repository fills (mold_v0-221; src/record-areas.ts putPlatform and deletePlatform,
-- src/data-repositories.ts applyIndex). A shared row written by staff (no source: provenance staff) over a key its
-- area's repository also writes is an override: it wins, and the repository's own version of the row is kept here
-- (refreshed by every index, never shown as the row) until staff remove the override, which puts it back.
--   {title, data, version, source, fingerprint}: the row as its repository wrote it. NULL: nothing behind the row (a
--   repository's own row, or a key only staff write).
-- Shared rows only. The tenant role's SELECT on the table (0004) covers the column; no customer read selects it.
ALTER TABLE platform_records ADD COLUMN IF NOT EXISTS upstream JSONB;
