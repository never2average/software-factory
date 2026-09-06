# Browser session security

Browser sessions are durable provider resources, but their access is always
bound to the verified Eve caller:

- every open, reattach, get, list, close, cap count, page operation and sweep
  carries `orgId` and `principalId`;
- persistent cookies default to `(orgId, customerId, principalId)`; callers must
  explicitly choose `contextScope: "team"` to share cookies across a workspace;
- CDP and live-view bearer URLs are AES-256-GCM encrypted with an org-derived
  `OPS_SECRETS_KEY` and a browser-specific HKDF label;
- a reattach response reports its status but does not replay its live-view URL;
- typed browser action values are never written to the automation audit log;
- idle cleanup runs in the Eve agent deployment that owns
  `BROWSERBASE_API_KEY`, calls the provider first, and marks a row closed only
  after a successful/idempotent release. Failed and crash-interrupted releases
  are retried.

Browser navigation is request/response work rather than a spawned command, so
there is no long-running stdout/stderr stream to cursor. Eve's durable session
id plus the database browser-session id provide reattach identity. If a future
browser tool starts background processes, it must add durable process ids,
cursor-based output reads, status/reboot detection and command redaction then;
an in-memory stream would not be a durable substitute.

## Required environment

The Eve agent project needs both `BROWSERBASE_API_KEY` and
`OPS_SECRETS_KEY` (or the applicable versioned key). `BROWSER_LOCAL=1` is only
for local development and still requires `OPS_SECRETS_KEY`, because local CDP
URLs are capabilities too.

## Migration contract

Before deploying, migrate existing browser rows transactionally:

1. stop new browser opens;
2. release or expire every legacy open session (legacy plaintext URLs should
   not be copied forward);
3. backfill `org_id` and `principal_id`, or close/delete rows whose owner cannot
   be proven;
4. replace plaintext `connect_url`/`live_view_url` with the encrypted envelope
   columns and make organization/principal fields non-null;
5. replace the customer-only browser-context key with the composite unique key
   `(org_id, customer_id, scope_key)`; the migration marks legacy shared
   contexts as audited `team` scope to preserve their prior semantics, while
   every newly created context defaults to principal-private scope;
6. make browser credential identity `(org_id, customer_id, site_origin)` and
   scope allow-list indexes by organization;
7. remove the legacy dashboard sweep cron after the Eve schedule is live.

Run the focused pure regression check with:

```sh
node --experimental-strip-types scripts/test-browser-security.mjs
```
