---
name: sweep
description: Keep the factory moving on a schedule (about every 30 minutes) - merge green pull requests, deploy what is pre-approved, start ready tickets as builders, tidy stale processes and scratch, and report only what changed. Use when asked to "keep the factory moving", "sweep", "run the sweep", or to set the sweep up on a schedule.
---
# sweep

One pass of the factory's housekeeping loop. `sweep.py` plans and checks; **you** merge, deploy and start builders, with
judgment and the operator's rules (AGENTS.md, then AGENTS.local.md). One pass takes a few minutes; it is safe to repeat.

```
python3 .claude/scripts/sweep.py plan --json             # read-only: PRs, ready tickets, deploys behind, hygiene
python3 .claude/scripts/sweep.py clean --dry-run         # what clean would stop / remove
python3 .claude/scripts/sweep.py clean --apply --yes     # only with the operator's yes (or standing instruction)
python3 .claude/scripts/sweep.py --self-test             # offline
```

`plan --json` prints one result (`ok, status, summary, next, needs, log, details`); `details` holds `prs`, `tickets`,
`deploys`, `hygiene` and the `settings` it used. Exit codes as everywhere: 0 done, 1 failed, 2 could not run, 3 a person
is needed (only `clean --apply` without `--yes` asks).

## The loop

Run `sweep.py plan --json`, then work through it in this order. Do nothing the plan does not list.

### 1. Pull requests (`details.prs.items`)

Merge a PR only when **all** hold:

- `merge_ready` is true: not a draft, `mergeable` is `MERGEABLE`, checks are not failing or pending, its files were
  read, and `clashes` is empty (no migration number already on main, below main's highest, or added by another open PR).
  `mergeable: UNKNOWN` right after a push means GitHub has not computed it yet: leave it for the next pass.
- The builder's own checks are green: when the repository's CI is parked (checks `none`), read the builder's results in
  the PR description or its last comment (self-tests, `factory.py validate`, the lanes or light checks the ticket asked
  for). No results, or a red one: do not merge; tell the builder.
- It is the change the ticket (`ticket`) asked for, and nothing from a same-day parallel PR breaks it: look at what merged
  since the branch was cut.

Then:

1. Squash-merge: `gh pr merge <number> --squash --delete-branch`. Never force-push, never merge with `--admin` unless the
   operator said so for that PR.
2. Close the ticket with the evidence: `python3 .claude/scripts/factory.py close <ticket> "factory PR #<n> merged: <one line>"`.
3. If the builder staged a pack patch (a change to a git-ignored `packs/<pack_id>/` the builder could not write itself):
   back up the pack first (`cp -a packs/<pack_id> packs/<pack_id>.bak-<date>`), apply the patch, run
   `python3 .claude/scripts/packs.py check <pack_id>`; on a failure restore the backup and tell the builder.
4. `python3 .claude/scripts/factory.py validate`. A failure after a merge is the next thing to fix, before anything else.

A clash is the builder's to fix: renumber the migration above main's highest (`details.prs.main_highest`), push, and the
next pass reads it again.

### 2. Deploys (`details.deploys`)

The plan reads `mint.py`'s own deploy station (an app is behind when "the mold moved") and splits the apps:

| List | What you do |
|---|---|
| `auto` | Pre-approved (`sweep.auto_deploy`) and the change holds no database migration: `provision.py <app> --deploy --background`, then poll `provision.py <app> status`. |
| `parity` | `sweep.parity_deploy` (apps carrying a host pack): deploy only after the parity check for that pack proves the change on a build copy (skeleton parity with the reference product, no missing screen or route). Not proven: leave it and say why. |
| `needs_yes` | A live-data migration, a change that could hold one (`migration: null`), or a live app not on either list. Ask the operator, naming the app, the change (`from -> to`) and the migration files; deploy only on a plain yes for that app. |
| `needs_operator` | `mint.py` needs the operator first (a sign-in code, or a deploy at their own terminal). Ask for exactly that one thing, the way AGENTS.md "Asking the operator" says. |

Then run the lanes on what you deployed (`lanes.py <app> --background`) as the `run-lanes` skill says. One long step per
app at a time; never touch a lock.

### 3. Tickets (`details.tickets`)

`start` lists the tickets to start now: every `depends_on` is done (strict phase order: a phase starts only after the one
before it is done), no gate holds it, and it fits `sweep.max_builders` (in all) and `sweep.builders_per_train` (per train:
a ticket's `train` field, else `sweep.trains`, else its mold). `ready_waiting` is ready work over those limits, `gated`
is held back (below), and `blocked` lists tickets that wait on a dropped or unknown ticket: tell the operator, do not start
them.

For each ticket in `start`: `factory.py set <ticket> status in_progress`, then start one builder (a subagent, or another
agent session) with the ticket's id, title, acceptance and these **builder rules**:

1. Work in a fresh shallow clone under the job's tmp folder (`git clone --depth 1`), on a branch named after the ticket.
2. Commit and push work in progress after every step (never force); the branch is the record if the builder stops.
3. Never write `packs/` (git-ignored, the operator's): stage a pack change as a patch file in the PR description or next
   to the branch, for the sweep to apply.
4. Heavy steps (builds, typechecks, browser lanes, Docker) go through this machine's own queue (the one AGENTS.local.md
   names); never run two heavy steps at once outside it.
5. A ticket that touches a host pack proves skeleton parity with the reference product first (every screen, route and
   tab of the reference is present) and says so in the PR.
6. Builders never merge and never deploy: they open a PR whose description lists the checks run and their results.
7. Never `pkill -f` or `killall` (a pattern matches idle shells and other builders); stop a process by its PID.
8. Never commit git-ignored paths; never put customer names, emails, addresses or secrets in tracked files.
9. A new database migration takes the next number above main's highest, and the PR says it changes live data.

**Idle builders.** A builder whose branch and session show no progress for 60 minutes: nudge it once (ask what it is
waiting on). Still idle at the next pass: stop it, note where it stood on the ticket, and start it again from its pushed
branch. A builder whose PR is open and complete: stop it (its work waits for the merge step).

### 4. Hygiene (`details.hygiene`)

- `stale_waits`: wait loops (`until|while ... pgrep`) older than `sweep.stale_wait_hours`; a `pgrep -f` pattern can match an
  idle shell and wait forever.
- `stale_servers`: dev/test servers left under a tmp root (orphaned, or older than `sweep.server_max_hours`).
- `disk`: free space against `sweep.disk_free_min_gb` (20 GB); `scratch` lists every folder under the tmp roots, which
  process uses it, and whether it is finished (idle, unused, nothing uncommitted or unpushed).

Run `sweep.py clean --dry-run`. Stopping processes and deleting folders needs a yes (AGENTS.md "What needs an explicit
yes"), so `clean --apply` without `--yes` exits 3 and lists them. Add `--yes` when the operator said yes to that list,
**or** when AGENTS.local.md records the operator's standing instruction that the sweep may stop stale loops and leftover
servers by PID and remove finished scratch: that instruction is the yes. Clean looks again before each step (a reused PID
is skipped, a folder a process started using is kept) and never removes anything outside a tmp root. Finished scratch is
removed only when disk is low, or with `--scratch`.

### 5. Report only on change

Say nothing when nothing changed. Otherwise one short message: what merged (PR, ticket), what deployed (app, from -> to,
lanes), what started or stopped, what was cleaned, and the **one** thing waiting on the operator, asked the AGENTS.md way.

## Operator gates (never crossed by a sweep)

- **Live-data migrations**: any deploy whose change adds or edits a database migration, for any app, every time.
- **Dated decisions**: tickets with `"gate": "dated_decision"` (or `{"kind": "dated_decision", "until": ...}`) wait for the
  operator's decision, even after the date; the operator removes the gate.
- **Operator-only actions**: tickets owned by the operator (`sweep.gated_owners`, default `sol`), `"gate": "operator_action"`,
  or listed in `sweep.gated_ids`; secrets (`--set-secret`, at their own terminal), sign-in codes, DNS, payments.
- Everything AGENTS.md "What needs an explicit yes" lists: a live app's deploy outside `auto_deploy`, force-push, repository
  publish, spending, deletes, contacting people.

## Settings

`state/factory.json` `sweep` holds the defaults (schema: `state/factory.schema.json`); this machine's own choices go in the
git-ignored `state/factory.local.json` under `sweep`, merged over them (app ids for `auto_deploy` and `parity_deploy`,
extra `gated_ids`, `trains`). Keys: `max_builders`, `builders_per_train`, `trains` (`{name: {ids, prefixes, molds, types}}`),
`molds`, `gated_ids`, `gated_kinds`, `gated_owners`, `auto_deploy`, `parity_deploy`, `migration_dirs`, `stale_wait_hours`,
`server_max_hours`, `scratch_idle_hours`, `disk_free_min_gb`, `tmp_roots`, `base_branch`, `server_patterns`.
Ticket fields: `train` and `gate` (`state/tasks.schema.json`).

## Scheduling it

The factory machine runs no scheduler of its own; the agent session (or the machine's cron) does. A sample prompt for every
agent:

```
Run one factory sweep: follow .agents/skills/sweep/SKILL.md (sweep.py plan --json, then PRs, deploys, tickets,
hygiene). Obey AGENTS.md and AGENTS.local.md. Report only if something changed.
```

- **Claude Code**: `/loop 30m <the prompt>` in a session that stays open, or ask it to schedule the prompt every 30 minutes
  (CronCreate, cron `*/30 * * * *`). Scheduled prompts end with the session; start it again after a restart.
- **Codex, Gemini, Qwen, OpenCode, Cursor, Kiro and the other CLIs** (their headless commands: the "Benchmark adapter" column of `docs/AGENT_INTEGRATION.md`):
  an OS cron entry on the factory machine that runs the agent's headless command with the prompt, from the repository,
  one run at a time, for example:

  ```
  */30 * * * * cd /path/to/software-factory && flock -n /tmp/factory-sweep.lock codex exec "<the prompt>" >> ~/.cache/factory-sweep.log 2>&1
  ```

  A headless run cannot ask: whatever needs a yes is left in the report for the operator's next look, never assumed.
- **An agent without a headless mode**: a reminder (calendar or cron `notify-send`) to paste the prompt every 30 minutes.
