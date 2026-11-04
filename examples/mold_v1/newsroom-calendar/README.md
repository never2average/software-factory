# Inkboard: a newsroom's story calendar and morning briefing

A shippable example for **mold_v1** (`kind: tool`). Paste [`prompt.md`](prompt.md) to your coding agent in this repository, or
mint the spec it produced directly.

## What it demonstrates

- A deployment profile that maps the newsroom by structure: desks as the accounts, assignments as the tasks area (own fields and a stage lifecycle with four-eyes subbing), daily editions as the period that holds them, corrections as the deployments area.
- A specialist as a full workspace (Story Briefing): seven skills, one per way the calendar arrives and per procedure, five scripts with --self-test, JSON schemas, a validator and the editors' rulebook kept word for word.
- Scheduled briefings as starter apps (weekday mornings and Friday afternoons), the assistant's own persona and briefing, hero lines, a relabelled data room, and the base specialists that do not fit left out.
- Web search and browser off, Workers AI inference, a dictation model, the first workspace with its owner and members.

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
python3 .claude/scripts/factory.py spec check examples/mold_v1/newsroom-calendar/spec.json
python3 .claude/scripts/mint.py new inkboard --spec examples/mold_v1/newsroom-calendar/spec.json
python3 .claude/scripts/mint.py inkboard run
```

`mint.py new` copies `pack/` to `packs/inkboard/` and writes the app's state; `run` then stops at the keys station, which asks for the inference, email and sign-in keys by name (`provision.py inkboard --set-secret NAME` in your own terminal).
Once the keys are set, `run` goes on to the first deploy (an agent asks you before that).

To check the build copy without deploying:

```
python3 .claude/scripts/packs.py apply inkboard
python3 .claude/scripts/packs.py verify inkboard
```
