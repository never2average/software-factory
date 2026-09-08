# Context

Existing: `npm run test:prompt-context`, `npm run test:memory`, `npm run test:org-isolation`, `npm run test:qm-hardening`.
Covers: primary_context assembly, multiplayer_context isolation across orgs/workspaces, memory persistence, data-room (dm.md) read/write paths.

## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane context

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`), which is also
where you add one. The runner writes `testing.context` into the application and the report into
`reports/<app_id>-<date>.md`. A check whose precondition is unmet is `skipped` with the sentence
saying what would make it run — the lane can then never be `pass`, only `skipped`.
