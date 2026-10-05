# Slack and GitHub credentials (`CONNECTIONS_PROVIDER`, `CONNECTIONS_WORKSPACE`)

**GitHub's credentials are per workspace on every target**, Vercel included: a workspace reads its own, and one
company's repositories are never another's because the two share a server. (GitLab will follow the same rule.)

Slack's depend on where the server runs. On Vercel, the Slack connector's credentials come from Vercel Connect (the
connector `slack/fde-agent`): the bot token, and the verification of inbound Slack events. A server that is not on
Vercel has no Vercel Connect, so nothing can be issued; `CONNECTIONS_PROVIDER=env` gives such a server another source.

## The settings

| Setting | Read by | What it is |
|---|---|---|
| `CONNECTIONS_PROVIDER` | agent, web app | Decides Slack only. Unset, empty or `vercel-connect`: Slack through Vercel Connect. `env`: Slack's credentials come from this server (below). Anything else is treated as unset and said once in the log. |
| `CONNECTIONS_WORKSPACE` | agent, web app | A workspace id (not a secret): the one workspace the server's environment credentials belong to. Unset: they belong to no workspace, **also on a server with a single workspace**. For GitHub it is read on every target; for Slack with `env` only. |
| `SLACK_BOT_TOKEN` | agent | The server's Slack app's bot token (`xoxb-…`). |
| `SLACK_SIGNING_SECRET` | agent | With `env` only. The server's Slack app's signing secret. It verifies inbound events at `/eve/v1/slack`. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, or `GITHUB_TOKEN` | agent | A server-wide GitHub credential. Used only for the workspace `CONNECTIONS_WORKSPACE` names (below). |
| `OPS_SECRETS_KEY` | agent, web app | As today: seals and opens the secrets stored per workspace in the Ops Center. |

Give the agent and the web app the same `CONNECTIONS_PROVIDER` and `CONNECTIONS_WORKSPACE`: the agent uses the
credentials, the web app reports whether a connector is connected.

## Whose credentials a workspace gets

For GitHub tool calls everywhere, and for Slack tool calls with `CONNECTIONS_PROVIDER=env`, in this order:

1. **The workspace's own.** The secrets stored on its enabled, workspace-level connector of that kind, in the Ops
   Center (Connectors, the connector, Secrets). They are encrypted with `OPS_SECRETS_KEY` under a key derived from the
   workspace id, and the table refuses any read outside that workspace's database scope. The agent reads them at call
   time, so storing one is all it takes: no restart, no deploy.
2. **Otherwise the server's environment values, only for the workspace named by `CONNECTIONS_WORKSPACE`.** On a
   server with several workspaces, one company's Slack bot or GitHub App is not every company's. Unbound, no
   workspace uses them; for GitHub this is said once in the agent's log. The server never counts or looks at its
   other workspaces to decide this, so **a server with a single workspace sets `CONNECTIONS_WORKSPACE` to that
   workspace's id once** (or stores the credential on the workspace's connector instead). With no database at all,
   which is local development and has no workspaces to name, they are used as they are.
3. **Otherwise the connector is not connected for that workspace.** A tool call gets the same error an uninstalled
   Vercel Connect connector gives (`ConnectionAuthorizationFailedError`, reason `app_not_installed`), with a sentence
   saying what to store. Nothing crashes; the turn carries on. The Ops Center shows the connector as missing its
   secrets, as it does for an unconnected connector today.

A set of credentials is used whole or not at all: a workspace's stored set is never completed from the server's. A
personal connector (one with an owner) and a disabled connector are never used.

This is the rule the workspace mailbox already follows (`IMAP_WORKSPACE`, `agent/lib/workspace-mailbox.ts`).

## If your deployment had a GitHub credential in the server's settings

Before this rule, on a deployment with `CONNECTIONS_PROVIDER` unset (every Vercel app), a `GITHUB_APP_*` set or a
`GITHUB_TOKEN` in the agent's environment was used for **every** workspace. It is now used only for the one workspace
`CONNECTIONS_WORKSPACE` names. Until you do one of the following, GitHub tools answer "GitHub is not connected for
this workspace" and the agent's log says so once. **This applies to a deployment with a single workspace too.**

- **The credential belongs to one workspace (or you have only one).** Set `CONNECTIONS_WORKSPACE` to that
  workspace's id on the agent and on the web app, and redeploy. That workspace is connected again; any others
  connect their own.
- **Each workspace connects its own.** In each workspace: Ops Center, Connectors, GitHub, Secrets; store that
  company's own `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY` (or a read-only
  `GITHUB_TOKEN`). It works from the next tool call. Then remove the server-wide values.

Nothing is deleted by the upgrade: the server-wide values stay where they are, unused, until you bind or remove them.

## GitHub is read-only by its tool list

The GitHub connection is GitHub's hosted MCP server, which lists write tools (`push_files`, `create_or_update_file`,
`merge_pull_request`, ...) beside the read ones. The connection carries an allow-list of read tools
(`agent/lib/github-mcp-tools.ts`), so a token with write permission still gives the agent no write tool: a name that
is not on the list is neither shown to the model nor callable. A tool GitHub adds later is not exposed until it is
added to the list on purpose.

## The Slack channel is the server's one Slack app

Inbound mentions and direct messages, and the posts the schedules make, go through one Slack app per server:
`SLACK_BOT_TOKEN` posts, `SLACK_SIGNING_SECRET` verifies inbound requests. Point the Slack app's Event Subscriptions
and Interactivity request URL at `https://<your server>/eve/v1/slack`.

With neither set the agent still starts. Every inbound Slack request is refused (401), and a scheduled post fails
with "Slack is not connected", which the schedules already record as a failed delivery before moving on.

Each workspace connecting its own Slack workspace to the channel (an "Add to Slack" button) is not built: it needs a
Slack app registered for distribution per deployment. See the proposal in the pull request that added this page.

## What does not change on Vercel

Slack. With `CONNECTIONS_PROVIDER` unset the two files that import `@vercel/connect` (`agent/lib/connections.ts`,
`agent/channels/slack.ts`) make the same Vercel Connect calls with the same arguments and hand eve the same Slack
connection and channel as before the setting existed. `npm run test:connections-default` compares every call, every
definition, the GitHub token and the request that mints it with a recording
(`scripts/fixtures/connections/default-provider.golden.json`). The recording's GitHub lines were changed on purpose
twice: the read-only tool list, and the credential being resolved per workspace.

## Tests

| Command | What it holds |
|---|---|
| `npm run test:connections-default` | The default path is identical to the recording. |
| `npm run test:connections-provider` | The setting, the rules (a server-wide credential with and without `CONNECTIONS_WORKSPACE`), the real eve modules with nothing configured and with the server's values, on both settings. No network. |
| `npm run test:connector-credentials-db` | The stored secrets against a real Postgres: per workspace, strict row-level security, per-workspace key; GitHub through the real connection on both settings; and that resolving it never reads the workspace table. |
| `npm run test:github-mcp-readonly` | eve's real MCP client against a stand-in server that advertises GitHub's write tools: none is shown or callable; the read tools are. |
