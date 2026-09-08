# Testing lanes for mold_v1

Every stamped application is checked in five lanes before the factory reports it serviceable. Each
lane folder holds its spec (`README.md`), a machine-readable declaration (`lane.json`) and any harness
the lane needs. Lanes reuse the mold codebase tests where they exist; a lane never edits
`codebase/`, which is an immutable snapshot.

## Running them

    python3 .claude/scripts/lanes.py <app_id>                    # all five, in order, stop at the first fail
    python3 .claude/scripts/lanes.py <app_id> --lane load        # one lane; repeatable
    python3 .claude/scripts/lanes.py <app_id> --list             # harness or not, check count, what is blocking each
    python3 .claude/scripts/lanes.py <app_id> --dry-run          # reports only, no state, no task

Order: functional (10) → context (20) → load (30) → accessibility (40) → responsiveness (50).

## Adding to a lane

Edit that lane's `lane.json` against [`lane.schema.json`](lane.schema.json). A check is one shell
command plus what to expect of it, and a `requires` precondition that says, in one sentence with a
runnable command in it, what would make the check run if it cannot. Anything richer than an exit code
goes in a harness script beside the `lane.json` that prints a markdown table and exits 0/1 — see
`functional/tenant-isolation.py`. A lane's dependencies live in that lane's folder with its own
`package.json`; nothing is ever installed into `codebase/`.

Two rules the runner enforces rather than trusts:

* a lane is `pass` only when every check it declares actually **ran** and passed. No harness, no
  checks, or one check skipped for want of a deployment is `skipped`.
* `known_defect: <task_id>` is an annotation. It links the task in the report and stops a duplicate
  being filed; it never turns a red check green.

## Reports

`<lane>/reports/<app_id>-<date>.md`, one per lane per run — the checks table, the raw failure output,
the measured tables, what was skipped and what would make it run, and what the lane does not cover. A
same-day re-run overwrites its own file on purpose; history is git. `clone.py` writes
`<app_id>-regression-<date>.md` into `context/reports/` and does not collide.
