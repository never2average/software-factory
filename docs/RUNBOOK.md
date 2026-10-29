# Runbook: from a five-line brief to a live application

For the operator who runs this factory and does not read code. Every command below exists today; where the
factory stops and needs something from you, this says what and why. All commands run on the DigitalOcean VM,
inside `/root/software-factory` (`ssh digitalocean`, then `cd /root/software-factory`).

Two kinds of step: **agent** (say it to Claude Code, the `intake` / `provisioner` subagents run it) and **you,
at the terminal** — every step that touches a secret value, because the agent runtime is not allowed to handle
one. The whole path is: brief → intake → provision (check, read-only) → the credentials → deploy (prints its plan,
then creates) → first sign-in → more workspaces and the first company (§6a) → lanes.

That path is mold_v1's. An application from **mold_v0** (an MCP product: the shell, a pack and a brand) has its own,
shorter path in §11.

## 0. What you get and what you must bring

The factory gives an application everything except a handful of credentials. It mints the database (a free Neon
Postgres on the Vercel Marketplace), the file store (a Vercel Blob store), the app's own cron secret, the key
that seals connector credentials, and the sign-in key pair. It cannot mint these, and every one of them
is unavoidable. Which inference credential you bring depends on the provider the brief chose — the default is
Cloudflare Workers AI; say `use the Vercel AI Gateway` in the brief for the other one:

| Secret name | What it is | Why the app cannot run without it |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` (Cloudflare Workers AI only) | your Cloudflare account id | the agent runs GLM 5.2 (`@cf/zai-org/glm-5.2`) on Cloudflare Workers AI; `agent/lib/model.ts` builds the API URL from this id. Without it every agent turn fails at request time |
| `CLOUDFLARE_API_TOKEN` (Cloudflare Workers AI only) | a Workers AI token (Cloudflare dashboard: Account → AI → Workers AI, permission *read/run*) | same file: the bearer token on every model call. GLM 5.2 also requires a paid billing method on the Cloudflare account (its pricing page says so) |
| `AI_GATEWAY_API_KEY` (Vercel AI Gateway only) | an AI Gateway API key (Vercel dashboard: AI Gateway → API keys) | in gateway mode `model.ts` hands the model id `anthropic/claude-sonnet-5` to the AI SDK, whose gateway provider authenticates with this key. Claude Sonnet 5 is the free-tier-safe default; the gateway's free tier refuses Opus. No Cloudflare name is read at all |
| `RESEND_API_KEY` | an API key from resend.com | **sign-in is an emailed one-time code and it has no other delivery path.** `lib/platform-notify.ts` `sendLoginCode` is "Email ONLY — no Slack fallback": if the key is missing it returns `delivered: false` and the person sees "email delivery is not configured" — nobody can get in |
| `PLATFORM_NOTIFY_FROM` | the From address, e.g. `Delivered <no-reply@yourdomain.com>` — the domain must be verified in Resend | the same function refuses to send without a From address, and Resend refuses an unverified domain. Invites and notices use it too |

The front door is "Continue with Google", and it needs a Google OAuth client id the factory does not provision: `GOOGLE_CLIENT_ID` (written under both names the app reads) is required and comes from YOUR Google Cloud project. It is per app: each stamped application can sit in a different Google project, and `--set-secret GOOGLE_CLIENT_ID` records which one in `infrastructure.google.project_number` (the id's numeric prefix; an identifier, not a secret). Google refuses personal-mail domains at sign-in, so the person signing in needs a Workspace account. The emailed six-digit code is the second way in.

So a Cloudflare app brings five names (the Cloudflare pair, the Resend pair, the Google client id) and a gateway app brings four. What else changes on a gateway app:
`state/application/<app_id>/application.json` records `model.provider: gateway` and `model.model:
anthropic/claude-sonnet-5` with no `context_window` (the gateway looks it up), `MODEL_PROVIDER=gateway` is set on
the api project at deploy, and the only pieces of the app that differ are the model and the credential — everything
else in this runbook is identical. To change the model or reasoning later, set `GATEWAY_MODEL_ORCHESTRATOR`,
`GATEWAY_MODEL_SPECIALIST` or `GATEWAY_REASONING_EFFORT` on `<project>` by hand in the Vercel dashboard and redeploy;
absent, the mold defaults apply. `docs/COST_MODEL.md` prices the Cloudflare path only.

Two more appear only if the brief turns the feature on: `EXA_API_KEY` (web search; the default brief keeps
search on, say "no web search" to drop it) and `BROWSERBASE_API_KEY` (the browser subagent; "no browser").

Never paste a secret value into chat, a file in this repo, or a command line. The one place a value goes is the
hidden prompt of `--set-secret` (step 4).

## 1. Write the brief (you)

Five lines in `briefs/<app_id>.md`. `app_id` is lowercase with underscores. Example:

```
Delivered for Acme's forward-deployed team.
Deploy on vercel. Fresh database. Product: delivered.
Workspace: Acme. Operator: you@acme.com. Members: a@acme.com, b@acme.com.
No browser subagent. Keep web search on.
Customer: acme.
```

Hints the intake understands are listed at the end of `docs/INTAKE.md` (`workspace:`, `operator:`, `members:`,
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

## 3. Provision, check mode (agent) — read-only

```
python3 .claude/scripts/provision.py <app_id>
```

This creates nothing, anywhere. On a Vercel app it only reads: whether the three projects (`<project>`,
`<project>-api`, `<project>-workflow`) exist, which secret names are already set, and which spare Neon databases
and Blob stores the team has. Then it prints, in this order: each project as `exists` / `does not exist`; `a deploy
will create:` — every step a deploy performs, in the order it happens: a branded build copy (if your app has branding),
the projects, the Neon database (adopt a spare if one is empty, else a fresh one on the free plan), the Blob store, the
internal secrets it will mint, the build-time flags it rewrites, the database step (it ROTATES the database
password unless the one already deployed is the app's own — the check reads secret names, not values, so it cannot
tell in advance; a rotation means the previous build stops connecting until this one replaces it), then the three production deployments (workflow, api, web; "framework PATCHed" means the project's
framework setting is changed by an API call before deploying) and the state files it updates; `secrets present: n/N`;
one `--set-secret` line for every credential from §0 you still have to set; `secrets a deploy will mint (not yours to
set): <the names the deploy mints>` and `set during
--deploy: <the names the deploy fills>` (neither is yours to set); a reminder to run `--verify-rls` while nothing
has measured tenant isolation yet (a new app always shows it; §5 measures it); and the last line `check only,
read-only: nothing was created.` followed by either `Set the secret(s) above, then run: ... --deploy` or `Ready: ...
--deploy`. Run it as often as you like. If it stops with a one-line instruction (a project reconnected to git, a
provider the target cannot use), do that and run it again.

## 4. The credentials (you, at the terminal)

There are five on a Cloudflare app (four on a gateway app, which swaps the Cloudflare pair for `AI_GATEWAY_API_KEY`): the two Cloudflare values, the two Resend values, and the Google OAuth client id — Google sign-in is the product's front door and is required. For the Google one the browser tab matters more than the value: in Google Cloud Console (APIs & Services → Credentials → your *Web application* OAuth client) add this app's production URL under **Authorized JavaScript origins** *and* under **Authorized redirect URIs** (the same URL, exactly, no trailing slash — the button signs in by redirecting to Google and back to the page's origin), or Google refuses with `origin_mismatch` / `redirect_uri_mismatch` whatever id you set. One `--set-secret GOOGLE_CLIENT_ID` writes both names the app reads; the browser one is baked in at build, so `--deploy` again afterwards.

You do not need to look anything up before you start. Each `--set-secret` command first prints **what** the
value is, **where** in the Cloudflare or Resend dashboard to get it (the exact clicks), and **why** the app
cannot run without it — then asks for it with hidden input. It also checks the value's shape before writing
it, so a value pasted from the wrong box is refused in one sentence and nothing is stored. The Cloudflare
token needs only the *Workers AI Read* permission; grant nothing more.

**Two connectors ship with this repository** (`.claude/settings.json` enables the `resend` and `cloudflare`
plugins for anyone who opens it). Run `/mcp` once and log in to each; from then on the operator's agent can add
your sending domain, hand you the exact DNS records and confirm it is *Verified* before you set
`PLATFORM_NOTIFY_FROM`, and can read your Cloudflare account id instead of you copying it. What they cannot
do — by both services' design — is mint the first credential: the Cloudflare API token and the Resend API key
are created by the account owner in a browser. The Resend connector *can* create API keys, and this factory
never asks it to: a key it created would pass through the agent's context, and secret values never enter the
chat. You create the key; the connector uses it. The sender address must be at a
domain Resend shows as *Verified*, or every sign-in code bounces.

For each name the check printed (the Cloudflare pair, or `AI_GATEWAY_API_KEY` for a gateway app):

```
python3 .claude/scripts/provision.py <app_id> --set-secret CLOUDFLARE_ACCOUNT_ID
python3 .claude/scripts/provision.py <app_id> --set-secret CLOUDFLARE_API_TOKEN
python3 .claude/scripts/provision.py <app_id> --set-secret RESEND_API_KEY
python3 .claude/scripts/provision.py <app_id> --set-secret PLATFORM_NOTIFY_FROM
python3 .claude/scripts/provision.py <app_id> --set-secret GOOGLE_CLIENT_ID
python3 .claude/scripts/provision.py <app_id> --set-secret EXA_API_KEY          # only when web search is on
python3 .claude/scripts/provision.py <app_id> --set-secret BROWSERBASE_API_KEY  # only when the browser is on
```

The check in step 3 prints exactly the lines this app still needs; run those and no others.

Each asks for the value with input hidden and writes it to all three Vercel projects. The first one has to have
somewhere to live: if the three projects do not exist yet, this command creates them (empty, free, no deployment)
and prints `creating the Vercel project(s) ... to hold <NAME>` before it does — the one thing `--set-secret`
creates. If it stops saying the value was stored as `sensitive`, turn off *Team Settings → Environment Variables →
Sensitive Environment Variables* in Vercel and rerun; a sensitive value can never be read back, so the factory
refuses it. Then rerun step 3 and expect `secrets present: N/N` and `check only, read-only: nothing was created.
Ready: python3 .claude/scripts/provision.py <app_id> --deploy`.

## 5. Deploy (you, at the terminal)

```
python3 .claude/scripts/provision.py <app_id> --deploy
```

First it prints the same plan as `about to create:`. If any credential from §4 is still missing it stops right
there with `refusing to deploy: N secret(s) above are not set, so NOTHING was created` and the `--set-secret`
lines to run — nothing has been made yet. Otherwise it creates what the plan named: the three projects if absent,
the Neon database (it inspects each spare through a short-lived `sf-neon-inspect-*` project that it deletes in the
same run, explained in `docs/HOW_IT_WORKS.md`), the Blob store, the internal secrets. Then, in order: schema push
and migrations on the Neon database, the `app_rw` role and the row-level-security policies, a proof that the credential about to become `DATABASE_URL` cannot read another workspace's rows
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
members and surface from the app's state into its database, through the app role.) On an app on a server of its own
(`target: vm_remote`, §9) the same step is `python3 .claude/scripts/provision.py <app_id> --workspace-remote` (§9 G);
`clone.py configure` is for Vercel apps. Then open the URL from step
5, enter the operator address from the brief, and type the code from the email. It expires in ten minutes. Every
other member from the brief signs in the same way; new people are invited from inside the app.

Connectors (GitHub, Slack, …) are entered inside the app after sign-in; a new app starts with none, because
each app seals them under its own key (`docs/HOW_IT_WORKS.md`, Secrets).

## 6a. You, another workspace, and the first company (agent)

The mold ships three commands of its own for this (`molds/mold_v1/codebase/package.json`):

| Command | What it writes |
|---|---|
| `operator:new-org -- --name "<Name>" --id <id> --owner <email>` | a workspace: the `orgs` row, the owner (also made a platform admin), one workflow row per specialist and the build's starter library. On `onfinance_hfc_research` that library is `hfc-research`: four starter apps that refresh on a schedule and spend inference whether anyone opens them or not (`docs/COST_MODEL.md` §2c). Refuses a workspace id that already exists unless `--force`, so it cannot change an existing workspace by accident |
| `operator:onboard-self -- --org <workspace id> --email <you> --name "<you>"` | records you as a team member **in that one workspace** (a team memory and, in its data room, `People/<you>/`) and prints a readiness checklist. `--org` is required since mold 1260acd (upstream #154, mold_v1-229); without it the command stops and writes nothing. Run it once per workspace you work in |
| `operator:new-customer -- --email <you> --name "<Company>" --id <id> --org <workspace id>` | a company in that workspace: its row, you as its solution engineer, and `context.md` + `interactions.jsonl` in the workspace's data room |

They run inside the app, with the app's own database connection (the app role, row-level security on), never with an
admin password. The factory runs them for you with one command (mold_v1-230), the script's own arguments after `--`:

```
python3 .claude/scripts/provision.py <app_id> --operator new-org --dry-run -- --name "<Name>" --id <id> --owner <your email>
```

The agent shows you that dry run first: the exact command, with the database address, the file store's key and any
password-like value hidden; nothing runs and nothing is contacted. Each of these writes to your live app, so the agent asks you before it
runs one and adds `--yes` only after you said yes (without it the command stops and asks). Then:

- **On a server of your own:** it runs there, as the web app's user (`sfweb`), in the release that serves
  (`/opt/software-factory/<app_id>/current`), with `/etc/software-factory/<app_id>/web.env` as its environment and
  `WORKSPACE_OPS_URL=https://<domain>` for the health line. The values stay on the server: they are read there, passed to
  the script, and removed from anything it prints. Nobody needs to SSH in by hand.
- **On Vercel:** it runs on the factory machine from the app's build copy (`build/<app_id>/`), with two things read from
  the project's production environment for that run only and never printed: the app's database address and the file
  store's key (`BLOB_READ_WRITE_TOKEN`, the Vercel Blob store the deploy made; on an `s3` store, its `STORAGE_S3_*`
  settings). So both the rows and the data-room files (onboard-self's `People/<you>/`, new-customer's `context.md`) are
  written. Nothing else of the project's settings is handed to the script (mold_v1-237). If the app keeps its files on a
  server's own disk (`STORAGE_DRIVER=filesystem`), the factory cannot reach that disk: the command says so, and only the
  rows are written.

Then sign in at the app's address. The new workspace is in the workspace switcher for its owner; your first workspace
stays the one you land in.

**Taking a workspace out of service.** The mold has no way to delete a workspace. The one it has is **Suspend**: in the
app, switch to that workspace, open `https://<address>/workspace`, the **Settings** tab, then **Suspend** under
*Danger zone* (or `PATCH /api/ops/orgs/<id>?org=<id>` with
`{"status": "suspended"}` as its owner or an admin). A suspended workspace refuses sign-ins to it and its schedules stop
(the starter apps no longer refresh); its rows and files stay, and **Reactivate** brings it back.

Measured on `onfinance_hfc_vm` on 2026-10-10 with a throwaway workspace "Onboarding Check 2026-10-10": `new-org` and
`new-customer` succeeded (readiness: 1 member, 7 workflows, data-room prefix, 1 company) and the workspace was
suspended. `onboard-self` failed there (mold_v1-229); on 2026-10-11, on mold 1260acd, it succeeded with `--org` in the
same workspace, still suspended (it does not need the workspace active), and its row landed in that workspace only.
The existing workspaces were not touched (task mold_v1-210).

**Keep a sign-in for the deploy's chat check.** After every deploy the factory sends one chat to the app as a check,
and it needs a signed-in session of yours that the factory keeps in its own private folder. Without one it says
"no signed-in session for this app is on hand" and skips the check. A session lasts 7 days; to give it one (or a
fresh one), tell the agent to run this, with your sign-in address:

```
python3 .claude/scripts/mint.py <app_id> code-request <your email>
```

The app emails a code only to an address that belongs to one of its workspaces (the factory creates the first one,
with you as its owner, right after the first deploy). The command checks that first: if your address belongs to none it
says so, sends nothing, and names the next step, so you are never left waiting for an email.

A six-digit code arrives by email. Paste it into the chat and the agent runs
`python3 .claude/scripts/mint.py <app_id> code <six digits> <your email>`. The code expires in ten minutes, and the session
is stored only on the factory's machine, never in the repository or the chat.

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

The two browser lanes measure the app at its deployed URL (`infrastructure.vercel.production_url`). A `target: vm` app
has no such URL, so those lanes are `skipped` for it — unless you have started the mold yourself on this machine
against that app's env (`molds/mold_v1/testing/accessibility/README.md`, "Measuring a vm fixture", lists the steps)
and tell the lane where, for one run:

```
MOLD_V1_LANE_URL=http://127.0.0.1:<port> python3 .claude/scripts/lanes.py <app_id> --lane accessibility
```

The variable is honoured only for a `target: vm` app with no `production_url`, in a status that serves nobody, and
only for `http://127.0.0.1:<port>` or `http://localhost:<port>`; anything else is refused with one sentence, and a
`target: vercel` app ignores it — its `production_url` always wins. On such a fixture the workflow builder is printed
`not-covered` (the vm lane does not run the task-workflow service it needs) and each signed-in check that carries that
row, and so the lane, is recorded `skipped` — never `pass`. On a deployment the factory mints no session at all, so no
`lanes.py` run measures the builder either: it is measured only when you sign in to the deployed app yourself and lend
that session for one run (`MOLD_V1_SESSION_TOKEN=... python3 .claude/scripts/lanes.py <app_id> --lane accessibility`
on a `target: vercel` app with a `production_url`; `molds/mold_v1/testing/accessibility/README.md`, "Authenticated
coverage"). Until then every report says the builder is unmeasured. The loopback variable is the only way this factory
ever runs the app on the vm target, and it is a measurement on your own machine, not a place customers can reach.

## 8. Later

| Want to | Run |
|---|---|
| see where everything stands | `python3 .claude/scripts/factory.py status` |
| re-prove tenant isolation after any restore or migration | `python3 .claude/scripts/provision.py <app_id> --verify-rls` |
| redeploy after changing a secret (env changes take effect on the next build) | `python3 .claude/scripts/provision.py <app_id> --deploy` |
| rehearse the database locally without touching Vercel | brief says `vm` and `self-host the postgres`; then `provision.py <app_id> --verify-db`, and `python3 .claude/scripts/lib/localpg.py down <app_id>` to remove it |
| set up only the database on Vercel, deploy later | `python3 .claude/scripts/provision.py <app_id> --verify-db` on a vercel app — this one **creates** (projects, database, Blob store) and bootstraps the database without waiting for your credentials; it prints `about to create:` first |
| change the gateway model or reasoning effort | set `GATEWAY_MODEL_ORCHESTRATOR` / `GATEWAY_MODEL_SPECIALIST` / `GATEWAY_REASONING_EFFORT` on `<project>` in the Vercel dashboard, then `--deploy` again |
| know what a workspace will cost in inference | `docs/COST_MODEL.md` |
| run the app on a server of your own instead of Vercel | §9 below |
| keep an application's code in a private GitHub or GitLab repository of its own | §10 below; nothing makes one unless you ask |

## 9. A server of your own instead of Vercel (`target: vm_remote`)

**Where this stands today:** in production since 2026-10-04 (`onfinance_hfc_vm`, a DigitalOcean `s-4vcpu-8gb`).
Steps A to E cost one server and change nothing for anyone; step F is the deploy.

Say in the brief `on the customer's own server` (step 1), and intake writes an application whose target is
`vm_remote`. From then on five things are needed from you, one at a time. Each says how long it takes.

### A. Get the key that lets the factory into the server (2 minutes, you or the agent)

The factory logs in to the server with a key, never a password. This makes the key and shows you the half that is
safe to share:

```
python3 .claude/scripts/provision.py <app_id> --remote-key
```

It prints one long line starting `ssh-ed25519` and a name such as `sf_<app_id>`. Keep that window open: you paste the
line in step B. The other half of the key stays on the factory's machine and is never shown.

### B. Create the server (about 5 minutes, you)

You need a server with 8 GB of memory, 4 CPUs and Ubuntu 24.04. At DigitalOcean:

1. Open https://cloud.digitalocean.com/droplets/new
2. Under **Choose Region**, pick the one closest to the people who will use the app.
3. Under **Choose an image**, click **Ubuntu**, then choose **24.04 (LTS) x64**.
4. Under **Choose Size**, click **Basic**, then **Regular**, then the box that says **8 GB / 4 CPUs** (about $48 a month).
5. Under **Choose Authentication Method**, click **SSH Key**, then **New SSH Key**.
6. In the big box, paste the line from step A.
7. In the **Name** box, paste the key name from step A:

   ```
   sf_<app_id>
   ```

8. Click **Add SSH Key**, and make sure its checkbox is ticked.
9. Leave everything else as it is. Do not tick any extra software (in particular, nothing with Docker).
10. Click **Create Droplet**.
11. Wait about a minute. The page then shows the new server with a number like `203.0.113.7` next to it. That is its
    address; copy it.

The key you pasted only lets this factory in. Nobody else can use it, and you can remove it from the server at any time.

### C. Point the domain at the server (about 5 minutes, you; then up to an hour of waiting)

People will open the app at a name such as `research.yourcompany.com`. That name has to lead to the server. Where your
company's domain is managed (GoDaddy, Namecheap, Cloudflare, Google Domains, ...):

1. Open that site and sign in.
2. Find your domain and open its **DNS** settings (sometimes called **DNS records** or **Manage DNS**).
3. Click **Add record** (or **Add**).
4. For **Type**, choose **A**.
5. For **Name** (or **Host**), type only the first part of the name. For `research.yourcompany.com` that is:

   ```
   research
   ```

6. For **Value** (or **Points to**, or **IPv4 address**), paste the server address from step B.
7. If you see a cloud icon or a switch that says **Proxied** (Cloudflare), turn it off so it says **DNS only**.
8. Click **Save**.

The change usually takes a few minutes and can take up to an hour. You do not have to watch it: the next steps tell
you in one sentence if the name does not lead to the server yet.

### D. Tell the factory the two values (1 minute, you or the agent)

The address and the name are not secrets. You can paste them into the chat and the agent runs this, or run it yourself:

```
python3 .claude/scripts/provision.py <app_id> --set-remote host=203.0.113.7 domain=research.yourcompany.com
```

### E. Check, then look before you leap (2 minutes, agent)

```
python3 .claude/scripts/provision.py <app_id>                              # offline: what is still missing, in plain words
python3 .claude/scripts/provision.py <app_id> --qualify-remote             # logs in and only looks: is the server big enough, does it have KVM?
python3 .claude/scripts/provision.py <app_id> --deploy-remote --dry-run    # prints every command it would run; runs none
```

The first connects to nothing. The second changes nothing on the server; if the server is too small, is not Ubuntu
24.04, cannot run the agent's sandbox (no "nested virtualization"), or already has other software on it such as Docker or
another web server, it says which and what to pick instead, and
you have lost only a few minutes of a server you can delete. The third is the whole deploy on paper.

### F. Deploy (about 30 minutes the first time, you, at the terminal)

```
python3 .claude/scripts/provision.py <app_id> --deploy-remote
```

It checks the server once more, then installs what the app needs, closes every door except the three it must keep open
(the login port and the two web ports), sets up the database, and then asks you for the same handful of values as §4,
one at a time: the Cloudflare pair, the Resend pair, the Google client id. Each prompt first says what the value is
and where to click to get it. The screen stays blank while you paste; that is on purpose. The values go straight to
the server, into one file only the server's administrator account can read. They are never shown, never saved on the
factory's machine and never sent to chat. On a later deploy it asks for nothing it already has.

Then it copies the app's source, builds it on the server, prepares the database with the same safety steps as §5
(including the proof that one workspace cannot read another's rows), starts the three services and the six scheduled
jobs, and gets the security certificate for your domain. The last line is `deployed: https://research.yourcompany.com`.

If it stops, the last lines say in one sentence what to do. Fix that and run the same command again; every step is
safe to repeat. A redeploy does not take the app offline. Before it sends anything, it rehearses on the factory's
machine, so a file missing from what it would send stops it before the server is touched. On the server, it builds
the new version in a folder of its own while the running one keeps serving, and prepares the new version's sandboxes
there too. Only then does it switch over, by restarting the three services, which takes seconds. If the new version
does not start or does not answer its health check, the server goes back to the version that was running, by itself,
and the last lines say so. The previous version stays on the server. To go back to it by hand at any time:
`python3 .claude/scripts/provision.py <app_id> --rollback-remote` (run it again to go forward).

For the Google sign-in button, add `https://research.yourcompany.com` under **Authorized JavaScript origins** and
**Authorized redirect URIs** in Google Cloud Console, exactly as §4 describes for a Vercel address.

### G. Afterwards

| Want to | Run |
|---|---|
| re-prove that workspaces cannot see each other | `python3 .claude/scripts/provision.py <app_id> --verify-rls` |
| put the brief's workspace and its people into the app | `python3 .claude/scripts/provision.py <app_id> --workspace-remote` (see "The workspace" below; add `--dry-run` to read it first) |
| run the five lanes against the server | `python3 .claude/scripts/lanes.py <app_id>` (they grade `https://<your domain>`; the functional lane adds `tool.python`, which asks the agent to really run Python in its sandbox) |
| know what the server costs | `docs/COST_MODEL.md` §7 |
| see what old sandboxes are taking up | `python3 .claude/scripts/provision.py <app_id> --prune-sandboxes` (only lists; see "The disk" below) |
| see the starter workflows and recipes an older version of the app left in a workspace | `python3 .claude/scripts/provision.py <app_id> --library-cleanup` (only lists, per workspace, what would go and what stays and why; add `--apply` to remove the ones nobody edited, ran or built on) |
| go back to the version that was running before the last deploy | `python3 .claude/scripts/provision.py <app_id> --rollback-remote` (add `--dry-run` to read it first; run it again to go forward) |
| close the login port to the internet | step H below |

**The workspace.** A freshly deployed app has no workspace and nobody in it. This one command creates the workspace the brief
describes, with its owner, its members and their roles, and the starter library of recipes and workflows if the app asked for one
(most do not: the default is none); then it sets up the
assistant the way the brief describes it (its name and tone, its standing instructions, its model, each specialist's settings,
and any workflows the brief defines). If you keep extra workspaces under `state/application/<app_id>/seed/orgs/`, it writes
those too:

```
python3 .claude/scripts/provision.py <app_id> --workspace-remote
```

It does its writing on the server itself, so the database's address and password never leave the server, and it is safe to run
again: it adds what is missing and never removes anything. If the server already has a workspace under a different name than the
brief's, it stops and tells you the two names instead of making a second, empty workspace; say which name is right and the agent
fixes the brief's record. `python3 .claude/scripts/mint.py <app_id> run` does this step for you after a deploy.
One thing to know: the assistant's settings come from the brief. If someone changed the assistant's name or instructions inside
the app, running this again puts back what the brief says. Add `--dry-run` to the command to read what it would write first.

**Who runs what on the server.** The app is three programs (the web app, the agent, and the workflow service). Each runs under
its own account, so that even if the agent were tricked into misbehaving it could not read the web app's keys. You do not need to
do anything for this: the deploy sets it up and checks it every time, and says so if a check fails.

**Desktop notifications.** The deploy makes the pair of keys that browser notifications need on the server itself,
once, and keeps them; nobody types or sees them. The contact address the notification services are given is the
operator's email from the brief.

**The disk.** Every chat in which the agent ran code leaves about half a gigabyte on the server (that chat's private
workspace). Each night the server removes the workspaces of chats nobody has touched for 7 days. What that costs a
person: if they go back to a chat older than that, the files the agent had made inside its workspace are gone and it
starts with a clean one. The conversation itself, the documents it produced and everything in the data room are kept;
they live in the database and the file store, not in the workspace. To keep workspaces longer, put a number of days
in `vm_remote.sandbox.retention_days` in `state/application/<app_id>/infrastructure.json` and deploy again. A deploy
warns when the disk is 80% full and refuses to call itself healthy at 95%.

```
python3 .claude/scripts/provision.py <app_id> --prune-sandboxes            # lists what tonight's run would remove, and how much space; removes nothing
python3 .claude/scripts/provision.py <app_id> --prune-sandboxes --apply    # removes it now
```

### H. Close the login port to the internet (optional; about 5 minutes, you or the agent)

**Where this stands today:** built and tested without a server; the first run against a real one has not happened yet.

After step F the server answers on three ports: the two web ports and the login port the factory uses. This step puts
the login port inside a private tunnel between the factory's machine and the server, so the internet can no longer
even knock on it. The app itself is not touched and nobody is signed out.

```
python3 .claude/scripts/provision.py <app_id> --tunnel-remote --dry-run          # prints everything it would do, on both machines; does nothing
python3 .claude/scripts/provision.py <app_id> --tunnel-remote --factory-apply    # does it
```

The first prints, among the rest, the short list of what is installed on the factory's own machine (one small
package, one key file, one settings file, one service). Nothing is installed there without `--factory-apply`.

It cannot lock you out while it runs, and here is why: before it changes anything, the server sets itself a ten-minute alarm that
re-opens the login port on its own. The port is closed only after the factory has logged in through the tunnel, and
the alarm is switched off only after it has logged in through the tunnel a second time. If any step fails, the last
lines say whether the login port is still open (it is, unless they say otherwise) and what to run.

Afterwards, the one thing that can go wrong is the tunnel itself stopping one day; the way back in is the next
section, and it is worth reading once before you run this step.

The last line is `the tunnel is on`. From then on every command in this runbook works exactly as before; it simply
travels through the tunnel. To go back:

```
python3 .claude/scripts/provision.py <app_id> --tunnel-remote --off --factory-apply
```

### If the factory cannot reach the server (the tunnel is down)

This can only happen after step H, and only if the tunnel stops working: for example the factory's machine was
rebuilt or got a new address. The app keeps serving people the whole time; only the factory's own login is affected.
You re-open the login port from DigitalOcean's website. It takes about 10 minutes and needs your DigitalOcean
sign-in and the inbox of the email address on that account.

One thing to know first. DigitalOcean offers two consoles. The usual one, **Launch Droplet Console**, itself comes
in through the login port, so while that port is closed it will not connect. The one that always works is the
**Recovery Console**, which is like sitting at the server's own screen and keyboard; it asks for a password.

**First, get a password for the server (about 5 minutes; the app is offline for about 2 of them).** Skip this part if
you already set a root password on this server and know it.

1. Open https://cloud.digitalocean.com/droplets
2. Click the name of the server (the one whose address is `host` in `state/application/<app_id>/infrastructure.json`).
3. In the menu on the left, click **Access**.
4. Under **Reset root password**, click **Reset Root Password**, and confirm.
5. Wait for the email from DigitalOcean with a temporary password (a minute or two). The server restarts while
   this happens, and the app comes back by itself.

**Then, open the door (about 3 minutes).**

1. On the same **Access** page, click **Launch Recovery Console**. A black window opens.
2. Click inside it and press Enter once. It shows `login:`.
3. Type `root` and press Enter.
4. Type the temporary password from the email and press Enter. Nothing shows while you type; that is normal.
5. It asks you to choose a new password: type the temporary one again, then a new one of your own, twice. Keep
   the new one somewhere safe; never paste it into the chat.
6. When you see a line ending in `#`, type this line exactly and press Enter (typing is more reliable than pasting
   in this window):

   ```
   ufw allow 22/tcp
   ```

7. It answers `Rule added`. Close the window.

That is all: the login port is open again, the way it was before step H. It is still protected by the key from
step A; the password you just set works only at this console, never over the internet. Nothing was deleted. Tell
the agent it is done; it then runs this, which tidies up and records that the tunnel is off:

```
python3 .claude/scripts/provision.py <app_id> --tunnel-remote --off
```

and, once whatever broke the tunnel is fixed, step H again.

If any screen looks different from what is described here, say what it shows and we go from there.

Not built yet for a server of your own, and said so rather than half-done: backups of the database and the file store.
It is a named task (`python3 .claude/scripts/factory.py tasks mold_v1`).

## 10. A repository of its own for an application (only if you ask)

An application's code can be kept in a private repository on GitHub or GitLab, one per application. Nothing makes
one by itself. You ask the agent ("put onfinance_hfc in a GitHub repository"), and it does three things in order.

1. **It looks first, and creates nothing.**

   ```
   python3 .claude/scripts/repo.py <app_id> publish --provider github --dry-run
   ```

   This prints the name, where it will live, that it is private, how many files and how big, and the result of the
   secret check. The agent tells you these and waits for your yes.

2. **It creates the repository and pushes.** The same command without `--dry-run`. The repository is always private.

3. **It gives you the link.** The repository is a record, not a place to work: the next push replaces what is in
   it. A change to the base product goes upstream as a pull request; a change that is this app's own goes in its pack.

Afterwards:

| Want to | Run |
|---|---|
| see whether an app has a repository, and what a push would send | `python3 .claude/scripts/repo.py <app_id> status` |
| push the app as it is now (one commit, only if something changed) | `python3 .claude/scripts/repo.py <app_id> push` |
| have every finished deploy and recorded test run push by itself | `python3 .claude/scripts/repo.py <app_id> auto-push on` (and `off` to stop) |
| stop the factory using that repository (it is not deleted) | `python3 .claude/scripts/repo.py <app_id> unlink` |
| use an organisation, a group or another name | add `--owner <name>` or `--name <name>` to `publish` |

What goes in: the app's code as it is deployed, a `factory/` folder with the brief and the state files (they list
the workspace's members by email and the names of the secrets, never a secret's value), and a `FACTORY.md` page.
What stays out: installed packages, build output, `.env` files and logs. If the secret check finds a token, a key
or a password anywhere, it refuses the whole push and names the file and the line; there is no way to skip it.

### GitHub (nothing to do)

The factory uses the GitHub sign-in this machine already has. If it is ever signed out, the command prints the
steps (one command at your terminal, then a code you type into a GitHub page).

### GitLab (about three minutes, once, for every app)

The factory needs one access token from you. It is the same token for every app, it is read from this machine's
environment under the name `GITLAB_TOKEN`, and it is never written to the repository, the state files or the chat.

1. Open https://gitlab.com/-/user_settings/personal_access_tokens (on a company's own GitLab server, the same
   address with that server's name in place of `gitlab.com`).
2. Click **Add new token**.
3. In **Token name** type:

   ```
   software-factory
   ```

4. In **Expiration date** pick a date. Three months from now is a good choice.
5. Under **Select scopes** tick only **api**. Leave every other box empty.
6. Click **Create token** (older servers call the button **Create personal access token**).
7. GitLab shows the token once. Copy it.
8. In the terminal on this machine, not in the chat, run this line, paste the token when it asks, and press Enter.
   Nothing appears while you paste; that is the hidden prompt working.

   ```
   read -rsp "Paste the token: " T && printf 'export GITLAB_TOKEN=%s\n' "$T" >> ~/.profile && chmod 600 ~/.profile && unset T && echo " saved"
   ```

9. Close the Claude Code session and start a new one, so it picks the token up. Then ask for the repository again.

Why **api**: it is the smallest permission GitLab offers that can create a project. The narrower ones
(`write_repository`) can push to a project that exists and cannot create one. To keep the token's reach small
anyway, create it from an account that belongs only to the group the repositories should live in, and tell the
agent that group's name (`--owner <group>`); the token then reaches nothing outside that group. On a GitLab plan
that offers them, a group access token (the group's **Settings**, then **Access tokens**, role **Maintainer** or
higher, scope **api**) does the same without a separate account. When the token expires, repeat the steps; delete
the old `GITLAB_TOKEN` line from `~/.profile` first.

For a company's own server, tell the agent its name; it adds `--host gitlab.example.com`. If the `glab` command is
installed and signed in on this machine, the factory uses that sign-in and no token is needed.

## 11. An application from mold_v0 (an MCP product: the shell and a pack)

Everything above is mold_v1 (a chat app with three Vercel projects). mold_v0 is the **MCP product shell**: one API
and MCP server plus a web console, with workspaces (called accounts or companies in an app's own words), sign-in,
install pages for AI clients, a key vault, a metered inference gateway, sandboxed runs, record areas, usage, billing
and email. An application from it is the shell, **a pack** (`packs/<pack_id>/`: a `pack.json` that declares the
product's records, runs, credentials, schedules, onboarding steps, words and guide pages) and **a brand**. Nothing in
the shell is edited for an app. The shell's own reference is `molds/mold_v0/MOLD.md` ("How the factory runs it").

Today it serves two apps on Vercel: the re-mint of the first product (live with users) and an audit product made only
from a pack and a brand (deployed, five lanes passed on 2026-10-27, its first end-to-end audit still to run). The
path is the same for both, and the same as above in outline: brief, state, pack, brand, keys, deploy, lanes, address,
first user. What differs is below.

### 11.1 The brief (you, about 15 minutes)

A page in `briefs/<app_id>.md`. The lines the factory reads (`docs/INTAKE.md`, "mold_v0: …" sections, has all of them):

```
Mold: mold_v0
It runs on Vercel.
Packs: <pack_id>
Brand: <Product name>
Brand colour: #2F3A9E
Logo: brands/<app_id>/logo.svg
Tagline: <one line under the name>
Admins: you@example.com
Domain: app.example.com
```

- `It runs on Vercel.` (two Vercel projects) or `It runs on its own server.` (the shell's own Docker Compose stack
  with HTTPS on a server you rent, target `compose_remote`; steps in `molds/mold_v0/MOLD.md`, "How the factory runs
  it").
- `Packs:` names an existing pack. Or describe the product in the brief's pack sections (`## Records`, `## Jobs`,
  `## Credentials`, `## Schedules`, `## Onboarding`, `## Words`, `## MCP`, …; `docs/INTAKE.md`, "mold_v0: the
  brief's pack sections") and intake writes the pack for you.
- `Admins:` who may open the staff console (`/admin`). Without it nobody can, so intake asks.
- Optional sections for the app's own settings (`## Profile`, `## Budgets`, `## MCP instructions`, the emails'
  sender, the legal pages): `docs/INTAKE.md`, "mold_v0: the app's own profile settings".

### 11.2 Start it (agent)

Say *"mint `<app_id>` from briefs/`<app_id>`.md"*. The agent runs

```
python3 .claude/scripts/mint.py new <app_id> --brief briefs/<app_id>.md --mold mold_v0
python3 .claude/scripts/mint.py <app_id>
```

The second line lists the ten stations and the one thing that happens next. For a mold_v0 app *workspaces* and
*package* say "not needed" (accounts are made in the app's own console; AI clients connect to its address, there is
no package to publish). `python3 .claude/scripts/mint.py <app_id> run` does every station that needs nobody and stops,
saying exactly what it needs, at the first that needs you. When the next station is the deploy, the agent asks you
first and runs the deploy as in §11.4 (a mold_v0 deploy needs one more word on its command line today). Its parts, if
one fails and has to be run alone:

| Station | Command |
|---|---|
| state | `python3 .claude/scripts/intake.py briefs/<app_id>.md --app <app_id> --mold mold_v0` (add `--ask` at a terminal to answer questions on screen) |
| packs | `python3 .claude/scripts/packs.py check <pack_id> --mold mold_v0`; `packs.py show <pack_id>` lists what it adds |
| brand | `python3 .claude/scripts/branding.py <app_id> set --name "<Name>" --color "#2F3A9E" --logo brands/<app_id>/logo.svg`, then `branding.py <app_id> preview` (a page showing the sign-in tile and colours). A brand of its own is required before the first deploy: the shell's default look must never ship |

### 11.3 The keys (you, at the terminal, only if the check asks)

```
python3 .claude/scripts/provision.py <app_id>
```

Read-only: it says which of the two projects exist, what a deploy would create, and every secret name, sorted into
what the deploy mints itself (the database address, the vault's master key, the worker token, the cron secret: never
yours to set), the console's sign-in names, and the optional names that stay off while empty (billing, analytics, an
object store, Google sign-in). A mold_v0 app on Vercel needs **no** key from you to deploy. Set an optional one only
when you want what it turns on, in your own terminal, never in the chat:

```
python3 .claude/scripts/provision.py <app_id> --set-secret STRIPE_SECRET_KEY
```

It asks at a hidden prompt and writes the value only to the project that reads it; it applies at the next deploy.

The keys the product itself uses are **not** environment settings. The model provider's key (Anthropic, or a Google
Cloud Vertex AI service account), the sandbox provider's key (runs wait, and say so, until one is there) and the
email service's key (Resend: invitations and emailed sign-in codes) go in the app's **Key vault**: open
`https://<address>/admin/keys` signed in as a platform admin, press **Add a key** on the provider's row, paste the key
and press **Save key**. A key is shown
only as a hint after that, is stored sealed, and never reaches a run: a run gets a short-lived gateway token instead.

Sign-in: an app whose state names Clerk's keys keeps Clerk (both apps today); otherwise the shell's built-in sign-in
is used, an emailed eight-digit code (it needs the Resend key in the Key vault) and Google when its two names are set.

### 11.4 Deploy (you say yes; about 10 minutes)

See the plan first, read-only:

```
python3 .claude/scripts/provision.py <app_id> --deploy --dry-run
```

Then, once you have said yes to this deploy:

```
python3 .claude/scripts/provision.py <app_id> --deploy --allow-unverified-mold "<why>" --background
python3 .claude/scripts/provision.py <app_id> status
```

`--allow-unverified-mold` is needed for every mold_v0 deploy today: the release gate wants this repository's own
GitHub checks for the commit, and none run yet (ticket mold_v0-001, set aside by the operator on 2026-10-22). The reason is recorded in
`infrastructure.json` `deploy_gate.override`. A check that failed still refuses.

What the deploy does: a fresh build copy (`build/<app_id>/`: the shell, the brand, the packs, checked), the API
project first (its own free Neon Postgres on the first deploy, proven empty; the keys the shell mints), then the
console project pointed at the API, then health on both (`/healthz` through the console, `/admin` and `/app`
answering), then the shell's row-level security check against the deployed database. If anything after the first
deployment fails, **both** projects go back to what served before, by themselves, and the app is recorded `reverted`
with the reason. `status` reports running, done, failed, or needs you.

### 11.5 Lanes (agent; about 30 minutes)

```
python3 .claude/scripts/lanes.py <app_id> --list
python3 .claude/scripts/provision.py <app_id> --lane-key --dry-run
python3 .claude/scripts/lanes.py <app_id> --background
python3 .claude/scripts/lanes.py <app_id> status
```

The MCP check needs an account of the app's own. `--lane-key --dry-run` shows what it would create; it writes to the
app's data, so it runs (`--lane-key --yes`) only after your yes, once per app. The five lanes print a row per pack,
so one pack's failure shows on its own; a failed lane reverts the app and files a ticket. Run them after every
deploy: the *tests* station counts only lanes run after the last deploy.

### 11.6 Its own address (you add one DNS record; up to an hour of waiting)

```
python3 .claude/scripts/domain.py <app_id> status
python3 .claude/scripts/domain.py <app_id> attach app.example.com
python3 .claude/scripts/domain.py <app_id> verify
```

`attach` prints the DNS record to add at the domain's registrar. `verify` passes when the domain serves the app's
health answer through the console. `switch` (it needs your yes) makes the domain the front door: AI clients then
connect to `https://app.example.com/mcp`, and emails and install pages name it. A redeploy follows. The
`vercel.app` address keeps working.

### 11.7 The first customer (you, in the app; about 20 minutes)

1. Open `https://<address>/admin` and sign in with an address from the brief's `Admins:` line.
2. **Key vault** (`/admin/keys`): add the model provider's key, the sandbox provider's key and the Resend key
   (§11.3), if they are not there yet.
3. **Accounts** (`/admin/accounts`), **New account**: fill in **Account name** and **First person's email**, then
   **Create account**. That person gets an invitation by email. (Someone who asked for access on the landing page waits in **Access requests**:
   **Approve** does the same.)
4. On the new account, **Set monthly allowance…**: the most its runs may spend on models in a month, in US dollars.
   **An account with no plan and no allowance has $0 and cannot start a run** (unless the API project sets a default,
   `APP_ORG_MONTHLY_BUDGET_USD`). Per-run and per-month-per-kind
   ceilings come from the app's profile (`## Budgets` in the brief).
5. The customer accepts the invitation and signs in. Their **Home** lists the setup steps, each ticking itself off
   from what really happens: connect the AI client (the connection card on **Home**, or **Setup & training** in an app
   without a Home of its own, or the public `https://<address>/install` pages, one per client: Claude, ChatGPT, Cursor, VS Code, Claude Code and others; clients sign in, no key is
   copied), then the pack's own steps. For the audit product those are: set up the company profile, add an
   application, give it a read-only repository token on **Credentials**, refresh it, run the first audit, read the
   findings. The customer guide (`/app/docs`) explains each.
6. Watch it from **Overview** (`/admin`): the onboarding funnel, and **Needs attention** for an account that stopped
   at a step. **Health** shows what failed; **FinOps** shows spend by account and by provider.

The staff guide is the first page of **Docs** in the admin console (`/admin/docs`).

### 11.8 Operating it

| Want to | Run |
|---|---|
| see what is waiting across the factory (pull requests, tickets, deploys that are behind, leftovers) | `python3 .claude/scripts/sweep.py plan --json`; clean-up preview `python3 .claude/scripts/sweep.py clean --dry-run` |
| redeploy after a merged change to the shell or a pack | `provision.py <app_id> --deploy --dry-run`, then (after a yes, except where a standing instruction pre-approves that app) `--deploy --allow-unverified-mold "<why>" --background` |
| try the next release's database changes on a copy of the live database first (always, before a deploy that adds or edits a migration on an app with users) | `python3 .claude/scripts/provision.py <app_id> --rehearse-migrations --dry-run`, then `--rehearse-migrations --yes` after your yes. It makes a temporary Neon branch, applies the migrations there, measures them, and deletes the branch; the live database is only read. It needs a Neon API key on this machine, by name; if it is missing it stops and says how to add it |
| re-prove that no account can read another's rows | `python3 .claude/scripts/provision.py <app_id> --verify-rls` |
| go back after a bad release | a failed deploy goes back by itself (both projects). To go back by hand on Vercel: in each project (the API first, then the console) open **Deployments**, the deployment that served before (`infrastructure.json` `vercel.release.before` names both), then **Instant Rollback**; the next good deploy is promoted past it. On its own server: `python3 .claude/scripts/provision.py <app_id> --rollback-remote --dry-run`, then without `--dry-run`. The database is never rolled back, which is why a release that changes it is rehearsed on a copy first (the row above) |
| change who may open `/admin` | the brief's `Admins:` line and intake, or `/admin/admins` in the app (owners only) |

mold_v1 commands that do not apply to a mold_v0 app (each refuses with one sentence): `mint.py <app_id> code-request`
and `code`, and `provision.py <app_id> --smoke`, `--rollback` and `--verify-db` on Vercel (its deploy checks and
rolls back both projects itself).

## What this runbook does not cover

- A custom domain in depth: `python3 .claude/scripts/domain.py <app_id> status | attach <domain> | verify | switch`
  (§11.6 for a mold_v0 app; `domain.py --help` for the rest).
- A clone of the live deployment: `.claude/skills/clone/SKILL.md`.
- `target: vm` as a place to run the app for anyone (a server of your own that does serve the app is `target: vm_remote`,
  §9). `vm` is a local verification target only (the reasons are in
  `infra/vm/README.md`); the one exception is §7's `MOLD_V1_LANE_URL`, which lets the browser lanes measure a mold
  you started yourself on this machine, at a loopback address, and nowhere else.
