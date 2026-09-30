# Context

Existing: `npm run test:prompt-context`, `npm run test:memory`, `npm run test:org-isolation`, `npm run test:qm-hardening`.
Covers: primary_context assembly, multiplayer_context isolation across orgs/workspaces, memory persistence, data-room (dm.md) read/write paths.

## Which copy a check runs in (mold_v1-146/147)

The mold's own offline tests (`npm run test:*`, `cwd: "default_profile"` in [`lane.json`](lane.json)) are written
against the DEFAULT deployment profile: they pin its wording, its tool arguments and its record fields, and upstream
CI runs them on nothing else. For an application with packs they therefore run in `build/<app_id>.lane-default/`
(the mold plus the packs' code, WITHOUT the packs' `profiles/`), rebuilt by `packs.py lane-copy` every run; for one
without packs, in the mold. Run on a relabelling profile they failed by design, not because anything was broken:
on onfinance_hfc `test:custom-fields` read "workspace's profile" for "deployment's", `test:workbook-spec` counted the
pack's `notes` column (39, pinned 38), `test:schedules` read `customerId` from a result the model is shown as
`companyId`, and `test-vision-tool.mjs` looked for a zod `.shape` on a tool whose schema the model is given as JSON
Schema. Each was probed on the pack build and the product was right.

Checks that grade what THIS application ships keep `cwd: "codebase"` (`build/<app_id>.lane/`, the app's own
profile): its subagents and shared helpers, its tenancy scan, its rendered cards, its live URL — and, in the context
lane, `vocabulary`, the agent-vocabulary gate in pack mode over what its model reads.

## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane context

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`), which is also
where you add one. The runner writes `testing.context` into the application and the report into
`reports/<app_id>-<date>.md`. A check whose precondition is unmet is `skipped` with the sentence
saying what would make it run — the lane can then never be `pass`, only `skipped`.

## Running as the application

`test:org-isolation` is meaningless as a BYPASSRLS role, so its check declares `app_env: ["DATABASE_URL"]`: the runner reads this app's own `DATABASE_URL` (the `app_rw` role) by name from where the app's state says it lives — the Vercel project's env for a deployed app, `infra/vm/apps/<app>/.env` for a vm fixture — and places it in the check's environment. The value is never printed or stored; the report shows the name. Nothing has to be copied into `.env.local`. If the app is not deployed yet the check is `skipped` with the deploy command, never failed.
