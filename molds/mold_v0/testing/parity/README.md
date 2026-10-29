# Parity snapshots (mold_v0-136)

A **snapshot** records what one build shows people, AI clients and the console. A **diff** of two snapshots says, in
groups, what changed. This lets a refactor that should change nothing (moving the Octillion host pack's surface into
config, plan phases P1 and later) be checked field by field, with each phase naming the differences it expects.

Nothing here deploys, writes to a deployed app, or starts a run. Snapshots are taken in the lane world
(`../console/world.mts`): the build's API on an embedded throwaway database behind the shell's offline Clerk, and its
console built from the copy (`../console/render.py`) and served on 127.0.0.1. The live probe only reads.

## Commands

From the repository root:

```
python3 molds/mold_v0/testing/parity/parity.py snapshot zero --out <dir>          # the mold, no pack
python3 molds/mold_v0/testing/parity/parity.py snapshot <app_id> --out <dir>      # build/<app_id>.lane/, rebuilt first
python3 molds/mold_v0/testing/parity/parity.py diff <before> <after> [--allow allow.json]
python3 molds/mold_v0/testing/parity/parity.py probe <app_id>... --out probe.json # deployed app, read-only
python3 molds/mold_v0/testing/parity/parity.py --self-test                         # diff.mts tests and probe parsers
```

`snapshot` options: `--codebase <copy>` (any other copy, such as a branch's lane copy), `--no-copy` (use
`build/<app_id>.lane/` as it is), `--no-shots`, `--no-smoke`, `--only mcp,generated,api,pages`, `--pages /a,/b` (only
those pages, and the landing page and admin home, as render.py selects them: a phase that changes a few pages),
`--context-fixture` (mold_v0-142: company and person context and six memory items for the lane workspace and its owner,
the customer MCP connected as that owner, and the memory search's answers in `mcp/memory-search.json`; `--memory-search
<tool>` names that tool, default `search_memory`), `--journeys-fixture` (mold_v0-143: an account-wide tip from the
workflow tool and the owner's own sent by hand, an own use case with a stage marked by hand and an open help request,
so the journeys and tips routes and pages show them, and one answer of the tool that always carries the waiting tip in
`mcp/tip-answer.json`; `--tip-tool <tool>` names it, default `get_started`). The output folder must be
empty. A snapshot is a heavy step: on the factory VM run it through the heavy-step queue.

## What a snapshot holds

| Part | Where | What |
|---|---|---|
| Customer MCP | `mcp/customer.json` | The lane world's workspace, its owner, over an in-memory client (with the host pack's per-caller context, as `/mcp` builds it): `initialize` (server, capabilities, instructions), `tools/list`, `prompts/list`, `prompts/get` for every prompt with no argument, each argument alone, and all of them, `resources/list`, resource templates, `resources/read` of every resource (the widgets). |
| Admin MCP | `mcp/admin.json` | The same for the admin server (Owner role); `prompts/get` is each skill's text, and `skills` the Connect page's list. |
| Generated files | `generated/<path>` | Every `*.generated.*` file of the copy, byte for byte: `mcp-tools.generated.json`, `docs-corpus.generated.json`, `pack-guides.generated.ts`, `landing.generated.ts`, `pack-nav`/`pack-routes`/`pack-web`, `admin-docs.generated.ts` and the rest. |
| API | `api/routes.json`, `api/*.json`, `api/public/*.json` | Every route the API mounts (read from a second `createApp()` that never listens), then the answer to every GET without a path parameter under `/api/app`, `/api/admin` (including the onboarding lists and `/api/admin/onboarding/compute`, where the settings are), `/api/auth` and the other `/api/*` routers, as the workspace's owner (also platform staff); `/api/admin/settings` whatever it answers; `/healthz`, `/api/auth/config` and the OAuth metadata signed out. |
| Pages | `pages/<page>.json` | Every page `../console/surface.mts` lists (the shell's, each host pack's `routes.json`, each pack's tabs, pages and record areas, and the portal as someone in no workspace): status, where it ended, title, text lines and links. |
| Screenshots | `shots/<sha256>.png` | Each page at 390 and 1440 wide, light and dark colour scheme (the console is dark until someone picks Light or System in its top bar's theme switcher, mold_v0-177, and a snapshot never does, so most pairs are one file: shots are stored once per content), up to 6000px tall. |
| Smoke | `smoke.json`, `smoke-<pack>.log` | Each pack's own `scripts/smoke.ts` when it has one (Octillion's), on its own embedded database, with `APP_PROXY_HOPS=1` as every deploy sets it: pass or fail. (Octillion's plays distinct callers through `X-Forwarded-For`; with no proxy trusted every request is 127.0.0.1 and the per-address access-request limit answers 429, so on main it fails without the setting and passes with it.) A run whose runtime itself dies (exit 128 and up, such as a V8 fatal error in the embedded database on a busy machine) is run once more; both are in the log and `meta.json` says so. |
| Meta | `meta.json` | The packs, the parts taken, and how long each took (only `packs` is compared). |

**Masking** (`mask.mts`): times, dates, ports, Clerk-style ids, minted keys, tokens and long hex are replaced with
markers (`<date>`, `<port>`, `user_<id>`, `oct_<key>`, ...). A field is never dropped: a real value that changes is a
diff, and a field that appears or goes is too. Database ids are kept (the world makes the same rows in the same order
every run). When a determinism run shows a difference that is not the build's, add a mask for that value, never a
filter for the field or the page.

## Diff and allow lists

`diff.mts` groups differences as `meta`, `mcp.customer`, `mcp.admin`, `generated`, `api`, `pages`, `shots`, `smoke`.
Each has a key of parts joined by `::`, for example `mcp.customer::tools::list_products::description`,
`pages::/app/settings::text`, `shots::/app::390-dark`, `generated::web/src/config/landing.generated.ts`. Lists of named
things (tools, prompts, resources, routes) are matched by name, and a change of their order is its own difference.
Text shows as a unified diff. Two screenshots differ when more than `--pixel-threshold` of their pixels (default 0.1%)
differ by more than 24 in a channel.

An allow list marks what a phase expects (`*` is any run without `::`, `**` anything):

```json
{
  "phase": "P1: the host pack's tools read from config",
  "allow": [
    { "key": "generated::src/hosts.generated.ts", "reason": "the host entry is generated from config now" },
    { "key": "mcp.customer::tools::*::_meta", "reason": "tool metadata moves to the config's shape" }
  ]
}
```

Allowed differences print in their own section and do not fail the diff; an entry that matched nothing is named.
Exit codes: 0 nothing outside the allow list, 1 differences, 2 a snapshot could not be read.

## Live probe

`probe <app_id>...` reads the app's addresses from `state/application/<app_id>/infrastructure.json`
(`vercel.production_url` and `vercel.api_url`, or a server's domain) and records, for each: `GET /`, `/early-access`,
`/request-access`, `/healthz` (status, title, hashes of the masked body and of its visible text, its first words),
`/app` and `/admin` (status and redirect, never followed), the OAuth protected-resource metadata, and an MCP
`initialize` on `/mcp` **without a key** (status and what the server asks for). `tools/list` and `prompts/list` need an
account's key (the Octillion pack's `scripts/mcp-check.ts` reads one from the environment); the probe holds no key, so
they are recorded as skipped unless the server answers them without one. Two probes of an unchanged deploy are
identical except `probed_at`.

## As a lane, later

It is not a lane yet: `lanes.py` knows five lanes and `application.json` has a `testing` key for each. To make it one,
add `testing/parity/lane.json` with one check that runs

```
python3 {testing}/parity/parity.py snapshot {app_id} --no-copy --out <reports>/<app_id>-<time>
python3 {testing}/parity/parity.py diff <baseline> <that snapshot> --allow {testing}/parity/allow/<phase>.json
```

(the baseline being the snapshot recorded before the phase began), expect exit 0 and the line
`parity: no difference`, and add `parity` to `LANES` in `.claude/scripts/lanes.py` and to
`state/application/app_id/application.schema.json`, as `lanes.py` says when it finds a lane it does not know.
