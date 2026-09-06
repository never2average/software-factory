# claudecode_web_replica clone report — 2026-09-06

Clone of live `fde-agent` (org `org-onfinance-ai`) into stamped app `claudecode_web_replica` on Vercel project `claudecode-web` (team `f20170061g-3183s-projects`). Overall verdict: **fail** — regression diff exited 1 and the blob copy is content-corrupt (see Verification and Gaps).

## Preflight

- live (ok, exit 0): plan printed for `claudecode_web_replica` org=org-onfinance-ai project=claudecode-web live=fde-agent scope=fresh; steps extract/snapshot/configure/regress listed. Live blob store reachable through `fde-agent-api`. `blobls dataroom/` counts: Customers 224, Implementation 1, People 31, Platform 8, README.md 1, Solutions 2, Uploads 7, _versions 2, orgs 40.
- state (ok, exit 0): `factory.py validate: ok`. State dir `/root/software-factory/state/application/claudecode_web_replica/` (answers.json, application.json, datainfra.json, datastores.json, infrastructure.json). `application.json.clone_of` = live_deployment ref fde-agent, snapshot_date 2026-09-06, extracted_at 2026-09-06T11:50:40+00:00, live_counts orgs 1 / org_members 5 / people_roster 23 / workflows 13 / workflow_definitions 1 / customers 66. Workspace org_id `org-onfinance-ai`, blob_prefix `orgs/org-onfinance-ai`, google_hosted_domain `onfinance.in`. `datastores.json postgres.scope` = fresh. WARNING: `infrastructure.json.vercel.workflow_url/api_url/production_url` are the literal string `"}"` (templating bug; real URLs needed after deploy). Live projects and mold codebase untouched; no secret values printed.
- mold (ok, exit 0): node v24.20.0; node_modules present; `npx eve --version` -> 0.25.1; vercel.json, vercel.api.json, vercel.eve.json present in `/root/software-factory/molds/mold_v1/codebase`.

## Deploy

- attempts: 0 recorded in this run (deploy was not exercised; the three infrastructure URLs remain the `"}"` placeholder).
- fixes applied: []

## Data

ok, exit 0. `pg_dump` of live (schema public, no owners/privileges) -> 233 KB. Live blob store reachable through `fde-agent-api`. `pg_restore` into claudecode-web (`--clean --if-exists`) -> restored. Copied 664 blobs under prefix `""` (whole store). `datastores.json` updated (blob.snapshot source live_fde_agent, ref fde-agent, taken_at 2026-09-06T12:12:30+00:00).

## Configure

ok, exit 0. Applied: orgs=1, org_members=5, platform_admins=1, people_roster=23, agent_profiles=1, agent_configs=0, workflow_definitions=1, workflows=0.

## Verification

Regression: `clone.py regress` exit 1; report `molds/mold_v1/testing/context/reports/claudecode_web_replica-regression-2026-09-06.md` (run_at 2026-09-06T12:15:18+00:00, header "fail"); `application.json.clone_of.regression.status` = fail.

| dimension | status | evidence | refutations |
|---|---|---|---|
| tables | fail | Regression report "Tables (row counts)": 56 tables, 45 ok, 9 volatile, 2 DIFF — `agent_profiles` clone 1 / live 0 and `platform_admins` clone 1 / live 0 (clone-side extras from configure). All other non-volatile tables match (customers 72/72, workflows 26/26, workflow_run_journal 43/43, automation_audit 79/79). | none |
| surface-rows | fail | "Surface rows": 12 of 16 tables ok; 4 DIFF: `orgs` changed `org-onfinance-ai:branding`; `platform_admins` only_clone `priyesh@onfinance.in`; `people_roster` 10 rows changed on `:escalations` (ajinkya.mawal, avantika.sharma, advait.mandawade, anuj.srivastava, mannish.pimpalkar, nishant.kushwaha, navya.sree.n, paartha.nimbalkar, prathmesh.shukla, priyesh); `agent_profiles` only_clone `org-onfinance-ai/`. 13 non-empty diff entries vs pass criterion 0. All diffs are configure-step data live does not carry. | none |
| blob | fail | Report says "prefix : same", but that is a per-top-level-folder count comparison (surface.mjs `blobTree`/`diff` line 167): clone {artifacts 348, dataroom 316} == live {artifacts 348, dataroom 316}; path sets identical (664/664). Initial verdict treated the missing numbers as cosmetic. | REFUTED (x2): every one of the 664 clone blobs is exactly 10 bytes (clone total 6,640 B vs live 7,943,754 B; size mismatch 664/664; e.g. `artifacts/Customers.Master-...xlsx` 6,475 B live vs 10 B clone). Root cause: `.claude/scripts/lib/surface.mjs` line 174 `blobcopy` does `fetch(b.url)` with no auth against a private store; the CDN answers 403 with the 10-byte body "Forbidden\n", which was `put` under the correct pathname and content-type (mold `lib/blob-read.ts` documents that private plain urls are never fetchable). Count-only diff cannot detect this. Secondary: fde-agent's production `BLOB_READ_WRITE_TOKEN` is a `sensitive` env var that `vercel env pull` cannot return (the 11-char value is the placeholder), which is why the live token fell through to `fde-agent-api`. Probes were read-only; tokens never printed. |

## Gaps

- Deploy not exercised; `infrastructure.json.vercel.{workflow_url,api_url,production_url}` still `"}"`. Next: fix the templating source, run `provision.py` for claudecode_web_replica, record real URLs.
- tables/surface-rows DIFF from configure-step extras (platform_admins, agent_profiles, orgs.branding, people_roster escalations). Next: either exclude configure-applied rows from the regress comparison or skip configure for scope=fresh clones and re-run `clone.py regress`.
- Blob copy is 664 x "Forbidden\n" stubs. Next: change `surface.mjs blobcopy` to fetch with `authorization: Bearer <live token>` (or presigned GET), abort on non-2xx, re-run `clone.py snapshot --apply`.
- Blob regression check compares folder counts only. Next: make `blobTree`/`diff` compare per-path sizes (at minimum byte totals) so stub copies fail.
- Live token discovery relies on `fde-agent-api` because fde-agent's token is `sensitive`. Next: document this in `clone/SKILL.md` or read the token via the Vercel API with decrypt where permitted.
