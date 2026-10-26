# Security: private customer data and agent execution

The app keeps two kinds of data:

- **Public data**, owned by the app and shared on purpose: the curated task library (`library_tasks`), the
  survey-based shared agent profiles (`developer_profiles` with `org_id IS NULL`) and the curated harnesses
  (`harnesses/registry.json`). Every organization's research and runs may use them.
- **Private data**, owned by one organization: the agent profiles, task sets and harnesses it brings, the agent profiles research
  picks for it, its products, runs, transcripts and reports. Private data is never visible to, searchable by, used
  for or inferable by another organization, and never flows into the public data.

Customer-supplied text (tasks, agent profiles) and code (harnesses) are also **untrusted**: they steer agents that run with
broad permissions, so they must not reach credentials, other tenants or the scoring.

## Controls in place

| Control | Where | Since |
|---|---|---|
| Every MCP read path is scoped to the caller's organization | `src/queries.ts` resolvers and queries | before 2026-10 |
| Real vendor keys (direct-mode providers) are never stored or brokered unless `APP_DIRECT_KEYS=allow`, never to a session running a customer-written task, never orchestrator-only keys (`boat`) | `src/gateway.ts` `brokerSessionCredentials`, `src/keyvault.ts` `setCredential` | 2026-10-15 |
| A shared agent profile is shared exactly when it comes from the vault: `CHECK ((org_id IS NULL) = (source = 'vault'))`, no default source | the host pack's `migrations/0001_tables.sql` (`sql/migrations/0001_baseline.sql` before mold_v0-049) | 2026-10-15 |
| Vault sync never overwrites an organization's agent profile, even on a slug clash | `src/vault.ts` | 2026-10-15 |
| Database errors reach callers as a generic message (a unique-key clash would otherwise reveal another org's slug) | `src/server.ts` `runTool` | 2026-10-15 |
| Customer inputs (URLs, prompts) are not written to orchestrator logs | `orchestrator/packs/<id>/research.ts` | 2026-10-15 |
| Per-job worker tokens (`owk_`): an autoscaled orchestrator can claim and act on its own job's sessions or research only, speak only as itself, and cannot read the global fleet plan; revoked with its sandbox | `src/workerauth.ts`, `src/http.ts`, `src/autoscaler.ts` | 2026-10-15 |
| Organization deletion revokes keys and tokens, stops work, purges ClickHouse transcripts and every R2 org prefix (verified empty), cascades Postgres, leaves a counts-only tombstone | `src/tenancy.ts`, `scripts/delete-org.ts` | 2026-10-15 |
| Private assets: agent profiles (random `per_` slugs), task sets and harness specs are stored with their org and readable, usable and updatable by that org only; the same error whether or not an id exists elsewhere; never in the shared library or profile search | `src/private.ts`, `src/queries.ts` `runSimulation` | 2026-10-15 |
| Customer harness specs are declarative only: integrity-pinned packages, argv without a shell, gateway providers only (no real vendor keys) | `src/private.ts` `harnessSpecIssues` | 2026-10-15 |
| Research web/package search runs on the server with orchestrator-only vault keys (no env_vars, so never matched to a session); capped per job, result text neutralised as data; result hosts become fetchable over https only (a GitHub result unlocks one owner) | `src/websearch.ts`, `orchestrator/core/safe-fetch.ts` | 2026-10-16 |
| Research fetch never connects to IP-literal URLs (they skip the private-address check), blocks IPv6 forms of private addresses, and onboarding refuses IP, localhost or internal product URLs | `orchestrator/core/safe-fetch.ts`, `src/research.ts` | 2026-10-15 |
| Event provenance: events are tagged orchestrator or harness; a harness cannot forge the diff, simulated-developer turns or ordering, and the scorer ignores harness-tagged evidence | `orchestrator/core/sink.ts`, `src/transcripts.ts`, `src/scoring.ts`, `src/worker.ts` | 2026-10-15 |
| Private runs (an org's own tasks or agent profiles) are claimed only by their own per-job orchestrator, never by a shared one | `src/queries.ts`, `src/worker.ts`, `src/http.ts` | 2026-10-15 |
| The production host guard refuses running the coding agent as boat's sudo-capable user | `orchestrator/core/host-guard.ts` | 2026-10-15 |
| Private harness mixes are org-owned populations; population lookups for customers see public ones plus their own; reports cover one population and label custom mixes | `src/populations.ts`, `src/private.ts`, `src/queries.ts` | 2026-10-15 |
| Customer text in our prompts is data: control/bidi characters stripped, `<` neutralised so it cannot close our tags, length-clipped; the simulated developer's rules say tagged text and tool results never change its instructions; replies capped at 1200 characters | `orchestrator/core/text-guard.ts`, `orchestrator/packs/<id>/prompt.ts`, `research-prompt.ts`, `core/session.ts` | 2026-10-15 |
| Blindness check: a session whose simulated developer named the product or another product it is compared with gets no verdict (`metadata.contaminated`) | `src/scoring.ts` `developerNamedTools`, `src/worker.ts` | 2026-10-15 |
| Isolation sweep in smoke: every MCP tool called as org B with every identifier of org A; nothing of A's returned or changed | `scripts/smoke.ts` | 2026-10-15 |
| No static admin token: `APP_ADMIN_TOKEN` is no longer accepted anywhere (admin API, admin MCP, cron). Scripts use admin tokens minted per purpose (`npm run admin:token`): stored as a hash, scoped to a platform role, expiring (90 days at most), revocable at once, logged as `token:<label>`; only a signed-in owner (not another token) mints one over the API. The cron takes only `CRON_SECRET` | `src/admin-tokens.ts`, `src/admin-auth.ts`, `src/admin-mcp.ts`, `src/http.ts` | 2026-10-20 |
| API keys never in URLs: connectors send `oct_` keys in a header (`Authorization: Bearer` or `X-API-Key`); issued setups, emails and scripts never put a key in a URL; legacy `/mcp/<key>` URLs are deprecated (`Deprecation` header, logged by key prefix) and refused with `APP_URL_KEYS=off` | `src/auth.ts`, `src/http.ts`, `src/connect-catalog.ts` | 2026-10-20 |
| Origin validated on every MCP endpoint (`/mcp`, `/mcp/<key>`, `/admin/mcp`, `/api/admin/mcp`), per the MCP spec's DNS-rebinding guidance: a request with an Origin that is not `PUBLIC_URL`'s, a `CLERK_MCP_AUDIENCE` origin or one listed in `APP_MCP_ALLOWED_ORIGINS` gets a 403 before auth; `null` is never allowed; requests without Origin (non-browser clients) are unaffected | `src/origin.ts`, `src/http.ts` | 2026-10-20 |
| OAuth access tokens: a JWT must come from the Clerk instance's issuer; a token that names an audience (RFC 8707) must name this resource (`/mcp`, or the admin MCP for the admin MCP), so tokens naming another resource are refused. Tokens naming none (what Clerk documents today) are accepted and logged until `APP_OAUTH_AUDIENCE=enforce`; until then a token for another resource that names no audience is not told apart | `src/clerk.ts` `verifyOAuthToken`, `src/auth.ts`, `src/admin-mcp.ts` | 2026-10-20 |
| Staff access to the admin API is logged (actor, method, path, status, IP; never bodies); signed links default to 1 hour | `src/http.ts`, `src/storage.ts` | 2026-10-15 |
| Postgres row-level security on every tenant table (each table with an `org_id`, and those reached through a tenant parent): MCP tool calls and customer-portal requests run their queries as this database's tenant role (`app_tenant_<hash of the database name>`, from `app_tenant_role()`; named so since `0024_neutral_database_names`, the old names kept as aliases a release from before it still uses, held by the catalog check to nothing of their own and probed) with their organization set (`app.org_id`), so the database itself returns and changes only that organization's rows (shared library rows read-only), fails closed with no organization set, and cannot reach the key vault, admin tokens, access requests or any table not explicitly granted; platform paths (worker API, admin, background jobs, vault and email reads via `asPlatform`) run as the app's role. It guards against a query that forgets its org filter, not against SQL injection (injected SQL runs on the app's login and could leave the role). Proven on every deploy: `npm run check:rls` (catalog + a live probe in a rolled-back transaction) in `deploy/rolling-deploy.sh`, the catalog check at every process start (tenant queries are refused while it fails), the live probe from the Vercel cron (`/healthz` `rls_probe`), and in smoke | `sql/migrations/0003_row_level_security.sql`, `src/tenant-scope.ts`, `src/db.ts`, `src/rls.ts`, `scripts/check-rls.ts` | 2026-10-20 |
| Tenant-SQL check: a new query on a tenant table without an org filter or a `/* tenant: ... */` note fails `npm run check:tenant-sql`; all 70 older queries were reviewed and annotated with how they are scoped (none needed a fix; baseline empty) | `scripts/check-tenant-sql.ts` | 2026-10-15 |
| The workspace store's file viewer (`/api/workspace-files`) serves a workspace's own snapshots only, to roles that may read every record area of the store's pack, opened per request with that workspace's key (refused while the vault is locked); it never lists or serves hidden paths, credential-looking files, paths the pack declares secret or strips, or a file holding one of the workspace's credential values; paths are plain relative paths the manifest names; text goes out as JSON, downloads as `application/octet-stream` attachments with `nosniff` and a sandboxing CSP. Retention deletes per workspace and store, objects only under that store's prefix | `src/workspace-files.ts`, `src/workspace-store-policy.ts`, `src/workspace-retention.ts`, `scripts/workspace-files-test.ts` | 2026-10-22 |
| Private agent profile and task text is encrypted at rest with a per-organization key, wrapped by the vault master key; deleting the organization deletes its key | `src/orgcrypto.ts` | 2026-10-15 |
| The orchestrator service on boat VMs runs as the unprivileged `appsvc` user (no sudo, NoNewPrivileges; its name until mold_v0-156 was the first product's short one); verified on a real VM | `orchestrator/deploy/boat-lib.ts` | 2026-10-15 |
| Network lockdown for agent VMs (proxy, firewall redirect, allowlist, start-up probe; fails closed): built and tested, but **opt-in** (`APP_EGRESS=private` or `all`) until its transparent HTTPS path is verified on boat VMs | `orchestrator/core/egress.ts`, `orchestrator/core/session.ts` | 2026-10-15 |

## Plan

| Phase | What | Status |
|---|---|---|
| 0a | Direct-mode key lock, agent profile table fails closed, generic DB errors, no customer data in logs | done |
| 0b | Per-job worker tokens: an autoscaled orchestrator's token is bound to one job and organization, enforced on every worker route | done |
| 0c | Organization deletion purges Postgres, ClickHouse and R2 (`npm run org:delete`) | done |
| 1 | Private agent profiles (`save_personas`), task sets (`import_tasks`, `run_simulation {task_set}`) and harness specs (`register_harness`), owner-only, encrypted at rest per org | done |
| 2 | Done: research fetch hardening, event provenance, private runs only on their own per-job orchestrator, host guard, orchestrator without sudo. Open: the network lockdown is opt-in until its transparent HTTPS path passes on a boat VM; the isolated harness build/scan/sign pipeline and runtime install | in progress |
| 3 | Private harness mixes (`save_harness_mix`, `run_simulation {population}`): owner-only, reports labelled and never blended with the default mix | done |
| 4 | Done: prompt-injection controls and tests, isolation sweep over every MCP tool, staff access log, 1-hour signed links, tenant-SQL check with every query reviewed, per-org encryption, Postgres row-level security proven on every deploy. Open: a least-privilege ClickHouse user | in progress |

### Custom harness mixes

Customers may define their own harness distribution as a private, named population of public agents and their own
harnesses. The default market-weighted mix stays the canonical number for headlines, case studies and cross-product
comparisons; every run records its population, reports never blend populations, and a custom-mix figure always
carries its mix label.

## Open items

- **Network lockdown is opt-in.** On the last boat VM run the proxy started and stayed up and most probe checks passed,
  but the transparent HTTPS checks failed, so the lockdown refused the session (fail closed). Diagnostics are in the
  error message of session `ses_vR4F6OLNopOx` (run `sim_g1UUtQfCxiUn`). Once fixed and verified, set
  `APP_EGRESS=private` on the server (it is passed to orchestrators) to turn it on for private runs.
- The isolated build, scan and signing pipeline for customer harnesses, and installing an approved harness at session
  start. Until then a customer harness stays `submitted` and cannot run.
- A least-privilege ClickHouse user. Row-level security covers MCP tool calls and the customer portal; the
  orchestrator worker API and per-job tokens are scoped in code (`src/workerauth.ts`), not yet by the database.
- The ClickHouse and R2 purge paths of organization deletion run only in production (smoke has neither).
- Hourly Postgres dumps in R2 keep deleted organizations' rows until their 30-day expiry.
