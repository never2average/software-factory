# Functional

Existing: Playwright `codebase/tests/cards.spec.ts`, `stickloop.spec.ts` (`npm run test:cards`), plus the `test:*` node scripts (dataroom, syncs, alerts, schedules, render, sor, browser-security).
Covers: feature-parity checks for the Claude Code web surface, FDE skills, workflow builder.

## Tenant isolation (mold_v1-015, rewritten for mold_v1-016)

    python3 molds/mold_v1/testing/functional/tenant-isolation.py <app_id>

Two rows, both required, neither satisfiable by a status code. The lane MEASURES; it never repairs.

    | rls.isolation | pass | {"role":"app_rw","superuser":false,"bypassrls":false,"tables_org_scoped":52,
                              "protected":52,"unprotected":[],"open_policies":[],"leaking_policies":[],
                              "policies_executed":52,"policies_unverified":[],"unmeasured":[],
                              "probe_tables":40,"own_org_rows":40,"foreign_rows":0,
                              "cross_org_write":"42501","unset_org_rows":0}
    | rls.health    | pass | the deployed app's own /api/ops/health db detail, with no BYPASSRLS in it

`rls.isolation` runs `provision.py <app_id> --verify-rls --no-repair`, which connects as the app role
on the app's own deployed DATABASE_URL and proves, rather than asserts:

* `current_user = app_rw`, `rolsuper = false` **and** `rolbypassrls = false`. Both flags: a
  `SUPERUSER NOBYPASSRLS` role ignores every policy too, and the app's own health endpoint
  (`app/api/ops/health/route.ts:83`) selects only `rolbypassrls` — measured, it read one foreign row
  while the endpoint would have printed `(RLS enforced)`.
* every `public` base table carrying an `org_id` column has `relrowsecurity` AND `relforcerowsecurity`
  AND at least one policy that scopes by `org_id`, counted from the catalog rather than from a name
  list — and NOT ONE permissive policy that does not, because Postgres OR's permissive policies and a
  single extra `USING (true)` reopens the whole table. `FORCE` is load-bearing: a table's owner
  bypasses a merely-ENABLED policy.
* every permissive policy is then **executed**, one at a time, against rows the check owns on a temp
  copy of its table's columns (`lib/rls-policy.mjs`), because reading a predicate is not running it:
  `USING ((org_id = current_setting('app.org_id', true)) OR true)` names `org_id`, names the GUC,
  satisfies every text rule above and still hands over another workspace's rows. Measured on
  `tickets`, which the live probe below must skip for its foreign keys. `policies_executed` says how
  many ran; `leaking_policies` must be empty, and a policy that could not be run is reported in
  `policies_unverified` rather than counted as a pass.
* on EVERY probe-eligible table (40 of 52 on this schema; the other 12 are named in `probe_skipped`
  with the reason, and covered by the execution pass above), a cross-workspace read returns **0 rows**
  while the same row is visible in its own workspace (so the check can never pass vacuously), a
  cross-workspace INSERT is refused with SQLSTATE **42501**, and —
  when the app declares `fail_closed` — a query with `app.org_id` set to the EMPTY STRING (what a
  transaction pooler leaves behind, not NULL) returns nothing. All inside one rolled-back transaction.
* the wire is encrypted and a transaction-local `set_config('app.org_id', …, true)` survives a round
  trip — which is what makes RLS hold through Supavisor:6543 and Neon's pooled endpoint.

READ THIS BEFORE TRUSTING A GREEN LINE HERE. The first version of this gate asked only
`count(pg_policies) > 0`; the second asked what the predicates SAID. Run verbatim against an as-shipped database, the mold's own bootstrap prints
`app_rw BYPASSRLS : false`, `policies : 17`, `tables app_rw cannot SELECT: 0` and concludes **READY** —
on a database where 35 of 52 org-scoped tables have no policy at all and the other 17 fail OPEN. The
check passed and the database still leaked. The second version passed too — on a database carrying
`CREATE POLICY tickets_scope ON tickets USING ((org_id = current_setting('app.org_id', true)) OR true)`,
which reads as scoped and is not, while `app_rw` scoped to one workspace read another's row. That is
why the row above quotes counts, a SQLSTATE, and how many policies were actually RUN, instead of a
word.

`rls.health` exists because the stored `DATABASE_URL` passing the gate is a different fact from the
RUNNING build using it: a Vercel env change only takes effect on the next build. The mold's `checkDb`
returns the BYPASSRLS warning as a `detail` string on a resolved (`ok: true`) check, so neither the
aggregate `ok` nor the HTTP status moves — which is how this lane once printed

    | health.db | pass | ok=true, 94-123 ms: "SELECT 1 ok · role postgres — WARNING: BYPASSRLS,
                                              row-level security is NOT enforced..."

The row reads the body, so that reading is now a `fail`.

An app whose `datastores.postgres.rls` is `"off"` gets `skipped`, not `pass`. `provision.py` runs the
same proof before it writes `DATABASE_URL` anywhere and records the result in
`datastores.postgres.rls_verified`; `factory.py validate` refuses `"rls": "fail_closed"` on a stamped
app without matching evidence, so a deploy that would fail this lane cannot be recorded as shipped.

### What the coverage pass fixes, and why it is not in the mold

`.bootstrap-supabase.mjs` policies a hardcoded 13-name list plus `connector_secrets`; the schema
carries `org_id` on 52 tables. `molds/*/codebase` is immutable (HARD RULE 1), so
`.claude/scripts/lib/rls-cover.mjs` applies `ENABLE` + `FORCE` + the mold's own `org_isolation`
predicate to whatever the catalog says is org-scoped, and provision.py/clone.py run it after the
bootstrap and after every migration. It is needed more often than it looks: measured on a real
database, `npx drizzle-kit push --force` takes `policies 52 -> 0` and `relrowsecurity 52 -> 0` while
leaving app_rw's DML grants in place, and `pg_restore --clean --if-exists` takes
`has_table_privilege('app_rw','orgs','SELECT') t -> f` and `pg_default_acl 2 -> 0` rows.

The coverage pass never drops a policy the application may depend on (the mold ships one deliberate
`USING (true)` on `login_codes`, a table with no `org_id`), but it refuses to certify one either: an
open or leaking policy is reported by name with the `DROP POLICY` that would fix it, and the pass
exits non-zero.

`orgs`, `org_members` and `org_invites` keep the permissive predicate even in fail_closed mode: they
are read before any workspace is known (sign-in, "which workspaces am I in", claiming an invite,
`acrossOrgsRls`'s sweep). They are still enabled, forced and policied, so they are scoped once a
workspace IS in scope. That exemption is printed on every run, in `control_plane`.


## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane functional

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`), which is also
where you add one. The runner writes `testing.functional` into the application and the report into
`reports/<app_id>-<date>.md`. A check whose precondition is unmet is `skipped` with the sentence
saying what would make it run — the lane can then never be `pass`, only `skipped`.
