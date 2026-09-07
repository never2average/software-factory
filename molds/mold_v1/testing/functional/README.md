# Functional

Existing: Playwright `codebase/tests/cards.spec.ts`, `stickloop.spec.ts` (`npm run test:cards`), plus the `test:*` node scripts (dataroom, syncs, alerts, schedules, render, sor, browser-security).
Covers: feature-parity checks for the Claude Code web surface, FDE skills, workflow builder.

## Tenant isolation through a transaction pooler (added for mold_v1-015)

    APP_RW_URL="$(the app's deployed DATABASE_URL)" node .claude/scripts/lib/verify-apprw.mjs

Asserts, on the exact URL the app runs with: `current_user = app_rw`, `rolbypassrls = false`,
`count(pg_policies) > 0`, the wire is encrypted (either Postgres terminated TLS, or the server refuses
a `sslmode=disable` connection — Neon terminates TLS at its proxy, so `pg_stat_ssl.ssl` reads false on
a fully encrypted connection), and that a **transaction-local** `set_config('app.org_id', …, true)`
survives a round trip.

That last one is the assertion that matters for `DATABASE_URL` being a pooled endpoint. Neon's pooled
endpoint is pgbouncer in transaction mode, and it is what the app must use — the mold opens 10 agent +
5 ops backends per serverless instance and the pool size cannot be capped from the URL (`?max=3` still
opened 10). Transaction pooling would break RLS if `app.org_id` were set with `set_config(..., false)`;
`withOrgRls` uses `true`, so it holds. Measured through a transaction pooler:

    no GUC   -> customers: 2
    GUC=orgA -> customers: 1
    GUC=orgB -> customers: 1
    app_rw, no GUC -> connector_secrets: 0        (org_isolation_strict denies when the GUC is unset)
    cross-org INSERT refused: 42501 new row violates row-level security policy for table "customers"

Lane result is a fail if the script exits non-zero. `provision.py` runs the same gate before it writes
`DATABASE_URL` anywhere, so a deploy that would fail this lane cannot happen.
