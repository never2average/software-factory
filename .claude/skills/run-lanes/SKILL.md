---
name: run-lanes
description: Run the five testing lanes (load, context, functional, accessibility, responsiveness) on a stamped application and record results. Use before any deploy or stage advance.
---
# run-lanes

One command runs the lanes, writes the reports and writes the state. Do not do any of it by hand.

    python3 .claude/scripts/lanes.py <app_id>                        # all five, in order, stop at the first fail
    python3 .claude/scripts/lanes.py <app_id> --lane functional      # one lane; repeatable
    python3 .claude/scripts/lanes.py <app_id> --list                 # which lanes have a harness, and what is blocking them
    python3 .claude/scripts/lanes.py <app_id> --dry-run              # run everything, write NO state, report to reports/dry/

Exit `0` every lane passed or was skipped · `1` a lane failed · `2` the runner could not run at all
(unknown app, missing state file, a malformed or misnamed `lane.json`). The last line is always one
plain sentence for the operator.

## What a lane is

A lane declares itself in `molds/<mold_id>/testing/<lane>/lane.json`, validated against
`molds/<mold_id>/testing/lane.schema.json`. Adding or deepening a lane means editing that file and the
harness beside it — never `lanes.py`. A check is one shell command plus what to expect of it:

    {"name": "test:syncs", "run": "npm run test:syncs", "cwd": "codebase",
     "expect": {"exit": 0, "stdout_not": ["BYPASSRLS"]},
     "requires": [{"state": "infrastructure.vercel.production_url", "must": "nonempty",
                   "else": "Deploy it first: python3 .claude/scripts/provision.py {app_id} --deploy"}],
     "known_defect": "mold_v1-017", "emits": "markdown_table",
     "why": "one sentence: what a failure here actually means"}

Anything richer than an exit code belongs in a harness script in the lane folder that prints a
markdown table and exits 0/1 — like `functional/tenant-isolation.py` — with `"emits":
"markdown_table"`. Budgets, viewport matrices and axe rule sets live there, not in `lane.json`.

## The rollup, which is deliberately unfakeable

    no lane.json | "checks": [] | a lane-level precondition unmet  -> skipped
    any check failed                                               -> fail
    every check RAN and passed                                     -> pass
    otherwise (>=1 check skipped by a precondition)                -> skipped

**A lane is `pass` only when every check it declares actually ran and passed.** No harness, zero
checks, or one check skipped for want of a deployment is `skipped` — never `pass`. `known_defect` is
an annotation, never a mute: a check carrying a task id still fails, and still reverts the app.

The rollup only reaches as deep as the check, so a harness that prints rows owes the same rule one
level down, and two obligations fall on the lane author rather than on `lanes.py`:

- **Nothing measured is never a pass, inside the harness too.** A page that answers HTTP 200 and
  renders nothing satisfies most criteria *vacuously* — 0 violations, 0 tap targets, 0px of overflow.
  A harness must assert that the application actually rendered (both browser lanes count interactive
  controls and fail a declared route that has none), and its `target-up`-style precondition must check
  that the URL serves *this mold's* markup, not merely that something answered 2xx.
- **A row that could never run is `not-covered`, not `skipped`.** `skipped` means "this could have been
  measured and was not", which is exactly what must stop a lane reading `pass`. A declared coverage gap
  (the accessibility lane's signed-in workflow builder) is labelled and counted separately, and named
  in `not_covered` so it is reprinted in every report.
- **A budget that moves on its own must be confirmed before it reverts an application.** Timing numbers
  (CLS, INP) are re-measured up to 3 times in `responsive.mjs` and fail only when the budget is missed
  on every run, with all samples printed. A revert is a serious act in front of a non-technical
  operator; it must not fire on VM jitter.

## What it writes

Per lane, the report first (so `report` always resolves), then
`testing.<lane> = {status, run_at, report}` in `state/application/<app_id>/application.json`, with the
report at `molds/<mold_id>/testing/<lane>/reports/<app_id>-<date>.md`.

`--dry-run` writes its reports to `molds/<mold_id>/testing/<lane>/reports/dry/` instead, headed
`DRY RUN` and naming the `--dry-run` command that produced them. It writes no state and files no task,
so its verdicts must never sit in the archive that recorded runs point at, and must never overwrite
one.

On the first `fail`: `status` becomes `reverted`, `revert = {lane, reason, at}` names the lane, the
failing checks, the report and the task, a task is filed into `state/tasks/<mold_id>.jsonl` — reusing
an open task for the same lane and app, and filing nothing when every failing check already carries a
`known_defect` — and the run STOPS. Control is back with the operator.

`lanes.py` is the only writer of `testing.<lane>`, and `reverted` is the only status it may write.
Promotion to `lanes_passing` is a product stage and stays with the operator (`productize`).
