/**
 * WHERE THE BUILT-IN CONNECTORS' CREDENTIALS COME FROM. One setting, read the same way by the agent (which uses the
 * credentials) and the web app (which reports whether a connector is connected):
 *
 *   CONNECTIONS_PROVIDER unset / empty / "vercel-connect"
 *       Today's behaviour, unchanged. Slack's credentials come from Vercel Connect (the connector `slack/fde-agent`:
 *       the bot token, and the verification of inbound events); GitHub's from the agent's own environment
 *       (GITHUB_APP_* or GITHUB_TOKEN), for every workspace.
 *
 *   CONNECTIONS_PROVIDER=env
 *       For a server that is not on Vercel, where Vercel Connect cannot issue anything. No call is made to it.
 *       A connector's credentials for a workspace are, in this order:
 *         1. the workspace's own: the secrets stored against its enabled, workspace-level connector of that kind
 *            (the Ops Center's connector secrets, encrypted with OPS_SECRETS_KEY under a key derived from the
 *            workspace id, and readable only inside that workspace's database scope);
 *         2. otherwise the server's environment values (SLACK_BOT_TOKEN; GITHUB_APP_* or GITHUB_TOKEN), ONLY for the
 *            one workspace named by CONNECTIONS_WORKSPACE. Unbound, they are nobody's;
 *         3. otherwise the connector is not connected for that workspace, reported exactly as an uninstalled
 *            Vercel Connect connector is.
 *       The Slack channel (inbound mentions, scheduled posts) is the server's one Slack app: SLACK_BOT_TOKEN and
 *       SLACK_SIGNING_SECRET.
 *
 * Only the exact value `env` turns it on. Anything unrecognised is the default, said once in the log, so a typing
 * mistake keeps today's behaviour rather than switching credential sources. Dependency-free: the agent, the web app
 * and plain-node tests all load it.
 */
export const CONNECTIONS_PROVIDER_ENV = "CONNECTIONS_PROVIDER";
/** A workspace id (not a secret): the one workspace the server's environment credentials belong to. */
export const CONNECTIONS_WORKSPACE_ENV = "CONNECTIONS_WORKSPACE";

export type ConnectionsProvider = "vercel-connect" | "env";

/** The connector kinds this setting decides. Every other kind is untouched by it. */
export const PROVIDED_CONNECTOR_KINDS = ["slack", "github"] as const;
export type ProvidedConnectorKind = (typeof PROVIDED_CONNECTOR_KINDS)[number];

export function isProvidedConnectorKind(kind: string): kind is ProvidedConnectorKind {
  return (PROVIDED_CONNECTOR_KINDS as readonly string[]).includes(kind.toLowerCase());
}

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

export function connectionsProvider(env: Env = process.env): ConnectionsProvider {
  const raw = env[CONNECTIONS_PROVIDER_ENV]?.trim().toLowerCase() ?? "";
  if (raw === "env") return "env";
  if (raw && raw !== "vercel-connect" && !warned.has(raw)) {
    warned.add(raw);
    console.warn(
      `[connections] ${CONNECTIONS_PROVIDER_ENV}=${JSON.stringify(raw)} is not a known value (use "env", or leave it unset for Vercel Connect). Using the default.`,
    );
  }
  return "vercel-connect";
}

/** Do connector credentials come from this server (the workspace's stored secrets, or its environment)? */
export const connectionsFromEnv = (env: Env = process.env): boolean => connectionsProvider(env) === "env";

/** The workspace the server's environment credentials are bound to, or null when they are bound to none. */
export function connectionsWorkspace(env: Env = process.env): string | null {
  const bound = env[CONNECTIONS_WORKSPACE_ENV]?.trim();
  return bound ? bound : null;
}
