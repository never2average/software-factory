# mold_v1

**Status:** active
**Source:** the mold's source (its address: `mold_sources.mold_v1` in `state/factory.local.json`) @ 20ebafc (`main`, snapshot 2026-10-09; PRs #13-#82, #84-#142): subagent packs, CI checks, deployment profile, subagent workspace inheritance + thread sharing + PDF viewer + per-role models, settings on the active workspace + Invite agents)

**Node:** 24.x (package.json engines; VM and Vercel project both on 24)
**Target model:** GLM 5.2 via OpenAI-compatible provider
**Definition (Factory 1 diagram):** multi-workspace, multi-agent Claude Code web at feature parity application that is purely vanilla and works with GLM 5.2.

## Contents

- `codebase/` — verbatim snapshot of the mold's source (eve framework + Next.js 16 + Drizzle/Postgres (Supabase in the live deployment) + Vercel Blob data room). `.git`, `node_modules`, `test-results`, `.next` excluded. Not in the factory's repository (git-ignored): `mold.py fetch mold_v1` puts it on a machine.
- `testing/` — the five test lanes the factory runs against a stamped application. Each lane README maps to what the codebase already provides and what is still to be written.

## Service surface (what the factory operator gets from a stamped app)

| Surface | Where in codebase |
|---|---|
| dm.md (data-room tree) | `codebase/dm.md`, `codebase/docs/OPERATOR_WORKFLOW.md` |
| browser (optional) | `ENABLE_BROWSER` build-time flag, browser subagent |
| web search (optional) | `ENABLE_WEB_SEARCH` build-time flag (Exa) |
| primary_context | `codebase/agent/instructions/`, memory + prompt-context |
| multiplayer_context | chat threads/presence, org tenancy, RLS |
| custom workflow builder | task-workflow service, workflow definitions/library |

## Packs

This mold is a general-purpose checkpoint and is never forked to stamp an application. An application's own code (subagents, a root-instructions section, shared sandbox helpers) is a pack under `packs/<pack_id>/`, applied to `build/<app_id>/` by `.claude/scripts/packs.py`. The codebase supports this since 95777a6: subagents are discovered (`scripts/gen-subagent-meta.mjs`, `docs/SUBAGENT_PACKS.md`), and it carries its own `eve-*` authoring skills and `scripts/check-subagents.py`.

## Fetching and refreshing the snapshot

```
python3 .claude/scripts/mold.py fetch mold_v1      # the pinned commit (molds[].source.commit in state/factory.json)
python3 .claude/scripts/mold.py refresh mold_v1    # the source's current main; records the new pin
python3 .claude/scripts/mold.py check mold_v1      # compare the snapshot with the pin; writes nothing
```

Where the source lives is this machine's own: `state/factory.local.json` → `mold_sources` → `{"mold_v1": "<git URL>"}`
(never committed; `state/factory.local.example.json` shows the shape). `mold.py` shallow-clones the source into a
temporary directory at the pinned commit (or, for `refresh`, at `main`), verifies the commit it got, and copies it into
`codebase/` with `rsync -a --delete`, excluding `.git`, `node_modules`, `test-results` and `.next` (an installed
`node_modules` in the snapshot survives). `refresh` then writes the new commit and today's date into
`molds[].source.commit` / `snapshot_date` in `state/factory.json` (lanes.py prints that commit in every report header)
and into the **Source** line above. Every run ends with the proof that the snapshot is the source: the two compared
file by file with the same excludes, `codebase/.next` absent, and the word IDENTICAL; anything else exits non-zero
and names the differences.

The snapshot is only ever written by `mold.py`. The mold's own scripts write INTO their cwd when the
functional lane runs them — `next dev` (the `test:cards` Playwright webServer) rewrites `next-env.d.ts` to import
`./.next/dev/types/routes.d.ts` and writes `.next/dev/` and `test-results/`; `test:dataroom` / `test:syncs` scratch
under `.dataroom/` — so `testing/functional/lane.json` wraps those three checks to put the file back and remove the
directories, with the test's own exit status. Each wrapped test runs under an inner `timeout` shorter than the
check's `timeout_s`, because lanes.py kills the whole shell on its own timeout and the cleanup would never run.
That inner timeout does not reach the `next dev` server Playwright spawns detached, so the `test:cards` wrapper
also kills it (by the snapshot's own `next` path, then any port-3000 listener whose cwd is this snapshot — never a
server an operator started elsewhere) and removes the chromium profiles that run left under `/tmp` before removing
`.next/`; otherwise the orphan re-creates `.next/` and the next run adopts it (`reuseExistingServer: true` in
playwright.config.ts).
A clean clone has no `.next/` at all (it is gitignored and excluded from the rsync, so a refresh never clears it):
the proof asserts it is absent. If `mold.py check mold_v1` ever shows `next-env.d.ts`, or `.next/` exists between runs, a
run wrote into the snapshot outside those wrappers: `mold.py fetch mold_v1` restores the file; remove the directory by hand.
