# Journeys: onboarding and "keep trying new things"

Journeys are built and run in **PostHog Workflows**: triggers, delays, waits, branches, email and Slack. PostHog is the
system of record for what journeys exist, who is in them and what each step says. Octillion adds the channel PostHog
cannot reach, the user's AI client:

```
Octillion events (src/telemetry.ts) ──▶ PostHog ──▶ Workflow ──┬─▶ email / Slack (PostHog)
                                                                └─▶ webhook ──▶ Octillion /api/journeys/nudges
                                                                                   │
              next tool result (≤ 1 a day), get_started, /app Setup  ◀─────────────┘
              └─▶ nudge_shown / nudge_dismissed back to PostHog, so the workflow can branch on them
```

An MCP server cannot push a message: a tip waits until the person next uses Octillion. People who are not using it
are reached by the workflow's email and Slack steps.

## Setup

1. PostHog: set `POSTHOG_API_KEY` on the server (docs/accounts.md). Turn on group analytics with group type
   `organization`. People get `email`, `name`, `account`, `account_name` and `role` as person properties when they sign
   in to `/app` or connect a client with Clerk sign-in, so email steps have an address.
2. PostHog → Workflows → Configure channels: add an email sender and verify your domain (SPF, DKIM). Add the Slack app
   if you want Slack steps.
3. Set `OCTILLION_JOURNEY_SECRET` on the server (`openssl rand -hex 24`).
4. In a workflow, a chat or app step is a webhook step:
   - URL: `https://<host>/api/journeys/nudges`, method POST, JSON body;
   - auth: header `Authorization: Bearer <secret>`, or, if the step cannot set headers,
     `https://<host>/api/journeys/nudges/<secret>`;
   - body:
     ```json
     { "distinct_id": "{event.distinct_id}", "journey": "first-report", "step": "run",
       "message": "Your product profile and tasks are ready. Check the competitor list, then run coding agents on the tasks.",
       "prompt": "Run a simulation." }
     ```
   `/admin` → Journeys shows each recommended step's body ready to copy, and can queue any step by hand to see it
   before you build it.

## The webhook

| Field | Required | Meaning |
|---|---|---|
| `distinct_id` | one of these | the person (`user_…`, a Clerk user id), the account (`org:<slug>`), or an approved requester's email |
| `org` | | account slug, when the distinct id alone does not identify it |
| `user_id` | | a Clerk user id (person-level tip) |
| `journey`, `step` | | names for reporting; a step that fires again replaces its earlier tip |
| `message` | yes | up to 280 characters, shown to the person |
| `prompt` | | what they can type to try it (shown as copyable text) |
| `link` | | an `https://` URL or a `/app…` path |
| `ttl_days` | | how long the tip waits (1 to 30, default 7) |

Delivery rules:
- In chat, a tip is appended to the next tool result as one line the AI passes on. At most one tip per person every
  `OCTILLION_NUDGE_INTERVAL_HOURS` (default 20); each tip appears in chat at most 3 times. `get_started` always shows
  the waiting tip.
- Person-level tips win over account-wide ones; newest first.
- On `/app`, Setup → Tips for you lists everything waiting, with Dismiss and a switch that turns tips off in chat.
- Octillion sends `nudge_queued`, `nudge_shown` (channel `chat`), `nudge_dismissed`, `nudges_muted` and
  `nudges_unmuted` to PostHog.

## Recommended journeys

The source of truth for these recipes is `RECIPES` in `src/journeys.ts` (also shown on `/admin` → Journeys).

| Journey | Trigger | Steps | Goal |
|---|---|---|---|
| Get connected | `app_signed_in` (first) | after 1 day unless `mcp_connected`: email + app tip with the client guide | connected within a day |
| First report | `mcp_connected` (first) | onboard (1 day, unless `onboard_product`), run (on `onboarding_completed`), report (on `simulation_completed`), each in chat, plus email for onboard and report | report within a week |
| Read the evidence | `tool_called` `get_visibility_report` | 2 days, unless evidence tools were used: "why did agents pick the competitor?" | transcripts read |
| Fix and re-run | `tool_called` `get_visibility_report` | 7 days, unless `run_simulation`: re-run after changing docs | a second run |
| Bring the team | `onboarding_completed`, account admins | 3 days, unless an invite was sent: app tip + email linking `/app#team` | a second member |
| Win back | cohort: active in 60 days, not in 14 | chat + email: models change, run again | back in 14 days |

Filters to use in PostHog: `tool_called` with property `tool`; person property `role = admin` for admin-only steps;
group `organization` to count accounts instead of people.
