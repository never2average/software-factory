# Runbook: from a five-line brief to a live application

For the operator who runs this factory and does not read code. Every command below exists today; where the
factory stops and needs something from you, this says what and why. All commands run on the DigitalOcean VM,
inside `/root/software-factory` (`ssh digitalocean`, then `cd /root/software-factory`).

Two kinds of step: **agent** (say it to Claude Code, the `intake` / `provisioner` subagents run it) and **you,
at the terminal** — every step that touches a secret value, because the agent runtime is not allowed to handle
one. The whole path is: brief → intake → provision (check) → the four credentials → deploy → first sign-in →
lanes.

## 0. What you get and what you must bring

The factory gives an application everything except four credentials. It mints the database (a free Neon
Postgres on the Vercel Marketplace), the file store (a Vercel Blob store), the app's own cron secret, the key
that seals connector credentials, and the sign-in key pair. It cannot mint these four, and every one of them
is unavoidable:

| Secret name | What it is | Why the app cannot run without it |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id | the agent runs GLM 5.2 on Cloudflare Workers AI; `agent/lib/model.ts` builds the API URL from this id. Without it every agent turn fails at request time |
| `CLOUDFLARE_API_TOKEN` | a Workers AI token (Cloudflare dashboard: Account → AI → Workers AI, permission *read/run*) | same file: the bearer token on every model call. GLM 5.2 also requires a paid billing method on the Cloudflare account (its pricing page says so) |
| `RESEND_API_KEY` | an API key from resend.com | **sign-in is an emailed one-time code and it has no other delivery path.** `lib/platform-notify.ts` `sendLoginCode` is "Email ONLY — no Slack fallback": if the key is missing it returns `delivered: false` and the person sees "email delivery is not configured" — nobody can get in |
| `PLATFORM_NOTIFY_FROM` | the From address, e.g. `Delivered <no-reply@yourdomain.com>` — the domain must be verified in Resend | the same function refuses to send without a From address, and Resend refuses an unverified domain. Invites and notices use it too |

There is a second front door in the mold, Google One Tap, but it needs a Google OAuth client id the factory
does not provision (`GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_GOOGLE_CLIENT_ID` are optional in state and unset by
default) and it refuses personal-mail domains. With the factory defaults, the emailed code is the only way in.

Two more appear only if the brief turns the feature on: `EXA_API_KEY` (web search; the default brief keeps
search on, say "no web search" to drop it) and `BROWSERBASE_API_KEY` (the browser subagent; "no browser").

Never paste a secret value into chat, a file in this repo, or a command line. The one place a value goes is the
hidden prompt of `--set-secret` (step 4).

## 1. Write the brief (you)

Five lines in `briefs/<app_id>.md`. `app_id` is lowercase with underscores. Example:

```
Delivered for Acme's forward-deployed team.
Deploy on vercel. Fresh database. Product: delivered.
Workspace: Acme. FDE: you@acme.com. Members: a@acme.com, b@acme.com.
No browser subagent. Keep web search on.
Customer: acme.
```

Hints the intake understands are listed at the end of `docs/INTAKE.md` (`workspace:`, `fde:`, `members:`,
`product:`, `customer:`, `domain:`, `fresh database`, `no web search`, `no browser`, `single workspace`, …).
Anything the brief does not say takes the factory default; nothing is guessed. If a mold has more than one
product (mold_v1 has `delivered` and `dover`) the brief must say `product: <id>`.

## 2. Intake (agent, or you)

Say: *"stamp an app from briefs/<app_id>.md"*. The `intake` subagent runs

```
python3 .claude/scripts/intake.py briefs/<app_id>.md --app <app_id>
```

and asks you only what is unresolved, in batches of at most four. With the factory defaults already confirmed (`defaults.confirmed` in `state/factory.json` is true) a five-line
brief usually asks nothing. At the terminal, the same with questions on
screen: add `--ask`. Result: `state/application/<app_id>/` (four JSON files, secrets by **name** only), the app
registered in `state/factory.json` and under its product, and `factory.py validate` printing `ok`. The last line
tells you how many secret names the app declares.

## 3. Provision, check mode (agent) — this creates things

```
python3 .claude/scripts/provision.py <app_id>
```

Read this as "check *and provision*, do not build": on a Vercel app it creates the three Vercel projects
(`<project>`, `<project>-api`, `<project>-workflow`), gets the app a free Neon database and a Blob store, mints the
internal secrets, and then prints the names still missing — the four above — each with the exact command to run.
It also creates and deletes short-lived `sf-neon-inspect-*` projects while checking that a database is empty;
that is expected and explained in `docs/HOW_IT_WORKS.md`. It does not deploy. Run it once; if it stops with a
one-line instruction (a Marketplace link to accept the free Neon plan, a Blob token to connect), do that and run
it again.

## 4. The four credentials (you, at the terminal)

For each name the check printed:

```
python3 .claude/scripts/provision.py <app_id> --set-secret CLOUDFLARE_ACCOUNT_ID
python3 .claude/scripts/provision.py <app_id> --set-secret CLOUDFLARE_API_TOKEN
python3 .claude/scripts/provision.py <app_id> --set-secret RESEND_API_KEY
python3 .claude/scripts/provision.py <app_id> --set-secret PLATFORM_NOTIFY_FROM
```

Each asks for the value with input hidden and writes it to all three Vercel projects. If it stops saying the
value was stored as `sensitive`, turn off *Team Settings → Environment Variables → Sensitive Environment
Variables* in Vercel and rerun; a sensitive value can never be read back, so the factory refuses it. Then rerun
step 3 and expect `secrets present: N/N` and `check only; re-run with --deploy once nothing is missing`.

## 5. Deploy (you, at the terminal)

```
python3 .claude/scripts/provision.py <app_id> --deploy
```

In order: schema push and migrations on the Neon database, the `app_rw` role and the row-level-security
policies, a proof that the credential about to become `DATABASE_URL` cannot read another workspace's rows
(the deploy refuses otherwise and records the app `reverted`), the three deployments (task-workflow, eve API,
web), the three health checks. The last line is `deployed: https://<project>.vercel.app`. If it stops, the last
line is one sentence saying what to do; fix that and run the same command again. Re-runs are safe.

## 6. First sign-in (you, at the terminal)

The emailed-code door only issues a code to an address that already has a membership or an invite, so the
members from the brief have to be in the database first:

```
python3 .claude/scripts/clone.py <app_id> configure
```

(`configure` is the one `clone.py` step that applies to an app that is not a clone: it writes the workspace,
members and surface from the app's state into its database, through the app role.) Then open the URL from step
5, enter the FDE address from the brief, and type the code from the email. It expires in ten minutes. Every
other member from the brief signs in the same way; new people are invited from inside the app.

Connectors (GitHub, Slack, …) are entered inside the app after sign-in; a new app starts with none, because
each app seals them under its own key (`docs/HOW_IT_WORKS.md`, Secrets).

## 7. Lanes (agent)

```
python3 .claude/scripts/lanes.py <app_id> --list      # read-only: what each lane needs
python3 .claude/scripts/lanes.py <app_id>             # the run of record; a failure reverts the app and files a task
```

A `pass` means every check ran and passed; `skipped` means something could not run and the `--list` output says
what would unblock it. Today two lanes (accessibility, responsiveness) grade the signed-in product and need a
session for the factory's test identity, and the functional lane carries three known mold defects, so expect
`skipped`/`fail` rows with a named task rather than a clean board; that is the factory telling the truth, not a
step you skipped. A failing lane puts the app in `reverted` and control back with you: read the task it filed
(`python3 .claude/scripts/factory.py next mold_v1`).

## 8. Later

| Want to | Run |
|---|---|
| see where everything stands | `python3 .claude/scripts/factory.py status` |
| re-prove tenant isolation after any restore or migration | `python3 .claude/scripts/provision.py <app_id> --verify-rls` |
| redeploy after changing a secret (env changes take effect on the next build) | `python3 .claude/scripts/provision.py <app_id> --deploy` |
| rehearse the database locally without touching Vercel | brief says `vm` and `self-host the postgres`; then `provision.py <app_id> --verify-db`, and `python3 .claude/scripts/lib/localpg.py down <app_id>` to remove it |
| know what a workspace will cost in inference | `docs/COST_MODEL.md` |

## What this runbook does not cover

- A custom domain (`domain: <host>` is recorded in state; attaching it is a Vercel dashboard step).
- A clone of the live deployment: `.claude/skills/clone/SKILL.md`.
- `target: vm` as a place to run the app. It is a local verification target only; the reasons are in
  `infra/vm/README.md`.
