/**
 * Shared connection definitions, re-exported from `connections/<name>.ts` files
 * in the root agent and in the subagents that need them (declared subagents do
 * not inherit the root's connections, so each re-exports the factory it needs).
 *
 * GITHUB's bearer is resolved PER WORKSPACE on every target (agent/lib/connector-credentials.ts): the calling
 * workspace's own credentials, stored on its GitHub connector; or the server's environment values (GITHUB_APP_* or
 * GITHUB_TOKEN) only for the one workspace CONNECTIONS_WORKSPACE names. One server-wide GitHub credential used to serve every workspace here; it no longer does.
 *
 * SLACK's auth goes through Vercel Connect. Register the connector once from this project, then replace the
 * placeholder UID below with the one the CLI returns:
 *
 *   vercel link
 *   vercel connect create <slack-connector>      --name slack
 *   vercel connect attach <connector-uid> --yes
 *   vercel env pull
 *
 * See https://vercel.com/docs/connect and node_modules/eve/docs/connections/.
 *
 * OFF VERCEL there is no Vercel Connect. With CONNECTIONS_PROVIDER=env (lib/connections-provider.ts) Slack takes
 * its bearer the way GitHub does, from the calling workspace's own credentials, and `connect()` is never called.
 * With the setting unset, Slack below is exactly what it was: scripts/test-connections-default-unchanged.mjs holds
 * every call and definition to a recording.
 */
import { connect } from "@vercel/connect/eve";
import { ConnectionAuthorizationFailedError, defineMcpClientConnection } from "eve/connections";
import { connectionsFromEnv, type ProvidedConnectorKind } from "../../lib/connections-provider.ts";
import { fill } from "./agent-vocabulary.ts";
import { connectorTokenFor, NotConnectedError } from "./connector-credentials.ts";
import { githubToolFilter } from "./github-mcp-tools.ts";
import { orgForSession, type SessionCtxLike } from "./org-context.ts";

/** Read once, when the agent starts: eve builds its connections from these definitions at load. */
const FROM_ENV = connectionsFromEnv();

/**
 * The bearer for one connector, resolved PER CALLER (GitHub always; Slack with CONNECTIONS_PROVIDER=env). eve calls
 * this inside the active turn with the session's context (and keeps the result in that turn's own context, never in
 * the process), so the token is the one that belongs to the workspace the session runs in, and to no other.
 *
 * A workspace with no credentials gets the error eve already knows for an app connector that is not installed
 * (what Vercel Connect's adapter raises: ConnectionAuthorizationFailedError, reason "app_not_installed", not
 * retryable). The tool call reports "not connected"; nothing crashes, and the turn carries on.
 */
export function workspaceConnectorAuth(kind: ProvidedConnectorKind) {
  return (ctx: unknown) => ({
    principalType: "app" as const,
    getToken: async () => {
      try {
        return await connectorTokenFor(await orgForSession(ctx as SessionCtxLike), kind);
      } catch (error) {
        if (error instanceof NotConnectedError) {
          throw new ConnectionAuthorizationFailedError(kind, { message: error.message, reason: "app_not_installed", retryable: false });
        }
        throw error;
      }
    },
  });
}

/**
 * GitHub (read-only). The bearer is the calling workspace's: an installation token minted on demand from its GitHub
 * App (short-lived, ~1h, cached per workspace, never shared between two) or its stored token
 * (agent/lib/connector-credentials.ts githubTokenFrom). eve sends it as a bearer and never shows it to the model.
 * A workspace with none gets "not connected". There is no process-wide token any more.
 */
export const githubConnection = defineMcpClientConnection({
  url: process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/",
  description: fill(
    "GitHub (read-only): inspect repos, issues, pull requests, commits, and workflow runs for {account} platforms.",
  ),
  auth: workspaceConnectorAuth("github"),
  // Read-only by construction, not by the token's permissions: only these names reach the model or can be called,
  // even when the server advertises write tools and the token could use them (agent/lib/github-mcp-tools.ts).
  tools: githubToolFilter(),
});

/**
 * Slack: the agent posts stand-up summaries and follow-up nudges and reads
 * customer channels. App-scoped so it acts as the workspace's bot.
 */
export const slackConnection = defineMcpClientConnection({
  url: process.env.SLACK_MCP_URL ?? "https://slack-mcp.example.com/mcp",
  description: fill(
    "Slack: read {account} channels and threads, and post stand-up summaries and follow-up reminders.",
  ),
  auth: FROM_ENV ? workspaceConnectorAuth("slack") : connect({ connector: "slack/fde-agent", principalType: "app" }),
});

// Email is intentionally NOT a connection here. It is handled by native,
// draft-only IMAP tools (`email_list_inbox`, `email_create_draft`) in
// `agent/lib/email.ts`, configured with IMAP_* env vars. There is no SMTP/send
// path anywhere — see the banner in agent/lib/email.ts.
