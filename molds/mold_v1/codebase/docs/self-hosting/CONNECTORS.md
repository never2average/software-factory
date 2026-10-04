# Slack and GitHub credentials off Vercel (`CONNECTIONS_PROVIDER`)

On Vercel, the Slack connector's credentials come from Vercel Connect (the connector `slack/fde-agent`): the bot
token, and the verification of inbound Slack events. A server that is not on Vercel has no Vercel Connect, so nothing
can be issued. This setting gives such a server another source. With it unset, nothing changes.

## The setting

| Setting | Read by | What it is |
|---|---|---|
| `CONNECTIONS_PROVIDER` | agent, web app | Unset, empty or `vercel-connect`: today's behaviour. `env`: credentials come from this server (below). Anything else is treated as unset and said once in the log. |
| `CONNECTIONS_WORKSPACE` | agent, web app | With `env` only. A workspace id (not a secret): the one workspace the server's environment credentials belong to. Unset: they belong to no workspace. |
| `SLACK_BOT_TOKEN` | agent | The server's Slack app's bot token (`xoxb-…`). |
| `SLACK_SIGNING_SECRET` | agent | With `env` only. The server's Slack app's signing secret. It verifies inbound events at `/eve/v1/slack`. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, or `GITHUB_TOKEN` | agent | As today. |
| `OPS_SECRETS_KEY` | agent, web app | As today: seals and opens the secrets stored per workspace in the Ops Center. |

Give the agent and the web app the same `CONNECTIONS_PROVIDER` and `CONNECTIONS_WORKSPACE`: the agent uses the
credentials, the web app reports whether a connector is connected.

## Whose credentials a workspace gets (`CONNECTIONS_PROVIDER=env`)

For Slack and GitHub tool calls, in this order:

1. **The workspace's own.** The secrets stored on its enabled, workspace-level connector of that kind, in the Ops
   Center (Connectors, the connector, Secrets). They are encrypted with `OPS_SECRETS_KEY` under a key derived from the
   workspace id, and the table refuses any read outside that workspace's database scope. The agent reads them at call
   time, so storing one is all it takes: no restart.
2. **Otherwise the server's environment values, only for the workspace named by `CONNECTIONS_WORKSPACE`.** On a
   server with several workspaces, one company's Slack bot or GitHub App is not every company's. Unbound, no
   workspace uses them. (With no database at all, which is local development with one workspace, they are that
   workspace's.)
3. **Otherwise the connector is not connected for that workspace.** A tool call gets the same error an uninstalled
   Vercel Connect connector gives (`ConnectionAuthorizationFailedError`, reason `app_not_installed`), with a sentence
   saying what to store. Nothing crashes; the turn carries on. The Ops Center shows the connector as missing its
   secrets, as it does for an unconnected connector today.

A set of credentials is used whole or not at all: a workspace's stored set is never completed from the server's. A
personal connector (one with an owner) and a disabled connector are never used.

This is the rule the workspace mailbox already follows (`IMAP_WORKSPACE`, `agent/lib/workspace-mailbox.ts`).

## The Slack channel is the server's one Slack app

Inbound mentions and direct messages, and the posts the schedules make, go through one Slack app per server:
`SLACK_BOT_TOKEN` posts, `SLACK_SIGNING_SECRET` verifies inbound requests. Point the Slack app's Event Subscriptions
and Interactivity request URL at `https://<your server>/eve/v1/slack`.

With neither set the agent still starts. Every inbound Slack request is refused (401), and a scheduled post fails
with "Slack is not connected", which the schedules already record as a failed delivery before moving on.

Each workspace connecting its own Slack workspace to the channel (an "Add to Slack" button) is not built: it needs a
Slack app registered for distribution per deployment. See the proposal in the pull request that added this page.

## What does not change on Vercel

With `CONNECTIONS_PROVIDER` unset the two files that import `@vercel/connect` (`agent/lib/connections.ts`,
`agent/channels/slack.ts`) make the same calls with the same arguments, hand eve the same definitions, and the
GitHub token path sends the same request. `npm run test:connections-default` compares all of it with a recording
made on the code before the setting existed (`scripts/fixtures/connections/default-provider.golden.json`).

## Tests

| Command | What it holds |
|---|---|
| `npm run test:connections-default` | The default path is identical to the recording. |
| `npm run test:connections-provider` | The setting, the rules, the real eve modules with nothing configured and with the server's values. No network. |
| `npm run test:connector-credentials-db` | The stored secrets against a real Postgres: per workspace, strict row-level security, per-workspace key. |
