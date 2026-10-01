# Application state: what each field drives in the mold

Four files under `state/application/<app_id>/`, validated by the schemas in `state/application/app_id/` (`factory.py validate` walks nested objects and arrays). Secrets appear by name only.

`application.surface` has one block per service-surface item in `state/factory.json`. Every field maps to something the mold_v1 codebase reads: a table, an env flag, or an `operator:*` script argument. Nothing here is interpreted; if the mold has no knob for it, the schema says so.

## surface.dm.md
| Field | Mold |
|---|---|
| `top_level` | `agent/lib/dataroom-schema.ts` `dataroomDomainSchema` (seven folders in `dm.md` plus `Uploads`) |
| `system_of_record` | always `postgres`; blob holds the files, Postgres the rows |
Physical wiring (backend, blob prefix, platform version ids, seed source) lives in `datainfra.dataroom`.

## surface.browser, surface.web_search
| Field | Mold |
|---|---|
| `enabled` | `ENABLE_BROWSER` / `ENABLE_WEB_SEARCH`, read at `eve build` time (`agent/lib/feature-flags.ts`); flipping requires a rebuild |
| `default_on_for_agent` | `agent_profiles.browserDefault` / `webSearchDefault` |
| `browser.local` | `BROWSER_LOCAL` runtime env |

## workspace (not a surface item)
Tenancy and people. `org` is the `orgs` row (`operator:new-org`); `operator_self` the operator identity (read under its pre-rename name `fde_self` for one release) (`operator:onboard-self`, also the `--email` every configure script runs as); `members` are `org_members` (`owner`, `admin`, `engineer`, `member`); `platform_admins` who may create orgs; `roster` is `people_roster` with `manager_email` as the reporting line and `escalations[]` as the fan-out; `customers` map to `operator:new-customer` plus `internal_staff` and `customer_stakeholders`.

## surface.primary_context
What the agent knows. For the upstream fde-agent that is customer agreements, product offerings and rollout case studies, not the org row.

| Field | Mold |
|---|---|
| `corpus[]` | One entry per body of knowledge, each a `dataroom_path` template from `dm.md` (validated by `DATAROOM_PATH_TEMPLATES` in `agent/lib/dataroom-store.ts`). `kind` names it, `sync` says how it arrives, `live_files` is what extract counted on the source |
| `instructions` | `agent_profiles` workspace default row (`instructions`, `persona_name`, `tone`, `default_mode`, `model`) and `agent_configs` per subagent under `subagents[]` |
| `memory` | `memories` table: allowed `scopes`, `sensitivity_ceiling`; `live_keys` from extract |
| `entity_vocabulary.account_noun` | **no knob in mold_v1**: "customer" is hardcoded. Recorded for the parity audit |

Corpus kinds and their mold locations: `customer_agreements` Customers/{customer_id}/agreements/; `customer_context` Customers/{customer_id}/context.md; `customer_personas` Customers/{customer_id}/personas.jsonl; `customer_interactions` Customers/{customer_id}/interactions.jsonl; `product_offerings` Solutions/{platform_version_id}/; `platform_design` Platform/{platform_version_id}/design_decisions/; `rollout_case_studies` Deployments/{customer_id}/{platform_version_id}/; `implementation_history` Implementation/{customer_id}/migrations/{migration_id}/context.md; `tickets` Tickets/{ticket_folder}/{customer_id}/; `people_context` People/{person_id}/context.md; `custom` Uploads/ with a description.

## surface.multiplayer_context
How people work together: sprint planning, onboarding, escalation handling, expressed as processes mapped to mold features.

| Field | Mold |
|---|---|
| `processes[]` | `name` from a fixed list (or `custom` with `label`), `implemented_by[]` pointing at `workflow_script` (workflows table / library), `workflow_definition` (state machine by entity or id), `recipe` (onboarding recipes), `cycles` (sprints: planning, active, closed, lead, capacity, rollover via /api/ops/cycles), `todos`, `roster_escalations`, `ticket_folder`, `schedule_rule`. Extract marks each `present` on the source; an empty or all-absent list is a parity gap |
| `escalation` | `roster_escalations` fan-out or PagerDuty through the `route-incident` workflow; `ticket_folders` the Tickets/ folders in use |
| `collaboration` | chat threads, presence, comments, inbox: mold constants |

Default processes for mold_v1: sprint_planning (cycles, todos, task definition), onboarding (five recipes, onboard-account, assign-account), escalation_handling (roster escalations, route-incident, bug tickets), incident_postmortem, go_live (go-live-sprint, infra-sizing, infosec-checklist), account_review (qbr-prep).

## surface.custom_workflow_builder
| Field | Mold |
|---|---|
| `library.install` | the 13 scripts in `scripts/operator/workflows/`, installed by `provisionWorkspace` on `new-org`; `listed` keeps only `names` |
| `scripts[]` | extra `workflows` rows; give `file` for system-owned ones because `operator:seed-workflows` prunes rows without a backing file |
| `definitions[]` | `workflow_definitions` state machines (`entity`, `stages[].assign`, `transitions[].migrate`); one `is_default` per entity |

## datastores.postgres
| Field | Meaning |
|---|---|
| `provider` | `neon` (default, free), `supabase`, `rds`, `self_hosted`. Drives which provisioner `provision.py` runs and which secret NAMES the app declares |
| `rls` | what the application ASKS for: `fail_closed` (multi-workspace: no workspace in scope means zero rows), `on` (policies enforced but permissive with no workspace set), `off` (no isolation). Written by intake from `tenancy`, never a constant. `fail_closed` and `on` are GATES — `provision.py` will not finish a deploy it cannot prove, and `factory.py validate` refuses either value on a deployed app with no matching evidence |
| `rls_verified` | the EVIDENCE for that ask, written only by a live measurement (`provision.py --deploy` / `--verify-db` / `--verify-rls`; `clone.py` reads it and never writes it) — never by hand. It names the role measured (`app_rw`, `superuser` and `bypassrls` both false), the `backend` it was measured on (a proof against the local database is not a proof about the Neon one), how many org-scoped tables were enabled+forced+policied, which permissive policies do not scope by `org_id` or leaked when executed, how many tables the cross-workspace probe actually ran on and which it skipped and why, `foreign_rows_readable` (must be 0), `cross_org_write` (must be SQLSTATE `42501`), `unset_org_rows` for `fail_closed`, and `running_app` — what the build in front of traffic says on `/api/ops/health`, which is a different fact from the stored credential passing the gate |
| `url_ref` | always `DATABASE_URL` — `agent/lib/db/index.ts:34` says "DATABASE_URL is the ONLY source. There is deliberately no POSTGRES_URL" |
| `admin_url_ref` | the secret NAME of the URL with DDL rights: `DATABASE_URL_UNPOOLED` (neon), `SUPABASE_POSTGRES_URL_NON_POOLING` (supabase), `POSTGRES_ADMIN_URL` (self_hosted). Never `DATABASE_URL` after the bootstrap — that is `app_rw`, which owns nothing, and `pg_restore --clean` against it fails `must be owner of table orgs` |
| `sslmode` | `require`. The runtime clients pass no `ssl` option, so this query parameter on `DATABASE_URL` is the only thing that turns TLS on |
| `pooling` | `transaction` when `DATABASE_URL` is a transaction pooler (Neon's pooled endpoint, Supavisor:6543). Safe for RLS because `app.org_id` is set with `set_config(..., true)`, which is transaction-local; `verify-apprw.mjs` asserts that round trip on every deploy |
| `exposure` | `managed_provider` or `private_docker_network`. There is no public-port option, by design |
| `network` / `host` / `port` / `database` | `self_hosted` only: the app's own docker network (`sf-<app_id>`), the host alias `db`, and port 6543 INSIDE the container — no host port is ever published, so `.bootstrap-supabase.mjs`'s hardcoded `port = "6543"` is a no-op instead of a workaround. `provision.py` refuses to pair `self_hosted` with `target: vercel`: a Vercel function cannot reach a private docker network, and the only way to let it would be to open Postgres to the internet. Brought up by `.claude/scripts/lib/localpg.py` (TLS on, self-signed cert) through `infra/vm/apps/<app_id>/docker-compose.yml`; both refuse to start a config that publishes a port |

**One Postgres cluster per app, never one database per app.** `app_rw` is a cluster-global role whose
name is hardcoded across the mold, so stamping app #2 into a second database on app #1's cluster
rotates app #1's password. Measured, not assumed: `app_two credential -> app_one DATABASE: OK`
(read confidential rows, wrote one), and a silent `ALTER ROLE app_rw` broke app #1's live deployment
with `FAIL 28P01`. See `infra/vm/README.md`.

## infrastructure.vercel
Closed (`additionalProperties: false`, mold_v1-057) and present only when `target` is `vercel`; a `target: vm` app
carries a `vm` object instead and never a URL (mold_v1-053). Keys: `team`, `project` (the web project; the api and
workflow projects are `<project>-api` / `<project>-workflow`), `production_url`, `api_url`, `workflow_url` (the three
deployment URLs, written by `provision.py --deploy`), `custom_domain`, `functions`, `crons` (`stripped
(shared_with_live)` when the deploy wrote a `vercel.nocron.json`), and `health` — the deploy's own verdict on the
three health endpoints (`workflow`, `api`, `web`), each the HTTP status as a string (`"200"`) or `"no answer"`,
written by `--deploy` and carried across a re-intake by `intake.py`, never by hand. A status code there is not proof
of isolation: that verdict is `datastores.postgres.rls_verified`.

## application.testing and application.status
`testing` holds the last result per lane — `{status, run_at, report}` for each of `functional`, `context`,
`load`, `accessibility`, `responsiveness`, and `additionalProperties: false`, so a sixth lane has nowhere
legal to live until the schema says otherwise. `status` is one of `pending`, `pass`, `fail`, `skipped`;
`skipped` (not `pass`) is what a lane gets when a check could not run, and `report` points at the markdown
under `molds/<mold_id>/testing/<lane>/reports/`.

`.claude/scripts/lanes.py` is the ONLY writer of this block, and the only `application.status` it may write
is `reverted` — which it does, plus a task against the mold, on any lane failure. Promotion to `stamped`,
`testing` or `serviceable` stays with the operator. A `--dry-run` writes neither, and its reports go to
`<lane>/reports/dry/` headed DRY RUN so an unrecorded verdict cannot sit in the archive.

What a lane needs from state, declared per check in the lane's `lane.json` rather than in the runner:
`infrastructure.vercel.production_url` (accessibility, responsiveness, and the functional `rls` row all
grade the deployed app; the two browser lanes read it through `<lane>/lane-url.py`, which for a `target: vm`
fixture accepts a loopback `MOLD_V1_LANE_URL` instead — `docs/RUNBOOK.md` §7), `datastores.postgres.rls` (the `rls` row is skipped when it is `off`), and
`application.clone_of.ref` (the context lane's `clone.regression` row only applies to a replica).

## capabilities and runtime env
`application.capabilities` is the source; `infrastructure.runtime_env` is what provision.py writes to the target (`OPS_MULTI_TENANT`, `ENABLE_*`, `MODEL_PROVIDER`). Never edit `runtime_env` by hand.

## clone_of
Set when the app replicates an existing deployment. `datastores.postgres.snapshot.cleared_sealed_rows` records the `connector_secrets` / `browser_credentials` rows the restore dropped: they were sealed under the source app's `OPS_SECRETS_KEY`, which is minted per app and never copied (`docs/HOW_IT_WORKS.md`, Secrets). A non-clone app restores nothing and starts with no connectors; enter them in the app. `datastores.postgres.snapshot` and `datastores.blob.snapshot` say where the data came from; `clone_of.regression` records the diff run against the source. Read-back tools in the mold (`operator:doctor`, `validate-solution`, `context-graph`) print prose, so the regression harness queries Postgres and blob directly.

## Brief hints that fill these blocks
`workspace: <name>`, `operator: <email>`, `members: a@x, b@x`, `primary context: customer agreements, product offerings, rollout case studies`, `multiplayer: sprint planning, onboarding, escalation handling`, `accounts are called patients`, `clone of live`, `fresh database` / `shared database`, `single workspace`, `workflows: all|none`, plus `neon` / `supabase` / `self-host the postgres`, and the older `vercel|vm`, `no web search`, `no browser`, `customer: <id>`, `domain: <host>`, `mold_v2`. Everything the brief does not say takes the mold default or a confirmed factory default; nothing is guessed.
