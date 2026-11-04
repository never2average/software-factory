# Wrenchline: a work tracker for field-service maintenance teams

A shippable example for **mold_v0** (`kind: tool`). Paste [`prompt.md`](prompt.md) to your coding agent in this repository, or
mint the spec it produced directly.

## What it demonstrates

- Four record areas typed field by field: sites and equipment (assets), work orders with a seven-state lifecycle and role rules, technician visits with photos (files).
- Two record clocks on every work order, their length chosen by priority: respond by (reminder, then the owners told) and fix by (pauses while awaiting parts; escalates by handing the order to its supervisor).
- Company email: a connected mailbox turns each email into a P3 work order with both clocks running; the team may send from its own mail server.
- Two agent job kinds that write markdown reports: a visit report started on one visit, and a preventive plan on a Monday schedule that may read a building-telemetry service with an optional, write-only workspace credential.
- Metrics, charts, the Overview's four headline numbers, list tabs with their four cards and a primary button each (create a record, start a report, add a schedule), onboarding steps and the app's own words (a run is a "draft").
- Every record area's contract declared (provenance, who may do each action, the list's primary action): the worked example of [docs/RECORDS.md](../../../docs/RECORDS.md).
- The data access trail on, member keys on, runners inside a customer's network off; per-run and per-month budgets; legal pages; email sender and notification groups.

## The files

| File | What it is |
|---|---|
| [`prompt.md`](prompt.md) | The prompt a person writes: plain words, complete enough that the agent asks nothing. |
| [`spec.json`](spec.json) | The app spec the agent produced from it, for comparison (`$schema` is the mold's schema). |
| [`pack/pack.json`](pack/pack.json) | The app's config-only pack (JSON, no code): record areas, clocks, job kinds, tabs and the rest. |
| [`logo.svg`](logo.svg) | The mark the brand uses. |

## Run it

From the repository root:

```
python3 .claude/scripts/factory.py spec check examples/mold_v0/field-service/spec.json
python3 .claude/scripts/mint.py new wrenchline --spec examples/mold_v0/field-service/spec.json
python3 .claude/scripts/mint.py wrenchline run
```

`mint.py new` writes the pack to `packs/wrenchline/` and the app's state; the stations up to the deploy need nobody. The keys the runs use (the model, the sandbox, object storage) go into the app's Key vault after the first deploy.
After the keys station comes the first deploy (about 10 minutes): `run` starts it, so run it when you mean to deploy (an agent asks you first).

To check the build copy without deploying:

```
python3 .claude/scripts/packs.py apply wrenchline
python3 .claude/scripts/packs.py verify wrenchline
python3 .claude/scripts/packs.py lane-copy wrenchline
```
