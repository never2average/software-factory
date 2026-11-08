-- No upstream catalogs (mold_v0-283; molds/mold_v0/MOLD.md "No upstream catalogs"). The upstream_catalog repository kind
-- is gone: a shared list copied from one GitHub repository at a pinned commit could not be edited by the people who keep
-- it. Shared lists are platform records staff keep with New, Edit and Import. What the catalogs left in a database:
--   1. the shared rows a catalog's index wrote (platform_records with a source) become staff rows: source, fingerprint
--      and version (the catalog's commit) cleared, so staff edit and remove them as any staff row; a staff override
--      drops the catalog's version kept behind it (upstream, 0040: the staff row already wins). Titles and fields stay.
--   2. the catalogs' index state (repository_index, 0019) goes.
--   3. the key vault's private catalogs' access (provider catalog_access, 0051) goes with what it held.
-- Nothing a workspace wrote is touched (workspace_records keeps its sources: the workspace_files repositories stay).
UPDATE platform_records SET source = NULL, fingerprint = NULL, version = NULL WHERE source IS NOT NULL;
UPDATE platform_records SET upstream = NULL WHERE upstream IS NOT NULL;
DROP TABLE IF EXISTS repository_index;
DELETE FROM vault_credentials WHERE provider = 'catalog_access';
DELETE FROM vault_providers WHERE slug = 'catalog_access';
