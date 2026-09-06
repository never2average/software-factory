---
name: intake
description: Describe an application in a few lines and get complete, validated state for it. Use when asked to "deploy X", "spin up an app for customer Y", or to stamp from a description.
---
# intake

Write the brief to `briefs/<app_id>.md` (five lines is enough: what, for whom, target, anything to turn off). Then launch the `intake` subagent with the brief path. It runs `intake.py`, asks the user only the unresolved questions in batches, and writes `state/application/<app_id>/`. On the terminal, sol can run `python3 .claude/scripts/intake.py briefs/x.md --app x --ask` instead.

The first intake also confirms the factory defaults in `state/factory.json` (deploy target, secret store, providers). After that only per-app questions remain. The list of questions and how each resolves is `docs/INTAKE.md`; edit the `QUESTIONS` table in `intake.py` to change them.
