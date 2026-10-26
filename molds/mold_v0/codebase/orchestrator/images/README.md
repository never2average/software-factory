# Worker images

There is one image per **enabled** harness in [`harnesses/registry.json`](../../harnesses/registry.json). The
registry (see [`harnesses/README.md`](../../harnesses/README.md)) says which agents exist, their pinned versions
and their usage weights. This directory turns those pins into two kinds of runnable sandbox:

- **Docker images** (`Dockerfile.<harness>`, `build.sh`), for the `docker` runner and the warm-pod fleet.
- **boat.dev named snapshots** (`boat-setup/<harness>.sh`, `boat-snapshot.sh`), for production on boat.dev VMs.

| harness | CLI | install source | version | boat preinstalled |
|---|---|---|---|---|
| claude-code | `claude` | npm `@anthropic-ai/claude-code` | 2.1.296 | yes (pinned over) |
| codex | `codex` | npm `@openai/codex` | 0.162.1 | yes (pinned over) |
| copilot | `copilot` | npm `@github/copilot` | 1.0.95 | no |
| cursor | `cursor-agent` | `downloads.cursor.com/lab/<build>/linux/<arch>/agent-cli-package.tar.gz` (what `cursor.com/install` fetches) | 2026.10.01-e373342 | yes (pinned over) |
| opencode | `opencode` | npm `opencode-ai` | 1.18.35 | yes (pinned over) |
| antigravity | `agy` | `storage.googleapis.com/antigravity-public/antigravity-cli/<build>/...` + sha512 (what `antigravity.google/cli/install.sh` fetches) | 1.3.3 | no |
| gemini-cli | `gemini` | npm `@google/gemini-cli` | 0.63.0 | no |
| pi | `pi` | npm `@earendil-works/pi-coding-agent` (`--ignore-scripts`) | 1.1.0 | yes (pinned over) |
| cline | `cline` | npm `cline` | 3.0.70 | no |
| kilo | `kilo` | npm `@kilocode/cli` | 7.8.8 | no |
| amp | `amp` | npm `@ampcode/cli` | 0.0.1791619249-g722a12 | no |
| droid | `droid` | npm `droid` (same binary as `app.factory.ai/cli`) | 0.238.0 | no |
| qwen-code | `qwen` | npm `@qwen-code/qwen-code` | 0.25.0 | no |

Package names and install URLs were checked against npm (`npm view`) and the vendors' own install scripts on
2026-10-10.

## Docker images

Every `Dockerfile.<harness>` follows the same contract, which `orchestrator/fleet` and the docker runner rely on:

- **Pinned:** `ARG HARNESS_VERSION=<registry harness_version>`. `build.sh` passes it explicitly from the registry.
- **Neutral base:** `node:22-bookworm` plus git, curl, jq, ripgrep, build-essential and python3 (pip, venv).
  It includes **no** dev-tool SDKs, no `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/rules files, no MCP config and no
  harness config. Anything preinstalled could bias which tools the agent picks, and that is exactly what
  the product measures. The harness is the only extra.
- **Non-root:** user `agent`, `HOME=/home/agent`, and `WORKDIR /home/agent/work` owned by `agent`. The npm global
  prefix is in `$HOME`, so the agent can `npm i -g` without sudo. The harness CLI is installed system-wide
  (`/usr/local/bin`), so `docker exec -u agent <pod> <cli>` works.
- **Warm pod:** `CMD ["sleep", "infinity"]`. The worker runs each session with
  `docker exec -u agent -e <KEY> <pod> <cli> ...`. **No API keys are baked in.** Keys are passed at exec time
  (`requires_env` in the registry).
- **Healthcheck:** `<cli> --version`, so `docker inspect` shows the running version. It uses
  `--start-interval=5s`, which needs Docker 25+.
- **No auto-update:** `DISABLE_AUTOUPDATER=1` (Claude), `COPILOT_AUTO_UPDATE=false` and
  `OPENCODE_DISABLE_AUTOUPDATE=true`. Cursor and Antigravity binaries are pinned by build id.
- **Labels, not env:** `dev.app.harness` and `dev.app.harness_version` are image LABELs (also set by
  `build.sh`). They used to be env vars, which the agent could read; nothing of the shell's own is in the env now.

### build.sh

```bash
orchestrator/images/build.sh                  # all enabled harnesses
orchestrator/images/build.sh codex cursor     # some
DRY_RUN=1 orchestrator/images/build.sh        # print docker commands
PLATFORM=linux/arm64 orchestrator/images/build.sh
NO_SMOKE=1 orchestrator/images/build.sh       # skip the warm-pod smoke test
```

`build.sh` reads `registry.json` with `node -e`. It builds each distinct (harness, version) once and tags it
exactly `image.docker` (`app/agent-<harness>:<harness_version>`), which is the tag `fleet/plan.ts` reads. Images built
before mold_v0-097 carry the old name; the orchestrator runs one of those only where the new tag is not built yet
(`core/runners.ts` `localImage`), never pulls an image (`--pull never`), and `deploy/cleanup.sh` removes the old tag
once the same version is built under the new one.
It then smoke-tests the image the way the fleet uses it:

```
docker run -d <tag>
docker exec -u agent <c> <cli> --version     # must contain the pinned version
docker rm -f <c>
```

It fails if two agents of one harness disagree on version or tag. It never pushes. Publishing to a registry is a
separate, deliberate step.

All 13 images built and passed the smoke test here on 2026-10-10. The images are 1.9–2.5 GB each (unpacked), mostly the
shared `node:22-bookworm` + apt layers, so a node pulling several of them pays for the base once.

## boat.dev snapshots (production)

The boat runner gives each session a fresh boat VM. Boat VMs ship `claude`, `codex`, `pi`, `opencode` and
`cursor-agent` preinstalled ([machines](https://docs.boat.dev/machines)), but at whatever version Boat's image
carries. Gemini, Copilot, Amp, droid and the rest are not installed. Installing on every session is slow and
unpinned, so we bake one **named snapshot per harness** and start session VMs from it.

### How boat named snapshots work

Source: <https://docs.boat.dev/snapshots>,
[save named snapshot](https://docs.boat.dev/api/reference/snapshots/save-named-snapshot),
[create sandbox](https://docs.boat.dev/api/reference/sandboxes/create-sandbox), and
[CLI reference](https://docs.boat.dev/cli-reference).

- **Save.** `POST /api/v1/named-snapshots {"sandboxId":"bx_...","name":"<name>"}` returns `202 status:"saving"`.
  Poll `GET /named-snapshots/{name}` until `status` is `ready` (then `snapshotId` is set) or `failed` (then
  `error` is set). If the sandbox is running, Boat first takes a fresh capture, which can take minutes. The CLI
  equivalent is `boat snapshot <sandboxId> <name>`, or `boat snapshot current <name>` from inside the VM.
- **Names** must match `^[a-z0-9][a-z0-9-]{0,62}$`, so no dots. The reserved names are `latest`, `tree`, `pull`,
  `rm`, `save`, `current`, `self` and `new`. That is why the registry uses `app-claude-code-2-1-296`. Snapshots baked
  before mold_v0-097 keep their old names in the account (nothing here deletes them); nothing starts from them by name
  either: the next bake saves them under the new names, and the old ones can be deleted after it.
  Saving under an existing name **replaces it only once the new save is ready**, so a failed re-bake leaves the
  old snapshot deploying.
- **Lifetime.** Named snapshots belong to the account or org, never expire, and survive deletion of their source
  sandbox.
- **Cost.** 10 named snapshots are free. Each one beyond that costs $1.70 a month, and saving one past 10 with no
  credit returns `402 credit_required`. With 13 enabled harnesses that is about $5 a month. Retire old versions
  with `DELETE /named-snapshots/{name}` or `boat snapshot rm <name>`.
- **What is captured:** `/home/user`, Docker named volumes, and your changes under `/etc`, `/usr`, `/opt`,
  `/root` and `/srv`. Not captured: `~/.cache`, running processes and Docker build cache. Exclusions go in
  `.boxignore`. Our setup scripts install into `/usr/local` and `/opt`, so the install is captured.
- **Deploy.** Call `POST /api/v1/sandboxes` with `{"from":"<name>","noEnv":true,"ttlSeconds":...}`. Omitting
  `type` inherits the snapshot's type. CLI: `boat new --from <name> --no-env`. Per-sandbox `env` set on the
  *source* sandbox is carried into sandboxes deployed from a snapshot, so never pass keys when baking. The bake
  uses `noEnv:true` and passes no `env`.

### Baking

```bash
BOAT_API_KEY=boat_... orchestrator/images/boat-snapshot.sh            # all enabled harnesses
BOAT_API_KEY=boat_... orchestrator/images/boat-snapshot.sh gemini-cli  # one
DRY_RUN=1 orchestrator/images/boat-snapshot.sh                         # plan only
```

For each harness, `boat-snapshot.sh` does the following:

1. Creates a fresh VM (`noEnv:true`, 1 h TTL).
2. Uploads `boat-setup/_common.sh` and `boat-setup/<harness>.sh` to `/tmp/app-setup/`.
3. Runs the setup script synchronously (it must finish within 600 s; all of ours take under a minute).
4. Removes the scripts and saves the named snapshot `image.boat_snapshot`.
5. Polls until `ready`, then deletes the build VM. The VM is deleted even when a step fails.

The key needs to create and delete sandboxes and save named snapshots.

`boat-setup/<harness>.sh [version]` can also be run by hand inside any boat VM. It does the following:

- Installs the pinned version **system-wide**: npm `--prefix /usr/local --force`, which overrides Boat's
  preinstalled copy, or the vendor tarball under `/opt` symlinked into `/usr/local/bin`.
- Makes sure `/usr/local/bin/node` is at least Node 22, copied from Boat's nvm Node if needed, because the npm
  CLIs use `#!/usr/bin/env node`.
- Verifies the install the way the worker runs it: as an unprivileged user, under `env -i` with
  `PATH=/usr/local/bin:/usr/bin:/bin`, checking `--version` against the pin.
- Writes `/etc/app/harnesses/<harness>.json` (harness, bin, path, version).
- Cleans the npm caches.

It writes no keys, config, rules or MCP servers.

**Tested:** the claude-code, cursor, antigravity, opencode and pi setup scripts ran clean in an Ubuntu 24.04
container that mimics a boat VM (a `user` account with passwordless sudo and Node 24 in an nvm-style dir).
**Not yet tested:** `boat-snapshot.sh` against the live boat API, because no `BOAT_API_KEY` was used here.

### Wiring it into the worker (not done here)

The boat runner currently creates sandboxes without `from`. To use the snapshots:

- Create session VMs with `{"from": agent.image.boat_snapshot, "noEnv": true, ...}`.
- Keep `snapshots:false` on *session* VMs only. The bake VM needs snapshots on.
- Put `/usr/local/bin` first on the agent user's PATH.
- Optionally assert that `/etc/app/harnesses/<harness>.json` matches the registry version before running.

## Adding a harness

1. Confirm it is runnable: Linux, non-interactive, auto-approve, env-var auth and a JSON event stream.
2. Add the agent(s) to `registry.json`, with `cli`, `headless`, `event_format` and `requires_env`.
3. Copy the closest `Dockerfile.<harness>` (npm-based, or tarball-based like cursor and antigravity) and change
   the install step, the `cli` in the healthcheck and the `dev.app.harness` LABEL.
4. Copy the closest `boat-setup/<harness>.sh`.
5. Run `build.sh <harness>`, then `boat-snapshot.sh <harness>`, then `npx tsx orchestrator/fleet/plan.ts 10`.
6. Add the adapter in `orchestrator/harnesses/adapters.ts` and set `worker_adapter: "supported"`.
