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

## workspace (not a surface item)
Tenancy and people. `org` is the `orgs` row (`fde:new-org`); `fde_self` the operator identity (`fde:onboard-self`, also the `--email` every configure script runs as); `members` are `org_members` (`owner`, `admin`, `engineer`, `member`); `platform_admins` who may create orgs; `roster` is `people_roster` with `manager_email` as the reporting line and `escalations[]` as the fan-out; `customers` map to `fde:new-customer` plus `internal_staff` and `customer_stakeholders`.

## surface.primary_context
What the agent knows. For an fde-agent that is customer agreements, product offerings and rollout case studies, not the org row.

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
| `library.install` | the 13 scripts in `scripts/fde/workflows/`, installed by `provisionWorkspace` on `new-org`; `listed` keeps only `names` |
| `scripts[]` | extra `workflows` rows; give `file` for system-owned ones because `fde:seed-workflows` prunes rows without a backing file |
| `definitions[]` | `workflow_definitions` state machines (`entity`, `stages[].assign`, `transitions[].migrate`); one `is_default` per entity |

## capabilities and runtime env
`application.capabilities` is the source; `infrastructure.runtime_env` is what provision.py writes to the target (`OPS_MULTI_TENANT`, `ENABLE_*`, `MODEL_PROVIDER`). Never edit `runtime_env` by hand.

## clone_of
Set when the app replicates an existing deployment. `datastores.postgres.snapshot` and `datastores.blob.snapshot` say where the data came from; `clone_of.regression` records the diff run against the source. Read-back tools in the mold (`fde:doctor`, `validate-solution`, `context-graph`) print prose, so the regression harness queries Postgres and blob directly.

## Brief hints that fill these blocks
`workspace: <name>`, `fde: <email>`, `members: a@x, b@x`, `primary context: customer agreements, product offerings, rollout case studies`, `multiplayer: sprint planning, onboarding, escalation handling`, `accounts are called patients`, `clone of live`, `fresh database` / `shared database`, `single workspace`, `workflows: all|none`, plus the older `vercel|vm`, `no web search`, `no browser`, `customer: <id>`, `domain: <host>`, `mold_v2`. Everything the brief does not say takes the mold default or a confirmed factory default; nothing is guessed.
