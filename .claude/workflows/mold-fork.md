# Workflow: mold-fork

Input: base mold, new mold id, capability list from `state/factory.json`.

1. Copy `molds/<base>/codebase` to `molds/<new>/codebase`; write `MOLD.md` with base + commit.
2. For each capability, a `mold-engineer` writes a design note `molds/<new>/design/<capability>.md` (scope, data model changes, tests to add to which lane).
3. Operator reviews notes, then implementation tasks (already in the backlog) get `in_progress` one at a time.
