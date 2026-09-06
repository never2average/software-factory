# mold_v1

**Status:** active
**Source:** github.com/never2average/fde-agent @ dc98cb6c0c25ef81304fb6cf1db172396e62b805 (main, snapshot 2026-09-06)
**Target model:** GLM 5.2 via OpenAI-compatible provider
**Definition (Factory 1 diagram):** multi-workspace, multi-agent Claude Code web at feature parity application that is purely vanilla and works with GLM 5.2.

## Contents

- `codebase/` — verbatim snapshot of the fde-agent repo (eve framework + Next.js 16 + Drizzle/Neon + Vercel Blob data room). `.git`, `node_modules`, `test-results` excluded.
- `testing/` — the five test lanes the factory runs against a stamped application. Each lane README maps to what the codebase already provides and what is still to be written.

## Service surface (what the factory operator gets from a stamped app)

| Surface | Where in codebase |
|---|---|
| dm.md (data-room tree) | `codebase/dm.md`, `codebase/docs/FDE_WORKFLOW.md` |
| browser (optional) | `ENABLE_BROWSER` build-time flag, browser subagent |
| web search (optional) | `ENABLE_WEB_SEARCH` build-time flag (Exa) |
| primary_context | `codebase/agent/instructions/`, memory + prompt-context |
| multiplayer_context | chat threads/presence, org tenancy, RLS |
| custom workflow builder | task-workflow service, workflow definitions/library |

## Refreshing the snapshot

```
git clone --depth 1 git@github-fde:never2average/fde-agent.git /tmp/fde-agent
rsync -a --delete --exclude .git --exclude node_modules --exclude test-results --exclude .next /tmp/fde-agent/ molds/mold_v1/codebase/
```
Then update the commit hash above.
