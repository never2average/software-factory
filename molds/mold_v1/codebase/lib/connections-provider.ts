/**
 * WHERE THE BUILT-IN CONNECTORS' CREDENTIALS COME FROM. Read the same way by the agent (which uses the credentials)
 * and the web app (which reports whether a connector is connected).
 *
 * VERSION-CONTROL CONNECTORS (GitHub today; GitLab will join VCS_CONNECTOR_KINDS) ARE PER WORKSPACE ON EVERY TARGET,
 * whatever CONNECTIONS_PROVIDER says. A workspace's credentials for one are, in this order:
 *     1. the workspace's own: the secrets stored against its enabled, workspace-level connector of that kind (the Ops
 *        Center's connector secrets, encrypted with OPS_SECRETS_KEY under a key derived from the workspace id, and
 *        readable only inside that workspace's database scope);
 *     2. otherwise the server's environment values (GITHUB_APP_* or GITHUB_TOKEN), ONLY for the one workspace named
 *        by CONNECTIONS_WORKSPACE. With that unset they are nobody's, said once in the log. Nothing counts,
 *        lists or infers the server's other workspaces to decide this: a server with a single workspace names it;
 *     3. otherwise the connector is not connected for that workspace.
 * Before this, with CONNECTIONS_PROVIDER unset, one server-wide GitHub credential served every workspace.
 *
 * SLACK follows the one setting:
 *
 *   CONNECTIONS_PROVIDER unset / empty / "vercel-connect"
 *       Slack's credentials come from Vercel Connect (the connector `slack/fde-agent`: the bot token, and the
 *       verification of inbound events). Unchanged.
 *
 *   CONNECTIONS_PROVIDER=env
 *       For a server that is not on Vercel, where Vercel Connect cannot issue anything. No call is made to it.
 *       Slack's credentials for a workspace are its own stored ones, otherwise the server's SLACK_BOT_TOKEN ONLY for
 *       the one workspace named by CONNECTIONS_WORKSPACE (unbound, nobody's), otherwise not connected, reported
 *       exactly as an uninstalled Vercel Connect connector is.
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

/**
 * Version-control connectors. Their credentials are per workspace on every target: one company's repositories are
 * never another's because the two share a server. Provider-neutral: a new provider is one more id here.
 */
export const VCS_CONNECTOR_KINDS = ["github"] as const satisfies readonly ProvidedConnectorKind[];

export function isVcsConnectorKind(kind: string): boolean {
  return (VCS_CONNECTOR_KINDS as readonly string[]).includes(kind.toLowerCase());
}

/**
 * Are this kind's credentials resolved per workspace (stored secrets first, the server's values only for the
 * workspace they belong to)? A version-control connector: always. Slack: only with CONNECTIONS_PROVIDER=env.
 */
export function credentialsPerWorkspace(kind: string, env: Env = process.env): boolean {
  if (!isProvidedConnectorKind(kind)) return false;
  return isVcsConnectorKind(kind) || connectionsFromEnv(env);
}

/**
 * Do the server's environment credentials belong to workspace `orgId`? Only when CONNECTIONS_WORKSPACE names it.
 * Unset, they are nobody's, for every connector kind: nothing here looks at how many workspaces the server has.
 */
export function serverCredentialsAreFor(orgId: string, env: Env = process.env): boolean {
  const bound = connectionsWorkspace(env);
  return bound !== null && bound === orgId;
}

/** The workspace the server's environment credentials are bound to, or null when they are bound to none. */
export function connectionsWorkspace(env: Env = process.env): string | null {
  const bound = env[CONNECTIONS_WORKSPACE_ENV]?.trim();
  return bound ? bound : null;
}
