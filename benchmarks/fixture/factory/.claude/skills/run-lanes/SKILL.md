---
name: run-lanes
description: Run the five testing lanes (functional, context, load, accessibility, responsiveness) on a stamped application and record results.
---
# run-lanes

One command runs the lanes, writes the reports and writes the state. Do not do any of it by hand.

    python3 .claude/scripts/lanes.py <app_id>                        # all five, in order, stop at the first fail
    python3 .claude/scripts/lanes.py <app_id> --lane functional      # one lane; repeatable
    python3 .claude/scripts/lanes.py <app_id> --list                 # what each lane checks

Exit `0` every lane passed or was skipped · `1` a lane failed (the app is now `reverted`, a task is filed) ·
`2` the runner could not run. Reports: `reports/lanes/<app_id>/<lane>.md`. Results: `application.json` → `testing`.

Never edit a lane, a report or the `testing` block to change a verdict. Report the verdict per lane, and for a
failure the check that failed and why.
