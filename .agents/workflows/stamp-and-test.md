# Workflow: stamp-and-test

Input: mold_id, app_id. Output: application tested, or `reverted` with a task and a report.

1. `stamp` skill → application exists, builds.
2. Optional rehearsal, in parallel: fan out `lane-tester` with
   `lanes.py <app_id> --lane <lane> --dry-run` to see every lane's verdict at once. `--dry-run` writes
   reports and no state, so parallel processes are safe here and nowhere else.
3. The run of record is ORDERED and single-process: `python3 .claude/scripts/lanes.py <app_id>`.
   Lanes run functional → context → load → accessibility → responsiveness and stop at the first fail.
   Do not fan this out: every lane writes `application.json`, and parallel writers race and lose
   results.
4. Exit 0 → the runner printed what passed and what was skipped. Report those verbatim; a `skipped`
   lane is not a pass, so the operator decides whether it is enough to advance the product stage
   (`productize`). Close the lane tasks with `factory.py close <id> "<report path>"`.
5. Exit 1 → the application is already `reverted`, the revert record names the lane and the report,
   and a task is already filed (or the existing `known_defect` tasks are named). Do not file another,
   do not re-run to get a greener answer: hand the report to the operator and stop.
