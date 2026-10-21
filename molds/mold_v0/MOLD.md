# mold_v0

**Status:** work in progress. Started as a verbatim snapshot of the operator's existing MCP product, by the operator's decision (2026-10-20): *clone first, generalise after*. **Authored in this repository since the fork point below** (operator decision D1, 2026-10-20; mold_v0-040).

**Source: in-tree.** `molds/mold_v0/codebase` is edited here, by pull request to this repository like any other file. The fork point is factory commit `e8d836532cb7` (the last refresh, which took in the product's hardening, mold_v0-031), a snapshot of the product at `7399bd4c3611` (snapshot 2026-10-21). Both are recorded in [mold.json](mold.json) (`source`: `in_tree`, `since`, `forked_from`) and in `state/factory.json` (`molds[mold_v0].source.in_tree`, `in_tree_since`). Nothing is fetched from the product's repository again: `mold.py refresh mold_v0` refuses, `mold.py fetch mold_v0` writes nothing, and `mold.py check mold_v0` reports "in-tree since e8d836532cb7", the last commit that changed the codebase and any uncommitted change under it. An app's `mold_commit` is the last commit of this repository that changed the codebase (the fork point reads as `7399bd4`, the same files), so `mint` shows a redeploy due after each merged change.

## Two recorded exceptions

**Edited in place (mold_v0-040).** AGENTS.md says a mold's codebase is never edited in place and base-code changes go to the mold's source by pull request. mold_v0 is the one exception: its source is this repository. A change to the shell is a pull request here that touches `molds/mold_v0/codebase`; the deploy gate then reads this repository's checks for the commit being deployed (below). mold_v1 keeps the rule unchanged: its snapshot is only ever written by `mold.py fetch|refresh` from its own source, and nothing in this exception reads or writes it.

**A product, not yet a general shell.** Molds are general-purpose: no product or customer words, apps declared through a profile and packs. mold_v0 starts as the opposite, a working product copied as it is, so the factory can reproduce it straight away (ticket mold_v0-029) and mint a second product from it (mold_v0-030). It becomes general step by step: [SCOPE.md](SCOPE.md) names each capability of the **agent-run shell**, where it lives in the snapshot today and the ticket that generalises it (mold_v0-038 to 050, with the surviving older tickets), and the product's own tools, pages, record areas and tables move into the pack `octillion`. Until then, an app minted from mold_v0 inherits the product's code.

## What is in it today

- A TypeScript server (Express, `src/http.ts`) with a stateless MCP endpoint (`/mcp`, tools in `src/server.ts`), per-organisation API keys (hashed), Clerk sign-in, client install guides, onboarding, usage analytics, billing and email.
- An agent-run engine: a job queue (`src/worker.ts`, `/api/worker`), an autoscaler that launches one sandboxed orchestrator per job (`src/autoscaler.ts`, `orchestrator/`), pinned coding-agent harnesses (`harnesses/registry.json`), an inference gateway with per-session tokens and cost metering (`src/gateway.ts`, `src/usage.ts`), a versioned key vault and per-organisation data keys (`src/keyvault.ts`, `src/orgcrypto.ts`), transcripts and an off-machine archive.
- A web console in `web/` (Next.js): `/admin` for platform staff, `/app` for an account's people.
- Postgres with versioned migrations (`sql/migrations/NNNN_*.sql`, `src/migrate.ts`, `npm run db:migrate`; proven by `npm run test:migrations`) and row-level security on every tenant table (`sql/migrations/0003_row_level_security.sql`, `src/rls.ts`; proven by `npm run check:rls`), plus optional analytics and archive stores.
- Two ways to run: its own server (Docker Compose with HTTPS) and Vercel.

## Hardening (ticket mold_v0-031, done)

API keys out of URLs, OAuth token audience checked, Origin validated on the MCP endpoint, no static admin token, database row-level security proven on every deploy, and versioned migrations: all in the codebase since the fork point. The factory's side of it is mold_v0-051 (intake, the deploy's RLS check, the lanes; below).

## Decisions

- Sign-in for apps from the generalised shell: Clerk at launch, the adapter the product already uses (operator decision, 2026-10-20, mold_v0-046); a built-in emailed code plus Google comes later, with Clerk then optional (mold_v0-004).
- The source has no licence constraints (a hackathon project).
- The operator's live copy moves to a factory-managed app through a new subdomain, two weeks side by side, then a public address switch only with the operator's yes (mold_v0-032).
- Generalisation (2026-10-20): mold_v0 becomes an **agent-run shell** (tenancy, an MCP front door, a run engine with sandboxed
  harness runs, an inference gateway with metering, vaults, storage, record areas, schedules, a console), with each product's own
  surface in a pack. The shell is authored **in this repository** (operator decision D1): after one last refresh that took in the
  product's hardening (mold_v0-031, factory commit `e8d836532cb7`), `molds/mold_v0/codebase` stopped being a snapshot and is edited
  here, a recorded exception to "never edit a mold in place" (mold_v0-040; see "Two recorded exceptions"). The product's own features become the pack `octillion`; the second app's is its own
  pack. Backlog: mold_v0-038 to 050.

## Pack and record-area contract

This is the seam the generalised shell exposes (mold_v0-038, record areas mold_v0-047). **The shell side is built
(mold_v0-038)**; the product's own tools, pages and tables are still in the shell until mold_v0-039 moves them into
its pack. The factory side is built too (mold_v0-024): `packs.py` applies a mold_v0 app's packs under the rules in
[mold.json](mold.json) `packs` (see "In the factory" below). What 038 wired, in `molds/mold_v0/codebase`:

- `scripts/gen-packs.mjs` (`npm run gen:packs`, `npm run check:packs`; the smoke test fails on a stale registry) reads
  every `packs/<id>/pack.json` and `profile.json` and writes `src/packs.generated.ts`, `src/pack-migrations.generated.ts`
  (the ordered pack migration directories), `src/profile.generated.ts`, `web/src/config/pack-nav.generated.ts` and
  `web/src/config/profile.generated.ts`. It refuses a pack whose SQL creates a table without row-level security or
  outside its `<id>_` names, writes grants, policies, roles, functions or DO blocks, or whose code imports any shell
  module but `src/pack-api.ts`, a database driver, or mentions `asPlatform`, `SET`/`RESET ROLE` or `set_config`
  (run programs under the pack's `runner` directory have their own rules: the runner boundary, mold_v0-054, below).
- `definePack` (`src/pack-api.ts`): **tools** register on the customer MCP server after the shell's (`src/packs.ts`),
  each call run for the calling workspace under row-level security with its account permission; **routes** mount at
  `/api/packs/<id>` (the portal's own session check, `edit` for changes, a CSRF header on cookie writes) and
  `/api/admin/packs/<id>` (inside the admin router: platform admin, `need(permission)` on every change, the access
  log); **migrations** run on `src/migrate.ts` after the shell's, recorded in `pack_schema_migrations`, each table
  secured by `shell_pack_tenant_table` (org_id NOT NULL, ON DELETE CASCADE, the workspace policy) or
  `shell_pack_private_table`, and `check:rls` checks every pack table's policy and probes it live; **pages** (in
  pack.json) appear in the `/app` or `/admin` sidebar and render through the shell's generic page from the pack's
  data route. **schedules** and profile **words** are declared and validated and listed by `packRegistry()`; the
  scheduler (035) wires them. **credentials** (034) and **onboarding** (011) are wired (below).
- **recordAreas** (mold_v0-047, built): a pack declares areas in `definePack` and writes no record code. Their rows
  live in two shell tables (`sql/migrations/0004_record_areas.sql`): `platform_records` (platform scope: the tenant
  role may only `SELECT` it, so customers cannot write it whatever the code does; staff write it at
  `/api/admin/records` with `library`, or a pack's admin route through `ctx.records`) and `workspace_records`
  (workspace scope: `org_id` under the `tenant_isolation` policy; an `asset` area's title and data are sealed with the
  workspace data key). `src/record-areas.ts` adds `list_records` and `get_record` to the customer MCP server when at
  least one area exists (none with zero packs, so the surface is unchanged); `src/record-routes.ts` serves
  `/api/records` (signed-in people of the workspace, read only) to the console's generic pages
  (`web/src/app/{app,admin}/records/[area]` and `[area]/[key]`); `gen-packs` loads each pack's definition once (through
  tsx) to write the areas and a Records sidebar group into `pack-nav.generated.ts`. Area names are unique in a build
  and links must name a declared area (both refused at build and at start). Handlers get `ctx.records`: reads of every
  platform area and the workspace's own rows; writes only to the pack's own workspace areas (admin routes: its own
  platform areas). `check:rls` probes both tables; `npm run test:record-areas` proves it with two workspaces.
- **jobKinds** (mold_v0-041, built): the generic run engine, beside the product's session queue (which it does not
  change). `sql/migrations/0005_runs.sql` adds `runs`, `run_events` and `run_results` (each `org_id` under
  `tenant_isolation`; the tenant role may only read them) and a `run` gateway token kind (`gateway_tokens.run_id`,
  `gateway_usage.run_id`). A pack's handler queues a run of its own kind for the calling workspace with
  `ctx.runs.start(kind, {scope, targets})` (also `get`, `list`, `results`, `cancel`); the kind's limits are frozen into
  the run. `src/runs.ts`: claim (`FOR UPDATE SKIP LOCKED`, a lease token stored as a hash, a deadline = now + the kind's
  `token_lifetime_seconds`), heartbeat (renews the lease; answers cancel at a cancel or the deadline), events, complete
  (results checked: each names a check-role record, optionally an asset-role record of the run's own workspace and a
  source-role record), retry on an infrastructure failure while attempts remain, a sweep of lapsed leases, cancel
  (a running run's gateway tokens are revoked at once). Every step after the claim needs the current attempt's lease
  token. `src/run-routes.ts` serves it to runners at `/api/worker/runs` (the fleet token, then `X-Run-Lease`).
  `src/run-harness.ts` is the "workspace-harness" runner contract (claim, workspace checkout, the kind's `entry` with
  node in an environment built from nothing but `RUN_*` and the gateway's variables, heartbeat, the kind's `validator`,
  write-back, complete) with an in-process and an HTTP client. The gateway (`src/gateway.ts`) gives a run one token for
  the kind's providers that lives until the attempt's deadline, refuses it once the run is not running or its cost
  (summed from `gateway_usage.run_id` across attempts) reaches the kind's `budget_usd`, and the run's cost is that sum.
  Egress: the harness starts the sandboxes' own egress proxy (`orchestrator/core/egress.ts`) with the run's list (the
  kind's `egress` plus the gateway's public host; a listed host includes its subdomains, the proxy's rule) and gives the
  program its proxy settings: **enforced** for every connection through the proxy; **not enforced** for a program that
  ignores proxy settings, which only the sandbox VM's uid firewall stops, and runs are not yet placed in sandbox VMs.
  The harness runs a kind's programs only as a user kept for runs (`runAs`, `OCTILLION_RUN_UID`; a runner started as
  root), never the runner's own: the program cannot read the runner's environment through `/proc`, gets its own copy
  of the pack and a private scratch, and every process of that user is killed when the run ends (one run at a time per
  such user). It refuses to run a program as its own user unless told (`allowSameUser`, the offline tests). Starting a
  run applies the account's launch rules for a signed-in person (`src/limits.ts` `checkRun`) and a per-workspace cap
  on runs queued or running (`OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE`, 20). **Not wired yet:** no process runs runs in
  a deployed app (no runner is launched by the autoscaler; `drainRuns` is there for one); a run's gateway spend is
  limited by its kind's budget but is not yet counted in the account's month figures or spend pages (they read
  sessions).
- **The runner boundary** (mold_v0-054, built; the import check resolves each pack's real import graph with esbuild,
  the resolver tsx uses, so spacing, comments, re-exports, extensionless or dot files cannot hide an import; a pack may
  carry only `.ts`/`.mts`/`.js`/`.mjs` code and plain data files, no `node_modules`, no links): a pack's code is of two kinds, told apart by pack.json `runner` (a
  directory inside the pack). *Server code* (everything else: the entry, tools, routes, loaded into the server) keeps
  the strict rules above and may neither import a process API nor the runner's files. *Runner code* (under `runner`:
  a job kind's programs, run by the harness with node as the run's own user) may also import `node:child_process`,
  `node:fs`, `node:os`, streams and the other node built-ins a program needs, imports only its own runner files (never
  `src/pack-api.ts`, the pack's server code or any shell module, and no package), is `.js`/`.mjs` only, and is held to
  the same text bans (`asPlatform`, `SET`/`RESET ROLE`, `set_config`, the tenant setting, `require`/`createRequire`, a
  computed import, `eval`). The entry may not sit in the runner directory, and no pack may carry a symbolic link. The
  processes a program starts run as the run's user and die with the run (`npm run test:runs`, section 12); the import
  rules keep the runner's code reviewable, while what isolates it at run time is the run user and an environment built
  from nothing. The same holds for server code: the import rules are a lint, not a sandbox (server code still runs in
  the server's process and could read its environment), so "values never reach a pack's server code" holds for the
  shell's API, which gives a handler none, not against a hostile pack. `npm run test:packs` proves both boundaries (a program with `child_process` passes under `runner` and is
  refused outside it, and 19 ways across the boundary are refused).
  `npm run test:runs` proves the lifecycle offline with fixture kinds (`scripts/fixtures/runs/`).
- **The workspace store** (mold_v0-033, built): a job kind with `workspace: true` gets versioned snapshots of its
  workspace's files that outlive a run, one store per workspace and pack (`sql/migrations/0006_workspace_store.sql`,
  `src/workspace-store.ts`, `src/workspace-bundle.ts`). Its claim takes the store's lease (`workspace_leases`, renewed
  by the heartbeat): one writer per workspace store, a second run waits in the queue. The harness checks the latest
  snapshot out before the program runs (each file checked against the sha256 manifest), and writes the directory back
  only when the program and the validator exited 0: it is staged, and becomes the next version inside the run's
  completion as succeeded; any other end discards it. Objects live in the product's storage (`src/storage.ts`
  `objectStore()`: the R2 bucket, or `OCTILLION_STORAGE_DIR` on one machine and in tests) under
  `workspaces/org-<id>/<store>/`, sealed with the workspace's data key (`src/orgcrypto.ts` `sealBytes`, refused while
  the vault is locked) and bound by AES-GCM additional data to their workspace, store, row and manifest. A runner names
  a run and its lease token, never a workspace (`GET`/`PUT /api/worker/runs/:id/workspace`); packing never follows a
  link; unpacking writes only inside an empty directory. Deleting a workspace removes its snapshots. **Not wired yet:**
  no customer-facing read of a snapshot's files (an evidence viewer), and no retention of old versions (all are kept).
  `npm run test:workspace-store` proves it with two workspaces.
- **The workspace credential vault** (mold_v0-034, built; merges the old 009): a pack declares credential fields
  (`definePack({ credentials })`: a label, help, `bound_to` the workspace, an `asset` of one of its asset areas (`area`)
  or an asset's `environment` (optionally from a list), delivered as an environment variable or a file). A workspace's
  owners set the values in the console (`/app/credentials`, `src/credential-routes.ts` at `/api/credentials`, mounted
  only when a field exists; an asset binding must name an asset record of their own workspace); no answer carries a
  value, owners see the last 4 characters and everyone else only which values are set; a file field takes a multi-line
  value (a key). Values live in `workspace_credentials` (`sql/migrations/0007_workspace_credentials.sql`),
  sealed with the workspace data key (`sealBytes`, refused while the vault is locked) and bound by additional data to
  their workspace, pack, field, asset and environment; the tenant role has no grant on the table (a pack's server code
  never sees a value; `check:rls` probes it). A job kind names the fields its runs receive (`credentials: [...]`, none
  by default); the runner fetches them with the run's lease (`GET /api/worker/runs/:id/credentials`), looked up with the
  run row's own workspace and its `targets.asset` / `targets.environment`, and gives the entry program each value as
  its declared environment variable or as a file (0400, the run user's) in a private directory on tmpfs
  (`RUN_CREDENTIALS_DIR`, `/dev/shm`; with no tmpfs the run fails rather than write one to disk), removed when the
  program ends; the validator gets none. Runs share their user, so before and after each run every file that user owns
  in `/tmp`, `/var/tmp` and `/dev/shm` is removed (a copy or hard link of a value never waits for the next run). A target
  that names an asset's area gets a value only for the field's own area. Everything a run writes (stdout lines, the
  stderr tail, results as text and as values, errors, event types) is redacted of the values (as is, JSON-escaped,
  URL-encoded, hex, base64 at any byte offset, numbers, each line of a multi-line value, longest first across values;
  `src/credential-redact.ts`) by the harness and again by the engine before it is stored (the engine refuses to store
  while it cannot open the values); a workspace holding a value in a file or a file name is not written back. `npm run test:credentials` proves it with two workspaces: same asset
  key, concurrent runs, 0 cross-workspace injections; a canary grep of every table, the database's files, the object
  store, the MCP and HTTP answers and the process's logs finds 0. **Not covered:** a program that sends a value out
  through an allowed host or the model gateway (egress is the run's allowlist; the gateway does not store prompts), or
  writes part of a value; values replaced while a run is going are redacted only by the harness (which holds what it
  delivered); no rotation reminder or expiry.
- **The onboarding checklist from packs** (mold_v0-011, built): a pack declares steps (`definePack({ onboarding })`: an
  id, a label, help, and `done_when`, one of `workspace`, `connected`, `first_call`, `tool:<name>`,
  `credential:<name>`, `record:<area>`, `run:<kind>`; a credential, a workspace-scope area or a kind must be the pack's
  own, a tool any tool of the build, all checked when the pack loads). `src/onboarding.ts` reads each condition for the
  calling workspace only (its id from the session; every query names it and runs under row-level security for it; the
  credential vault, which tenant work cannot reach, is read with that id), with the time it first held, and serves the
  list at `/api/onboarding` (signed-in people of the workspace, read only; mounted only when a step exists). The
  console's Setup page shows it above the shell's own timeline when the build has a step (`packOnboardingSteps` in
  `pack-nav.generated.ts`); with zero packs it asks nothing and the page is unchanged. `npm run test:onboarding` proves
  it with two workspaces (everything B does ticks none of A's steps). **Not covered:** the end-to-end browser walk of
  the old ticket's acceptance (a new person from the landing page to a first call): there is no browser harness in the
  shell yet, and the product's own setup steps (`src/app.ts`) stay as they are until mold_v0-039 moves them into the
  `octillion` pack.
- **Declarative packs** (mold_v0-057, built): a pack may be its `pack.json` alone, with no entry and no TypeScript.
  `src/pack-manifest.ts` is the one definition of pack.json (zod; its JSON Schema is written to `packs/pack.schema.json`
  by `npm run gen:pack-schema`, for editors and intake, and `npm run test:declarative-packs` holds it current and runs a
  JSON Schema validator over it). Beside the manifest keys it takes `record_areas`, `job_kinds`, `credentials`,
  `schedules`, `onboarding`, `metrics`, `repositories` and `run_results`; `gen-packs` validates every pack.json with it
  (each refusal names its path: `packs/<id>/pack.json: record_areas[2].lifecycle.initial: …`) and compiles the
  declarations into the `definePack` fields they stand for, carried in `src/packs.generated.ts` as `declared` (no import
  for a pack with no entry). `src/packs.ts` merges them with the code entry's definition when there is one
  (`mergePack`: lists joined, a name both declare is refused), so code stays an escape hatch that extends a declarative
  pack. Without `entry`, `index.ts` is still the entry when the pack has one. What a declaration holds:
  - **Typed fields** (shared with `definePack`): `text` (`max_length`), `number` (`min`, `max`), `date`, `boolean`,
    `json`, `enum` (`options`: values or `{value, label}`; values are plain words, never markup or quotes), `person` (a
    sign-in id), `reference` (`to`: an area; the key must exist **as the writer sees it**, so a workspace never refers to
    another workspace's record, and a shared area may refer only to shared areas), `file` (`{path, name?, sha256?,
    size?}`, a path inside the workspace's files), the 047 `link`; `multiple` for enum, person, reference and file;
    `required`. Checked on every write by the shell's record store (`src/record-areas.ts` `checkRecord`), every problem in
    one 400. Stored in the 047 tables (`workspace_records`, `platform_records`): no per-pack SQL.
  - **A lifecycle** (workspace areas): `field` (a single enum field: its options are the states), `initial`,
    `transitions` (`from`: states or `"*"`, `to`, `label`, `roles`). A new record starts in `initial`; a write never
    changes the state (it is carried over; a different one is a 409); `records.move(area, key, to)` moves it only along a
    declared transition and its roles (409 naming the moves there are; 403 for the wrong role). Moves and writes on a
    lifecycle area change a row only from what they read (compare-and-set on the row's version), so a write racing a move
    never restores the old state. A row with no state (written before its area had a lifecycle) is in `initial`. The
    other fields stay editable in every state by whoever may `update`: per-state edit locks are an extension point.
  - **Permissions** per action (`read`, `create`, `update`, `move`, `delete`) as lists of account roles. Defaults: read
    every role; create, update, move the roles with the platform's `edit` (member, billing, owner); delete as update, or
    the owner alone on an area with a lifecycle (else deleting and re-adding a record would put it back in its initial
    state past the transitions' roles). Every write, move and delete also needs `read` (its answer and refusals show
    the stored record). A declaration only narrows the platform: a write naming `viewer` is refused at build, a shared area declares `read`
    only, and at run time a role must hold both. Enforced for the person a call is made for, on `ctx.records`
    (tools and workspace routes pass the caller's role), `list_records`/`get_record` and `/api/records` (a link into an
    area the caller may not read is left out). An account API key has no role limits, as for every shell tool.
  - **Only through the store.** Pack code (server and runner) may not name `workspace_records` or `platform_records`
    (gen-packs refuses it, beside `asPlatform` and the rest), so the checks above are not bypassed by a raw `ctx.db`
    query in a reviewed pack; as for every pack rule, this is a lint, not a sandbox (MOLD.md "The runner boundary").
    A pack with no entry may not carry server code (it would never load); text a database cannot store (NUL, a broken
    surrogate pair) is a 400 naming the field.
  - **Schema drift**: a row read under a changed declaration keeps its stored values, drops fields no longer declared
    from what is shown, and names every field that no longer fits in `drift`; the next write must fit.
  - **Job kinds**: `runner: "workspace-harness"` (a program of the pack, as before) or `"agent-workspace"` (mold_v0-061:
    declared with its limits, `args`, `concurrency` and `credentials`, listed as `agentJobKinds`, not taken by the run
    engine until 061). `args` are typed like fields and checked when a pack's code starts a run (`declaredRuns`, outside
    the engine); `concurrency` is declared and validated, the engine's per-workspace cap still holds.
  - **Credentials, schedules, onboarding** as in `definePack`; **metrics** (mold_v0-063: a name, a label, `over` an area
    or `run_results`, the rest kept for 063); **repositories** (mold_v0-059: a `kind` and its settings; an area names one
    with `repository`, checked) and **run_results** (mold_v0-061: how a run's output becomes rows; `check` names areas,
    checked). Reserved, refused with the ticket that brings them: `tabs` (058), `mcp` (060), `charts` (063).
  - `npm run test:declarative-packs` proves it with `scripts/fixtures/packs/fixture_tracker` (a pack.json, no code) and
    two workspaces; `npm run test:packs` typechecks a build copy with it.
  - **Not covered yet:** no generic write door (REST/MCP create, update, move) for a pack with no code: that is the
    generic data API (059), built on the same store functions. A shared library and each workspace's state of it are two
    areas today (one platform, one workspace, the second's rows keyed by the first's keys and linked to them); a declared
    "library + per-workspace state" pairing is an extension point for 059 (one area name, two scopes).
- The profile (`profile.json` over a neutral default, `src/profile.ts`) names the MCP server, the email sender and
  the console title. The codebase's `profile.json` carries the product's names until 039; without it the shell is
  "Workspace".
- `npm run test:packs` proves it with a fixture pack (`scripts/fixtures/packs/fixture_notes`) in a build copy, and that
  with zero packs the MCP surface (`scripts/export-mcp-tools.ts --full`) is unchanged.

**In the shell.** A pack is a directory the shell discovers at build time. `gen-packs.mjs` (mold_v0-038) reads every
pack in the build copy and writes a generated registry the server and the console import; nothing in the shell names
a pack. A pack's definition is what its pack.json declares (mold_v0-057; the pack.json key in brackets below), extended
by its code entry's `definePack({...})` when it has one (tools and routes are code only):

| Field | What the pack declares | Where the shell puts it |
|---|---|---|
| `tools` | MCP tools: name, input and output schemas, annotations, a handler that receives the calling workspace first | the tool registry behind `/mcp` (today hand-written in `src/server.ts`) |
| `routes` | HTTP handlers | mounted at `/api/packs/<id>` (workspace-scoped, behind sign-in) and `/api/admin/packs/<id>` (platform staff, behind the admin roles), never at a shell path |
| `jobKinds` (`job_kinds`) | run kinds: the runner (`workspace-harness`), its `entry` and `validator` programs in the pack, the gateway providers, token lifetime, lease, attempts, budget, egress allowlist, whether it uses the workspace store | the run engine (mold_v0-041) |
| `recordAreas` (`record_areas`) | areas with a `role` (`source`, `check` or `asset`), a `scope` (`platform` or `workspace`), typed fields, list columns, links and references to other areas, a lifecycle and per-role permissions | a list page, a detail page and MCP list/get tools with no extra code (mold_v0-047); fields, states and permissions enforced on every write and move (mold_v0-057) |
| `credentials` (`credentials`) | fields a workspace must give: label, help, bound to the workspace, an asset or an environment, how a run receives it (environment name or tmpfs file) | the workspace credential vault (mold_v0-034, built): the console's Credentials page; a kind's `credentials` names what its runs receive; only names reach a run's definition |
| `schedules` (`schedules`) | default schedules per workspace (a run kind over a scope) | the scheduler (mold_v0-035), editable per workspace in the console |
| `onboarding` (`onboarding`) | checklist steps and the event that ticks each off | the `/app` setup checklist (mold_v0-011, built: `src/onboarding.ts`, `/api/onboarding`) |
| `migrations` | versioned SQL for the pack's own tables, prefixed with the pack id; every workspace-owned table carries the workspace id under row-level security that fails closed | applied after the shell's migrations (mold_v0-031), in pack order; the context lane checks every pack table |
| nav and profile words | console navigation entries, and words the pack shows instead of the shell's (a workspace shown as a "company", a run as an "audit") | the console sidebar (today `web/src/config/nav-config.ts`) and the profile |

Record-area roles: a `source` is where requirements come from (versioned, read-only to customers); a `check` is a unit
checked repeatedly and traced to a source (library at platform scope, its per-workspace state at workspace scope); an
`asset` is what is checked and holds the workspace's private data (workspace scope only, sealed with the workspace
data key). Platform-scope areas are read-only to customers; workspace-scope areas pass the cross-workspace test. A
run's results are rows of (run, workspace, check, asset, status, finding fingerprint, evidence reference).

A pack that wraps an upstream project (the second app's audit-agent pack, for one) pins it by commit in its manifest
and runs it at a process boundary inside the run's sandbox; it is never vendored into the pack or the shell, and never
patched locally (changes go upstream by pull request).

**In the factory.** A pack lives at `packs/<pack_id>/` (git-ignored): `pack.json` and a `files/` tree that mirrors the
codebase root and only adds files. An app names its packs in `application.json` (`"packs": ["octillion"]`), and
`packs.py apply <app>` copies them into `build/<app_id>/`, then runs the mold's generators there; deploys and lanes
use that build copy, never `molds/mold_v0/codebase`. The rules are this mold's own (mold_v0-024), in [mold.json](mold.json)
`packs` (a mold without that block, mold_v1, keeps the rules built into `packs.py`): a pack id is the shell's own
(`^[a-z][a-z0-9_]{1,30}$`, also its table prefix), a pack may add files only under `packs/{pack}/` with `{pack}` its own id
(its `pack.json`, entry, migrations and run programs; its console pages render through the shell's generic page and need
no files of their own) and must add `packs/{pack}/pack.json` (no hidden or `node_modules` folder, which `gen-packs.mjs` does not read, and no
link), the support test is `scripts/gen-packs.mjs`, the generator
`node scripts/gen-packs.mjs` and the check `node scripts/gen-packs.mjs --check` (`packs.py verify`). A pack file that would
replace a codebase file is refused, as for mold_v1, and a pack folder left in a build copy by an earlier apply for a pack
the app no longer names is pruned. `build_copy` in mold.json says what the copy leaves out (the server deploy's own
excludes) and which installed `node_modules` folders it links (never written).

**Brand.** [branding/rules.json](branding/rules.json): `branding.py <app> set` takes a name, a colour and a logo as for any
app; `prepare` writes the name and words into the copy's `profile.json` (name, console title, email sender, MCP server
name, and the descriptions from the brand's own tagline, else the shell's neutral words, never the product's; a name
with a character the profile cannot carry is refused at `set` and intake; the sender address is kept, a mail-domain
setting) and re-runs `gen-packs.mjs`, writes the favicon set to
`web/src/app` and `web/public` and points the web manifest at it, and sets the console theme's brand tokens (primary, its
foreground, ring) from the colour, its neutrals kept; `check` proves each. It rewrites no source code, so until
mold_v0-039 moves the product's pages into its pack, the landing page and some console text still carry the product's
own words.

**Deploy and lanes from the build copy.** An app with packs or a brand is deployed from `build/<app_id>/`, made afresh
from the codebase for every deploy before anything is created or contacted (`lib/single_service.py` `build_source`:
`branding.py prepare`, then `packs.py apply` and `verify`); a step that fails stops the deploy with nothing created, and
the app is not marked reverted. An app with neither deploys from the codebase, as before. The lanes of an app with packs
run in its unbranded lane copy `build/<app_id>.lane/` (`packs.py lane-copy`), as mold_v1's do.

**Two proofs.**

- **Zero packs is a neutral shell.** A build with `packs: []` signs in, has workspaces, keys, the console, the vaults
  and the run engine, passes the smoke test and the tenant-SQL check, and has none of the product's tools, pages or
  tables (mold_v0-038, 039, 049); the vocabulary check finds no product word in it (mold_v0-045).
- **`["octillion"]` reproduces today's product.** A build of the new shell plus `packs/octillion` has the same surface as
  the old pin: the same MCP tools with the same schemas (the list `scripts/export-mcp-tools.ts` writes), the same HTTP
  routes, the same console pages and navigation, and the same tables. The surface diff between the two must be empty,
  and the re-mint (mold_v0-029) must still pass smoke, `mcp:check` and the isolation sweep (mold_v0-039).

## How the factory runs it

mold_v0 is a **single-service mold**: [mold.json](mold.json) says so, and every factory script hands such an app to
`.claude/scripts/lib/single_service.py` before any mold_v1 path. A deploy never changes the codebase: what the factory needs
(the compose project's default name, the service it builds, its port, the env names it requires or accepts, the
health check, the row-level security check) is read from the codebase's own `deploy/docker-compose.prod.yml`,
`deploy/bootstrap.sh`, `Dockerfile` and `package.json` each time.

**Mint.** `mint.py new <app> --brief briefs/<app>.md` (the brief says `Mold: mold_v0`) runs the same ten stations as any
app. *workspaces* and *package* are "not needed", each with the reason in mold.json: organisations made in the product's
own console, no agent package. *packs* and *brand* read as for any app (mold_v0-024); intake takes `Packs:` and `Brand:`,
`Brand colour:`, `Logo:` and `Tagline:` lines from the brief. `code-request`, `code`
and `reuse-keys` refuse a mold_v0 app.

**Intake.** The same four state files and schemas. It asks only where the app runs, unless the brief says ("its own
server", or "Vercel"), and takes the domain from the brief (`Domain: app.example.com`). Fields only this shape uses:
`infrastructure.compose_remote` (target `compose_remote`), `postgres.exposure: "compose_network"` and
`blob.provider: "none"`. `postgres.rls` is `"fail_closed"` (mold_v0-051): the product puts every tenant table under
row-level security for a per-database tenant role, and a query with no organisation set sees no tenant rows. Intake
writes it from [mold.json](mold.json) `rls` only while the codebase's `package.json` has that check (`check:rls`);
without it, `"off"`. Tenant rows are also scoped in the queries themselves, which the tenant-SQL check guards.

**Row-level security on every deploy (mold_v0-051).** After the health checks, each deploy runs the product's own
`npm run check:rls` (its catalog check, then a live two-organisation probe inside a transaction that is always rolled
back) against the **deployed** database, and writes the verdict to `datastores.postgres.rls_verified`; a check that
fails or cannot run is a failed health check, so the deploy goes back to what served before.
`provision.py <app> --verify-rls` runs it again and records it. What each target honestly proves:

- *Its own server:* the check runs in a one-off container of the new release's image with the server's env file, as
  the product's own `deploy/rolling-deploy.sh` does: the same code, database and login the serving containers use.
  Recorded `running_app: "enforced"`.
- *Vercel:* nothing can run inside the function, so the check runs on the factory machine (from the same codebase the
  deploy just uploaded; it needs the codebase's dependencies installed) against the api
  project's production `DATABASE_URL`, read back and never shown, right after the deployment that reads it was built.
  It proves the database the function uses. The function's own probe (`/healthz` `rls_probe`, run by the product's cron
  at most hourly) is read and recorded as it said: `"ok"` is `enforced`, `"failed"` fails the deploy, and `"not run"`
  (a fresh deployment) is `unmeasured`, never `enforced`. `factory.py validate` accepts `unmeasured` for this mold only,
  because the database proof is there and the product refuses tenant queries in a process whose start-up catalog check
  fails (the product's own guarantee, which the factory reads in its code but does not observe).

**Its own server** (target `compose_remote`; a deploy that comes up but fails its health checks switches back to the
release that served before, by itself): `provision.py <app> --set-remote host=<address> domain=<name>`,
`--remote-key`, then `--deploy-remote` (see every step first with `--dry-run`). It reuses vm_remote's host probe, SSH,
DNS check, key pair, hidden prompt and env file, then:

1. checks on this machine that the snapshot has every file the image build copies, that every name the compose file
   requires is written from state or minted by the product's own `bootstrap.sh`, and that the compose project is
   `sf-<app id>`, never the compose file's own default name, which another copy of the product uses;
2. qualifies the server: Ubuntu 24.04, sudo, systemd, 4 GB, 2 CPUs, 20 GB free, no other web server, and the web
   ports free or held by this app's own project. It refuses a server where another stack already answers on 80/443;
3. installs Docker and its compose plugin if absent, ufw (SSH, 80, 443 only) and fail2ban;
4. copies the source into a new release directory beside the serving one;
5. writes `DOMAIN` and `PUBLIC_URL` from state into `/etc/software-factory/<app>/env` (root, mode 600), then mints every
   name still missing (the database password and the product's keys) with the product's own `bootstrap.sh`, on the
   server, in a private temp directory that sees names and never values. Optional keys (sign-in, billing, analytics)
   stay off until the operator sets one with `provision.py <app> --set-secret NAME`;
6. points `current` at the new release and runs `docker compose -p sf-<app> ... up -d --build --wait`; on failure it
   switches back to the release that served before and brings that up;
7. checks health: the app container healthy and not running as root, only Caddy publishing ports, and
   `https://<domain>/healthz` answering 200 `{"ok": true}` from outside. Then old releases are removed.

HTTPS comes from the stack's own Caddy (automatic certificate for `DOMAIN`), which is why the domain must point at the
server first. `--rollback-remote` goes back to the previous release by hand.

**Vercel** (target `vercel`): **two projects**, by the operator's decision of 2026-10-20 (mold_v0-029). Nothing is
typed by hand, and nothing in the snapshot changes:

- `<project>-api` is the API and MCP function, deployed from the product's own `vercel.json` (one function and its
  cron). `<project>` is the web console: `web/`, a server-rendered Next.js app behind a middleware, deployed as its own
  Next.js project from `web/` (its own `vercel.json` and committed `package-lock.json`). The console is pointed at the
  API through the one variable its `next.config.ts` reads for the API's address (`process.env.NAME ?? 'http://...'`),
  found there at plan time; its fallback rewrite then carries every other path (the landing page, `/mcp`, `/api`,
  `/healthz`) to the API, so people open one address. [mold.json](mold.json) declares the shape (`vercel.projects`).
- Both names pass the same refusals before anything reads or writes them: never one of the live projects, never a
  name another app holds (its base, `-api` or `-workflow`, or the names its state records). Both are created with
  `vercel project add <name> --scope <team>` and unhooked from git; the console's framework preset is set to Next.js.
  When neither exists yet and a name is taken in the team or on vercel.app, the free base provision.py chooses is
  used for both and recorded in `vercel.name_history`; intake already suffixes a default base whose either name
  another app holds, and says so.
- Only the api project gets the app's own Postgres, through provision.py's Neon provisioning (an empty free database
  adopted, or a new one from the Vercel Marketplace, each proven empty with the product's own `pg` client before the
  project is connected; `DATABASE_URL` is the one the integration writes, never written by the factory and never
  replaced), and only it gets the keys the product's `bootstrap.sh` mints and `CRON_SECRET`. Its `PUBLIC_URL` is its own
  address, so connector addresses point straight at the function.
- The console gets the API's address in its API-address variable and nothing else of the API's: never `DATABASE_URL`,
  never a minted key. The only other names it reads are its sign-in keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `CLERK_SECRET_KEY`, mold.json `operator_env`), set by the operator with `provision.py <app> --set-secret NAME`, which
  writes a name to every project that reads it (`CLERK_SECRET_KEY` to both, the publishable key to the console only).
  Both are required: the console's `src/proxy.ts` runs Clerk's middleware on `/admin` and `/app`, which cannot start
  without them, so the check (`provision.py <app>`) stops and asks for them (exit 3) rather than deploying a console that fails its health
  check. The built-in emailed-code sign-in comes with the generalised shell.
- Order: the API first (twice on a first deploy, so it reads its own address as `PUBLIC_URL`), its `/healthz` must
  answer 200 ok; then the API-address variable on the console, then the console. Health on the console: `/healthz`
  through the console answers 200 ok (so it reaches the API), and `/admin` and `/app` answer, read without following a
  redirect (a page, its sign-in redirect, or 401/403; never a 5xx or nothing).
- When anything after the first deploy fails (a health check, a build, an address that cannot be read), **both**
  projects go back to the production deployment that served before, where there was one, and the app is recorded as
  reverted with the reason and `vercel.rollback`. A later good deploy is promoted past that rollback on both.
- State: `vercel.project` (the base), `vercel.projects` (`api`, `web`), `vercel.api_url`, `vercel.production_url`
  (the console's: it is what people open, and it carries the API's paths too), `vercel.health` (`api`, `web`, and the
  console's `pages`), `vercel.release` (what served each project before the deploy). The lanes' MCP check targets the
  API: `--lane-key` reads `DATABASE_URL` from the api project and keeps a connector address for `vercel.api_url`.

`--deploy --dry-run` prints every step; `provision.py <app>` is the read-only check of both projects. The rehearsal in
`lib/single_service_selftest.py` runs the whole sequence through provision.py against `fixtures/release/fake.py`
(FACTORY_REHEARSAL): nothing real is contacted.

**The console on a server of its own** is still not served the same way: the `Dockerfile` copies `/web/out` from its
web stage, and the console's `next build` writes no static export (it is a server app). That is the server target's
open question, not the Vercel one.

**Lanes** (`molds/mold_v0/testing/`, run by `lanes.py` as for any mold): *functional* runs the product's
`npm run typecheck`, `npm run test:migrations` (embedded throwaway databases only; `MIGRATIONS_PG_URL` unset), `npm run
smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep) and `npm run mcp:check` against
the deployed address; *context* runs `npm run check:tenant-sql` and `npm run check:rls` on a throwaway embedded
database (the deployed database is proven by the deploy itself, above). `test:migrations` also upgrades from older
versions of `sql/schema.sql` found in git history; this repository holds one version of that file, so that part has
nothing to run here (the lane says so). *load*, *accessibility* and
*responsiveness* have no harness in the product and are recorded `skipped`, never `pass`. The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**The CI gate (mold_v0-040).** `provision.py`'s release gate (`lib/deploy_gate.py`) reads, for an in-tree mold, **this
repository's** checks for the commit being deployed: HEAD of the checkout the deploy runs from, and only when
`molds/mold_v0/codebase` on disk is exactly that commit (no tracked change, no untracked file, and no ignored file the
deploy would carry other than mold.json's `source_excludes`, such as `node_modules` and `.env`). Then:

- once mold_v0-001 names the shell's own workflow in [mold.json](mold.json) (`source.ci.workflow`), that workflow's run
  for the commit must have passed with every job it defines, the same rules as mold_v1's `ci.yml`;
- until then, at least one of this repository's **own** checks (a GitHub Actions run of its workflows) must have
  succeeded for that commit, and no check or status at all (from any app) may have failed or still be running. A
  check or status posted by an outside app (a git-connected deploy service, a bot) can refuse a deploy but never pass
  one, and a skipped check never counts. None of these checks tests the shell yet, so a green verdict says only "this
  repository's own checks passed for this commit", and the recorded verdict says exactly what was read.

Today this repository runs no workflow, so the verdict is *missing* and a mold_v0 deploy needs
`--allow-unverified-mold "<reason>"` (recorded in `infrastructure.json` `deploy_gate.override`). A check that failed, one
still running, GitHub not answering, no GitHub `origin`, or an uncommitted change refuses as for any mold.

**Known before the first deploy (mold_v0-029).** The codebase commits `web/package-lock.json`, so the server deploy's
preflight no longer refuses for it and the console project can install exactly.
