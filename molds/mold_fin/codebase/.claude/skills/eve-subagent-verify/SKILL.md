---
name: eve-subagent-verify
description: Prove that a subagent in this eve codebase is complete and wired — structure, skills, scripts' self-tests, schemas, registration, typecheck, build, generated files, and a live smoke turn that leaves an automation_runs row. Use before reporting a subagent task as done, after changing any subagent, when someone says "is the X subagent finished", "prove it works", "why is there no run history", or when adding the subagent checks to the mold's functional testing lane. Gives the exact commands, what each failure means, the evidence to attach, and the lane.json entry shape.
---

# Prove a subagent

A subagent is done when the checks below pass and their output is attached to the task.
"It answered once in the chat" is not evidence: the failure mode of a prompt-only subagent
is the second document, not the first.

Run everything from the codebase root (`molds/mold_fin/codebase`).

## 1. Offline checks, in this order

```bash
python3 scripts/check-subagents.py --self-test      # the checker itself is sound
npm run check:fin-workspace                         # every finlib copy matches its source
npm run check:subagents                             # every workspace subagent; add -- <key> for one
npm run typecheck
npm run build:generated                             # then commit the regenerated files
npm run build                                       # the web front end (next build)
npm run build:eve                                   # the agent bundle (eve build): this is what discovers the subagent
```

| Command | Proves | A failure usually means |
|---|---|---|
| `npm run check:subagents` | the workspace standard, see below | read the message; each names the file and the fix |
| `npm run check:fin-workspace` | `sandbox/workspace/scripts/finlib/` is byte-identical to `scripts/fin-workspace/finlib/` in every subagent in `FIN_SUBAGENTS` | someone edited a copy, or edited the source and did not run `npm run sync:fin-workspace` |
| `<script> --self-test` (run by the checker) | each deterministic script still computes what it claims, with no input files and no third-party parser | a real regression, or a parser imported at module top level instead of lazily |
| `npm run typecheck` | the tool re-exports, `agent.ts`, the hook and the dynamic instructions compile | a wrong export name in a `tools/*.ts` re-export, or a `.ts` specifier where `#lib/x.js` is expected |
| `npm run build` | the web front end builds with the new key in its lists and the regenerated `subagent-meta.generated.ts` | a typo in one of the `app/_components` registration sites |
| `npm run build:eve` | the agent bundle builds. The web app and the agent are separate deployments (`next.config` proxies `/eve/v1/*` to the agent project), so `npm run build` alone never compiles a subagent. eve rejects a subagent without `description`, a subagent/tool name collision, or both `instructions.md` and `instructions.ts` | see `node_modules/eve/docs/reference/project-layout.md`, "Why didn't eve discover my file?" (`npx eve info` lists the discovered surface). If it fails only for a missing provider credential, say so in the task rather than reporting it as passed |
| `npm run check:generated` | `setup/skills`, `agent/lib/workflow-library.generated.ts` and `app/_components/subagent-meta.generated.ts` match their sources | it diffs against `HEAD`, so it only passes **after** the regenerated files are committed; before that, run `npm run build:generated` and review `git status` |

### What `check:subagents` checks

`python3 scripts/check-subagents.py [key ...] [--json] [--timeout N]`. Default scope is
every subagent that has `sandbox/workspace/`, so legacy subagents are not failed; naming a
key checks it regardless. Exit 1 on any failure; warnings (`~`) never fail.

Per subagent: the required files exist and there is no top-level `sandbox.ts`;
`operator-override.ts` and `hooks/usage.ts` are keyed to this subagent; at least six skill
packages, each with a non-empty `description:`, a worked-example heading, and a
`/workspace/scripts/<x>.py` command that exists; every skill is named in `instructions.md`;
every script supports `--self-test`, it exits 0 within the timeout, and the script is
mentioned in `instructions.md` or a skill (helper modules imported by a sibling script are
exempt from the mention, not from the self-test); every `references/...` file a skill points
at exists; every schema parses and has `"type"`; there is a
`validate_*.py`, and every `<name>.jsonl` in `instructions.md` is named by one (unless each
line mentioning it says `read-only`); a rulebook exists here or is referenced by path;
`tools/web_search.ts`, if present, uses the `WEB_SEARCH_ENABLED` gate; the key is in all
seven registration sites; the `finlib` copy matches and the key is in `FIN_SUBAGENTS`.

It cannot check that the skills are *right*. Review them against the format-variation
checklist in eve-subagent-skills, and read each worked example's command output against
what the script really prints.

## 2. A smoke turn that leaves a row

The offline checks cannot see three things: that eve discovered the subagent, that the root
delegates to it, and that its usage hook is keyed and has a `workflows` row to write to.
One delegated turn proves all three.

Preconditions: a deployment (or `npm run dev` with `DATABASE_URL` set), a signed-in
session, and a `workflows` row named `<key>` in the workspace you are signed in to
(eve-subagent-wiring, section 4).

1. In the chat, ask for something only this subagent does, and name it:
   "Use the `<key>` specialist: <a small real request for a company in the data room>".
2. Confirm a delegation card for `<key>` appears and the reply carries citations or an
   explicit `not_found`, not an invented figure.
3. Confirm the row:

```sql
select r.run_key, r.status, r.input_tokens, r.output_tokens, r.duration_ms, r.started_at
from automation_runs r
join workflows w on w.id::text = r.automation_id::text
where w.name = '<key>'
order by r.started_at desc
limit 3;
```

Expected: a row whose `run_key` is `<workflow id>:<turn id>`, `status` `success`, and
non-zero tokens. The same run appears in the Ops Center's run history for the `<key>`
workflow.

| What you see | Cause |
|---|---|
| no row at all | no `workflows` row named `<key>` in this workspace; or `hooks/usage.ts` missing; or the process cached "no such workflow" before the row was added (cold start needed) |
| a row under **another** workflow | `WORKFLOW` in `hooks/usage.ts` still has the key it was copied from |
| row stuck at `running` | the turn was cancelled or crashed before `turn.completed`; read the server log |
| the root answered by itself | `agent.ts` description does not match the request, the subagent is paused in `agent_configs`, or the build did not include it (`eve info`) |
| "web search is not available" | `ENABLE_WEB_SEARCH=false` at build time; correct if that deployment forbids it |

If you cannot reach a database or a deployment, say so in the task. Do not report the
smoke turn as passed. Never ask the operator to run SQL; ask them only for what the
codebase's `AGENTS.md` and the factory's guidance allow, in plain steps.

## 3. Add the checks to the functional lane

`../testing/functional/lane.json` is what a stamped application must pass. It lives outside
this codebase; propose the entries to whoever owns the mold's `testing/` directory rather
than editing it from here. Each element of `checks` has this shape (from
`../testing/lane.schema.json`; `additionalProperties` is false):

| Field | Meaning |
|---|---|
| `name` | required, unique within the lane; becomes the report row |
| `run` | required, one shell command; placeholders `{app_id} {root} {mold} {codebase} {testing} {lane} {date} {url} {report}` |
| `cwd` | `codebase` (default), `testing` or `root` |
| `timeout_s` | default 600; a timeout is a fail |
| `expect` | `exit` (default 0), `stdout` (every regex must match), `stdout_not` (none may match), `skip_on` |
| `requires` | preconditions; unmet means the check is skipped, and a lane with a skipped check is never `pass` |
| `known_defect` | a task id; annotation only, never changes the verdict |
| `why` | one sentence: what a failure here actually means |

[`references/lane-entries.md`](references/lane-entries.md) has the three entries to propose
(`check:subagents`, `check:fin-workspace`, `check-subagents.self-test`), ready to paste.
The lane's existing `chat.turn` check is the pattern for a live smoke turn: it runs as a
signed-in person against the deployed URL and is `skipped`, never `pass`, without a session.

## Evidence to attach

- the full output of `npm run check:subagents` (or `--json`)
- the last line of `npm run check:fin-workspace`, `typecheck`, `build` and `build:eve`
- the `automation_runs` row from the smoke turn, or the plain statement that it was not run and why
- the commit hash
