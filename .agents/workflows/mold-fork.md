# Workflow: mold-fork

Input: base mold, new mold id, capability list from `state/factory.json`.

1. Copy `molds/<base>/codebase` to `molds/<new>/codebase`; write `MOLD.md` with base + commit.
2. For each capability, a `mold-engineer` writes a design note `molds/<new>/design/<capability>.md` (scope, data model changes, tests to add to which lane).
3. Operator reviews notes, then implementation tasks (already in the backlog) get `in_progress` one at a time.

**Do not fork a mold to stamp an application.** A fork is only for a new general-purpose platform capability (the mold_v2 and mold_v3 capability lists). An application's own subagents, instructions and helpers are a pack (`packs/<pack_id>/`, `.claude/scripts/packs.py`, the `subagent` skill). A base-code change a vertical needs is a pull request to the mold's upstream, followed by a snapshot refresh.
