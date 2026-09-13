# claudecode_web_replica vs live (fde-agent) — pass

run_at: 2026-09-13T10:45:12+00:00  org: org-onfinance-ai  prefix: 

## Tables (row counts)

| table | clone | live | |
|---|---|---|---|
| account_summaries | 0 | 0 | volatile |
| agent_configs | 0 | 0 | ok |
| agent_profiles | 0 | 0 | ok |
| agent_prompt_versions | 0 | 0 | ok |
| app_versions | 7 | 7 | ok |
| apps | 1 | 1 | ok |
| automation_audit | 79 | 79 | ok |
| automation_runs | 6 | 6 | ok |
| browser_allowlist | 0 | 0 | ok |
| browser_contexts | 5 | 5 | ok |
| browser_credentials | 0 | 0 | ok |
| browser_sessions | 8 | 8 | ok |
| chat_presence | 0 | 0 | volatile |
| chat_sessions | 5 | 5 | volatile |
| chat_thread_members | 2 | 2 | ok |
| chat_threads | 1 | 1 | ok |
| chat_turn_authors | 0 | 0 | ok |
| comments | 0 | 0 | ok |
| connector_secrets | 0 | 0 | ok |
| connectors | 0 | 0 | ok |
| customer_stakeholders | 0 | 0 | ok |
| customers | 72 | 72 | ok |
| cycles | 0 | 0 | ok |
| dataroom_changesets | 0 | 0 | ok |
| dataroom_file_versions | 1 | 1 | ok |
| deployments | 3 | 3 | ok |
| entity_activity | 15 | 15 | ok |
| implementation | 11 | 11 | ok |
| inbox_items | 0 | 0 | volatile |
| interactions | 2 | 2 | ok |
| internal_staff | 1 | 1 | ok |
| login_codes | 2 | 2 | volatile |
| memories | 1 | 1 | ok |
| org_invites | 4 | 4 | ok |
| org_members | 8 | 8 | ok |
| orgs | 3 | 3 | ok |
| people_roster | 24 | 24 | ok |
| platform | 0 | 0 | ok |
| platform_admins | 0 | 0 | ok |
| project_workflow_versions | 2 | 2 | ok |
| recipes | 0 | 0 | ok |
| room_presence | 1 | 1 | volatile |
| runtime_env_presence | 22 | 23 | volatile |
| schedule_rules | 1 | 1 | ok |
| solutions | 0 | 0 | ok |
| subagent_runs | 59 | 59 | volatile |
| system_cron_overrides | 0 | 0 | volatile |
| task_workflow_instances | 1 | 1 | ok |
| task_workflow_transition_events | 6 | 6 | volatile |
| tickets | 0 | 0 | ok |
| todos | 1 | 1 | ok |
| workflow_definitions | 2 | 2 | ok |
| workflow_instruction_versions | 3 | 3 | ok |
| workflow_run_journal | 48 | 48 | ok |
| workflow_runs | 11 | 11 | ok |
| workflows | 26 | 26 | ok |

## Surface rows

- orgs: clone=1 live=1 ok
- org_members: clone=5 live=5 ok
- platform_admins: clone=0 live=0 ok
- people_roster: clone=23 live=23 ok
- agent_profiles: clone=0 live=0 ok
- agent_configs: clone=0 live=0 ok
- memories: clone=1 live=1 ok
- workflows: clone=13 live=13 ok
- workflow_definitions: clone=1 live=1 ok
- customers: clone=66 live=66 ok
- internal_staff: clone=1 live=1 ok
- customer_stakeholders: clone=0 live=0 ok
- platform: clone=0 live=0 ok
- solutions: clone=0 live=0 ok
- deployments: clone=0 live=0 ok
- recipes: clone=0 live=0 ok

## Tenant isolation

- declared: `fail_closed` · measured `fail_closed` on neon at 2026-09-13T10:44:26+00:00 (provision.py --verify-rls)
- role `app_rw` superuser=False bypassrls=False
- org-scoped tables enabled+forced+policied: 52/52
- cross-workspace read across 40 probed table(s): 0 row(s) · write refused with `42501`
- policies executed one at a time: 52 · none handed over another workspace's rows
- app in front of traffic (/api/ops/health): `enforced` · SELECT 1 ok · role app_rw (RLS enforced)
- ok

## Blob tree (files, bytes per top-level folder)

prefix '': same clone={'artifacts': {'files': 348, 'bytes': 4554656}, 'dataroom': {'files': 316, 'bytes': 3389098}} live={'artifacts': {'files': 348, 'bytes': 4554656}, 'dataroom': {'files': 316, 'bytes': 3389098}}
