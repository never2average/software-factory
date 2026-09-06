# Workflow: stamp-and-test

Input: mold_id, app_id. Output: application at `lanes_passing` or `reverted`.

1. `stamp` skill → application exists, builds.
2. Fan out `lane-tester` once per lane (functional, context, load, accessibility, responsiveness), each writing its report.
3. Collect: all pass → `factory.py close` the lane tasks with report paths, product advances. Any fail → application `reverted`, `factory.py add` a harden task per failure, stop and report to the operator.
