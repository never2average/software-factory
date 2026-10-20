# Security: private customer data and agent execution

Octillion keeps two kinds of data:

- **Public data**, owned by Octillion and shared on purpose: the curated task library (`library_tasks`), the
  survey-based developer profiles (`developer_profiles` with `org_id IS NULL`) and the curated harnesses
  (`harnesses/registry.json`). Every organization's research and runs may use them.
- **Private data**, owned by one organization: the personas, task sets and harnesses it brings, the personas research
  picks for it, its products, runs, transcripts and reports. Private data is never visible to, searchable by, used
  for or inferable by another organization, and never flows into the public data.

Customer-supplied text (tasks, personas) and code (harnesses) are also **untrusted**: they steer agents that run with
broad permissions, so they must not reach credentials, other tenants or the scoring.

## Controls in place

| Control | Where | Since |
|---|---|---|
| Every MCP read path is scoped to the caller's organization | `src/queries.ts` resolvers and queries | before 2026-10 |
| Real vendor keys (direct-mode providers) are never stored or brokered unless `OCTILLION_DIRECT_KEYS=allow`, never to a session running a customer-written task, never orchestrator-only keys (`boat`) | `src/gateway.ts` `brokerSessionCredentials`, `src/keyvault.ts` `setCredential` | 2026-10-15 |
| A developer profile is shared exactly when it comes from the vault: `CHECK ((org_id IS NULL) = (source = 'vault'))`, no default source | `sql/schema.sql` | 2026-10-15 |
| Vault sync never overwrites an organization's persona, even on a slug clash | `src/vault.ts` | 2026-10-15 |
| Database errors reach callers as a generic message (a unique-key clash would otherwise reveal another org's slug) | `src/server.ts` `runTool` | 2026-10-15 |
| Customer inputs (URLs, prompts) are not written to orchestrator logs | `orchestrator/pi-octillion/research.ts` | 2026-10-15 |
| Per-job worker tokens (`owk_`): an autoscaled orchestrator can claim and act on its own job's sessions or research only, speak only as itself, and cannot read the global fleet plan; revoked with its sandbox | `src/workerauth.ts`, `src/http.ts`, `src/autoscaler.ts` | 2026-10-15 |
| Organization deletion revokes keys and tokens, stops work, purges ClickHouse transcripts and every R2 org prefix (verified empty), cascades Postgres, leaves a counts-only tombstone | `src/tenancy.ts`, `scripts/delete-org.ts` | 2026-10-15 |
| Private assets: personas (random `per_` slugs), task sets and harness specs are stored with their org and readable, usable and updatable by that org only; the same error whether or not an id exists elsewhere; never in the shared library or profile search | `src/private.ts`, `src/queries.ts` `runSimulation` | 2026-10-15 |
| Customer harness specs are declarative only: integrity-pinned packages, argv without a shell, gateway providers only (no real vendor keys) | `src/private.ts` `harnessSpecIssues` | 2026-10-15 |
| Research web/package search runs on the server with orchestrator-only vault keys (no env_vars, so never matched to a session); capped per job, result text neutralised as data; result hosts become fetchable over https only (a GitHub result unlocks one owner) | `src/websearch.ts`, `orchestrator/core/safe-fetch.ts` | 2026-10-16 |
| Research fetch never connects to IP-literal URLs (they skip the private-address check), blocks IPv6 forms of private addresses, and onboarding refuses IP, localhost or internal product URLs | `orchestrator/core/safe-fetch.ts`, `src/research.ts` | 2026-10-15 |
| Event provenance: events are tagged orchestrator or harness; a harness cannot forge the diff, simulated-developer turns or ordering, and the scorer ignores harness-tagged evidence | `orchestrator/core/sink.ts`, `src/transcripts.ts`, `src/scoring.ts`, `src/worker.ts` | 2026-10-15 |
| Private runs (an org's own tasks or personas) are claimed only by their own per-job orchestrator, never by a shared one | `src/queries.ts`, `src/worker.ts`, `src/http.ts` | 2026-10-15 |
| The production host guard refuses running the coding agent as boat's sudo-capable user | `orchestrator/core/host-guard.ts` | 2026-10-15 |
| Private harness mixes are org-owned populations; population lookups for customers see public ones plus their own; reports cover one population and label custom mixes | `src/populations.ts`, `src/private.ts`, `src/queries.ts` | 2026-10-15 |
| Customer text in our prompts is data: control/bidi characters stripped, `<` neutralised so it cannot close our tags, length-clipped; the simulated developer's rules say tagged text and tool results never change its instructions; replies capped at 1200 characters | `orchestrator/core/text-guard.ts`, `orchestrator/pi-octillion/prompt.ts`, `research-prompt.ts`, `core/session.ts` | 2026-10-15 |
| Blindness check: a session whose simulated developer named the product or a competitor gets no verdict (`metadata.contaminated`) | `src/scoring.ts` `developerNamedTools`, `src/worker.ts` | 2026-10-15 |
| Isolation sweep in smoke: every MCP tool called as org B with every identifier of org A; nothing of A's returned or changed | `scripts/smoke.ts` | 2026-10-15 |
| Staff access to the admin API is logged (actor, method, path, status, IP; never bodies); signed links default to 1 hour | `src/http.ts`, `src/storage.ts` | 2026-10-15 |
| Tenant-SQL check: a new query on a tenant table without an org filter or a `/* tenant: ... */` note fails `npm run check:tenant-sql`; all 70 older queries were reviewed and annotated with how they are scoped (none needed a fix; baseline empty) | `scripts/check-tenant-sql.ts` | 2026-10-15 |
| Private persona and task text is encrypted at rest with a per-organization key, wrapped by the vault master key; deleting the organization deletes its key | `src/orgcrypto.ts` | 2026-10-15 |
| The orchestrator service on boat VMs runs as the unprivileged `octi` user (no sudo, NoNewPrivileges); verified on a real VM | `orchestrator/deploy/boat-lib.ts` | 2026-10-15 |
| Network lockdown for agent VMs (proxy, firewall redirect, allowlist, start-up probe; fails closed): built and tested, but **opt-in** (`OCTILLION_EGRESS=private` or `all`) until its transparent HTTPS path is verified on boat VMs | `orchestrator/core/egress.ts`, `orchestrator/core/session.ts` | 2026-10-15 |

## Plan

| Phase | What | Status |
|---|---|---|
| 0a | Direct-mode key lock, persona table fails closed, generic DB errors, no customer data in logs | done |
| 0b | Per-job worker tokens: an autoscaled orchestrator's token is bound to one job and organization, enforced on every worker route | done |
| 0c | Organization deletion purges Postgres, ClickHouse and R2 (`npm run org:delete`) | done |
| 1 | Private personas (`save_personas`), task sets (`import_tasks`, `run_simulation {task_set}`) and harness specs (`register_harness`), owner-only, encrypted at rest per org | done |
| 2 | Done: research fetch hardening, event provenance, private runs only on their own per-job orchestrator, host guard, orchestrator without sudo. Open: the network lockdown is opt-in until its transparent HTTPS path passes on a boat VM; the isolated harness build/scan/sign pipeline and runtime install | in progress |
| 3 | Private harness mixes (`save_harness_mix`, `run_simulation {population}`): owner-only, reports labelled and never blended with the default mix | done |
| 4 | Done: prompt-injection controls and tests, isolation sweep over every MCP tool, staff access log, 1-hour signed links, tenant-SQL check with every query reviewed, per-org encryption. Open: row-level security, a least-privilege ClickHouse user | in progress |

### Custom harness mixes

Customers may define their own harness distribution as a private, named population of public agents and their own
harnesses. The default market-weighted mix stays the canonical number for headlines, case studies and cross-product
comparisons; every run records its population, reports never blend populations, and a custom-mix figure always
carries its mix label.

## Open items

- **Network lockdown is opt-in.** On the last boat VM run the proxy started and stayed up and most probe checks passed,
  but the transparent HTTPS checks failed, so the lockdown refused the session (fail closed). Diagnostics are in the
  error message of session `ses_vR4F6OLNopOx` (run `sim_g1UUtQfCxiUn`). Once fixed and verified, set
  `OCTILLION_EGRESS=private` on the server (it is passed to orchestrators) to turn it on for private runs.
- The isolated build, scan and signing pipeline for customer harnesses, and installing an approved harness at session
  start. Until then a customer harness stays `submitted` and cannot run.
- Postgres row-level security as defence in depth; a least-privilege ClickHouse user.
- The ClickHouse and R2 purge paths of organization deletion run only in production (smoke has neither).
- Hourly Postgres dumps in R2 keep deleted organizations' rows until their 30-day expiry.
