/**
 * IS A BUILT-IN CONNECTOR CONNECTED FOR THIS WORKSPACE, when its credentials are the server's own
 * (CONNECTIONS_PROVIDER=env, lib/connections-provider.ts)?
 *
 * On Vercel a built-in connector's health is what the running agent holds in its environment, the same for every
 * workspace, and a secret stored in the Ops Center does not make it live. Off Vercel the agent reads Slack's and
 * GitHub's credentials PER WORKSPACE at call time (agent/lib/connector-credentials.ts), so the report has to follow
 * the same two sources or it would lie in both directions:
 *
 *   - a secret stored on this workspace's connector IS live (the agent reads it);
 *   - the server's environment counts ONLY for the one workspace it is bound to (CONNECTIONS_WORKSPACE). Another
 *     workspace's connector is never shown as connected because the server holds somebody else's token.
 *
 * Pure: the routes pass in what they already read. Nothing here runs with the setting unset.
 */
export interface SecretNeed {
  readonly name: string;
  readonly optional?: boolean;
}

/**
 * One secret, for this workspace: true (the agent has it), false (it does not), or undefined (the server's value
 * would count, and the agent has not reported its environment yet).
 */
export function workspaceSecretLive(
  name: string,
  stored: ReadonlySet<string> | undefined,
  /** runtime_env_presence: what the running agent reported about its own environment. */
  present: ReadonlyMap<string, boolean>,
  serverIsThisWorkspace: boolean,
): boolean | undefined {
  if (stored?.has(name)) return true;
  if (!serverIsThisWorkspace) return false;
  return present.has(name) ? present.get(name) === true : undefined;
}

export type WorkspaceConnectorHealth = "live" | "degraded" | "missing" | "unknown";

/** The connector's health for this workspace, by the same words the Ops Center already uses. */
export function workspaceConnectorHealth(
  secrets: readonly SecretNeed[],
  stored: ReadonlySet<string> | undefined,
  present: ReadonlyMap<string, boolean>,
  serverIsThisWorkspace: boolean,
): WorkspaceConnectorHealth {
  const state = (name: string) => workspaceSecretLive(name, stored, present, serverIsThisWorkspace);
  if (secrets.filter((s) => !s.optional).some((s) => state(s.name) === false)) return "missing";
  if (secrets.some((s) => state(s.name) === undefined)) return "unknown";
  return secrets.every((s) => state(s.name)) ? "live" : "degraded";
}
