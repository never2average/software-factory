# @delivery-agents/cli

Sign in to **Delivered** and point your coding agent at your workspace over MCP —
the Data Room, Connectors, Workflows and Crons, driven from your editor.

Two binaries, zero runtime dependencies, Node 20+.

| | |
|---|---|
| `fde-login` | One interactive Google sign-in. Stores a refresh token at `~/.config/fde-mcp/credentials.json` (mode 600). |
| `fde-mcp` | The MCP server your coding agent talks to. Mints a fresh ID token per session, so every write carries *your* identity — not a shared key. |

> `fde-mcp` writes to the **live** platform — the same blob store and Ops API the
> web console uses. There is no sandbox, so be deliberate about what you write.

---

## 1. Sign in (once)

```bash
npx -p @delivery-agents/cli fde-login
```

Opens your browser for Google consent, catches the code on `127.0.0.1`, and
exchanges it with PKCE. Use your **work** Google account — personal Gmail
addresses aren't admitted.

While it waits, press **`c`** to copy the sign-in URL to your clipboard. That
is the path that matters over SSH, on a headless box, or when your default
browser is not the one you are signed into — the URL is ~400 characters and
selecting it out of a terminal by hand is where it gets mangled.

Check the platform is healthy any time:

```bash
curl -s https://fde-agent.vercel.app/api/ops/health
```

## 2. Connect it to your coding agent

Add this to your Claude Code MCP config (`~/.claude/mcp.json`, or a project
`.mcp.json`). Cursor and Codex use the same shape:

```json
{
  "mcpServers": {
    "fde": {
      "command": "npx",
      "args": ["-y", "-p", "@delivery-agents/cli", "fde-mcp"],
      "env": {
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

`fde_status` is a good first call — it reports what the workspace already has,
so you do not recreate it.

### About that token

`BLOB_READ_WRITE_TOKEN` unlocks the **Data Room** tools only. The Connector,
Workflow and Cron tools authenticate from your `fde-login` session instead — so
skip the token entirely if you don't need the data room.

It is direct write access to production customer data: never commit it, never
paste it into a chat or into `dataroom_write`.

## Configuration

| Variable | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Enables the Data Room tools. |
| `FDE_OAUTH_CLIENT_ID` / `FDE_OAUTH_CLIENT_SECRET` | Override the built-in desktop OAuth client. |

The desktop client id and secret ship inside this package deliberately. Google's
docs are explicit that an installed-app secret ["is not treated as a
secret"](https://developers.google.com/identity/protocols/oauth2/native-app) —
an installed app cannot keep one. It grants nothing on its own: every token
still requires an interactive sign-in, and the API re-verifies each one against
Google's JWKS.

## Troubleshooting

**`401` / "not signed in"** — the refresh token expired or was revoked. Re-run
`npx -p @delivery-agents/cli fde-login`.

**Data Room tools missing** — `BLOB_READ_WRITE_TOKEN` isn't set in the MCP
server's `env` block.

**Browser never opens** — copy the URL the command prints and open it manually.

---

Working in the platform repo itself? [`TEAM-SETUP.md`](./TEAM-SETUP.md) has the
full ten-minute walkthrough: pulling the blob token, the tool inventory, and the
end-to-end verification loop.
