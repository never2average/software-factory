# Application state: what each field drives in the mold

Four files under `state/application/<app_id>/`, validated by the schemas in `state/application/app_id/` (`factory.py validate` walks nested objects and arrays). Secrets appear by name only.

`application.surface` has one block per service-surface item in `state/factory.json`. Every field maps to something the mold_v1 codebase reads: a table, an env flag, or an `fde:*` script argument. Nothing here is interpreted; if the mold has no knob for it, the schema says so.

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

## surface.primary_context
| Field | Mold |
|---|---|
| `workspace` | `orgs` row: `orgId`, `name`, `branding.displayName`, `googleHostedDomain`, `plan`, `limits`, `blobPrefix` (`fde:new-org`) |
| `entity_vocabulary.account_noun` | **no knob in mold_v1**: "customer" is hardcoded in tables, path templates and tool names. Recorded for the parity audit; mold_v2+ work |
| `agent_profile` | `agent_profiles` row with `email=""` (workspace default): persona, tone, instructions, `defaultMode`, model, tool defaults |
| `agent_configs[]` | `agent_configs` rows keyed by subagent directory name under `agent/subagents/` |
| `memories[]` | `memories` rows (`scope`, `entityId`, `key`, `value`, `sensitivity`) |
Per-customer platform, solution and deployment records are in `datainfra.platforms`, `pipelines`, `agents`, `deployments` and map to `fde:configure-platform`, `configure-solution`, `configure-agents`, `configure-infra`.

## surface.multiplayer_context
| Field | Mold |
|---|---|
| `fde_self` | `fde:onboard-self`; also the identity every configure script runs as (`--email`) |
| `members[]` | `org_members` (`owner`, `admin`, `engineer`, `member`); at least one owner |
| `platform_admins[]` | `platform_admins` (who may create orgs) |
| `roster[]` | `people_roster`: `managerEmail` is the reporting line, `escalations[]` the per-condition fan-out |
| `customers[]` | `fde:new-customer` plus `internal_staff` and `customer_stakeholders` |

## surface.custom_workflow_builder
| Field | Mold |
|---|---|
| `library.install` | the 13 scripts in `scripts/fde/workflows/`, installed by `provisionWorkspace` on `new-org`; `listed` keeps only `names` |
| `scripts[]` | extra `workflows` rows; give `file` for system-owned ones because `fde:seed-workflows` prunes rows without a backing file |
| `definitions[]` | `workflow_definitions` state machines (`entity`, `stages[].assign`, `transitions[].migrate`); one `is_default` per entity |

## capabilities and runtime env
`application.capabilities` is the source; `infrastructure.runtime_env` is what provision.py writes to the target (`OPS_MULTI_TENANT`, `ENABLE_*`, `MODEL_PROVIDER`). Never edit `runtime_env` by hand.

## clone_of
Set when the app replicates an existing deployment. `datastores.postgres.snapshot` and `datastores.blob.snapshot` say where the data came from; `clone_of.regression` records the diff run against the source. Read-back tools in the mold (`fde:doctor`, `validate-solution`, `context-graph`) print prose, so the regression harness queries Postgres and blob directly.

## Brief hints that fill these blocks
`workspace: <name>`, `fde: <email>`, `members: a@x, b@x`, `accounts are called patients`, `clone of live`, `fresh database` / `shared database`, `single workspace`, `workflows: all|none`, plus the older `vercel|vm`, `no web search`, `no browser`, `customer: <id>`, `domain: <host>`, `mold_v2`. Everything the brief does not say takes the mold default or a confirmed factory default; nothing is guessed.
