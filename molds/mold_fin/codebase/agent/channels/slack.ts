import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

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
const connect = connectSlackCredentials("slack/fde-agent");
const botTokenOverride = process.env.SLACK_BOT_TOKEN;

export default slackChannel({
  credentials: botTokenOverride
    ? { ...connect, botToken: botTokenOverride }
    : connect,
  // Repeated @mentions in a thread inject only what's new, so the orchestrator
  // has the customer discussion context without re-reading the whole thread.
  threadContext: { since: "last-agent-reply" },
});
