# The agent package: one per deployment

Every application stamped from this codebase gets **its own published npm package** for
coding agents (for example `@acme/research`), built from that application's build of the
codebase. It carries the deployment's address, its product name and vocabulary, its own
agent skills and its own description of the data room. `npx <package> login` needs no
configuration, and nothing in the package names another product.

This document is the upstream half: how the codebase **builds** such a package,
deterministically. Choosing the name, the version policy, holding npm credentials and
publishing are the deployer's.

```bash
npm run build:generated        # the profile and the subagent registry must be current
npm run build:agent-cli -- --name @acme/research --version 1.0.0 --origin https://research.acme.com
```

writes a complete package directory to `dist/agent-cli/` (gitignored), runs the safety gate
over it, writes `manifest.json` beside the files and prints what `npm pack` would include.
It never publishes.

## How the package and the hosted endpoint relate

| | The hosted endpoint (`<address>/api/mcp`, [`MCP.md`](MCP.md)) | The package |
|---|---|---|
| Install | nothing | `npx <package>` |
| Sign-in | any invited email address (an emailed code) | `login`: a Google Workspace account (browser sign-in); `login --email <address>`: an emailed code |
| Address | it IS the deployment | baked in at build time |
| Tools | `setup/fde-tools.mjs` | the same file, copied |
| Skills | none | `npx <package> install-skills` |

Both serve the same tools from one definition. The package's help and README **lead with
the hosted one-liner**, and that string is produced by `lib/mcp-connect.ts` at build time,
the same function the onboarding screen and the invite email use, so the three cannot
disagree. The package exists for the skills, for a sign-in that is kept for you (Google,
refreshed; or an emailed code, good for 7 days), and because a versioned, immutable package
is a trust anchor a URL is not.

## Inputs

Each flag is also an environment variable.

| Flag | Env | |
|---|---|---|
| `--name` | `AGENT_CLI_NAME` | required. An npm package name; scopes allowed. Checked against npm's naming rules. |
| `--version` | `AGENT_CLI_VERSION` | required. Semantic version. |
| `--origin` | `AGENT_CLI_ORIGIN` | required. The deployment's address: `https`, host only, no path or query. Becomes the built-in address. |
| `--access` | `AGENT_CLI_ACCESS` | `public` (default) or `restricted`; written to `publishConfig.access`. |
| `--out` | `AGENT_CLI_OUT` | default `dist/agent-cli`. A non-empty directory that is not a previous build is refused. |
| `--repository`, `--homepage` | `AGENT_CLI_REPOSITORY`, `AGENT_CLI_HOMEPAGE` | omitted from `package.json` unless given. |
| `--allow-host` | `AGENT_CLI_ALLOW_HOSTS` | a third-party host a pack's skills legitimately name. Repeatable; the env is comma-separated. |
| `--allow-email` | `AGENT_CLI_ALLOW_EMAILS` | an email address that may appear. None by default. |

The **product name, tagline and vocabulary are not flags.** They come from the deployment
profile (`lib/deployment-profile.generated.ts`, [`DEPLOYMENT_PROFILE.md`](DEPLOYMENT_PROFILE.md)),
so a package cannot be named for a product the build is not. `PROFILES_DIR`, as for
`scripts/gen-deployment-profile.mjs`, reads another set of profiles through that same
validating generator; the tests use it.

## What is built

| File | From |
|---|---|
| `fde-cli.mjs`, `fde-login.mjs`, `fde-mcp.mjs`, `fde-tools.mjs`, `fde-install-skill.mjs` | `setup/`, byte for byte |
| `deployment.generated.mjs` | generated: `packageName`, `name`, `slug`, `tagline`, `origin`, `mcpEndpoint`, `vocabulary`, `commands`, `connect` |
| `dm.md` | the repo's `dm.md` as this deployment shows it (below) |
| `skills/<name>/` | the skills this deployment ships (below) |
| `README.md`, `package.json` | generated |
| `manifest.json` | every file with its size and sha256, and the total. **Not packed**: it sits beside the files so a publisher can diff two releases. |

**One generated module.** Every product word and the default address in `setup/*.mjs` comes
from `deployment.generated.mjs`. `setup/` ships the default one (the generic
`@delivery-agents/cli`: the base product's wording, **no address**), which
`npm run build:agent-cli -- --write-default` rewrites from `profiles/00-default.json`. A
built package replaces that one file and nothing else. `fde-tools.mjs` takes everything
from its host (`ctx`), so it has no product words to replace and is shared with the app.

**Commands.** `npx <package>` prints help (the product's name, the hosted one-liner, then
the commands) and exits 0. `npx <package> login | mcp | install-skills` go through that
dispatcher (`fde-cli.mjs`), which also still takes the older `fde-login`, `fde-mcp` and
`fde-install-skill`. The bins all carry the package's own unscoped name: `<name>` (the
dispatcher), `<name>-login`, `<name>-mcp` and `<name>-install-skills`. There is no bare
`login` bin (installed globally it shadowed the system's) and no `fde-*` bin (two
deployments' packages would collide on them).

**Sign-in.** `login` is the Google installed-app flow. `login --email <address>` is for the
many people with no Google account: it calls `POST /api/auth/email/request` on the
package's address, asks for the six-digit code on the terminal (`--code <digits>` verifies a
code already in hand and sends no new one; with stdin not a terminal the code is read from
stdin), calls `POST /api/auth/email/verify`, and stores
`{ kind: "email-session", session_token, email, expires_at, ops_url }` in the same
credentials file (mode 600). The MCP server sends that token as its bearer until
`expires_at` (epoch seconds); after that it answers with one sentence telling the person to
sign in again, since these sessions have no refresh. The token is never printed.

**Which address, first match wins:** `--url <address>` or `FDE_OPS_URL`; the address saved
at sign-in; the built-in one. A built package keeps its sign-in in its own folder
(`~/.config/fde-mcp/<deployment host>/`), so signing in to a second product cannot repoint
the first.

**`dm.md`.** Hidden data-room domains are removed. A relabelled domain reads
`Label [Folder]`, for example `Companies [Customers]`: the bracketed name is the real one,
and the one every tool path uses. Redefined record areas are summarised at the top, for
example `Portfolios (stored as Implementation; each row is a Portfolio entry): …`. Path
templates subagents add (`EXTRA_DATAROOM_PATH_TEMPLATES`) are appended under their domain.
Under the default profile the result is `setup/dm.md` byte for byte; a test asserts it.

## Skills and the `agent-kit/` convention

A pack may add **`agent-kit/skills/<name>/SKILL.md`** (plus references beside it), at the
codebase root or inside one of its subagents (`agent/subagents/<key>/agent-kit/`). This is
the only place a pack puts material meant for a coding agent outside the app, and
**only `agent-kit/` content ships** in the package.

- No `agent-kit` skills: the package ships the repo's `skills/*`.
- Any `agent-kit` skill: the base skills are **left out**. They teach the base product's
  use ("onboard a customer's platform"), which is a different use from a research desk's.
  To ship one anyway, name it in the optional `agent-kit/kit.json`:
  `{ "include_base_skills": ["delivered-setup"] }`.
- A base skill that ships has the generic package's name replaced with this package's.
- Every `SKILL.md` needs valid YAML frontmatter with `name` (equal to its directory,
  `^[a-z0-9-]{1,64}$`) and `description` (at most 1024 characters). A description
  containing `: ` must be double-quoted. Anything else fails the build.

## The safety gate

A public package is readable by anyone. The build **fails (exit 1), lists every offender
and removes the output** if the package contains:

- a file that is not on the allowlist: the nine package files above, and under
  `skills/<name>/` only `.md .json .txt .yaml .yml .csv`; a symbolic link; binary content;
- any `.env` file;
- any `*-spec.md` rulebook, or any file under a `schemas/` directory. These are operator
  material (an analysts' KPI rulebook, say) and must never reach a public package;
- something shaped like a secret: `re_…`, `cfut_…`, `sk-…`, `AKIA…`, a private key block,
  `Bearer <long value>`, `postgres://user:password@`, a JSON Web Token, GitHub, Slack and
  Vercel Blob tokens, and any `GOCSPX-` value other than the installed-app client secret
  `fde-login.mjs` has always shipped (Google does not treat that one as confidential; it is
  matched by digest);
- an email address other than the placeholders the connect instructions print and
  `--allow-email`;
- **another deployment's address**: any `http(s)` address that is not `--origin`, a
  documentation placeholder (`example.com`), or one of the third-party hosts the CLI
  legitimately names: `accounts.google.com`, `oauth2.googleapis.com` (sign-in and token
  refresh), `mcp.linear.app` (an example in a tool description), `developers.google.com`,
  `127.0.0.1` and `localhost` (the sign-in callback). Add another with `--allow-host`;
- the generic package's name (`@delivery-agents/cli`), when building under another name.

Findings are reported as `file:line` with the value shortened, never printed in full.
After the gate, the build checks that `npm pack --dry-run` would pack **exactly** the files
the gate checked.

The gate is a net, not a review. Read `README.md`, `dm.md` and the skills before the first
publish of a new deployment.

## Publishing (a person does this)

The build never runs `npm publish` or `npm login`, and nothing in this repository should.

```bash
npm run build:agent-cli -- --name @acme/research --version 1.0.0 --origin https://research.acme.com
diff <(jq -r '.files[] | "\(.sha256)  \(.path)"' previous/manifest.json) \
     <(jq -r '.files[] | "\(.sha256)  \(.path)"' dist/agent-cli/manifest.json)   # what changed since the last release
npm publish dist/agent-cli --access public
```

A published version is immutable: a mistake is fixed by publishing the next version.

## Testing

```bash
npm run test:agent-cli
```

Builds real packages into temp directories under the default profile and a probe profile
(`docs/examples/profile-equity-research.json`) with a temporary `agent-kit/` skill, and
checks the `package.json`, every bin's `--help`, which address wins, sign-in by emailed code
(against a local stub of the two routes; no mail is sent), `dm.md`, which skills
ship, each safety-gate rule, that npm packs exactly the manifest, and that the generic
package in `setup/` is unchanged apart from its new generated module. It leaves the
working tree as it found it, and needs a base checkout (no `agent-kit/` present).
