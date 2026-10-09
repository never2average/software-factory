# The hosted MCP endpoint — `/api/mcp`

Every application built from this codebase serves its **own** MCP server, at its
**own** address:

```
<your deployment's address>/api/mcp
```

A coding agent (Claude Code, Cursor, VS Code, Codex) connects to that URL and
gets the workspace tools — customers, people, connectors, workflows, schedules,
tasks, the data room. Nothing to install and nothing to point: the endpoint *is*
the deployment.

## Why it exists

Coding agents used to connect only through an npm package (`@delivery-agents/cli`,
built from `setup/`). That package is shared by every deployment of this codebase,
and it defaulted to one particular product's production address, while the app's
own "wire your coding agent" instructions gave no address at all. On any other
deployment, following the on-screen steps connected your agent — successfully —
to somebody else's app.

Two fixes, both in this change:

1. The app hosts the MCP server itself, so the address is never a setting.
2. The package has **no default address** any more. It requires `WORKSPACE_OPS_URL`
   (or an address saved by `workspace-login --url`) and fails with a message naming
   the variable.

Since then: **each deployment builds its own package** with its own address, name, skills
and data-room description baked in (`npm run build:agent-cli`,
[`AGENT_CLI.md`](AGENT_CLI.md)). `mcpConnect({ agentPackage })` in `lib/mcp-connect.ts`
then gives the package alternative as `npx <package> login`, with no address to type. A
pack adds skills for coding agents under `agent-kit/skills/<name>/SKILL.md`; the hosted
endpoint serves tools only, so the package is how those skills reach an agent. The generic
`@delivery-agents/cli` still has no default address.

## Connect

The exact strings for a deployment are built by `lib/mcp-connect.ts` from the
deployment's address and its product name, and shown on the "Invite your team"
screen and in every invite email. For a deployment at `https://app.example.com`
whose product is named "Acme Research":

**1. Get a token** — the same emailed-code sign-in the web app uses:

```bash
curl -s -X POST https://app.example.com/api/auth/email/request -H 'content-type: application/json' -d '{"email":"you@company.com"}'
# a six-digit code arrives by email
curl -s -X POST https://app.example.com/api/auth/email/verify -H 'content-type: application/json' -d '{"email":"you@company.com","code":"123456"}'
# -> {"token":"eyJ…","email":"you@company.com","expiresIn":604800}
```

**2. Add the server** (Claude Code):

```bash
claude mcp add --transport http acme-research https://app.example.com/api/mcp --header "Authorization: Bearer <token>"
```

Cursor (`~/.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`, keyed on `servers`
with `"type": "http"`) take `{"url": "…/api/mcp", "headers": {"Authorization":
"Bearer <token>"}}`; Codex takes `url` + `http_headers` in `~/.codex/config.toml`.

**3. Optional — pin a workspace.** Add a second header, `x-ops-org: <workspace id>`.
Without it the tools act in your active workspace — the one the web app's switcher
shows. `workspace_list` / `workspace_use` read and change that from the agent.
The header names a workspace; it does not grant one. A workspace you are not a
member of, or an id that does not exist, is refused on every call ("You are not a
member of this workspace.", never told apart) — the tools are not answered from
your active workspace instead.

## Authentication

- `Authorization: Bearer <token>` on **every** request, `initialize` included,
  verified by `verifyOpsAuth` (`lib/ops-auth.ts`) — the Ops API's own check. It
  accepts exactly what the Ops API accepts: an emailed-code session token, or a
  Google ID token for a Workspace account.
- Missing or bad token → `401`, `WWW-Authenticate: Bearer …`, and a JSON-RPC error
  body (`-32001`) saying where to get a token.
- **Lifetime.** An emailed-code token lasts **7 days** (`SESSION_TTL_SECONDS`,
  `lib/auth-session.ts`). When it expires the agent sees 401; repeat step 1 and
  update the header. A Google ID token lasts about an hour, so it is a poor fit
  for a config file — use the emailed code, or the npm package (which refreshes
  Google tokens itself).
- **The npm package takes either.** `npx <package> login` is the Google sign-in;
  `npx <package> login --email <address>` runs the two calls of step 1 for you,
  asks for the code on the terminal and stores the session (never printed) where
  its MCP server reads it. After 7 days its tools say the sign-in has expired and
  the person runs it again.
- **What the token is.** It proves an email address and nothing else. Workspace
  membership is read from the database on every request, so removing someone
  from a workspace cuts their agent off immediately, token or not. It cannot be
  revoked individually before it expires — see "Not built yet".
- Requesting a code only ever emails an address that already has a membership or
  a live invite; codes expire in ten minutes, allow five guesses, and are single
  use. Both routes are rate limited per address.

## Authorisation

The endpoint does not reimplement any. A tool call becomes an ordinary request to
**this same deployment's** Ops API (`/api/ops/*`) carrying the caller's own
`Authorization` and `x-ops-org` headers. It crosses `proxy.ts` and each route's
membership and role checks exactly as a click in the web app does. A tool can
never act in a workspace the caller is not a member of, because the Ops API
refuses — and that refusal comes back as a tool error the agent can read.

The cost is one same-origin HTTP request per Ops call. Calling the ~40 route
handlers in-process would have skipped the proxy gate and coupled the endpoint to
every route's signature.

## Transport

MCP **Streamable HTTP**, stateless, JSON responses.

- `POST /api/mcp` — one JSON-RPC message, or a batch of at most 10 (batching left
  the spec in 2025-06-18; older clients may still send small ones). Requests are
  answered with `application/json`; a POST carrying only notifications gets `202`.
- `GET` / `DELETE` → `405`, `Allow: POST`. There is no server-to-client stream and
  no session to delete. No `Mcp-Session-Id` is issued: a serverless function
  cannot promise the next request reaches the same instance, and nothing here
  needs memory between requests (the selected workspace lives in the database).
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`; notifications are
  accepted and ignored. Protocol versions `2025-11-25`, `2025-06-18`,
  `2025-03-26`, `2024-11-05`.
- `initialize` and `tools/list` touch neither the database nor the Ops API.

**Hand-rolled, not the SDK.** `@modelcontextprotocol/sdk` 1.30 does ship a
web-standard transport that fits a route handler. It was not adopted because the
surface is four methods that the stdio package already implemented without the
SDK — that implementation is now shared (`handleRpc` in `setup/workspace-tools.mjs`) —
while the SDK adds about ninety transitive packages (express, hono, cors, ajv…)
to the app. The SDK's *client* is the right tool for checking interoperability
against a running deployment.

## Tools

One definition, two hosts. `setup/workspace-tools.mjs` holds every tool's name,
description, schema and handler; the stdio package (`setup/workspace-mcp.mjs`) and the
hosted endpoint (`lib/mcp-server.ts`) each supply only a context — how to call the
Ops API, who the caller is, which workspace is selected. `npm run
test:mcp-endpoint` asserts both hosts list identical tools.

Those are this repository's file names. In a package **built for a deployment** the
same two files ship as `<package>-tools.mjs` and `<package>-mcp.mjs`, and the stdio
server reports that deployment's slug as its name, exactly as the hosted endpoint
already does: a package a customer installs carries no other product's name
([`AGENT_CLI.md`](AGENT_CLI.md)). The **tool names** (`workspace_status`, `dataroom_*`, …)
are the wire contract the two hosts share and do not change with the package.

| Area | Tools |
|---|---|
| Orientation | `workspace_status` (start here), `workspace_list`, `workspace_use` |

`workspace_status` once had a name carrying the base product's role word. That name was
accepted as an unadvertised alias while assistants holding it in a conversation moved over, and
is no longer accepted. `scripts/check-wire-names.mjs` fails the build if any advertised name,
environment variable or storage key grows the word back.
| Customers | `customer_create`, `customer_list` |
| People | `people_list`, `people_invite`, `people_set_role` |
| Subagents | `agent_list`, `agent_configure` |
| Connectors | `connector_list`, `connector_create`, `connector_update`, `connector_delete`, `connector_probe`, `connector_secrets`, `connector_secret_set`, `connector_secret_delete` |
| Workflows | `workflow_list`, `workflow_get`, `workflow_create`, `workflow_set_script`, `workflow_update`, `workflow_run`, `workflow_delete` |
| Schedules | `cron_list`, `cron_create`, `cron_update`, `cron_delete` |
| Apps | `app_list`, `app_create` |
| Delivery | `sprint_list`, `sprint_create`, `implementation_list`, `implementation_upsert`, `deployment_list`, `deployment_upsert` |
| Work | `task_list`, `task_create`, `task_update`, `task_delete`, `ticket_list` |
| Data room | `dataroom_structure`, `dataroom_list`, `dataroom_read`, `dataroom_read_jsonl`, `dataroom_write`, `dataroom_append_jsonl` |
| Bulk writes | `backfill_start`, `backfill_finish`, `backfill_list`, `backfill_show`, `backfill_revert` |
| Sessions and learnings | `record_coding_session`, `session_upload`, `session_upload_batch`, `session_continue_url`, `learning_distil`, `learning_list` |

The two period tools (`sprint_list`, `sprint_create`) follow the deployment profile's `work_periods`
([`DEPLOYMENT_PROFILE.md`](DEPLOYMENT_PROFILE.md)): their descriptions read the profile's word for a period, and a
deployment whose profile turns work periods off is offered neither, and no task tool there takes or names a period.

Writes to the data room and invites preview by default and need `confirm: true`
plus the preview token; see the server's `instructions`. Through the hosted
endpoint the data room is always reached via the Ops API — as the caller,
workspace-scoped, versioned and audited. The direct-blob mode exists only in the
package, inside the platform repo.

## Security model

| Concern | What the endpoint does |
|---|---|
| Browsers / DNS rebinding | MCP clients are programs and send no `Origin`. A request whose `Origin` is not this deployment's own is refused with `403` before anything else. No `Access-Control-Allow-Origin` is ever sent. |
| Who may connect | Bearer verified per request (above). No shared key, no anonymous `initialize`. |
| What they may do | Decided by the Ops API, per request, from database membership. |
| Where tool calls go | Only to paths under `/api/ops/` on this deployment; redirects are not followed. On Vercel the target is the request's own origin (the platform routes by host). Self-hosted it is `WEB_ORIGIN` when set, or `MCP_INTERNAL_ORIGIN` (e.g. `http://127.0.0.1:3000`) when the app should call itself on loopback. |
| Request size | Body capped at 4 MB, counted as it streams (a false `Content-Length` does not help). Batches capped at 10. |
| Response size | A tool result over 400,000 characters is truncated with a note telling the agent how to narrow the request. |
| Failures | A tool that throws, or an Ops API refusal, is an MCP tool error (`isError: true`, HTTP 200) — never a 500. |
| Secrets | No credential appears in any tool description or in `instructions` (asserted by the test). `connector_secret_set` never echoes a value. |
| Caching | `Cache-Control: no-store` on every response. |
| `proxy.ts` | Unchanged. `/api/mcp` is not under the `/api/ops/*` gate because it authenticates itself with the same verifier; each tool call then crosses that gate. The CSP header the proxy adds is inert on a JSON response. |

**Rate limiting.** There is no general per-identity limiter in `lib/` to reuse
(the only limits are the database-backed ones on sign-in codes), and an in-memory
counter means nothing on serverless. None was added; the caps above bound the
cost of a single request, and every tool call is an authenticated, audited Ops
API call.

## Not built yet — agent tokens

Seven days is workable but not comfortable, and a session token cannot be revoked
on its own. The intended follow-up is a dedicated credential:

- `agent_tokens` table — `id`, `org_id`, `email` (the member it acts as),
  `name`, `token_hash` (SHA-256 of a 32-byte random secret shown once, prefix
  `dlv_agt_`), `last_used_at`, `expires_at` (default 90 days), `revoked_at`,
  `created_by`. Row-level security on `org_id`, with a drizzle migration in the
  style of `drizzle/0016_agent_session_scopes.sql`.
- Verification must run on the Node runtime (a database lookup), so it belongs in
  the `/api/mcp` handler — which would then mint a short-lived, workspace-scoped
  session token (`mintSessionToken(email, orgId)`) for the hop to the Ops API,
  rather than teaching the Edge proxy a new credential.
- Org-scoped: the token carries its workspace, `x-ops-org` cannot widen it, and
  membership is still re-checked on every call.
- Listed, named and revocable from workspace settings; mint, use-from-new-address
  and revoke all written to the ops audit trail.

It was left out of this change deliberately: a credential system is not something
to half-build alongside a transport.

## Testing

```bash
npm run test:mcp-endpoint
```

Drives `handleMcpRequest` in-process with real session tokens (a throwaway ES256
key) and a recording fake of the Ops API: 401 / 403 / 405 / 413 / 415 paths,
`initialize` naming the product, tool-list equality with the stdio package
(spawned over its real transport), header forwarding, batch ordering, tool errors,
truncation, and the strings people are told to type.
