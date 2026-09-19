# eve Agent App

This project uses the eve framework. Before writing code, read the relevant guide
from the installed eve package docs. In most installs, those docs are at
`node_modules/eve/docs/`. In workspaces or local package installs, resolve the
installed `eve` package location first and read its `docs/` directory. If
package docs are unavailable, use https://eve.dev/docs as a fallback.

## Onboarding

New to the project? Start with [`setup/TEAM-SETUP.md`](setup/TEAM-SETUP.md): a ten-minute
procedure to connect your coding agent to the data room over MCP, put data in,
and build subagent-driven workflows. It begins with a live health check
(`/api/ops/health`) so you know the platform is up before you touch it.

## Working as an FDE

Forward-Deployed Engineers operate this platform through a set of guided **skills**
in [`.claude/skills/`](.claude/skills/), backed by scripts in
[`scripts/fde/`](scripts/fde/) (`npm run fde:*`). The lifecycle — and where every
kind of work lands in the data room — is [`docs/FDE_WORKFLOW.md`](docs/FDE_WORKFLOW.md).

Start with the **`onboard-self`** skill (get yourself signed in, wired, and recorded
as an FDE) before any customer work. Then `onboard-customer`, and the backfill
skills for reconstructing customization and integration history.

## Customising the eve agents

Adding or changing a specialist subagent is guided by seven skills in
[`.claude/skills/`](.claude/skills/). A subagent is a **full workspace** (rulebook, skills per
format variation, sandbox scripts with self-tests, schemas, validators), and registering one
is creating its directory and running `npm run build:subagent-meta`: no list is edited by hand.

| Skill | Use it to |
|---|---|
| `eve-subagent-workspace` | build a new subagent end to end; the entry point and the standard `npm run check:subagents` enforces |
| `eve-subagent-skills` | write the skill packages a subagent loads for each way its input varies |
| `eve-sandbox-workspace` | give it a sandbox with parsers, seeded scripts, schemas, validators and shared helper families |
| `eve-subagent-tools` | pick the narrowest tool set; `web_search` only through the gate |
| `eve-subagent-wiring` | `subagent.json`, data-room path templates, root delegation text, the `workflows` row, what reads the generated registry |
| `eve-subagent-verify` | prove it: the offline checks, both builds, a smoke turn, CI steps |
| `eve-customize-existing-agent` | change an existing agent with the right lever (code vs per-workspace data) |

A vertical (a set of subagents for one line of work) ships as a **subagent pack**: files
dropped in, no fork, no edits to base files. See
[`docs/SUBAGENT_PACKS.md`](docs/SUBAGENT_PACKS.md).

What a deployment is *for* (the product name, what a "customer" and an "FDE" are called,
which data-room domains show and under what label, the starter tree, the chat's opening
lines, a short per-turn briefing for the model) is a **deployment profile**: JSON files
added under `profiles/`, never an edit to a component. See
[`docs/DEPLOYMENT_PROFILE.md`](docs/DEPLOYMENT_PROFILE.md).

## Configuration

Every environment variable the platform reads is documented in
[`.env.example`](.env.example) — what it does, whether it is required, and the
traps (Sensitive vars pulling as empty strings, trailing newlines changing which
model provider you bill).

### Capability flags

Two capabilities can be removed from a deployment entirely, for customers whose
security review forbids outbound network access from the agent:

| Flag | Effect when `false` |
|---|---|
| `ENABLE_WEB_SEARCH` | removes `web_search` (Exa) |
| `ENABLE_BROWSER` | removes the browser subagent's 8 tools |

Both default **on**, so a deployment that sets neither is unchanged.

They work by exporting eve's `disableTool()` sentinel from the tool file, so the
tool is never registered and — per eve's docs — *"the model never sees it"*.
That is stronger than refusing inside `execute()`: a tool the model cannot see
is not one it can be talked into calling, and it costs no context describing a
capability that is not there.

Two consequences:

* **They are read at build time.** Flipping one needs a rebuild and redeploy,
  not just an environment change. That is the price of the tool being absent
  rather than merely refusing.
* **A capability must be gated everywhere it is declared.** `web_search` exists
  in four places — the root agent plus the `research`, `app-author` and
  `customer-context` subagents. Gating only the root leaves three subagents with
  full web access while the flag reads "off". If you add a flag, `grep` for
  every declaration of the tool first; a flag that covers some callers is worse
  than none, because it reports a guarantee it does not provide.
  Subagents added by a pack ([`docs/SUBAGENT_PACKS.md`](docs/SUBAGENT_PACKS.md))
  are declaring sites too and must use the same gated re-export
  (`WEB_SEARCH_ENABLED ? webSearchTool : disableTool()`); `npm run check:subagents`
  fails any `agent/**/tools/web_search.ts` that does not.
