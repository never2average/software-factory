# software-factory

Turn a one-page description into a tested, deployed, multi-workspace AI agent app, operated from [Claude Code](https://claude.com/claude-code).

You write a brief: who the app is for, what its agents do, where it runs. The factory then takes it through each step:

1. stamps the app from a **mold** (a pinned base codebase);
2. applies your **pack** (the app's own agents and instructions) and your **brand**;
3. deploys it to **Vercel** or **your own server**, after proving each workspace's data stays locked to that workspace;
4. runs **five test suites** (functional, context, load, accessibility, responsiveness).

Any failure stops the line and says what's needed. A **factory board** inside Claude Code shows every app's health, stage, tickets, usage and build cost.

![The factory board](plugins/factory-board/docs/board-full.png)

> **Status.** One mold is usable today (`mold_v1`); `mold_v2` and `mold_v3` are coming soon.

---

## Quick start

### 1. What you need

- **Accounts, as needed:** a Linux machine (Ubuntu 24.04 tested), a Vercel account for Vercel apps, and a Cloudflare account for Workers AI inference.
- **Tools:**
  - **Python 3.11+** and **Node.js 24**
  - **git** and the **GitHub CLI** (`gh`)
  - the **Vercel CLI** (`npm i -g vercel`), signed in, for Vercel apps
  - **Claude Code**, for the agents, skills and the board
- **For an app on your own server:** a server with `/dev/kvm`, at least 4 vCPU / 8 GB, and SSH access. `provision.py <app> --qualify-remote` checks it for you.

### 2. Get the factory

```bash
git clone https://github.com/never2average/software-factory.git
cd software-factory
cp state/factory.local.example.json state/factory.local.json   # then put your own email, domain and Vercel team in it
python3 .claude/scripts/factory.py validate                      # prints "ok"
```

`state/factory.local.json` holds your own values (operator email, notification domain, Vercel team, machine address). It is git-ignored and never committed.

### 3. Fetch the mold

Molds are kept out of the repository and fetched from their source:

```bash
git clone --depth 1 https://github.com/never2average/fde-agent.git /tmp/fde-agent
rsync -a --delete --exclude .git --exclude node_modules --exclude test-results --exclude .next /tmp/fde-agent/ molds/mold_v1/codebase/
```

The pinned commit and the proof that your copy matches it are in [`molds/mold_v1/MOLD.md`](molds/mold_v1/MOLD.md).

### 4. Mint an app

Write a brief, a page of plain words, at `briefs/<app_id>.md`. Then:

```bash
python3 .claude/scripts/mint.py new my_app --brief briefs/my_app.md   # brief -> validated state; asks only what it can't work out
python3 .claude/scripts/mint.py my_app                                 # where it stands, and the one thing that happens next
python3 .claude/scripts/mint.py my_app run                             # do every step that needs nobody; stop where you're needed
```

`run` can be repeated at any time. Each step works out whether it's done by looking at the state, the registry and the live app, not by remembering. When it needs you, it says exactly what for:

- **a credential**, typed at a hidden prompt: `python3 .claude/scripts/provision.py my_app --set-secret NAME`;
- **a one-time sign-in code**, for the signed-in tests: `mint.py my_app code-request you@…`, then `mint.py my_app code <digits> you@…`;
- **a DNS record**, if the app has its own domain.

The steps, in order:

| Step | Done when |
|---|---|
| brief | `briefs/<app_id>.md` exists |
| state | the four state files are valid and no question is unanswered |
| packs | every pack the app names checks clean |
| brand | a name, a colour and a logo are set, or the default look is accepted |
| keys | every credential the deploy needs is present, checked **by name** |
| deploy | the app's three services answer, on the current mold snapshot |
| workspaces | the app's workspaces and their starting content are applied |
| tests | the five test suites ran after the last deploy and none failed |
| package | the app's own agent package is published (optional) |
| address | the app's own domain serves it (optional) |

`python3 .claude/scripts/mint.py list` shows every app and its next step.

### 5. Watch it

Start Claude Code in the factory folder and type `/factory`. The board ships with the factory and is turned on by `.claude/settings.json`. It has four tabs:

- **Products & apps:** stage, live health, deploys and build cost.
- **Molds:** each mold and its tickets.
- **Tickets:** filterable and clickable.
- **Analytics:** usage by agent and by user, and the tickets raised inside each app.

See [`plugins/factory-board/README.md`](plugins/factory-board/README.md).

To use the board outside the factory folder:

```
/plugin install factory-board --marketplace never2average/software-factory
```

---

## Everyday commands

| Command | What it does |
|---|---|
| `python3 .claude/scripts/provision.py <app>` | read-only check: what exists, what a deploy would create, which secrets are missing |
| `python3 .claude/scripts/provision.py <app> --deploy` | deploy to Vercel, after printing the plan; refuses if a secret is missing, and proves workspace isolation first |
| `python3 .claude/scripts/provision.py <app> --deploy-remote` | deploy to your own server over SSH; only ports 22, 80 and 443 are opened, with HTTPS by Caddy |
| `python3 .claude/scripts/provision.py <app> --capacity` | read-only: is the server big enough, or is it time for a bigger one |
| `python3 .claude/scripts/lanes.py <app>` | run the five test suites; a failure marks the app `reverted` and files a ticket |
| `python3 .claude/scripts/app_usage.py <app> --json` | read-only usage from the app's own database, by workspace, agent and user |
| `python3 .claude/scripts/mint_report.py <app>` | what building the app took: Claude Code cost and time, and deploys |
| `python3 .claude/scripts/factory.py status` | products, stages and ticket counts |
| `python3 .claude/scripts/factory.py next mold_v1` | the next ticket to work on |
| `python3 .claude/scripts/repo.py <app> publish --provider github --dry-run` | give an app its own private repository, only when you ask for one |

Most scripts have `--self-test` and `--dry-run`.

## How it fits together

| Folder | What's in it |
|---|---|
| `molds/` | each mold's `MOLD.md` (pinned source commit), its five test-suite definitions under `testing/`, and its branding rules. The codebase itself is fetched, not committed. |
| `packs/` | *(yours, not committed)* an app's own agents, instructions and starter content, applied on top of the mold. Molds are never edited or forked. |
| `state/` | `factory.json` (molds, defaults), `products.json` (products and their stage gates), `tasks/` (one ticket list per mold), `application/app_id/` (the schemas every app's records follow) |
| `.claude/` | Claude Code agents (`intake`, `provisioner`, `mold-engineer`, `lane-tester`, `product-packager`), skills (`mint`, `provision`, `run-lanes`, `productize`, `task`, `repo`, …) and the scripts above |
| `.agents/` | the same scripts and skills for other agent runtimes |
| `plugins/factory-board/` | the board |
| `infra/` | notes on the Vercel and server targets |
| `docs/` | the long-form documentation below |

Each app's own records (`state/application/<app_id>/`), packs, brands, briefs, build copies and reports stay on your machine and are git-ignored.

A **product** is a mold under a brand, with stage gates: defined → built → tested → deployed → released. A stage moves only when every ticket that gates it is closed (`productize` skill).

| Mold | Status | What it is |
|---|---|---|
| mold_v1 | **active** | multi-workspace, multi-agent web app on the eve framework, Next.js and Postgres, with Workers AI (GLM) or the Vercel AI Gateway |
| mold_v2 | coming soon | mold_v1 plus agent governance, pipeline-level data isolation, budgets and a performance governor |
| mold_v3 | coming soon | mold_v1 plus autoresearch, and multi-context, multi-role isolation per workflow |

## Ground rules the factory enforces

- **Secrets by name only.** State files hold `*_ref` names; values live in Vercel or the server's environment files, and are never printed.
- **Workspaces never see each other.** Every deploy proves row-level security on every workspace table before it finishes, and refuses otherwise.
- **Molds stay general.** App-specific words, agents and content live in a pack. A base-code change is a pull request to the mold's source, never a fork.
- **Nothing is guessed.** A figure that can't be measured says "not measured", never 0.

## Documentation

- [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md): the whole system, end to end.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md): operator runbook, from brief to live app, including your own server.
- [`docs/INTAKE.md`](docs/INTAKE.md): the questions intake asks, and how each is resolved.
- [`docs/PRODUCTS.md`](docs/PRODUCTS.md): products, packaging and stage gates.
- [`docs/COST_MODEL.md`](docs/COST_MODEL.md): inference and hosting costs per workspace.
- [`docs/STATE.md`](docs/STATE.md): the state files.
- [`AGENTS.md`](AGENTS.md): the rules any agent working in this repository follows.
