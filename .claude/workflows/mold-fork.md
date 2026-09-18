# Workflow: mold-fork

Input: base mold, new mold id, capability list from `state/factory.json`.

1. Copy `molds/<base>/codebase` to `molds/<new>/codebase`; write `MOLD.md` with base + commit.
2. For each capability, a `mold-engineer` writes a design note `molds/<new>/design/<capability>.md` (scope, data model changes, tests to add to which lane).
3. Operator reviews notes, then implementation tasks (already in the backlog) get `in_progress` one at a time.
4. Subagents are built as full workspaces, one `mold-engineer` per subagent in parallel (`subagent` skill). The forked mold carries its own `eve-*` authoring skills and `scripts/check-subagents.py`. Ask the operator for their rulebook (definitions, source precedence, units, missing-data rules) before writing any subagent.
