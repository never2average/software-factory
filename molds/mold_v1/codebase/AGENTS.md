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

## Working as an operator

The engineers who run this platform for a customer (operators) work through a set of guided **skills**
in [`.claude/skills/`](.claude/skills/), backed by scripts in
[`scripts/operator/`](scripts/operator/) (`npm run operator:*`; each command's older name still runs the same
file). The lifecycle — and where every
kind of work lands in the data room — is [`docs/OPERATOR_WORKFLOW.md`](docs/OPERATOR_WORKFLOW.md).

Start with the **`onboard-self`** skill (get yourself signed in, wired, and recorded
as a team member) before any customer work. Then `onboard-customer`, and the backfill
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

What a deployment is *for* (the product name, what an account and a team member are called,
which data-room domains show and under what label, the starter tree, the chat's opening
lines, a short per-turn briefing for the model, whether tasks are grouped into time-boxed periods the team shares,
periods each person holds their own items in, or none at all, and what a period is called) is a **deployment profile**: JSON files
added under `profiles/`, never an edit to a component. See
[`docs/DEPLOYMENT_PROFILE.md`](docs/DEPLOYMENT_PROFILE.md). When a profile relabels the
domains, the agent's model reads only its words: tool names, parameters, results, paths,
prompts and the roster are translated at the tool boundary (`agent/lib/agent-vocabulary.ts`),
storage never moves, and `npm run check:agent-vocabulary` proves both halves. What a PERSON reads (the UI, the
ops API's messages, the client bundle) takes the same words from `lib/ui-words.ts`, and
`npm run check:ui-vocabulary` proves it. The rest of the tree (identifiers, file names, comments, docs) is held by
`npm run check:neutral-names`: the base product's role word may appear only as a listed contract with its
migration plan, under a per-file ceiling, or under an exempt path (`scripts/neutral-names.allow.json`). Base text
never spells a role or a record word: it writes a placeholder the profile fills (`{member}`, `{owner}`, `{account}`,
`{deployment}`, `{implementation}`, `{rollout}`; `speak()` / `fill()` in `agent/lib/agent-vocabulary.ts`, `W` in
`lib/ui-words.ts`), the default profile's words are neutral, and the same check holds every record word still written
as prose to a per-file ceiling (`record_words` in the allow-list). The data room's FOLDER names are the
profile's too (`dataroom.domains.<id>.folder`): code builds a path from `FOLDER.<id>` (`agent/lib/dataroom-folders.ts`),
text writes `{folder:<id>}` / `{domain:<id>}`, and no file spells one (`stored_folders` in the same allow-list). A
deployment that already holds files pins the names it has and nothing moves; one that does not is refused at build
(`npm run check:dataroom-folders`) and at its first write, never forked. See "Stored folder names" in
[`docs/DEPLOYMENT_PROFILE.md`](docs/DEPLOYMENT_PROFILE.md). Every tool is
exported through `modelFacing(...)`; the root prompt is `agent/prompt-*.md`, rendered by
`agent/instructions.ts`, and a base specialist's is its `prompt.md`.

Base code ships **no workflow and no recipe of its own**. What a new workspace is provisioned
with (workflow scripts, the onboarding recipe catalog) is the content of the directories the
profile names under `library.sources`: none by default, the first product's under
[`library/account-delivery/`](library/account-delivery/README.md) for a deployment that opts in
(`cp library/account-delivery/profile.json profiles/40-library-account-delivery.json`), a
pack's own beside its specialists. A specialist the profile excludes gets no row. Existing
workspaces are never changed by a build: `npm run operator:library-cleanup` lists what an
earlier build left behind (a dry run) and removes only untouched rows, only with `--apply`.
`npm run check:neutral-names` refuses a library in base code. See "library" in
[`docs/DEPLOYMENT_PROFILE.md`](docs/DEPLOYMENT_PROFILE.md).

Each deployment publishes **its own npm package for coding agents**, built from its build of
this codebase by `npm run build:agent-cli` (address, product name, skills from
`agent-kit/skills/`, data-room description; a safety gate keeps operator material and
secrets out). The build never publishes. See [`docs/AGENT_CLI.md`](docs/AGENT_CLI.md).

## Configuration

Every environment variable the platform reads is documented in
[`.env.example`](.env.example) — what it does, whether it is required, and the
traps (Sensitive vars pulling as empty strings, trailing newlines changing which
model provider you bill).

### Capability flags

Three capabilities can be removed from a deployment entirely, for customers whose
security review forbids outbound network access from the agent (or, for vision,
sending a document image to an inference provider):

| Flag | Effect when `false` |
|---|---|
| `ENABLE_WEB_SEARCH` | removes `web_search` (Exa) |
| `ENABLE_BROWSER` | removes the browser subagent's 8 tools |
| `ENABLE_VISION` | removes `read_image` (the vision-language model behind a tool call). `CLOUDFLARE_MODEL_VISION=off` removes it the same way, for an account with no vision model. The vision model defaults to `@cf/zai-org/glm-5.3-flash`, asked for reasoning `MODEL_REASONING_VISION` (default `low`) |

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
