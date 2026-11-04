# Panelwise: a hiring pipeline for teams that run structured interview panels

A shippable example for **mold_v0** (`kind: tool`). Paste [`prompt.md`](prompt.md) to your coding agent in this repository, or
mint the spec it produced directly.

## What it demonstrates

- Roles, candidates and interviews, each with a lifecycle; candidates hold their CV and cover letter as files.
- Encrypted fields: a candidate's email (searchable by exact address, revealed by members and owners), phone and salary expectation (owners only), every reveal on the data trail.
- Working-day clocks: reply by (5 working days), decide by (10 working days from entering interviewing) and an interviewer's feedback by (2 working days, stopped by a recommendation).
- Three agent job kinds: screen a CV against the role's must-haves, summarise a candidate's interviews, and a weekly pipeline digest on a schedule; a reports tab whose button offers a picker of two kinds.
- Both audit trails on (data and platform); member keys off, so AI apps connect by signing in; the company's own sender allowed.

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
python3 .claude/scripts/factory.py spec check examples/mold_v0/hiring-pipeline/spec.json
python3 .claude/scripts/mint.py new panelwise --spec examples/mold_v0/hiring-pipeline/spec.json
python3 .claude/scripts/mint.py panelwise run
```

`mint.py new` writes the pack to `packs/panelwise/` and the app's state; the stations up to the deploy need nobody. The keys the runs use (the model, the sandbox, object storage) go into the app's Key vault after the first deploy.
After the keys station comes the first deploy (about 10 minutes): `run` starts it, so run it when you mean to deploy (an agent asks you first).

To check the build copy without deploying:

```
python3 .claude/scripts/packs.py apply panelwise
python3 .claude/scripts/packs.py verify panelwise
python3 .claude/scripts/packs.py lane-copy panelwise
```
