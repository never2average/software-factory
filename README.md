# software-factory

Repository for the software factory: agent definitions, state schemas, application molds, and infrastructure.

## Layout

- `.claude/`, `.agents/` — agents, skills, scripts, workflows, sandboxes for Claude Code and generic agent runtimes
- `state/` — factory-wide schema plus per-application schemas (`state/application/<app_id>/`)
- `molds/` — versioned application molds (codebase template + testing suites)
- `infra/` — deployment targets (`vercel/`, `vm/`)
