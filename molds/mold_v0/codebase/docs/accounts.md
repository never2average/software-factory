# Accounts: onboarding, people, billing, analytics

Everything between "someone asked for access" and "their team uses Octillion every week". Octillion is the system of
record for none of it, except the product data it already had:

| Module | System of record | Octillion code | Octillion stores |
|---|---|---|---|
| People: organizations, users, invitations, roles, sign-in (passwords, social, enterprise SSO) on `/mcp`, `/app` and `/admin` | **Clerk** (Organizations, OAuth server, sessions) | `src/clerk.ts`, `src/session.ts`, `resolveUserToken` in `src/auth.ts` | `organizations.clerk_org_id` |
| Money: plans, subscriptions, invoices, cards, usage metering | **Stripe** (Billing, Checkout, customer portal, Meters) | `src/billing.ts` | `organizations.stripe_customer_id` |
| Product analytics: funnels, retention, feature adoption by account | **PostHog** (group analytics, `organization` group) | `src/telemetry.ts`, `src/analytics.ts` | nothing new |
| Ops observability: traces, latency, errors, alerts | **New Relic** over OpenTelemetry (any OTLP backend works) | `src/otel.ts`, a span per tool call in `src/server.ts` | nothing |
| Admin console (`/admin`) | none: reads the rows above | `src/admin.ts`, `web/` | a landing-page request's `status`, `org_id`, `decided_at` |
| Customer page (`/app`): setup check, training, usage, team, billing | none | `src/app.ts`, `web/` | nothing (Clerk holds the session) |
| Journeys: onboarding and re-engagement flows, email, Slack | **PostHog Workflows** | `src/journeys.ts` (in-chat and /app delivery) | a queue of pending tips |
| Platform admins (who may use `/admin`) | `OCTILLION_PLATFORM_ADMINS` (Clerk-verified addresses or domains) or Clerk `public_metadata.platform_admin` | `src/admin-auth.ts` | nothing |
| Usage limits inside an account: budget split across teams and people, rollout, throughput | the plan's budget from Stripe; the policy in Postgres (Octillion enforces it) | `src/limits.ts`, `/app` Limits | policy, teams, per-person settings |
| Context: company, person, product | Postgres (it is the product's own data) | `src/context.ts`, `/app` Context | company and personal context; product profiles as before |

The connector log Octillion already kept (`mcp_events`: method, tool name, client, outcome, timing, never arguments)
now also records the signed-in Clerk user. It drives the setup check and the usage page; PostHog gets the same
events for cross-account analysis.

Each integration is off until its env var is set (`.env.example`), and the server works without any of them: per-org
API keys, no billing, no analytics. `npm run smoke` covers both modes, with `scripts/mock-providers.ts` standing in
for the Clerk Backend API and Stripe (session and OAuth tokens are minted by the mock and verified with its public key).

## The funnel

| Stage | Reached when | Source |
|---|---|---|
| Account created | the organization exists | Postgres |
| Invited | a Clerk invitation was sent | Clerk |
| Joined | a membership exists (the invitation was accepted) | Clerk |
| Connected | first connector request (`initialize`) | `mcp_events` |
| First tool call | first successful `tools/call` | `mcp_events` |
| Product onboarded | onboarding research completed, or a product saved by hand | Postgres |
| Simulation run | first simulation | Postgres |
| Report read | first `get_visibility_report` | `mcp_events` |

`/admin` lists accounts that need a person, for example: invited 2+ days ago and not accepted, an expired invitation,
joined but never connected, connected but no tool call (tools switched off in the client), failed onboarding, a past-due
subscription, or 80% of the monthly model budget used.

## Setting it up

### Clerk (people and sign-in)

1. Create a Clerk application (a development instance first). Set `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`
   (the web app uses `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; the server reads either). Optionally set `CLERK_JWT_KEY`
   (Dashboard → API keys → PEM public key) so session tokens are verified without a call to Clerk; otherwise Octillion
   fetches the instance's JWKS once an hour.
2. **Organizations:** turn them on, with the roles `org:admin` and `org:member` (creator role `org:admin`) and slugs
   enabled. Whoever asked for a new account is invited as admin; admins invite colleagues and manage billing on
   `/app`; members see setup and usage.
3. **Sign-in methods** (User & authentication): email and password, and the social connections you want (Google,
   Microsoft, GitHub). Enterprise SSO (SAML/OIDC) is set up per organization in the Clerk dashboard.
4. **OAuth applications → Settings → Client onboarding:** publish Client ID Metadata Document support (Claude, ChatGPT
   and current MCP clients) and, for older clients, Dynamic Client Registration; set default scopes `profile email`.
   Clerk is then the authorization server for `/mcp`.
5. **Domains / allowed origins:** the web app's origin (`$PUBLIC_URL`). Set `CLERK_AUTHORIZED_PARTIES` if the app is
   served from more than one origin (by default only `PUBLIC_URL`'s origin may mint session tokens Octillion accepts).
6. No webhooks are needed: Octillion reads Clerk when it needs to (with a 30 to 60 second cache).

How Octillion uses it:
- **Portal (`/api/app`):** the UI sends Clerk's session, the `__session` cookie on the same origin or a Bearer session
  token; the account is the session's active organization (else the person's oldest membership). Signed out is a 401
  `{error, sign_in_url: "/sign-in"}`; signed in without an account is a 403 `{code: "no_account"}`.
- **Connectors (`/mcp`):** the plain URL `$PUBLIC_URL/mcp`. The client finds Clerk from the 401 (`resource_metadata` in
  `WWW-Authenticate`, `/.well-known/oauth-protected-resource`, CORS-open), signs the person in and sends a Clerk OAuth
  access token (opaque `oat_…` or a JWT); Octillion verifies it and uses the person's oldest membership that is not
  suspended. Existing `oct_` keys work in a header (`Authorization: Bearer`, or
  `X-API-Key`). Keys in the URL (`/mcp/<key>`) are deprecated: served with a `Deprecation` header and logged by key prefix
  while `OCTILLION_URL_KEYS` is `allow` (the default), refused with `OCTILLION_URL_KEYS=off`; new keys are never
  issued as URLs.
- **Origin:** browsers send an `Origin` header; on every MCP endpoint a request whose Origin is not `PUBLIC_URL`'s (or
  a `CLERK_MCP_AUDIENCE` origin, or one listed in `OCTILLION_MCP_ALLOWED_ORIGINS`, comma-separated) is refused with a
  403 and logged (`mcp origin refused … origin="…"`, once a minute per origin); the `/mcp` access line shows any Origin a
  served request carried. Claude Code, Cursor and the SDKs send none; Claude's and ChatGPT's connectors call from their
  servers and are expected to send none (check the access lines after deploying). Allowing an origin passes this check
  only: no CORS headers are sent. A server on loopback with no `PUBLIC_URL` also refuses a `Host` that is not
  localhost.
- **OAuth token audience:** a JWT access token must come from the Clerk instance (`iss` is its Frontend API), always.
  Its audience (a JWT's `aud`; for an opaque token, an audience field in Clerk's verify response) must name this
  server's `/mcp` (`$PUBLIC_URL/mcp`, or one of the URIs `CLERK_MCP_AUDIENCE` lists, comma-separated); the admin MCP
  takes only tokens naming `/admin/mcp` or `/api/admin/mcp`. `OCTILLION_OAUTH_AUDIENCE`: `auto` (default) refuses a
  token that names another audience and accepts one that names none, logging it (`oauth audience missing …`, once per
  client per 10 minutes, claims only), because Clerk does not document putting the resource in its tokens; `enforce`
  also refuses tokens with no audience (turn it on once the logs show Clerk's tokens carry it); `report` refuses
  nothing and logs mismatches. An `aud` that is not an http(s) address, or that is the client id or the issuer, names no
  resource and counts as none. Behind a Clerk proxy URL, set `CLERK_FRONTEND_API_URL` to it (the tokens' issuer).
- **Suspending someone:** Clerk memberships have no deactivated state, so suspension is the membership's
  `public_metadata.suspended = true`; Octillion refuses suspended members on `/mcp` and `/api/app` (at once for changes
  made through Octillion, within 30 seconds for changes made in the Clerk dashboard). Removing a member deletes the
  membership in Clerk.
- **Inviting someone who already has a pending invitation** replaces it (Clerk revokes the old one).
- An organization created in the Clerk dashboard gets its Octillion row on first use (and `public_metadata.octillion_slug`
  written back). A legacy account moves to Clerk from `/admin` (Move to Clerk), and its keys keep working.

### Stripe (billing)

1. Set `STRIPE_SECRET_KEY` (a restricted key with Customers, Checkout Sessions, Customer portal, Subscriptions,
   Prices, Invoices read and Meter events write is enough).
2. Create the plans as recurring prices with a `lookup_key` starting with `octillion_` (e.g. `octillion_starter`) and
   `metadata.monthly_budget_usd` (the plan's model-spend cap; the product's metadata works too).
3. Configure the customer portal (plan switching between the Octillion prices, card updates, invoices, cancellation).
4. Optional usage-based pricing: create a meter (sum, value in cents, customer mapping `stripe_customer_id`), set
   `STRIPE_SPEND_METER` to its event name. Each finished agent session reports its model cost once (deduplicated by
   session id).
5. Octillion records the Stripe customer on the Clerk organization (`public_metadata.stripe_customer_id`) and the
   Clerk organization on the Stripe customer (`metadata.clerk_organization_id`). Billing stays on Stripe directly,
   not Clerk Billing (which has no usage-based pricing and is not synced with Stripe Billing).

During the beta, leave `OCTILLION_REQUIRE_SUBSCRIPTION` unset: accounts without a plan get
`OCTILLION_ORG_MONTHLY_BUDGET_USD`. With it set to `1`, new simulations need an active or trialing subscription.

### PostHog (product analytics)

Set `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU or self-hosted). Enable **group analytics** with group type
`organization`. Server-side events:

| Event | When |
|---|---|
| `access_requested` | landing-page form |
| `admin_request_approve`, `admin_org_create`, `admin_invite_send`, `admin_member_deactivate`, `admin_billing_checkout_link`, ... | console and `/app` admin actions (no emails) |
| `mcp_connected`, `mcp_tools_listed`, `mcp_dashboard_loaded`, `mcp_prompt_used` | connector handshake steps, with the client name |
| `tool_called` | every tool call: tool, ok, duration, client, auth (`clerk` / `api_key`) |
| `onboarding_completed`, `onboarding_failed`, `simulation_completed`, `simulation_cancelled` | product milestones |
| `app_signed_in`, `app_connection_test_started` | customer page |

Distinct ids are the Clerk user id (signed in), `org:<slug>` (API key) or `admin:<name>` (console). A starting
dashboard: the funnel `access_requested → admin_request_approve → mcp_connected → tool_called (onboard_product) →
onboarding_completed → tool_called (run_simulation) → tool_called (get_visibility_report)`, aggregated by organization;
weekly retention on `tool_called`; adoption broken down by `tool`.

### New Relic (observability)

Set `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net` (EU: `https://otlp.eu01.nr-data.net`) and
`OTEL_EXPORTER_OTLP_HEADERS=api-key=<ingest license key>`. `npm start` and the Dockerfile load `src/otel.ts` first.
You get:
- HTTP spans for every route (`/mcp`, the gateway, the worker API), with `/mcp/oct_…` rewritten to `/mcp/:key`;
- Postgres query spans (statement only, never values) and outbound `fetch` spans (Clerk, Stripe, model providers);
- an `mcp.tool <name>` span per tool call with `octillion.org`, `mcp.tool.name`, `octillion.auth` and an error flag.

Useful alerts: `/mcp` p95 latency, the error rate on `mcp.tool *` spans, 5xx on `/api/worker/*`, and outbound errors to
`api.clerk.com` or `api.stripe.com`. The orchestrators are not instrumented yet.

## The two web surfaces

| | Admin panel `/admin` | Customer portal `/app` |
|---|---|---|
| For | Octillion staff (platform admins), across every account | each account's people; account admins get management controls |
| Sections | Overview, Requests, Accounts, Journeys, Analytics | Setup, Usage, Context, Team, Limits, Billing |
| Sign-in | Clerk (platform admins only); admin token for scripts | Clerk; the account is the active Clerk organization |
| Analytics | every account: adoption, retention, accounts at risk, health (replicated from the event log; PostHog and New Relic hold the full record) | their own team's usage only |

Both are the Next.js app in `web/`, which calls this server's JSON API on the same origin (so Clerk's `__session`
cookie reaches it); admin writes authenticated by that cookie carry `X-Octillion-Admin: 1`.

## Sign-in

Clerk signs people in everywhere: the portal, the admin panel and the AI client's OAuth on `/mcp`. Which methods are
offered (password, Google, Microsoft, GitHub, enterprise SSO) is set in the Clerk dashboard, not in Octillion.

## Platform admins

`/admin` is for Octillion staff, across every account; an account's own admins manage their team on `/app`. A Clerk user
is a platform admin when their **verified** primary email matches `OCTILLION_PLATFORM_ADMINS` (comma-separated
addresses or `*@company.com` domains), or their Clerk `public_metadata.platform_admin` is `true`. Removing an entry
ends that admin's access on their next request. `GET /admin/session` tells the UI who is signed in and whether they
are a platform admin. Scripts use admin tokens (`npm run admin:token`, src/admin-tokens.ts): one per purpose,
with a role and an expiry, revocable; the old static `OCTILLION_ADMIN_TOKEN` is no longer accepted. A token acts with its role but can never mint tokens or add, promote
or remove admins (those need a signed-in owner). On a VM, mint inside the app container; on Vercel, run
`npm run admin:token` from a checkout with the production `DATABASE_URL` in the environment (it never prints the
URL), or, signed in as an owner, `POST /api/admin/tokens {label, role, days}`.

## Analytics

PostHog is the system of record for product analytics and New Relic for traces. `/admin` → Analytics replicates what
staff check daily (active accounts and people with change vs the previous period, daily activity, weekly retention
by account cohort, tool adoption, client mix, accounts at risk, and health: error rate, tool latency, simulation and
session outcomes, onboarding failures, gateway errors, model cost) from the event log Octillion already keeps, so it
matches the account pages and works before PostHog is connected. `POSTHOG_PROJECT_URL` and `NEW_RELIC_DASHBOARD_URL`
add links to the full record. Customers see only their own team's usage (`/app` → Usage).

## Usage limits (account admins, /app → Limits)

An account's admins decide how the plan's monthly model budget is used:
- **Sharing:** *shared pool* (everyone draws from the account), *split evenly* (budget minus a reserve, divided by
  people, each adjustable up or down; people in a team with a budget split that budget), or *custom caps* per person
  with a default.
- **Teams:** a team's budget is split among its people and caps their combined spend in every mode.
- **Rollout:** whether new members may launch simulations, and a per-person switch. Reports and transcripts stay open.
- **Throughput:** simulations running at once (per person, team default or account default) and agent sessions per
  launch.

Enforced when a simulation starts (a clear message names the limit and where to change it) and while an adaptive run
samples more (it stops early when its launcher's allowance or team budget runs out). Spend per person is the model cost
of the simulations they launched this month; tokens are shown alongside. Limits apply to people signed in with
Clerk; connector keys draw from the account's pool.

## Context (/app → Context)

- **Company** (admins): what the company does, its developers, competitors to always track, internal names, notes.
- **You** (each person): role, the product they work on most, what they care about, preferred answer style.
- **Products** (admins): the product profile (names, packages, domains, competitors) and its coding tasks, which can
  be retired or brought back.

Company and personal context are added to the MCP server's instructions on every connection, as background, so the AI
client tailors answers without being told again. Company context also goes to onboarding research.

## Journeys

See **[docs/journeys.md](journeys.md)**: build journeys in PostHog Workflows; Octillion delivers their in-chat and
`/app` tips.

## Day to day

- **New request:** `/admin` → Requests → Approve. This creates the Clerk organization, the Stripe customer and the
  invitation, and Clerk sends the email. Add a colleague to an existing account with "Add to an existing account".
- **Someone is stuck:** `/admin` → Overview → Needs attention. Open the account to resend an invitation, or to see their
  clients, errors and tool use.
- **Their IT wants SSO:** set up an enterprise connection for their organization in the Clerk dashboard.
- **Plans:** account → Billing → copy a checkout link, or open the Stripe portal. Customers can do both from
  `/app#billing`.
- **Someone leaves:** their admin suspends them on `/app#team`, or you do in `/admin` (or remove them in Clerk). They
  lose access at once. For legacy keys, revoke the key.

## Local preview

```bash
npm run mock:providers     # fake Clerk Backend API + Stripe on :4455 (API tests; browsers need a real Clerk dev instance)
npm run demo:seed          # one account with two weeks of scored runs
npm run admin:demo         # requests and accounts at every funnel stage (mock only)
npm run dev                # the API; sign in through the web app against a Clerk development instance
```
