---
name: intake
description: Describe an application in a few lines and get complete, validated state for it. Use when asked to "deploy X", "spin up an app for customer Y", or to stamp from a description.
---
# intake

Write the brief to `briefs/<app_id>.md` (five lines is enough: what, for whom, target, anything to turn off). Then launch the `intake` subagent with the brief path. It runs `intake.py`, asks the user only the unresolved questions in batches, and writes `state/application/<app_id>/`. On the terminal, sol can run `python3 .claude/scripts/intake.py briefs/x.md --app x --ask` instead.

One question is optional and always offered: the speech model behind the microphone button (`asr_model`; Whisper large v3 turbo by default, with the price per audio minute of each choice). The developer of the app chooses it, never the app's users; a brief may name it ("speech model: nova-3", "speech language: hi", "no dictation"). See "Speech model" in `docs/INTAKE.md`.

**A mold_v0 app is a brief + a generated pack.json + a brand.** Its brief carries the app's own pack in plain `## ` sections (`## Records`, `## Metrics`, `## Charts`, `## Tabs`, `## Jobs`, `## Credentials`, `## Schedules`, `## Onboarding`, `## Words`, `## MCP`; the bullet syntax is "mold_v0: the brief's pack sections" in `docs/INTAKE.md`). From a free-text description, write those sections yourself, putting in ONLY what the person said: their records and what each holds, the states a record moves through and who may move it, the numbers and charts they want, the jobs (an agent repository and its full commit id) and the keys workspaces give. Leave out anything they did not say: `intake.py` turns every gap into a question with options and a suggested answer, so nothing is guessed. It writes `packs/<pack_id>/` (validated against the mold's pack.schema.json and the build's cross-checks, then `packs.py check`), never overwrites a pack.json someone edited (it asks keep or replace), and never touches a pack it did not make. A malformed brief comes back with the line of each problem: fix those lines and run it again.

A mold_v0 app is also asked `platform_admins`: the email address(es), or `*@domain`, that may open its admin console (a brief line `Admins: you@example.com` answers it; the operator's own address is suggested). It is not a secret. An app already deployed without one is not asked again here: `provision.py` checks whether its API already holds the variable.

The first intake also confirms the factory defaults in `state/factory.json` (deploy target, secret store, providers). After that only per-app questions remain. The list of questions and how each resolves is `docs/INTAKE.md`; edit the `QUESTIONS` table in `intake.py` to change them.
