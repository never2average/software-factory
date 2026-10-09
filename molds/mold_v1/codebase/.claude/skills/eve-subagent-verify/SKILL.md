---
name: eve-subagent-verify
description: "Prove that a subagent in this eve codebase is complete and wired: structure, skills, scripts' self-tests, schemas, the generated registry, shared helper copies, typecheck, both builds, and a live smoke turn that leaves an automation_runs row. Use before reporting a subagent task as done, after changing any subagent or applying a subagent pack, when someone says \"is the X subagent finished\", \"prove it works\", \"why is there no run history\", or when adding the subagent checks to CI. Gives the exact commands, what each failure means, the evidence to attach, and the CI steps."
---

# Prove a subagent

A subagent is done when the checks below pass and their output is attached to the task.
"It answered once in the chat" is not evidence: the failure mode of a prompt-only subagent
is the second document, not the first.

Run everything from the codebase root.

## 1. Offline checks, in this order

```bash
python3 scripts/check-subagents.py --self-test      # the checker itself is sound
npm run sync:subagent-shared                        # only if a shared family or its targets changed
npm run build:generated                             # regenerates the subagent registry (and the other generated files)
npm run check:subagent-shared                       # every shared-family copy matches its source
npm run check:subagents                             # the registry, then every workspace subagent; add -- <key> for one
npm run test:dataroom                               # imports the data-room store: a bad dataroomPaths template throws here
npm run typecheck
npm run build                                       # the web front end (next build)
npm run build:eve                                   # the agent bundle (eve build): this is what discovers the subagent
```

| Command | Proves | A failure usually means |
|---|---|---|
| `npm run check:subagents` | the generated registry is current and the workspace standard holds, see below | read the message; each names the file and the fix |
| `npm run check:subagent-shared` | each `sandbox/workspace/scripts/<family>/` is identical to `scripts/subagent-shared/<family>/` for every subagent in that family's `targets.json` | someone edited a copy, or edited the source and did not run `npm run sync:subagent-shared`, or `targets.json` names a subagent that does not exist |
| `<script> --self-test` (run by the checker) | each deterministic script still computes what it claims, with no input files and no third-party parser | a real regression, or a parser imported at module top level instead of lazily |
| `npm run test:dataroom` | the path templates, including the ones subagents contribute, compile | a `dataroomPaths` entry with an unknown domain or `{token}` |
| `npm run typecheck` | the tool re-exports, `agent.ts`, the hook and the dynamic instructions compile | a wrong export name in a `tools/*.ts` re-export, or a `.ts` specifier where `#lib/x.js` is expected |
| `npm run build` | the web front end builds against the regenerated `subagent-meta.generated.ts` | a stale or hand-edited generated file |
| `npm run build:eve` | the agent bundle builds. The web app and the agent are separate deployments, so `npm run build` alone never compiles a subagent. eve rejects a subagent without `description`, a subagent/tool name collision, both `instructions.md` and `instructions.ts`, or a skill whose frontmatter is not valid YAML | look for `Error:` lines; warnings about unsupported directories under the legacy subagents are pre-existing. See `node_modules/eve/docs/reference/project-layout.md`, "Why didn't eve discover my file?" (`npx eve info` lists the discovered surface). If it fails only for a missing provider credential, say so in the task rather than reporting it as passed |
| `npm run check:generated` | `setup/skills`, `agent/lib/workflow-library.generated.ts`, `app/_components/subagent-meta.generated.ts` and `agent/lib/subagent-registry.generated.ts` match their sources | it diffs against `HEAD`, so it only passes **after** the regenerated files are committed; before that, run `npm run build:generated` twice and confirm the second run changes nothing (`git status --short` is identical) |

### What `check:subagents` checks

`python3 scripts/check-subagents.py [key ...] [--json] [--timeout N]`. Exit 1 on any
failure; warnings (`~`) never fail.

**The registry, always** (every subagent, legacy ones included): both generated files exist
and list exactly the directories under `agent/subagents/` that have `agent.ts` (a missing
or a stale key means `npm run build:subagent-meta` was not run); every `subagent.json` is a
JSON object with only `name`, `summary`, `dataroomPaths`, non-empty strings, and templates
that match the generator's grammar, start with a real data-room domain, use only tokens the
store knows, and are present in `EXTRA_DATAROOM_PATH_TEMPLATES`; the generated templates
hold nothing no `subagent.json` declares; every `scripts/subagent-shared/*/targets.json` is
well formed and names existing subagents; every `agent/**/tools/web_search.ts` uses the
`WEB_SEARCH_ENABLED` gate.

**Per subagent.** Default scope is every subagent that has `sandbox/workspace/`, so the
ten built-in legacy subagents are not failed; naming a key checks it regardless. With none
in scope (the base app) it prints "no workspace-standard subagents yet", checks the
registry only, and exits 0. For each one: the required files exist and there is no
top-level `sandbox.ts`; `operator-override.ts` and `hooks/usage.ts` are keyed to this
subagent; at least six skill packages, each with a non-empty `description:` that is safe as
YAML (double-quoted if it contains `: ` or ` #`), a worked-example heading, and a
`/workspace/scripts/<x>.py` command that exists; every skill is named in `instructions.md`;
every script supports `--self-test`, it exits 0 within the timeout, and the script is
mentioned in `instructions.md` or a skill (helper modules imported by a sibling script are
exempt from the mention, not from the self-test); every `references/...` file a skill points
at exists; every schema parses and has `"type"`; there is a `validate_*.py`, and every
`<name>.jsonl` in `instructions.md` is named by one (unless each line mentioning it says
`read-only`); a rulebook exists here or is referenced by path; `tools/web_search.ts`, if
present, is gated; the key is well formed and present in both generated files; its
`subagent.json` is valid and matches what was generated; every shared family that names it
is present and identical, and it carries no family copy it is not a target of.

It cannot check that the skills are *right*. Review them against the format-variation
checklist in eve-subagent-skills, and read each worked example's command output against
what the script really prints.

## 2. A smoke turn that leaves a row

The offline checks cannot see three things: that eve discovered the subagent, that the root
delegates to it, and that its usage hook is keyed and has a `workflows` row to write to.
One delegated turn proves all three.

Preconditions: a deployment (or `npm run dev` with `DATABASE_URL` set), a signed-in
session, and a `workflows` row named `<key>` in the workspace you are signed in to. A
workspace created after the subagent was added has it; an older one needs it added once
(eve-subagent-wiring, section 3).

1. In the chat, ask for something only this subagent does, and name it:
   "Use the `<key>` specialist: <a small real request for a record in the data room>".
2. Confirm a delegation card for `<key>` appears (with its display name) and the reply
   carries citations or an explicit `not_found`, not an invented value.
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
non-zero tokens.

| What you see | Cause |
|---|---|
| no row at all | no `workflows` row named `<key>` in this workspace; or `hooks/usage.ts` missing; or the process cached "no such workflow" before the row was added (cold start needed) |
| a row under **another** workflow | `WORKFLOW` in `hooks/usage.ts` still has the key it was copied from |
| row stuck at `running` | the turn was cancelled or crashed before `turn.completed`; read the server log |
| the root answered by itself | `agent.ts` description does not match the request, the subagent is paused in `agent_configs`, or the build did not include it (`npx eve info`) |
| "web search is not available" | `ENABLE_WEB_SEARCH=false` at build time; correct if that deployment forbids it |
| the data room refused the path | the template is not in `EXTRA_DATAROOM_PATH_TEMPLATES`: `subagent.json` was edited without `npm run build:subagent-meta`, or the deployment predates it |

If you cannot reach a database or a deployment, say so in the task. Do not report the
smoke turn as passed. Never ask a non-technical operator to run SQL.

## 3. Add the checks to CI

`.github/workflows/ci.yml` runs offline checks only (no database, no secrets), which all of
section 1 satisfies. [`references/ci-steps.md`](references/ci-steps.md) has the steps to
add and the output each should be held to.

## Evidence to attach

- the full output of `npm run check:subagents` (or `--json`)
- the last line of `npm run check:subagent-shared`, `typecheck`, `build` and `build:eve`
- `git status --short` showing that only files were added, plus the two `*.generated.ts`
- the `automation_runs` row from the smoke turn, or the plain statement that it was not run and why
- the commit hash
