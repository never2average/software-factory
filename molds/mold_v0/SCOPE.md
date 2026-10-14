# mold_v0 scope (coming soon)

**Status:** coming soon. No codebase and no source yet: the operator builds it in a repository of their own, bottom up,
and brings the link here. Then the factory fetches it (`mold.py fetch mold_v0`) and turns it into a declarative app
(tickets `mold_v0-022` to `mold_v0-025`).
**Product:** `mcp_product_shell` in `state/products.json`. **Backlog:** `state/tasks/mold_v0.jsonl`.

## What mold_v0 is

mold_v0 is a general-purpose product shell for an MCP server that is already deployed. You give it the server's
address, and it gives you a branded web product around that server. People can install the server in their MCP
client, read its documentation, sign up, connect the credentials it needs and use it, and the app's owner can see who
uses what.

At its centre is a **metering gateway**: an MCP endpoint of the product's own that sits in front of the upstream
server. On every call it:

1. checks who the caller is (OAuth or a per-user token);
2. decides which tools that caller may see;
3. adds the caller's own upstream credential;
4. forwards the call and streams the answer back;
5. records the call.

Everything else (install pages, docs, onboarding and the admin console) is a web app on the same database.

It is much smaller than mold_v1. There is no agent runtime, no model, no chat, no data room and no workflows. From
mold_v1 it reuses only the patterns that fit: the emailed-code sign-in, workspace tenancy with row-level security that
fails closed under a non-owner database role, invites, AES-256-GCM secret encryption with a versioned key, the email
adapter and the profile-driven branding. It is built new; it is not a fork.

The upstream may speak **Streamable HTTP**, the current MCP transport, or the deprecated **HTTP+SSE** transport,
which the gateway supports for compatibility. A **stdio** server is in scope only once someone has hosted it behind
HTTP. mold_v0 never runs a client's local process.

The gateway speaks both protocol generations, toward clients and toward the upstream:

- the stateless 2026-07-28 revision: `server/discover`, per-request `_meta`, `Mcp-Method` and `Mcp-Name` headers
  checked against the body, and `subscriptions/listen`;
- the session-based revisions from 2025-03-26 to 2025-11-25: `initialize`, `Mcp-Session-Id` and the GET stream.

## Capabilities

| Capability | What a user or the app owner gets |
|---|---|
| Install pages | One page per enabled client (Claude Code, Claude Desktop and claude.ai connectors, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI, ChatGPT, plus others such as Zed and Cline). Each page has the exact config or command for a remote server, a one-click install link where the client has one, a copy button, and the user's own token filled in when the client cannot sign in with OAuth. |
| Generated docs and playground | Docs built from the upstream's own answers to `server/discover` (or `initialize` on an older server), `tools/list`, `resources/list` and `prompts/list` (following pagination). They include descriptions, input and output schemas and annotations. The app developer can override any text and add examples. The playground calls a tool through the gateway as the signed-in user, with that user's credentials, and the call is metered. |
| Onboarding | Sign-up and sign-in by emailed code or Google, a workspace, invites, connecting credentials, installing in a client, and a guided first call. A checklist ticks itself off from real events. |
| Metering gateway and usage tracking | Every call records user, workspace, client, tool, outcome, error class, latency and sizes. Arguments and results are not stored unless the profile turns that on. Dashboards show calls per tool, errors, p50/p95 latency, daily and weekly active users and retention, for each workspace and for the owner across all workspaces. |
| Credential vault | Credential fields the upstream needs, declared in the profile, stored per user or per workspace. Values are encrypted at rest and injected on forward as a header, a query parameter or a bearer token. Third-party OAuth connections (connect, refresh, revoke) count as credentials too. When one is missing, the gateway can ask for it in the client with URL-mode elicitation; the credential itself never passes through the client. |
| MCP OAuth for clients | The gateway is an OAuth 2.1 protected resource with its own authorization server. Clients register by Client ID Metadata Document first. Dynamic client registration is only a fallback, because the 2026-07-28 revision deprecated it. PKCE S256 and resource indicators are required, and tokens are short-lived, bound to one workspace and to the gateway's audience. Per-user tokens are the fallback for clients without OAuth. |
| Admin console | Users, workspaces, tokens (revoke), tool visibility, per-plan limits and grouped recent errors, with an audit log of every change. Only the app's own admins can reach it. |
| Upstream health and changelog | The upstream is probed on a schedule (with a discovery call, or `ping` on an older upstream) and the results feed a public status page. Every change to the tool list (a tool added, removed, or with a new schema or description) becomes a changelog entry. Re-introspection runs on deploy, on a schedule and when the upstream announces a changed tool list (on `subscriptions/listen`, or on the GET stream for an older upstream). |
| Billing hooks (declared, **off**) | Plans with limits and entitlements in the profile, and a billing interface (usage events out, plan changes in). No provider is wired. |
| Email notifications (declared, **off** by default) | Sign-in codes and invites are on. Upstream-down alerts, quota warnings and digests stay off until the profile turns them on. |
| Abuse limits | Rate limits and quotas per token, user, workspace and IP, size caps on requests and responses, and a concurrency cap per workspace. Sign-up, invites and token creation are also limited. |

## The MVP line

The MVP is tickets `mold_v0-001` to `mold_v0-012`, all priority 1:

- the skeleton with the profile loader;
- a fake upstream MCP server for tests;
- workspace tenancy and sign-in;
- introspection;
- the gateway with tool filtering;
- **per-user tokens**;
- usage tracking;
- the credential vault;
- install pages;
- onboarding.

The MVP is done when it runs on one deployment in front of a real upstream: a new person signs up, saves their
credential and installs from the install page in Claude Code and Cursor using a token. Their first call shows on
their usage page and on the owner's. On that same deployment, the test where two users call at the same time proves
that neither user's secret was ever sent on the other's call.

These come after the MVP, at priority 2 or 3:

- MCP OAuth 2.1, needed for the claude.ai and ChatGPT connectors;
- third-party OAuth credentials;
- generated docs and the playground;
- the admin console;
- health and changelog;
- abuse limits;
- billing and email hooks;
- the two hosting targets;
- the in-repository lanes.

## What makes it declarative

The operator's codebase becomes a factory mold when **every product decision is a profile key**. The code holds no
product, customer or domain word, and the factory only ever writes `profiles/*.json` (plus the logo and favicon
files). Intake writes these keys from a brief, and provision checks and deploys them:

| Key | Meaning |
|---|---|
| `product.name`, `product.tagline`, `brand.color`, `brand.logo` | the brand: the factory's three-input brand plus a tagline |
| `upstream.url`, `upstream.transport` (`streamable_http` \| `sse`) | the server being productized |
| `upstream.auth` (`none` \| `static_header` \| `bearer` \| `per_user_credential`), `upstream.operator_secret_ref` | how the gateway authenticates to the upstream. The value is a secret **name** only. |
| `tools.expose` / `tools.hide` (names or globs), `tools.labels` | which tools users see, and their display names |
| `credentials[]`: `{id, label, help, scope: user\|workspace, inject: {as: header\|query\|bearer, name}, oauth?: {authorize_url, token_url, scopes, client_id_ref, client_secret_ref}}` | what each user or workspace must connect before a tool works |
| `clients.enabled[]` | which install pages exist |
| `auth.methods` (`email_code`, `google`), `auth.oauth_clients` (`cimd`, `dcr`), `auth.token_fallback` | how people and clients sign in |
| `plans[]`: `{id, limits: {calls_per_min, calls_per_month, concurrency}, entitlements}`, `limits.default` | plans and abuse limits |
| `usage.store_arguments` (default `false`), `usage.retention_days` | how much the gateway records |
| `features.billing` (default `false`), `features.email_notifications` (default `false`), `features.status_page`, `features.changelog`, `features.playground` | optional surfaces |
| `docs.overrides` | the developer's text and examples, keyed by tool name |

The app's environment names (never values) also belong to the contract. They are the database URL, the vault key and
its versions, the session signing keys, the email key and sender, the Google client id, and each `*_ref` above. The
mold declares them in a manifest the factory reads. With them, `provision.py` deploys **one** project (not
mold_v1's three) on Vercel or on a server of the app's own. The lanes run against the deployed app plus the fake
upstream.

## Security requirements

- **Workspace isolation.** Every workspace-owned table carries `workspace_id` under row-level security that fails
  closed when no workspace is set, and the app connects as a non-owner role. Tokens, credentials, usage and audit rows
  of one workspace are never readable from another. The context lane proves this.
- **No credential crossing.** The gateway resolves the upstream credential from the authenticated caller on each
  call, never from shared or cached connection state. An upstream session is never reused across users. A test that
  sends concurrent calls from two users through the fake upstream, which echoes back the credential it received,
  must show zero crossings.
- **No token passthrough.** The token a client presents to the gateway is never forwarded upstream. Only the
  credential that the profile declares for that user goes upstream. Tokens are checked for issuer, audience (the
  gateway's own MCP address), expiry, workspace and revocation.
- **Secrets.** Vault values are encrypted with AES-256-GCM under a key from the deployment's environment, with a key
  version so the key can rotate, and with no plaintext fallback. They are write-only from the browser (only the last
  four characters are ever shown) and never appear in logs, usage records, error messages or docs. The factory
  handles secret names only, by the factory's own rule.
- **Token scoping.** OAuth access tokens are short-lived and bound to one workspace and one resource, and refresh
  tokens rotate. Per-user tokens are stored as hashes, shown once, named, revocable and expiring.
- **OAuth hygiene.** PKCE S256 is required. Redirect URIs are matched exactly. The consent screen names the client and
  the workspace. Third-party OAuth `state` is bound to the user and the workspace.
- **Abuse.** Limits apply per token, user, workspace and IP, along with size caps, a concurrency cap and timeouts on
  upstream calls. A slow or failing upstream turns into fast, well-formed MCP errors, never a hung client.
- **Admin surface.** The console returns 404 to anyone who is not an admin, and every change made there is
  audit-logged.

## Out of scope

- Hosting or running the upstream server itself, and running stdio servers or a client's local process.
- An agent runtime, a model, chat, a data room or workflows (that is mold_v1).
- A built-in payment provider: billing stays an interface that is off by default.
- Marketing email and a CRM.
- A marketplace or registry listing of many servers. One app fronts one upstream.
- Changing the upstream's tools. The gateway filters, labels, meters and injects credentials, and never rewrites
  arguments or results.

## Sources (MCP facts, checked 2026-10-14; the latest revision is 2026-07-28)

- **2026-07-28 changelog.** The protocol is stateless, with `server/discover`, no sessions and
  `subscriptions/listen`. HTTP+SSE and dynamic client registration are deprecated.
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- **Streamable HTTP.** One POST endpoint; the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers;
  intermediaries forward `Mcp-Param-*` headers; `Origin` is validated.
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- **Authorization.** Covers:
  - OAuth 2.1;
  - RFC 9728 protected resource metadata;
  - RFC 8414 and OIDC discovery;
  - PKCE S256;
  - the RFC 8707 `resource` parameter;
  - audience validation;
  - no token passthrough;
  - a proxy asking for consent for each client.

  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization and
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- **URL-mode elicitation** for third-party credentials:
  https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- **Client config formats** for the install pages. Each one is checked again when its install page is built (ticket
  mold_v0-010). Which ChatGPT plans can add a server could not be confirmed on 2026-10-14.
  - Claude Code: https://code.claude.com/docs/en/mcp
  - Claude custom connectors: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
  - Cursor: https://cursor.com/docs/context/mcp/install-links
  - VS Code: https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
  - Windsurf / Devin Desktop: https://docs.devin.ai/desktop/cascade/mcp
  - Codex CLI: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
  - Gemini CLI: https://geminicli.com/docs/tools/mcp-server/
  - ChatGPT: https://developers.openai.com/plugins/deploy/connect-chatgpt
  - Zed: https://zed.dev/docs/ai/mcp
  - Cline: https://docs.cline.bot/mcp/configuring-mcp-servers
