# Keyward: a residential property maintenance desk

A shippable example for **mold_v1** (`kind: tool`). Paste [`prompt.md`](prompt.md) to your coding agent in this repository, or
mint the spec it produced directly.

## What it demonstrates

- A deployment profile with all four record areas: buildings as the accounts, maintenance tickets (own fields: place, trade, vendor, quote, visit day, photos; a seven-state lifecycle), quarterly inspection rounds, vendors' service contracts (several per building, read-only to the assistant) and planned works.
- A specialist as a full workspace (Inspection Intake): seven skills for checklist spreadsheets, written reports and photo logs and for places, severity, duplicates and validation; six scripts with --self-test; a schema, a validator and the desk's rulebook.
- Scheduled lists as starter apps (urgent and overdue every weekday, contracts renewing every Monday).
- Web search and browser off, Workers AI inference, dictation for coordinators on site, the first workspace with its owner and members.

## The files

| File | What it is |
|---|---|
| [`prompt.md`](prompt.md) | The prompt a person writes: plain words, complete enough that the agent asks nothing. |
| [`spec.json`](spec.json) | The app spec the agent produced from it, for comparison (`$schema` is the mold's schema). |
| [`pack/`](pack/) | The app's pack: `pack.json` and the files it adds to the build (a specialist's full workspace, the instructions section, the deployment profile, the starter apps). |
| [`logo.svg`](logo.svg) | The mark the brand uses. |

## Run it

From the repository root:

```
python3 .claude/scripts/factory.py spec check examples/mold_v1/property-desk/spec.json
python3 .claude/scripts/mint.py new keyward --spec examples/mold_v1/property-desk/spec.json
python3 .claude/scripts/mint.py keyward run
```

`mint.py new` copies `pack/` to `packs/keyward/` and writes the app's state; `run` then stops at the keys station, which asks for the inference, email and sign-in keys by name (`provision.py keyward --set-secret NAME` in your own terminal).
Once the keys are set, `run` goes on to the first deploy (an agent asks you before that).

To check the build copy without deploying:

```
python3 .claude/scripts/packs.py apply keyward
python3 .claude/scripts/packs.py verify keyward
```
