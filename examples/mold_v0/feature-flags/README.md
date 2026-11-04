# Flagwell: a feature-flag and experiments service developers build into their products

A shippable example for **mold_v0** (`kind: embedded`). Paste [`prompt.md`](prompt.md) to your coding agent in this repository, or
mint the spec it produced directly.

## What it demonstrates

- kind embedded: the REST API at /v1 with its OpenAPI description, scoped keys, client sessions, signed webhooks out (five events) and in (a CI release receiver), and TypeScript and Python SDKs.
- Append-only, hash-chained record areas (rollouts and per-user overrides) with signed hourly checkpoints (audit.sign; the key is set by name).
- One declarative yes/no check answered from the records with a fallback across areas: the user's current override (matched through an encrypted, equality-searchable user id) decides when there is one, else the latest rollout, its flag not archived, and a deterministic percentage bucket of the user for the rollout's share. Client sessions may ask it from a browser (`checks:is_flag_on`), and the onboarding step "ask is_flag_on" is done once it has been asked.
- A clean-up clock on every flag (90 days, capped by its remove-by date) and a decide-by clock on running experiments.
- An agent job kind that writes an experiment readout, with an optional analytics credential and its egress host; rate limits per key and per workspace; a list tab that opts out of a primary button with its reason.

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
python3 .claude/scripts/factory.py spec check examples/mold_v0/feature-flags/spec.json
python3 .claude/scripts/mint.py new flagwell --spec examples/mold_v0/feature-flags/spec.json
python3 .claude/scripts/mint.py flagwell run
```

`mint.py new` writes the pack to `packs/flagwell/` and the app's state; the stations up to the deploy need nobody. The keys the runs use (the model, the sandbox, object storage) go into the app's Key vault after the first deploy.
Signed checkpoints need one more key, set by name in your own terminal before the first deploy:
`python3 .claude/scripts/provision.py flagwell --set-secret APP_LEDGER_SIGNING_KEY` (`npm run ledger:keygen -- --out <file>` in
the mold's codebase makes one). After the keys station comes the first deploy (about 10 minutes): `run` starts it, so run it when you mean to deploy (an agent asks you first).

To check the build copy without deploying:

```
python3 .claude/scripts/packs.py apply flagwell
python3 .claude/scripts/packs.py verify flagwell
python3 .claude/scripts/packs.py lane-copy flagwell
```
