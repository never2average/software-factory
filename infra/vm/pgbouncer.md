# Fallback: a pgbouncer appliance in front of a self-hosted cluster

**Not in use.** The committed database is Neon on the Vercel Marketplace (free). This file exists so
that if Neon's free tier is ever exhausted the way Supabase's was, the factory has a tested shape to
fall back to instead of re-deriving it under pressure. It is also the honest answer to the one real
objection to choosing Neon: a single free-tier account is a single point of failure.

## Why a pooler is mandatory for any self-hosted production path

The mold opens **10 (agent) + 5 (ops) backends per serverless instance**, and the pool size cannot be
capped from the connection string — postgres.js takes `max` from the code option only, so
`?sslmode=require&max=3` still opened **10** backends. A per-role `CONNECTION LIMIT` is a blast-radius
control, not a throttle: simulating three instances against `CONNECTION LIMIT 20` gave
`queries: 60  ok: 20  rejected: 40`, first failure `too many connections for role "app_two_owner"`.
About six concurrent Vercel instances exhaust a default `max_connections=100`.

## The two gotchas, recorded

1. **uid 70.** In `edoburu/pgbouncer` the process runs as uid 70. A TLS key file that is 0600 root
   makes pgbouncer fail to start with a permissions error that does not name the file. `chown 70:70`.
2. **SCRAM pass-through works from `auth_file`, not from `auth_query`.** With `auth_query` against
   `pg_shadow`/`pg_authid`, login fails with `server login failed: wrong password type`. The working
   shape is a real `auth_file` holding the SCRAM verifier, regenerated from `pg_authid` and reloaded
   (SIGHUP) **after every password rotation** — and `.bootstrap-supabase.mjs` rotates `app_rw` on
   every run unless `APP_RW_PASSWORD` is supplied, which provision.py does supply.

## Shape

- `pool_mode = transaction`. Safe for this app: `withOrgRls` sets `app.org_id` with
  `set_config(..., true)`, which is transaction-local, and both clients run `prepare:false`. Measured
  through a transaction pooler: `no GUC -> customers: 2`, `GUC=orgA -> 1`, cross-org INSERT refused
  `42501`. This is the same property Neon's pooled endpoint relies on.
- pgbouncer terminates TLS to the client and speaks TLS to Postgres.
- Postgres itself stays on the private docker network with no host port; only pgbouncer is published,
  and only behind the `--ctorigdstport` DROP rule described in `README.md` (the `--dport` rule is a
  no-op under Docker).
- Still unsolved by this fallback: no server authentication (`verify-full` needs `ssl: { ca }` in the
  mold), and no static egress IP on Vercel Pro means `hostssl ... 0.0.0.0/0`. Treat it as a way to
  keep stamping in an emergency, not as an equal alternative to a managed provider.
