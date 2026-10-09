# @delivery-agents/cli

Sign in and point your coding agent at your workspace over MCP — the Data Room,
Connectors, Workflows and Crons, driven from your editor.

> **You may not need this package.** Every deployment serves its own MCP endpoint
> at `<your deployment's address>/api/mcp` — nothing to install, works with any
> invited email address, and cannot point at the wrong app. The invite email and
> the "Invite your team" screen show the exact command. See `docs/MCP.md` in the
> platform repo. This package signs you in either way — a work Google account, or
> a code emailed to you (`workspace-login --email <address>`) — and is the only route to
> the direct-blob data-room mode.

> **There is no default address.** This same package serves every application
> built from this codebase, so it cannot know which one is yours. Set
> `WORKSPACE_OPS_URL` to your deployment's address (the one you open in a browser), or
> save it once with `workspace-login --url <address>`. Without it every tool fails with
> a message naming `WORKSPACE_OPS_URL`. (It used to default to one product's production
> address, which silently connected everyone else to the wrong app.)

> **A deployment can have its own package instead.** `npm run build:agent-cli` in the
> platform repo builds one with that deployment's address, product name, skills and
> data-room description baked in, so `npx <package> login` needs no configuration. That
> package is named after itself: the five files below ship as `<package>-login.mjs` and so
> on, its commands are `login` / `mcp` / `install-skills`, and it keeps its sign-in in
> `~/.config/<package>/<host>/`. The names on THIS page are the generic package's. See
> `docs/AGENT_CLI.md`. This directory is its source: every product word and the default
> address live in `deployment.generated.mjs` (here: the generic wording and no address;
> rewrite it with `npm run build:agent-cli -- --write-default`, never by hand).

Two binaries, zero runtime dependencies, Node 20+.

| | |
|---|---|
| `workspace-login` | One interactive sign-in: Google, or `--email <address>` for a six-digit code sent to your inbox. Stores the login at `~/.config/workspace-mcp/credentials.json` (mode 600). |
| `workspace-mcp` | The MCP server your coding agent talks to. Presents your own login on every call (a fresh Google ID token, or your email session), so every write carries *your* identity — not a shared key. |

**Older names still work.** Before version 0.12 these were `fde-login`, `fde-mcp` and
`fde-install-skill`, the files were `fde-*.mjs`, and the sign-in was kept in
`~/.config/fde-mcp/`. The old commands are still installed beside the new ones, the old files
still run, and a sign-in in the old folder is read (and copied to the new one), so an MCP
config written then needs no edit and nobody is signed out. Use the new names in anything
you write now.

> `workspace-mcp` writes to the **live** platform — the same blob store and Ops API the
> web console uses. There is no sandbox, so be deliberate about what you write.

---

## 1. Sign in (once)

```bash
npx -p @delivery-agents/cli workspace-login --url https://your-deployment.example.com
```

`--url` saves your deployment's address next to the credentials so `workspace-mcp`
needs no `WORKSPACE_OPS_URL`. Opens your browser for Google consent, catches the code on `127.0.0.1`, and
exchanges it with PKCE. Use your **work** Google account — personal Gmail
addresses aren't admitted.

**No Google account?** Sign in with a code sent to your inbox instead:

```bash
npx -p @delivery-agents/cli workspace-login --url https://your-deployment.example.com --email you@company.com
```

It emails you a six-digit code and asks for it on the terminal. The session it
stores lasts 7 days and cannot be refreshed: when it runs out, the tools say so
and you run the same command again. Already have a code? Add `--code <digits>`
and no new one is sent (a new code cancels the one before it). When stdin is not
a terminal, the code is read from stdin. The session token is never printed.

With Google, while it waits, press **`c`** to copy the sign-in URL to your clipboard. That
is the path that matters over SSH, on a headless box, or when your default
browser is not the one you are signed into — the URL is ~400 characters and
selecting it out of a terminal by hand is where it gets mangled.

Check the platform is healthy any time:

```bash
curl -s https://your-deployment.example.com/api/ops/health
```

## 2. Connect it to your coding agent

Add this to your Claude Code MCP config (`~/.claude/mcp.json`, or a project
`.mcp.json`). Cursor and Codex use the same shape:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["-y", "-p", "@delivery-agents/cli", "workspace-mcp"],
      "env": {
        "WORKSPACE_OPS_URL": "https://your-deployment.example.com",
        "BLOB_READ_WRITE_TOKEN": "blob_rw_..."
      }
    }
  }
}
```

Restart your agent, then ask it to list connectors to confirm the wiring.

## 3. Set up a data room

> **`vertical_list` and `vertical_setup` do not exist.** This section described
> them for weeks and they were never implemented — not in this MCP server, not
> in the agent. They were taken at face value and copied into the onboarding
> skill, which then told every new engineer's agent to call tools that are not
> there. If you are looking for one-command vertical setup, it is unbuilt.

Ask your agent to lay down the data room with the tools that do exist:

```
dataroom_structure             # the canonical layout
dataroom_list                  # what is already there
dataroom_write                 # write the paths that are missing
customer_create                # the first customer
connector_create               # a source, then connector_secret_set
```

`workspace_status` is a good first call — it reports what the workspace already has,
so you do not recreate it.

### About that token

`BLOB_READ_WRITE_TOKEN` unlocks the **Data Room** tools only. The Connector,
Workflow and Cron tools authenticate from your `workspace-login` session instead — so
skip the token entirely if you don't need the data room.

It is direct write access to production customer data: never commit it, never
paste it into a chat or into `dataroom_write`.

## Configuration

| Variable | Purpose |
|---|---|
| `WORKSPACE_OPS_URL` | **Required** (unless saved by `workspace-login --url`): your deployment's address. No default. |
| `WORKSPACE_ORG` | Pin the workspace these tools write to. Checked against your membership server-side. |
| `WEB_ORIGIN` | Address used in links handed back to people. Defaults to `WORKSPACE_OPS_URL`. |
| `BLOB_READ_WRITE_TOKEN` | Direct-blob mode for the Data Room tools (platform repo only). Without it they go through the Ops API as you. |
| `WORKSPACE_OAUTH_CLIENT_ID` / `WORKSPACE_OAUTH_CLIENT_SECRET` | Use this Google desktop OAuth client instead of the one the package was built with. This generic package is built with none, so without these it signs in by emailed code (`--email`). |

Every variable above was once spelled `FDE_*` (`FDE_OPS_URL`, `FDE_ORG`,
`FDE_ACTOR`, `FDE_OAUTH_CLIENT_ID`, `FDE_OAUTH_CLIENT_SECRET`,
`FDE_PRODUCT_NAME`). **The old names still work** — an MCP config you wrote
months ago needs no edit — and using one prints a single line on stderr naming
the variable to move to. They will be removed once nobody is on them.

A package built for a deployment carries that deployment's Google desktop client
id and secret in its `deployment.generated.mjs`, deliberately; this generic
package carries none. Google's docs are explicit that an installed-app secret ["is not treated as a
secret"](https://developers.google.com/identity/protocols/oauth2/native-app) —
an installed app cannot keep one. It grants nothing on its own: every token
still requires an interactive sign-in, and the API re-verifies each one against
Google's JWKS.

## Troubleshooting

**"WORKSPACE_OPS_URL is not set"** — the server does not know which deployment to talk
to. Add `"WORKSPACE_OPS_URL": "<your deployment's address>"` to the MCP server's `env`
block, or run `workspace-login --url <address>` once.

**`401` / "not signed in"** — the refresh token expired or was revoked. Re-run
`npx -p @delivery-agents/cli workspace-login`.

**"Your email sign-in has expired"** — an emailed-code session lasts 7 days.
Re-run `workspace-login --email <address>`.

**Data Room tools missing** — `BLOB_READ_WRITE_TOKEN` isn't set in the MCP
server's `env` block.

**Browser never opens** — copy the URL the command prints and open it manually.

---

Working in the platform repo itself? [`TEAM-SETUP.md`](./TEAM-SETUP.md) has the
full ten-minute walkthrough: pulling the blob token, the tool inventory, and the
end-to-end verification loop.
