-- The request an access-log entry keeps (mold_v0-286; src/audit-request.ts, src/audit-trail.ts, the only writer). Each
-- trail's entry gains `request`: the headers and JSON body of the request that made it (an MCP call's tool and its
-- arguments too), masked before it is written and at most 16 KB:
--   kept     every header but the caller's address headers (the entry's ip column has the address, for staff only), the
--            JSON body as sent (a non-JSON body: its type and size only), and a request id shared by its entries
--   masked   "••••": Authorization (its scheme word kept: "Bearer ••••"), Cookie, Set-Cookie, X-Api-Key and any header
--            or body field named for a token, secret, key, password, session, signature or sign-in code (a key's public
--            prefix kept); every value of a sealed area's record and every encrypted or file field of an area the request
--            touched; file contents; values that look like a credential whatever their name; a credential or key
--            vault request's values
-- Read only by the Access log's side panel and its per-entry export: a workspace's owners their own entries' (a staff
-- member's request withheld), platform staff any. Entries written before this migration have none (no backfill). It
-- is kept as long as its entry (audit.retention_days, audit.platform_retention_days) and is not part of the chained and
-- signed fields (src/ledger.ts reads the columns it names). Adding a column fires no row trigger: the tables stay
-- append-only. Rollback: sql/rollback/0064_audit_request_payloads.sql.
ALTER TABLE audit_data_events ADD COLUMN IF NOT EXISTS request JSONB;
ALTER TABLE audit_platform_events ADD COLUMN IF NOT EXISTS request JSONB;
