import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel, type SlackChannelCredentials } from "eve/channels/slack";
import { connectionsFromEnv } from "../../lib/connections-provider.ts";

// Credentials run through Vercel Connect: the client `slack/fde-agent`
// (scl_gCLgLYLGkUd4lS4NDCVaNw) is attached to the fde-agent-api project, with
// its trigger destination registered at eve's Slack route `/eve/v1/slack`
// (prod/preview/dev). Inbound app_mention + message.im events route there.
// FF_CONNECT_ENABLED=1 is only needed locally to run the `vercel connect …`
// CLI commands; it is not a runtime env. To re-point the trigger:
//   FF_CONNECT_ENABLED=1 vercel connect attach slack/fde-agent \
//     --triggers --trigger-path /eve/v1/slack --yes   (link fde-agent-api first)
//
// OUTBOUND TOKEN OVERRIDE: when SLACK_BOT_TOKEN (xoxb-…) is set, it takes over
// posting — thread replies and `receive(slack, …)` from the schedules — while
// INBOUND verification stays with Connect's `webhookVerifier`. The two are
// independent fields, so overriding the token does NOT leave inbound events
// unverified. Unset the env var and outbound falls back to Connect's own token,
// which is the better long-run home for it: Connect handles rotation, so a
// hand-managed token has to be rotated by hand.
// See node_modules/eve/docs/channels/slack.mdx.
//
// OFF VERCEL (CONNECTIONS_PROVIDER=env, lib/connections-provider.ts) there is no Vercel Connect, and it is not
// called. The channel is then the server's own Slack app: SLACK_BOT_TOKEN posts, and Slack's signing secret
// (SLACK_SIGNING_SECRET) verifies inbound events at /eve/v1/slack, both from the server's environment. With neither
// set the agent still starts: an inbound request is refused, and a post fails with a sentence saying Slack is not
// connected (the schedules already record a failed delivery and move on). With the setting unset, what is handed to
// slackChannel is exactly what it was (scripts/test-connections-default-unchanged.mjs).
const threadContext = { since: "last-agent-reply" } as const;

/** The server's own Slack app, from its environment. Read when used, so nothing is needed for the agent to start. */
function serverSlackCredentials(): SlackChannelCredentials {
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  return {
    botToken: () => {
      const token = process.env.SLACK_BOT_TOKEN?.trim();
      if (!token) throw new Error("Slack is not connected: SLACK_BOT_TOKEN is not set on this server.");
      return token;
    },
    // Without a signing secret nothing can be verified, so nothing is admitted: every inbound request is refused,
    // rather than the route failing on a missing setting.
    ...(signingSecret
      ? { signingSecret }
      : {
          webhookVerifier: () => {
            throw new Error("Slack is not connected: SLACK_SIGNING_SECRET is not set on this server, so no inbound Slack request is accepted.");
          },
        }),
  };
}

function vercelConnectChannel() {
  const connect = connectSlackCredentials("slack/fde-agent");
  const botTokenOverride = process.env.SLACK_BOT_TOKEN;
  return slackChannel({
    credentials: botTokenOverride
      ? { ...connect, botToken: botTokenOverride }
      : connect,
    // Repeated @mentions in a thread inject only what's new, so the orchestrator
    // has the customer discussion context without re-reading the whole thread.
    threadContext,
  });
}

export default connectionsFromEnv() ? slackChannel({ credentials: serverSlackCredentials(), threadContext }) : vercelConnectChannel();
