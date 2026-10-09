/**
 * The Vercel Connect client the Slack channel and the Slack connection use (`slack/<name>`).
 *
 * It is the name the client was created under in the deployment's Vercel team, so it is the deployment's setting,
 * never the code's: SLACK_CONNECT_CLIENT names it. Unset, it is `slack/agent-workspace`. A deployment whose Connect
 * client has another name sets SLACK_CONNECT_CLIENT to it before deploying, or Slack is not connected.
 */
export const DEFAULT_SLACK_CONNECT_CLIENT = "slack/agent-workspace";

export function slackConnectClient(): string {
  return process.env.SLACK_CONNECT_CLIENT?.trim() || DEFAULT_SLACK_CONNECT_CLIENT;
}
