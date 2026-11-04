Please make me a new app from mold_v0, called **Flagwell**: a feature-flag and experiments service that software teams
build into their own products.

## Who it is for, and how it is used

Product engineering teams. Their developers put Flagwell behind their own apps: their servers ask Flagwell whether a
flag is on with a scoped API key, their front ends read flags with short-lived sessions their servers hand out, and
their CI tells Flagwell about every release. Product managers and engineers also sign in to Flagwell's own screens to create flags, roll them out and
run experiments. Because developers build it into other products, it is **embedded**, not a stand-alone tool: it needs
the full developer surface (the REST API with its OpenAPI description, scoped API keys, client sessions, signed webhooks
both ways, and generated SDKs) and every request must be recorded. Each team's project is its own; no project sees
another's flags.

## What it keeps

- **Flags.** The record's key is the flag key the code asks about (for example `new-checkout`). Each flag has what it
  controls (required, a sentence), a type (release toggle, experiment, operational switch or permission; required), the
  owning team, a remove-by date for release toggles, and a status: active, then deprecated, then archived (archiving is
  for owners; a deprecated flag can be brought back).
- **Rollouts.** Every change of a flag in one environment, as a new record that is never edited or deleted: the flag
  (required), the environment (development, staging or production; required), on or off (required), the share of users
  from 0 to 100 (the product's SDK buckets users by a hash of their id), a segment description, the day of the change
  (required) and why. The latest rollout is the flag's state. Rollouts are append-only and hash-chained, so a team can
  prove its flag history was never rewritten.
- **User overrides.** A flag forced on or off for one end user, also append-only and hash-chained: the flag, the
  environment, the user's id, on or off (all four required), an expiry day and why. The user id is personal data: it is
  stored encrypted, only owners may reveal it, and the service can still find an override by the exact user id.
- **Experiments.** A test behind an experiment flag: the flag (required), the hypothesis (required), the primary metric
  (required), the smallest effect worth shipping as a percentage, the day it started, who decides (a person in the
  team), the result (variant wins, control wins, no difference or inconclusive), and the analytics export as an
  uploaded CSV file. An experiment is a draft, then running; it is concluded, or stopped early by an owner.
- **Releases.** Deployments reported by the team's CI through an incoming signed webhook: service, environment,
  commit and when it finished. Nobody types releases in.

## The yes/no answers

The heart of the product is one question the product's code asks in one call, answering yes or no with the reason, the
records that decided it and which of them decided:

- **Is this flag on for this user?** Given a flag key, an environment and a user id: the user's latest override for
  that flag and environment decides when there is one that has not expired (yes when it turns the flag on). Otherwise
  the latest rollout of the flag in that environment decides: yes when it turned the flag on, the flag is not archived,
  and the user falls within the rollout's share of users (no share means everyone).

The share is a stable percentage: each user is put in a bucket by a hash of the flag key and their user id, the same
on every call and in the product's own SDKs, so a user who is in at 10% stays in at 20%.

## Developer surface

- Events sent to the team's webhooks: a record created (a flag, rollout, override, experiment or release), a record
  updated (a flag's or an experiment's details), a record's state changed (a flag deprecated or archived, an experiment
  started, stopped or concluded), a readout finished, and a deadline passed (a flag past its clean-up date, an
  experiment past its decide-by).
- SDKs in TypeScript and Python, on the API version of 2026-11-01.
- Client sessions last 15 minutes, may read and ask "is this flag on for this user" (nothing else), and work only
  from https://app.example.com. The product's servers ask the same question with an API key that holds the checks
  scope.
- One incoming webhook, "CI releases": your CI's deployment report, where `/deployments` is the list, each item's
  `/id` is the record key, `/version` its title, and `/service`, `/environment`, `/commit` and `/finished_at` fill the
  release's service, environment, commit and finished time. Only reports of the type `deployment.succeeded` are kept.

## Deadlines and alerts

- **Clean up by:** every flag should be gone within 90 days of being created, or by its remove-by date if that is
  earlier; the clock stops when the flag is archived. The owners are reminded two weeks before, and told again two
  weeks after it is missed.
- **Decide by:** an experiment is decided within 14 days of starting to run, stopped by concluding or stopping it. The
  decider and the owners are reminded three days before; two days late, the owners are told.

Reminders show in the app and go out by email, with the access-request and usage-budget emails.

## The AI agent

- **Write an experiment readout**, started on one experiment. It reads the hypothesis, the primary metric, the
  smallest worthwhile effect and the analytics export (or, if the team gave it an analytics read token, fresh numbers
  from analytics.example.com), and writes the readout as a markdown document: the effect with its interval, whether it
  clears the smallest worthwhile effect, guardrail metrics, a plain recommendation, and what the data cannot say. It
  uses Anthropic's models, may spend at most US$3 a run and US$90 a month per project, 2 at once, is retried once and
  has 15 minutes. Code: https://git.example.com/agents/experiment-readout at commit
  6666666666666666666666666666666666666666; it runs `python3 readout.py --experiment <the experiment>`, is checked by
  `python3 validate_readout.py out/readout.md`, and keeps its `out` folder.
- The analytics read token is optional, write-only, entered in Settings, and handed to the agent only as
  `ANALYTICS_TOKEN`.

In the app, an agent run is a "readout" and a team's space is a "project".

## Screens

- **Overview**: four headline numbers (active flags, flags past their clean-up date, rollout changes this week,
  running experiments), the getting-started steps (create a flag, turn it on in development, ask "is this flag on"
  from your code or AI app, done once it has been asked, connect your AI app), and charts of flags by type, rollout changes and releases per week
  over 8 weeks, changes by environment, and how experiments ended.
- Under **Flags**: **Flags** (main button "New flag"), **Rollouts** ("Change a rollout"), **User overrides**
  ("Override for a user") and **Releases** (no button: releases only come from CI).
- Under **Experiments**: **Experiments** ("New experiment") and **Readouts**, the agent's documents ("Write a readout").
- Settings has the Developers page for API keys, webhooks, allowed origins and incoming webhooks.

What the AI assistant is told: Flagwell keeps a project's flags, rollouts and per-user overrides (append-only and
hash-chained), experiments and releases; to know whether a flag is on for a user, ask "is this flag on for this user"
(it weighs the user's override, then the rollout and its share), never guess from the lists; a change is a new
rollout, never an edit.

## Security and records of access

Turn on the data access trail, the platform request trail, and signed hourly checkpoints of both trails and of the
chained records, so a customer can verify nothing was rewritten (the signing key is set as a secret by name, never
written down). Team members may make personal API keys. Every agent run is hosted; nothing runs inside a customer's
network.

## Brand

Name Flagwell, colour #0F766E (teal), tagline "Feature flags and experiments your product asks in one call". The logo
is a light flag on a rounded teal square: `examples/mold_v0/feature-flags/logo.svg`.

## Who runs it, where, and what it may spend

- It runs on Vercel, at flagwell.example.com.
- The platform administrator is platform@example.com.
- Emails come from flags@example.com.
- The company behind the terms and privacy pages is Example Flags Ltd, contact legal@example.com, effective 2026-11-04.
- Budgets: any one agent run at most US$5, any one kind of run at most US$120 a month per project, 2 runs at once and 10
  live per project. Each API key may make 600 requests a minute and each project 3,000.
- Agent runs use an Anthropic key, boat.dev sandboxes and the key vault's object storage.
