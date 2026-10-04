# Design: native GitHub and GitLab connectivity for minted apps

2026-10-04. Design only. Mold read at `1f43117`.

## 1. What the competitors ship

| | Lovable | Replit |
|---|---|---|
| Providers | GitHub (.com, Enterprise Cloud, Enterprise Server), GitLab (.com, self-managed), Bitbucket Cloud | GitHub in the Git pane; import from GitHub and Bitbucket; GitHub Enterprise Server, GitLab Self-Managed, Bitbucket Data Center on Enterprise only. GitLab.com is not listed for import; any remote works from the shell |
| Connect | Workspace admin installs Lovable's GitHub App once per workspace; each project is then linked to one repository | "Connect to GitHub" in the app's Git pane; auth details not documented |
| What syncs | The project's whole code | The app's whole code |
| Direction | Two-way, automatic, one branch at a time | Manual push and pull; conflicts resolved by hand |
| Import existing repo | No, export only; Lovable creates the repo | Yes (public and private); the import does not stay linked |
| Branches | Switch/create inside Lovable; only the active branch syncs | Create, switch, publish |
| Owner | Customer's account or organisation, private by default | The user's account (not stated in the docs) |
| Scope | Per-workspace connection, per-project link, one repo per project | Per app |
| Limits | Deleting the repo breaks sync; reconnect makes a new repo; no force-push or rebase on the synced branch; 100 MB file cap | Self-managed hosts need Enterprise |

Sources: https://docs.lovable.dev/integrations/git-sync-overview, https://docs.lovable.dev/integrations/github, https://docs.replit.com/features/workspace-tools/git-interface, https://docs.replit.com/getting-started/quickstarts/import-from-github, https://docs.replit.com/replit-workspace/workspace-features/version-control

**The shape differs.** Both sync the code of the app the user is building. Our product is an agent workspace whose users never edit the app's code, so only reading A below is something a workspace user touches.

## 2. What exists (verified)

- `agent/lib/connections.ts`: GitHub is GitHub's hosted MCP server with no `tools.allow`; "read-only" is only the App's registered permissions.
- By default (every Vercel app) one server-wide `GITHUB_APP_*`/`GITHUB_TOKEN` serves **every workspace**. `CONNECTIONS_PROVIDER=env` fixes this (per-workspace `connector_secrets`, HKDF per workspace, RLS) but also takes Slack off Vercel Connect.
- A workspace admin must paste an App id, installation id and key. No button, no OAuth, no GitLab.
- eve already offers MCP `tools.allow`, tool `approval` gates (used in `signoff-tools.ts`) and sandbox **credential brokering** (`networkPolicy` per-domain `transform`, Vercel and microsandbox).
- Sandbox bootstrap installs no git; self-hosted egress is allow-all minus the private ranges.

## 3. Reading A: a workspace connects its repositories (recommended first)

### Credentials

**GitHub: one GitHub App per deployment**, not an OAuth App (user-wide grant, no repository choice) or a pasted token.
- Operator, once per app: registers the App through GitHub's manifest flow (one confirm click). Deployment secrets, by name: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`; plus `GITHUB_APP_SLUG` (not secret).
- Customer admin: clicks Connect GitHub, picks the organisation and repositories on GitHub's screen, returns.
- Stored per workspace: only the installation id. No long-lived token exists.
- Binding check (the isolation-critical step): the callback carries a signed `state` (workspace, admin, nonce, 10 minutes) and the user `code`; the server confirms through `GET /user/installations` that this person can see that installation. An installation id from the URL alone is never trusted.
- Every call mints a 1-hour installation token narrowed to the repositories and permissions it needs (`contents:read` unless the write switch is on).
- Revocation: uninstall on GitHub (a webhook marks it disconnected) or Disconnect in the app.

**GitLab: an OAuth application per GitLab host.** GitLab has no installation concept.
- gitlab.com: the operator registers one application per deployment (`GITLAB_APPLICATION_ID`, `GITLAB_APPLICATION_SECRET`).
- Self-managed: the customer's GitLab administrator registers it on their server; the workspace admin enters the address, id and secret in the connect form, stored in that workspace's encrypted store.
- Scopes: `read_api read_repository`; turning write on reconnects with `api`.
- Access tokens last 2 hours; refresh tokens are single-use, so refresh runs under a per-workspace lock. A 401 on refresh marks the connector disconnected.
- The token acts as the connecting person across all their projects. So the workspace keeps a repository allow-list enforced by our tools, and the form recommends a dedicated bot user. Second option: paste a project or group access token (repo-scoped, revocable; paid tier on gitlab.com).

### Isolation

- VCS credentials resolve per workspace on every target. The server-wide credential is used only when `CONNECTIONS_WORKSPACE` names one workspace; otherwise it is nobody's. This is decided per connector kind so Slack on Vercel is untouched.
- Personal connectors are never used. Guests of a shared chat never reach a VCS tool.
- Every write records an audit row (workspace, actor, tool, repo, branch, commit or PR link) **before** the call, completed after; if the row cannot be written the write does not happen.

### Permission model

- Read-only by default. "Allow changes" is a per-workspace switch, admin only, audited.
- Writes go only to branches named `agent/...` that the agent created. The default branch and any protected branch are refused in our code. No merge, no force-push, no delete, no settings.
- Each commit and each PR/MR pauses for a person through eve's `approval` gate; a workspace may relax commits to once per chat.

### Agent surface: native tools

One provider-neutral set: `vcs_list_repos`, `vcs_read_tree`, `vcs_read_file`, `vcs_search`, `vcs_list_changes`, `vcs_read_change`, `vcs_ci_status`; with the switch on, `vcs_create_branch`, `vcs_commit_files`, `vcs_open_change`, `vcs_comment`.

Why native, not MCP: the allow-list, write switch, branch rule, approval and audit must be enforced in our process; one tool set serves both providers; tokens are narrowed per call. GitLab's MCP server is beta. Whether GitHub's hosted MCP accepts installation tokens is disputed in its issue tracker. Meanwhile pin the existing connection to `/readonly` with `tools.allow`; retire it when native read ships.

### Sandbox

- Add `git` to the template bootstrap (the template is shared by all workspaces, so nothing workspace-specific goes in it).
- Clone uses eve credential brokering: per session, the workspace's short-lived read token is attached to requests for the provider host at the firewall. The token never enters the sandbox, its disk or the model's view.
- Self-hosted: keep the private-range deny list. A self-managed GitLab address that resolves into it is refused at connect time, in plain words. Server-side calls to a customer-supplied address go through `assertPublicUrl`.
- Version 1 writes go through `vcs_commit_files`. Push from the sandbox is version 2: a brokered write token cannot enforce the branch rule.

### Vercel and self-hosted

- Callback, setup and webhook addresses are per deployment domain, so one App per app; a domain change means updating them.
- Vercel: the web and API projects both need the App secrets. Self-hosted: needs a public HTTPS name.
- Webhooks in version 1: GitHub `installation` and `installation_repositories` only. GitLab has none.

## 4. Reading B: the app's own code in the customer's repository

One-way export, not Lovable-style two-way: two-way makes the customer's repository a fork of the mold, which the factory forbids. After each deploy, push `build/<app_id>` (secret-scanned) as one commit to a customer-owned repository. Vercel's Git integration stays disconnected. Version 2.

## 5. Factory side

- Intake, one question: "Should people be able to connect GitHub, GitLab, both or neither?"
- State (names only): `application.capabilities.vcs {github, gitlab, write_allowed}`; `infrastructure.vcs.github {slug, app_id_ref, private_key_ref, client_id_ref, client_secret_ref, webhook_secret_ref}`; `infrastructure.vcs.gitlab {base_url, application_id_ref, secret_ref}`; the names join `secrets_user`.
- `provision.py`: sets `ENABLE_VCS_GITHUB`/`ENABLE_VCS_GITLAB`, prints the addresses to register, refuses a deploy with a named secret missing, and gains `--register-github-app` (exchanges the pasted code, stores secrets hidden).
- Lane check (functional, skipped when off), against a stub provider: connect; forged `state` refused; workspace B cannot see A's connection; read works; write refused with the switch off and on a protected branch; audit row present.
- Runbook, as the operator sees it: "I need you to approve a GitHub App so customers get a Connect GitHub button. Two minutes. 1. Open `https://<app address>/setup/github-app`. 2. Click **Create GitHub App**. 3. On GitHub, click **Create GitHub App for <name>**. 4. Paste here the code the page shows. The code expires in an hour and is never stored." GitLab is asked separately afterwards, one field at a time.

## 6. Scope

**Version 1:** per-workspace isolation fix; Connect GitHub; Connect GitLab (gitlab.com and public self-managed); native read tools; write switch with branch + PR/MR, approval, audit; sandbox clone; factory fields, provisioning, lane, runbook.

**Version 2:** code export (B); sandbox push; webhook-triggered agent runs; GitHub Enterprise Server; private-network GitLab.

**Not in version 1:** merge, force-push, deletion, repository creation, settings, CI triggers, issue management, Bitbucket, per-user identity, two-way sync of app code.

## 7. Tickets

| # | Title | Where | Size | Depends | Test | Operator |
|---|---|---|---|---|---|---|
| 1 | VCS credentials per workspace on every target | upstream | S | - | provider tests, new recording | reconnect notice |
| 2 | Pin hosted GitHub MCP read-only with allow-list | upstream | S | - | unit | no |
| 3 | GitHub App connect, binding check, uninstall webhook | upstream | L | 1 | stub + one live install | register a test App |
| 4 | App registration page (manifest) | upstream | S | 3 | e2e against stub | no |
| 5 | GitLab OAuth connect, refresh lock, token option, self-managed address | upstream | L | 1 | stub + gitlab.com | register an application |
| 6 | Native read tools | upstream | M | 3, 5 | recorded API fixtures | no |
| 7 | Write switch, write tools, branch rule, approval, audit | upstream | L | 6 | stub; refusal cases | no |
| 8 | Sandbox git + brokered clone (spike microsandbox first) | upstream | M | 3, 5 | both backends; token absent from sandbox | no |
| 9 | State schema + intake question | factory | S | - | `factory.py validate` | no |
| 10 | `provision.py` flags, checks, `--register-github-app` | factory | M | 4, 9 | self-test, check mode | pastes one code |
| 11 | Functional lane check | factory | M | 7, 10 | the lane | no |
| 12 | Runbook and operator steps | factory | S | 10 | read-through | no |
| 13 | (v2) One-way code export | factory | M | 9 | scratch repo | customer repo access |

## 8. Decisions for the operator

1. Workspace Connect buttons first, or exporting each app's code first? **Buttons first.**
2. May the agent change code in version 1? **Yes, behind a per-workspace switch, always as a branch plus a pull or merge request a person approves.**
3. One GitHub App per minted app, or one shared by all? **One per app.**
4. What name do customers see on GitHub's permission screen? **The app's brand name.**
5. GitLab: gitlab.com only, or customers' own servers too? **Both, public addresses only.**
6. Existing Vercel apps lose the shared GitHub credential and must reconnect. Acceptable? **Yes.**
7. May customers receive the full source, mold included? **Decide the licence before ticket 13.**

## 9. Risks

- A repository file can instruct the agent (prompt injection); with write on, damage is capped by the branch rule, approval and no merge.
- GitLab tokens are user-wide; our allow-list is the only fence unless a bot user or project token is used.
- Refresh-token races can disconnect a GitLab workspace.
- Brokering on microsandbox together with the deny list is unproven.
- One App per app means operator work per mint, and again on a domain change.
- Ticket 1 changes a default held by a recorded test.
- Not fetched today, stated from memory: GitHub and GitLab token lifetimes, the manifest flow, GitLab tier limits (https://docs.github.com/en/rest/apps/apps, https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest, https://docs.gitlab.com/api/oauth2/, https://docs.gitlab.com/user/model_context_protocol/mcp_server/, https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
