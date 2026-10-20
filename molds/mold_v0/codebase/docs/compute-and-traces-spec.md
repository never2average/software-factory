# Final build spec: admin Compute page and Health traces

Repo: `/root/octillion-live/octillion-admin`. This spec starts from the highest-scoring design (operator-first, 8.5 / 8.5 / 6). It takes the best parts of job-centric and cost-capacity and fixes every flaw the judges raised. I checked the code for these facts before writing:

- **Admin routes that exist:** `/admin/{accounts, agents, analytics, compute, configuration, health, journeys, keys, personas, profile, requests, tasks}`.
  - Key vault is `/admin/keys`, not `/admin/key-vault`.
  - There is no `/admin/usage` page.
- **Exports:** `computeDemand` and `computeJobDemand` are already exported (`src/autoscaler.ts:78,101`). `computeBudget`, `boatLimits` and `listSandboxes` live in `orchestrator/deploy/boat-lib.ts:63,77,90`, not in the autoscaler.
- **Session cancel already works end to end.**
  - `heartbeat()` (`src/worker.ts:153-156`) throws 409 once a session's status is no longer `running`.
  - The orchestrator turns 409 or 404 into `serverRejected` (`orchestrator/core/session.ts:228,264`), which kills the sandbox and skips `/complete` (`:476`).
  - So "Cancel" needs only a server-side status change.
- **`kickAutoscaler`** (`src/autoscaler.ts:427-429`) returns `null` in two cases that look the same to the caller: the trigger is not configured (no HTTPS `PUBLIC_URL`, no `OCTILLION_WORKER_TOKEN`, or autoscale off), and the 10-second debounce.
- **Global error handler** (`src/http.ts:488-492`): it already passes the message through for status < 500 and masks status ≥ 500 as "Internal error".
- **`INFRA_FAILURE`** (`src/worker.ts:182`) matches `\b(502|503|504|529)\b` and `No heartbeat for \d+ minutes`.
- **`ERROR_KINDS`** is at `src/insights.ts:256`.

---

## 1. Summary

- **Compute page (`/admin/compute`).** An on-call console that answers four questions in about 10 seconds: is compute healthy, is work flowing, what is stuck, and why. In page order:
  1. A verdict computed on the server.
  2. A freshness label showing tick age.
  3. KPI tiles.
  4. A limits table, with the editable settings on the row of the limit each one changes.
  5. An activity chart.
  6. Three paged RecordViews: Jobs, Sessions and Orchestrators (Orchestrators also lists unmatched boat sandboxes).
  7. Failures by reason.
  8. An autoscaler decisions log.
  9. Read-only environment knobs and the boat account.

  Every number links to the records behind it. Key vault, Harness mix and Agent configuration are linked to, never copied.
- **Traces (Health).** Traces are built inside the app from Octillion's own tables. New Relic keeps the raw OTel spans and is reached by a deep link.
  - **Slice 1** is a read-only model over rows that already exist. It covers every past job across the full 30-day window, with no new storage and no orchestrator deploy.
  - **Slice 2** adds real correlation ids (`trace_id`/`span_id`), one span per model call, and `traceparent` propagation.
  - The same release also adds server spans so that New Relic traces become meaningful.
- **Two root-cause fixes ship early:**
  - A missing provider credential stops being masked as a 503 and requeued as an infrastructure failure.
  - `orchestrator_sandboxes.error` is split into a launch error and a reap reason.
- **Scope rules for v1:**
  - Mutating actions are limited to *Run a tick now*, *Cancel session* (a verified path) and editing settings (already audited).
  - Drain, delete, sandbox delete, requeue, log tailing and metered boat cost are listed under "Not in v1".

---

## 2. Compute page

### 2.0 Shared conventions

- **Files:**
  - `web/src/features/admin/compute.tsx`: page shell (sections A–D and I).
  - New files: `compute-jobs.tsx`, `compute-sessions.tsx`, `compute-orchestrators.tsx`, `compute-failures.tsx`, `compute-decisions.tsx`.
  - Tables use `RecordView` (`web/src/components/layout/record-view.tsx`) with `detail` (peek), `actions`, `properties` and `exportName`. They are outlined and paged.
- **API:** every route below lives under `/api/admin/onboarding/compute/*` on the `ob` router, so `useAdmin('/compute/...')` works. Errors return `{ error }`. Every mutation calls `admin.log(actor, 'compute.<action>', {...})`. The existing `GET /compute`, `PUT /compute/settings` and `GET /compute/sandbox` stay unchanged. `GET /api/admin/autoscaler` stays as it is for the CLI.
- **URL state:** `?job=<id>`, `?session=<id>` and `?orch=<row id>` open the matching peek. `?section=sessions&status=queued&...` applies filters and scrolls. Health and other pages deep-link through these.
- **Refresh:**
  - Summary every 15 s; tables every 30 s; chart every 60 s.
  - Refresh pauses while `document.hidden` is true, while a peek is open, or while a settings field has unsaved edits. A "Paused" chip offers Resume. A Refresh button refetches everything.
- **States:**
  - Each section loads and fails on its own, with an `ErrorBox` and a Retry button. Loading shows skeletons.
  - If the boat listing or limits are unavailable, boat-derived cells show "—" with the tooltip "boat.dev did not answer: {error}". Sections backed by the database still render.
- **Formatting:**
  - Times are relative ("4 min ago") with the absolute time on hover. Durations look like "2.1 min". Ids are in `Mono`.
  - Every sandbox dollar figure is labelled **"est."**, with the tooltip "Estimate from the boat price table (BOAT_PRICE_PER_HOUR), not boat's billing meter."
  - Copy is plain English. Environment variable names appear only in the knobs list and in fix hints.
- **Link targets:**

  | Target | Route |
  |---|---|
  | Key vault | `/admin/keys` |
  | Agent configuration | `/admin/agents` |
  | Harness mix | `/admin/configuration` (exact page to confirm, see Q5) |
  | Simulation | `/admin/accounts/<org>` (existing account detail) |
  | Trace | `/admin/health/traces/<job_id>` (section 3) |

  Deep-link query params (`?agent=`, `?harness=`) are added to those pages only if they are cheap. Otherwise the link opens the page.

### 2.1 Cost and number rules (fixes for the spend and starts flaws)

- **Session model $:** `agent_sessions.cost_usd`, windowed by `ended_at`. Running sessions add nothing until they finish, so tiles say "finished sessions". This value already takes the larger of the CLI-parsed and the gateway-metered figure. **Never add session-consumer `gateway_usage` or `gateway_model_usage` rows on top of it.**
- **Orchestrator model $, time-windowed** (tiles, failures): `gateway_model_usage` rows whose consumer is an orchestrator. This is daily granularity, so the window is "today (UTC)" and the label says so.
- **Orchestrator model $, per job or per orchestrator** (rows, peeks): `gateway_usage.cost_usd WHERE orchestrator_id = <orch id>`. This is a lifetime running total, which is correct because a job orchestrator lives exactly as long as its job.
  - It is the only spend source for research jobs, because `product_research` has no cost column.
  - It is never used for windowed totals.
- **Worker sandbox $ (est.):** `metadata->>'boat_est_cost_usd'`.
- **Orchestrator sandbox $ (est.):** `(coalesce(deleted_at, now()) − created_at) × BOAT_PRICE_PER_HOUR.small`.
  - Orchestrators are always launched with `type:"small"`, so a named constant `ORCH_SANDBOX_TYPE = "small"` lives next to `launchOrchestrator`. No column is added.
- **Boat starts:**
  - The meter is labelled **"Our starts"**: `count(orchestrator_sandboxes.created_at)` plus `count(agent_sessions.started_at WHERE sandbox_id IS NOT NULL)` in the window.
  - It is shown against boat's account-wide limit, with the note "boat does not report used starts; other deployments' starts are not counted."
  - It is never marked "binding" on its own.

### 2.2 Sections, top to bottom

#### A. Header and freshness

- **Title:** "Compute". **Subtitle:** "Orchestrators and agent sandboxes on boat.dev: what is running, what is waiting, and why."
- **Freshness label:** `Last autoscaler tick 12 s ago · runtime VM | Vercel · data as of 14:03:21`.
  - Tick age is `now − last_tick.at`.
  - It turns amber above `3 × tick_seconds` and red above 10 min.
  - On Vercel, when red, it reads: "No autoscaler tick for 47 min. On Vercel, ticks only happen when something happens; queued work may wait until the 06:00 UTC cron."
- **Button "Run a tick now":** `POST /compute/tick`, then a toast: "Tick ran: launched 1, reaped 0. {note}", or the error text.
- **Menu item "Open in New Relic":** shown only when `links.newrelic` is set.

#### B. Verdict banner

- One line with a coloured left border. It shows the worst true rule. A "+N more" control expands the full list.
- Rules are evaluated on the server, in this order, and returned as `verdict[]`. Each has `href`, a filtered in-page URL or another page.

| # | Level | Code | Rule | Copy | href |
|---|---|---|---|---|---|
| 1 | red | `autoscale_off` | `!AUTOSCALE.enabled()` | "The autoscaler is off. Queued work will not get orchestrators." | §I knobs |
| 2 | red | `kick_unconfigured` | `runtime='vercel' && !kickConfigured()` | "This deployment cannot trigger the autoscaler: PUBLIC_URL is not HTTPS or the worker token is unset." | §I knobs |
| 3 | red | `boat_down` | `sandboxProvider()` errored | "boat.dev is not answering: {error}" | `/admin/keys` |
| 4 | red | `no_boat_key` | no enabled boat credential | "No boat key. Add one in Key vault." | `/admin/keys` |
| 5 | red | `tick_error` | `last_tick.error` | "The last tick failed: {error}" | §H, `has=error` |
| 6 | red | `tick_stale` | tick age > 10 min and queued > 0 | "{n} sessions are queued but nothing has ticked for {m} min." | Run a tick now |
| 7 | amber | `queue_old` | oldest queued session > 15 min, or oldest queued research > 20 min | "The oldest queued session has waited {n} min." | Sessions: `status=queued`, `sort=queued_at` |
| 8 | amber | `unclaimable` | `demand.unclaimable_sessions > 0` | "{n} sessions can never run: their agent is not in the scheduled population." | Sessions: `class=unclaimable` |
| 9 | amber | `plan_capacity` | `last_tick.note` matches `waits for boat plan capacity` | "{job} waits for boat capacity: {free} free, other deployments use {others}." | §D |
| 10 | amber | `at_cap` | job orchestrators live ≥ `OCTILLION_MAX_JOB_ORCHESTRATORS` and queued > 0 | "At the orchestrator limit ({n}). Raise it in Limits or wait." | §D |
| 11 | amber | `not_checking_in` | a booting row is older than `boot_minutes`, or a running row has heartbeat age > 90 s | "{n} orchestrators are not checking in." | Orchestrators: `state=stale` |
| 12 | amber | `launch_failures` | ≥ 2 rows with `launch_step IS NOT NULL` in the last hour | "{n} orchestrator launches failed in the last hour (latest: {step}: {msg})." | §G |
| 13 | amber | `cooldown` | note starts with `cooldown:` | "Relaunch is paused (cooldown): {note}" | §H |
| 14 | amber | `missing_keys` | any scheduled agent has `missing_env` not empty | "{agents} cannot run: no vault key for {envs}." | `/admin/keys` |
| 15 | amber | `leaked_workers` | live workers whose parent orchestrator is not live > 0 | "{n} worker sandboxes are running with no live orchestrator." | Orchestrators: `state=unmatched` |
| 16 | amber | `namespace_collision` | `compute_events` has kind `orphan_deleted` in the last 24 h | "{n} orchestrator sandboxes with no row were deleted in 24 h. Another deployment may share namespace {ns}." | §H |
| 17 | amber | `idle_orch` | a running orchestrator has Σ `meta.running` = 0 for more than `idle_minutes` + 5 | "{n} orchestrators are idle but not drained." | Orchestrators: `state=live` |
| 18 | green | `ok` | none of the above | "Compute is healthy. {running} sessions running on {n} orchestrators, queue {q}, oldest {age}." | none |

- Rule 16 is the honest version of namespace collision. A collision on the same prefix cannot be seen from names, so the symptom (orphan deletes) is what gets flagged.
- If the summary call fails, the banner reads "Could not load compute status: {message}" with a Retry button.

#### C. KPI tiles

Six tiles: one row at xl, three per row at md, two on mobile. Each opens a filtered section.

| Tile | Value | Subtext | Source | Click |
|---|---|---|---|---|
| Queued | queued sessions + queued research | "oldest 6 min · 3 jobs" | `agent_sessions` with status='queued' (count, `min(queued_at)`, existing index); `product_research` with status='queued' | Sessions: `status=queued` |
| Running | running sessions | "on 4 orchestrators · 38 of 160 pods" | `status='running'`; Σ `orchestrators.meta.running`; Σ `pods` on live rows | Sessions: `status=running` |
| Queue wait p50 / p95 (1 h) | "2.1 / 9.4 min" | "queued → started, n=42" | `percentile_cont` on `started_at − queued_at` where `started_at > now()-1h` | Sessions: `sort=wait` |
| Orchestrators | live count | "3 running · 1 booting · 0 draining" | `orchestrator_sandboxes` with state <> 'deleted', grouped | Orchestrators |
| Failures (24 h) | failed + timed-out sessions + launch failures | "12 sessions · 2 launches · top: Harness install" | `status IN ('failed','timeout')` and `ended_at > now()-24h`; `launch_step` not null and `created_at > now()-24h` | §G |
| Spend today (UTC) | session model $ + orchestrator model $ + sandbox est. | "$41.20 model (finished sessions) · $3.10 orchestrators · $6.10 sandbox est." | §2.1 rules | Jobs: `sort=spend` |

- The Queued tile turns amber when rule 7 fires.
- The Failures tile turns amber when failed sessions ÷ sessions ended in 24 h > 10%.
- There are no sparklines. Tick history does not exist at launch.

#### D. Limits: which ceiling binds (settings are edited here)

An outlined table, one row per limit. Columns:

- **Limit:** a plain-English name.
- **Used / Limit:** a meter.
- **Status:** OK, Near (≥ 85%) or Binding.
- **Source:** `set` (with "by X, 3 d ago"), `env` or `default`.
- **Change:** inline number or select editing on editable rows. It saves through the existing `PUT /compute/settings`, so the audit log is reused.

| Row | Used | Limit | Editable | Source |
|---|---|---|---|---|
| boat sandboxes at once | `activeNow`, stacked: our orchestrators · our workers · other deployments · free | `limits.activeSandboxes` | no ("Set by your boat plan") | `boatLimits()` and the classified `listSandboxes()` |
| Our starts: minute / hour / day (3 rows) | §2.1 | `startsPerMinute / Hour / Day` | no | boat `/limits` and the DB |
| Job orchestrators | live rows with `job_id IS NOT NULL` | `OCTILLION_MAX_JOB_ORCHESTRATORS` | yes | DB, settings |
| Worker pods per job orchestrator | max `pods` on live job orchestrators (sub line: "avg running 23") | `OCTILLION_JOB_POD_CAPACITY` (max 50) | yes | DB, settings |
| Worker sandbox size | none | `BOAT_SANDBOX_SIZE`, with its $/h | yes (select) | settings, price table |
| Shared orchestrators | live rows with `job_id IS NULL` | `OCTILLION_MAX_ORCHESTRATORS` | yes | Shown only when `OCTILLION_ORCH_PER_JOB` is off; otherwise collapsed into a muted line "Shared orchestrators: not used in per-job mode (limit 4)" |

- **Binding rule (server):**
  - Use the row named by `computeBudget(limits, n, pods, oursActive).reason`.
  - Override it with the latest `last_tick.note` when the note matches `at OCTILLION_MAX_JOB_ORCHESTRATORS` (Job orchestrators row) or `waits for boat plan capacity` (boat sandboxes row).
- **Line under the table:** "Room for {available} more orchestrators of {1+pods} sandboxes; about {sessionsPerDayCeiling} sessions a day. Autoscaler says: "{note}"" (the note is quoted verbatim).
- **When `others > 0`:** "Other deployments on this boat account ({prefixes}) use {others} sandboxes. They share the plan."
- **Free capacity:** `free = plan − (activeNow − ours) − Σ(1 + pods)`. This is the same formula as `scaleJobs`. `scaleJobs` writes `free` into `TickState`, and the summary reads it from there rather than computing it again.

#### E. Activity, last 2 hours (1 h / 2 h / 24 h picker, choice kept in localStorage)

- **Series:**
  - Queued sessions (line).
  - Running sessions (line).
  - Live orchestrators (step line, right axis).
  - Launch markers ▲ and reap markers ▼. Hover shows the reason.
- **Source:** `autoscaler_ticks` sample rows (§2.4, one row per minute at most, plus a row for every acting tick). Buckets are 1 min (5 min for 24 h).
- **Gaps:** a bucket with no rows is a hatched band labelled "no autoscaler tick", never interpolated. The legend reads "Data current through 14:03", or "No samples since 13:16 (no autoscaler tick)."
- **Empty:** "No history yet. Recording starts with this release ({deploy date})."

#### F. Jobs (RecordView, 25 per page, `id="compute-jobs"`)

- **Default view:** active, or finished in the last hour. Waiting jobs first, then running, then finished.
- **Filters:**
  - State: Waiting, Booting, Running, Draining, Finished, Failed, All.
  - Kind: Simulation, Research (product), Research (prospect).
  - Account search.
  - "Has failures".
- **Status rules** (server, first match wins):
  1. Failed: the job row's status is failed.
  2. Finished: `finished_at` is set.
  3. Draining: an orchestrator for the job is draining.
  4. Running: there is a running orchestrator and running sessions > 0, or research is running.
  5. Booting: there is a booting orchestrator.
  6. Waiting: there is queued work and no live orchestrator, or the job is in `last_tick.jobs[]` with `served=false`.
  7. Queued: everything else.

| Column | Source |
|---|---|
| Job (id + kind chip; second line shows account · product) | `simulations` / `product_research`, joined to orgs and products |
| State | rules above |
| Why waiting (blank when the job is served) | Matching `last_tick.jobs[].served=false`, plus the note mapped to plain English: "Waiting for boat capacity (3 free, needs 41)", "At the orchestrator limit", "Relaunch cooldown", "No orchestrator yet", "Agents not scheduled" (unclaimable) |
| Work | Simulation: sessions done / failed / running / queued as a mini stacked bar. Research: `stage` plus "attempt n" |
| Orchestrator | `orchestrator_id` with a state chip, or "2 (1 failed launch)" |
| Pods: running / reserved | Σ `meta.running` / `pods` |
| Waiting since / running for | first queued `queued_at` or research `created_at` / orchestrator `ready_at` |
| Failures | count, plus the top class chip (simulations only) |
| Spend | session model $ + orchestrator model $ (`gateway_usage` by `orchestrator_id`) + sandbox est. Research shows "orchestrator model $ + sandbox est.", with the tooltip "Research spend is metered only through its orchestrator." |

- **Row actions:**
  - Open job (account page).
  - Show sessions: filters §F2 to `job_id`.
  - Show orchestrator: opens the §F3 peek.
  - Open trace (`/admin/health/traces/<id>`, always available because the slice-1 trace is keyed by job id).
  - Copy id.
- **Peek** (no tabs, sections stacked in this order):
  1. **Status sentence:** "Running 38 of 40 pods on orch-212. 12 sessions queued; the oldest has waited 3 min." Or "Waiting: boat has 3 free sandboxes, needs 41."
  2. **Why it is waiting:** the full note plus the numbers compared (free, needed, cap).
  3. **Sessions by agent:** agent, queued, running, done, failed, $. An agent that cannot run is flagged with its runnability reason and a link (§2.3).
  4. **Orchestrators for this job:** a compact list of id, state, boot, lifetime, end reason. Clicking a row opens the §F3 peek (it replaces this peek; there is a "← Back" link).
  5. **Research details** (rsh only): stage, note, attempts, searches, heartbeat age, error.
  6. **Spend breakdown:** four lines.
  7. **Links:** job, trace.
- **Empty:** "No jobs active or finished in the last hour."

#### F2. Sessions (RecordView, 50 per page)

- **Default filter:** queued, running, failed and timeout, last 24 h.
- **Filters:**
  - Status (multi).
  - Agent (multi).
  - Harness.
  - Model.
  - completed_reason.
  - Error class.
  - Job id.
  - Range: 1 h / 24 h / 7 d.
  - "Heartbeat older than 5 min".

| Column | Source |
|---|---|
| Session | `id` |
| Job | `simulation_id` |
| Agent · harness | `agent_id`, `harness` |
| Model | `model` |
| Status (+ "attempt n" when > 1; "infra retry" chip when `metadata.infra_retries > 0`) | `status`, `attempt`, metadata |
| Wait | `started_at − queued_at`, or `now − queued_at` while queued |
| Run time | `ended_at − started_at`; while running, the elapsed time plus heartbeat age, amber when > 5 min |
| Outcome | `completed_reason`, or the error class chip |
| Error (one line) | `error_message` |
| Orchestrator / sandbox | `worker_id`, `sandbox_id` |
| Cost | `cost_usd` + `boat_est_cost_usd` (est.) |

- **Error classes:** computed in the shared `src/error-classes.ts` (§2.3).
- **Row actions:**
  - Cancel (queued or running), behind a confirm: "Stops this session. A running sandbox is killed when its orchestrator next heartbeats."
  - Open trace (the job's trace, scrolled to the session span).
  - Copy id.
- **Peek** (no tabs):
  1. **Status line and the full error in mono.** It adds a hint per class, for example `credentials`: "Missing key {ENV}. Add it in Key vault" (env parsed from `No vault provider supplies (\S+)`).
  2. **Timing:** queued, started, last heartbeat, ended, `metadata.wall_ms`.
  3. **Run:** harness_runs, agent_turns / max_agent_turns, simulated_user_turns, developer_nudges, done_reason, changed_files count, exit_code and exit_signal.
  4. **Infra:** infra_retries, infra_error, boat sandbox id and type, sandbox seconds.
  5. **Spend:** tokens in and out, model $, and `gateway_usage` rows for this session (shown as detail only, never added to totals).
  6. **Runnability of this agent** (§2.3): shown when the class is `unclaimable`, `harness_install` or `credentials`.
  7. **Transcript preview:** the last 20 `transcript_events`, with a link to the full transcript page (section 3.5).
  8. **Links:** job, orchestrator, trace.
- **Empty:** "No sessions match these filters."

#### F3. Orchestrators (RecordView, 25 per page)

- **State chips:**
  - Live (default).
  - Booting.
  - Running.
  - Draining.
  - Stale: booting older than `boot_minutes`, or heartbeat age > 90 s.
  - Failed launches: `launch_step` not null.
  - Ended (24 h).
  - Unmatched on boat.
  - All.

| Column | Source |
|---|---|
| Orchestrator (`orch-12`; sandbox id below in mono) | `orchestrator_id`, `sandbox_id` |
| State · time in state (amber past `boot_minutes`, or with heartbeat > 90 s) | `state`; `created_at` / `ready_at` / `retiring_since` |
| Job | `job_id` or "shared" |
| Workers by agent ("claude-code 6 · codex 4") | `orchestrators.meta.running` |
| Pods used / reserved | Σ `meta.running` / `pods` |
| Heartbeat | `orchestrators.last_seen`, falling back to `orchestrator_sandboxes.last_seen`. Amber > 90 s, red > `stale_minutes` |
| Boot (with an "image" chip when `from_image`; hover shows the phases) | `ready_at − created_at`, `timings` |
| TTL left | live listing `archiveAfter − now`; "n/a" once deleted |
| Code | short `code_hash`, with a "retiring" chip when `retiring_since` is set |
| Ended because | `reap_reason`, or `launch_step: launch_error` in red |
| Spend | sandbox est. + orchestrator model $ |

- **"Unmatched on boat" chip:** swaps in the live-listing rows that match no live `orchestrator_sandboxes` row and no live parent.
  - Columns: name, kind (worker without a live orchestrator / orchestrator name with no row / image builder / other prefix), parent orchestrator (parsed from `${ns}-w-<orchId>-<agent>`), age, boat state, TTL left.
  - These rows are read only in v1.
- **Row actions:**
  - "Copy logs command": `npm run boat-orchestrators -- logs <sandbox_id>`, with the note "Logs are lost when the sandbox is deleted."
  - Open job.
  - Open trace.
- **Peek** (no tabs):
  1. **Summary fields:** state, job, sandbox, created, ready, last seen, TTL, code hash, from image.
  2. **Boot timeline:** bars for create → ready → code → configured → preflight → started, each with its ms from `timings`. A failed launch shows one red segment, `launch_step` ({N} s), with `launch_error`.
  3. **Workers now:** from the live listing joined to `agent_sessions.sandbox_id`: agent, session (opens the §F2 peek), status, heartbeat age, boat state.
  4. **Recent sessions on it:** up to 10, where `worker_id = meta.worker_id`.
  5. **Worker tokens:** `worker_tokens` rows by `sandbox_row_id`, showing expires_at and revoked_at.
  6. **Events:** `compute_events` for this `sandbox_id`.
  7. **Spend.**
  8. **Links:** job, trace, copy logs command.
- **Empty (Live):** "No orchestrators running. One launches when a job queues work." If rule 1 or rule 2 is true, show that rule's copy instead.

#### G. Failures by reason (24 h; 24 h / 7 d picker)

Two outlined lists side by side; they stack on mobile.

- **Orchestrator launches and reaps.**
  - Groups:
    - Launch failures by `launch_step`.
    - Reaps by normalized `reap_reason`. Normalizing strips ids and numbers, giving: stale, stuck booting, TTL, idle drain, job drain, retired, job ended, sandbox gone, never created.
    - Unattended deletes from `compute_events`: worker deleted with its orchestrator, orphan orchestrator deleted, stale image builder.
  - Routine reasons (idle drain, job drain, retired, job ended) are shown muted below a divider and counted separately from "failures".
  - Columns: reason, count, last seen, latest message.
  - Clicking a row sets Orchestrators to Ended (24 h) with that reason.
- **Session failures.**
  - Grouped by error class.
  - Columns: class, count, share of sessions that ended, jobs affected, top agent, last seen, and a "Fix it in" link (Key vault, Harness mix, Agent configuration, or none).
  - Clicking a row filters §F2.
- **Empty:** "No failures in the last 24 hours."

#### H. Autoscaler decisions (outlined, paged 25, newest first)

- **Rows:** acting ticks only (`acted = true`). A toggle, "Include minute samples", adds the sample rows.

| Column | Source (`autoscaler_ticks`) |
|---|---|
| At | `at` |
| Saw ("queued 14 · research 1 · can't run 2") | `demand` |
| Wanted → cap → active · free | `desired`, `cap`, `active`, `free` |
| Did ("launched orch-15 for sim_ab12 · reaped orch-9 (drained, idle)") | `launched`, `reaped` |
| Note | `note` |
| Error (red) | `error` |
| Leader | `holder` |

- **Filters:** has error, launched, reaped, note contains.
- **Peek:**
  - Labelled sections: demand, jobs served or waiting, launched, reaped with reasons.
  - Linked orchestrator rows.
  - Raw JSON in a collapsed block with a copy button.
- **Empty:** "No decisions in this window. Only ticks that changed something are recorded." On Vercel it adds: "Ticks run only on events and at the daily 06:00 UTC cron."

#### I. Environment and boat account (muted, read-only)

- **Knobs table** (name, value, source, meaning): `autoscalerStatus().knobs` plus:
  - `OCTILLION_AUTOSCALE`
  - `OCTILLION_ORCH_PER_JOB`
  - `OCTILLION_ORCH_LAUNCHES_PER_TICK`
  - `OCTILLION_FLEET_STALE_SECONDS`
  - `OCTILLION_RESEARCH_STALE_MINUTES`
  - `OCTILLION_SESSION_INFRA_RETRIES`
  - `OCTILLION_LEASE_MINUTES`
  - `MAX_SESSION_MINUTES`
  - `BOAT_TTL_MARGIN_MINUTES`
  - `BOAT_READY_TIMEOUT_SECONDS`
  - `OCTILLION_BOAT_NAMESPACE` (effective value)
  - Runtime (VM / Vercel)
  - Kick configured (yes/no)

  Footer: "Change these in the deployment environment."
- **Related settings, read only with links:** `ORCHESTRATOR_MODEL`, `OCTILLION_MAX_SESSIONS_PER_RUN` and `RESEARCH_MAX_COST_USD`, each linking to its page.
- **Boat account:** the existing `SandboxProvider` block, compacted: API, namespace, key hint, uses, last used, a "Test connection" button, and a link to Key vault. Plan and running counts move up to §D.

### 2.3 Shared server logic

**`src/error-classes.ts` (new).** One `classifySession(row)` and one `classifyOrchestrator(row)`. Compute, Health and traces all use it. The first match wins, in this order (heartbeat is now checked before the time cap):

| Key | Label | Match | Fix |
|---|---|---|---|
| `unclaimable` | Agent not scheduled | status queued and `agent_id` not in the scheduled population | Harness mix |
| `credentials` | Missing provider key | `missing_credential` · `No vault provider supplies` · `No .+ credential in the vault` · `/credentials -> 503` (old rows) | Key vault |
| `harness_install` | Harness install failed | `^harness \S+ not available` | Harness mix |
| `gateway_token` | Gateway token expired | `Gateway token is invalid, expired or revoked` | none |
| `boat_permission` | boat key not allowed | `api_key_action_forbidden` · `not allowed to create sandboxes` | Key vault |
| `boat_capacity` | boat rate limit or capacity | `rate_limited` · `limit_reached` · `no_ready_machine` · `\b429\b` | none |
| `sandbox_boot` | Sandbox not ready | `not ready after \d+s` | none |
| `sandbox_prepare` | Sandbox setup failed | `sandbox prepare failed` · `egress lockdown failed` | none |
| `heartbeat` | Lost heartbeat | `No heartbeat for` | none |
| `time_cap` | Hit time limit | `Exceeded MAX_SESSION_MINUTES`, or status timeout with no other match | Agent configuration |
| `shutdown` | Worker shut down | `Worker shut down` | none |
| `agent` | Agent stopped | `completed_reason IN ('agent_gave_up','turn_cap','time_cap','error')` with no other match | Agent configuration |
| `other` | Other | fallback | none |

- Orchestrator keys: `launch:<step>` from `launch_step`, and `reap:<kind>` from the normalized `reap_reason`.
- The regex inputs are `error_message` plus `metadata->>'infra_error'`.

**Runnability (`GET /compute/agents/runnable`).** This replaces the invented "pin matches" check.

- For each scheduled agent:
  - `has_setup_script`: whether the harness is in `BOAT_SETUP_HARNESSES`.
  - `missing_env`: `requires_env` / `HARNESS_ENV[harness]` minus `providersForEnv` coverage in the vault.
  - `runnable = missing_env.length === 0`.
  - `reason`: plain English.
- `BOAT_SETUP_HARNESSES` is a constant in `src/harness-setup.ts`. A unit test asserts it equals the file names in `orchestrator/images/boat-setup/*.sh`. This works on Vercel without shipping that directory.
- With no setup script, the UI says: "No setup script: runs only if boat's preinstalled CLI matches the pin (checked inside the sandbox at run time)." The server cannot know boat's preinstalled CLI version, so it does not claim to.

**Boat listing.**

- `classifiedSandboxes()` lives in a new `src/compute.ts`. It wraps `listSandboxes()` with:
  - A 30 s in-process cache.
  - An 8 s timeout.
  - A fallback to the last good value with `stale: true`, or to `{ error }`.
- Names are classified by the prefixes `${ns}-orch-`, `${ns}-w-<orchId>-<agent>`, `${ns}-orch-img-`, `${ns}-img-build`, and "other".
- `boatLimits()` keeps its existing 5-minute cache.

**Kick configured.** Export `kickConfigured(): boolean` from `src/autoscaler.ts`. It holds the first-line condition of `kickAutoscaler`, and `kickAutoscaler` calls it. This separates "not configured" from "debounced".

### 2.4 Endpoints (all under `/api/admin/onboarding/compute`)

| Method · path | Response |
|---|---|
| `GET /summary` (cached 5 s) | see shape below |
| `GET /activity?minutes=60\|120\|1440` | `{ bucket_s, samples:[{t, queued, running, research, orchestrators, gap:boolean}], events:[{at, kind:'launch'\|'reap', orchestrator_id, sandbox_id, reason}] }` |
| `GET /jobs?state&kind&q&has_failures&offset&limit=25` | `{ total, rows:[{id, kind:'simulation'\|'research'\|'prospect', org:{id,name}, product:{id,name}\|null, state, why_waiting:string\|null, note:string\|null, sessions:{queued,running,completed,failed,timeout,cancelled}\|null, research:{stage,attempts}\|null, orchestrator:{id,orchestrator_id,state}\|null, orchestrators_total, failed_launches, pods:{running,reserved}, waiting_since, running_since, failures:{count, top_key, top_label}, spend:{session_model_usd, orchestrator_model_usd, sandbox_est_usd, total_usd}}] }` |
| `GET /jobs/:id` | `{ job:<row>, why:{note, free, needed, cap}\|null, agents:[{agent_id, harness, queued, running, completed, failed, usd, runnable:{ok, reason}}], orchestrators:[{id, orchestrator_id, state, boot_ms, lifetime_s, end_reason}], research:{stage, note, attempts, searches, heartbeat_at, error}\|null }` |
| `GET /sessions?status&agent&harness&model&reason&class&job_id&since&stale_heartbeat&sort=queued_at\|wait\|ended_at&offset&limit=50` | `{ total, rows:[{id, simulation_id, agent_id, harness, model, status, attempt, infra_retries, queued_at, started_at, heartbeat_at, ended_at, completed_reason, error_class, error_label, error_message, worker_id, sandbox_id, cost_usd, sandbox_est_usd}] }` |
| `GET /sessions/:id` | `{ session:<row>, metadata:<whitelisted keys>, gateway:[{provider, requests, errors, input_tokens, output_tokens, cost_usd, last_at}], hint:{text, href}\|null, runnable:{…}\|null, transcript:[{seq, ts, type, text}] }`. Transcript is the last 20 events, text truncated to 300 chars. |
| `POST /sessions/:id/cancel` | `{ ok, status }`. Calls `completeSession(id, {status:'cancelled', error_message:'Cancelled by <actor>'})`, which keeps the simulation-finish bookkeeping. 409 if the session is already final. |
| `GET /orchestrators?state=live\|booting\|running\|draining\|stale\|failed_launch\|ended\|unmatched\|all&job_id&reason&offset&limit=25` | `{ total, boat:{ok, stale, error}, rows:[{id, sandbox_id, orchestrator_id, job_id, state, boat_state, state_since, running_by_agent:{[agent]:n}, pods, heartbeat_at, boot_ms, from_image, ttl_left_s, code_hash, current_code, retiring_since, launch_step, launch_error, reap_reason, created_at, ready_at, deleted_at, spend:{orchestrator_model_usd, sandbox_est_usd}}] }`. For `state=unmatched`, rows are `[{sandbox_id, name, kind:'worker_no_parent'\|'orch_no_row'\|'image_builder'\|'other_prefix', parent_orchestrator_id, created_at, boat_state, ttl_left_s}]`. |
| `GET /orchestrators/:id` | `{ row, timings, workers:[{sandbox_id, agent_id, session_id, status, heartbeat_age_s, boat_state}], sessions:[…≤10], tokens:[{job_id, expires_at, revoked_at}], events:[compute_events], gateway:[{provider, requests, errors, input_tokens, output_tokens, cost_usd}], logs_command }` |
| `GET /failures?hours=24\|168` | `{ launches:[{step, count, last_at, message}], reaps:[{reason, routine:boolean, count, last_at, message}], unattended:[{kind, count, last_at}], sessions:[{key, label, count, share, jobs, top_agent, last_at, fix:{text, href}\|null}] }` |
| `GET /ticks?acted=1&has=error\|launch\|reap&q&offset&limit=25` | `{ total, rows:[autoscaler_ticks row] }` |
| `GET /agents/runnable` | `{ rows:[{agent_id, harness, has_setup_script, missing_env:string[], runnable, reason}] }` |
| `POST /tick` | `{ ran:boolean, leader, launched, reaped, note, error }`. Calls `kickAutoscaler({force:true})`. A `null` result returns `{ran:false, note:'not configured'}`. It awaits the tick, then calls `otelFlush()`. |

**`GET /summary` shape:**

```
{ at,
  runtime: 'vm'|'vercel',
  verdict: [{ level:'red'|'amber'|'green', code, text, href }],
  tick: { at, age_s, holder, enabled, kick_configured, note, error, tick_seconds, free },
  queue: { sessions, research, oldest_session_at, oldest_research_at, unclaimable, jobs_waiting },
  running: { sessions, orchestrators:{booting, running, draining}, pods_used, pods_reserved },
  wait_1h: { p50_s, p95_s, n },
  failures_24h: { sessions, launches, ended, rate, top:{key, label, count}|null },
  spend_today: { session_model_usd, orchestrator_model_usd, sandbox_est_usd, total_usd },
  limits: { ok, error, plan, active_now, ours_orch, ours_workers, others, other_prefixes:string[],
            our_starts:{minute, hour, day}, starts:{per_minute, per_hour, per_day},
            job_orch_live, job_orch_cap, shared_orch_live, shared_orch_cap, per_job_mode,
            pods_max_reserved, pods_cap, available, per_orchestrator, sessions_per_day_ceiling,
            reason, binding:'plan'|'job_orch'|'pods'|null, note },
  settings: <existing compute settings with source/updated_by/updated_at>,
  knobs: [{ name, value, source:'env'|'default', meaning }],
  provider: { ok, error, has_key, key_hint, uses, last_used_at },
  links: { newrelic:string|null } }
```

### 2.5 Schema changes (`sql/schema.sql`, idempotent `IF NOT EXISTS`)

```sql
-- split the mixed error column (keep `error` for back-compat; keep writing it as today)
ALTER TABLE orchestrator_sandboxes
  ADD COLUMN IF NOT EXISTS launch_step  TEXT,
  ADD COLUMN IF NOT EXISTS launch_error TEXT,
  ADD COLUMN IF NOT EXISTS reap_reason  TEXT;
-- backfill (one-off migration):
UPDATE orchestrator_sandboxes SET
  launch_step  = substring(error from '^(create|name|ready|code upload|configure|preflight|start) \(\d+s\):'),
  launch_error = substring(error from '^(?:create|name|ready|code upload|configure|preflight|start) \(\d+s\): (.*)$')
WHERE ready_at IS NULL AND error ~ '^(create|name|ready|code upload|configure|preflight|start) \(\d+s\):' AND launch_step IS NULL;
UPDATE orchestrator_sandboxes SET reap_reason = error
WHERE error IS NOT NULL AND launch_step IS NULL AND reap_reason IS NULL;

-- one history table (replaces both compute_samples and every-tick logging)
CREATE TABLE IF NOT EXISTS autoscaler_ticks (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), holder TEXT,
  acted BOOLEAN NOT NULL,                 -- launched/reaped/error/note changed
  queued INT, running INT, research INT, unclaimable INT, orchestrators INT,
  desired INT, cap INT, active INT, free INT,
  demand JSONB, jobs JSONB, launched JSONB NOT NULL DEFAULT '[]', reaped JSONB NOT NULL DEFAULT '[]',
  note TEXT, error TEXT, trace_id TEXT);
CREATE INDEX IF NOT EXISTS autoscaler_ticks_at_idx    ON autoscaler_ticks (at DESC);
CREATE INDEX IF NOT EXISTS autoscaler_ticks_acted_idx ON autoscaler_ticks (at DESC) WHERE acted;

CREATE TABLE IF NOT EXISTS compute_events (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('launch_failed','reaped','worker_deleted','orphan_deleted','image_builder_deleted','tick_error','admin_cancel')),
  sandbox_id TEXT, orchestrator_id TEXT, job_id TEXT, session_id TEXT, step TEXT, reason TEXT, actor TEXT, trace_id TEXT);
CREATE INDEX IF NOT EXISTS compute_events_at_idx      ON compute_events (at DESC);
CREATE INDEX IF NOT EXISTS compute_events_sandbox_idx ON compute_events (sandbox_id);

CREATE INDEX IF NOT EXISTS agent_sessions_status_ended_idx ON agent_sessions (status, ended_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_agent_status_idx ON agent_sessions (agent_id, status);
CREATE INDEX IF NOT EXISTS agent_sessions_started_idx      ON agent_sessions (started_at DESC) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orchestrator_sandboxes_job_idx  ON orchestrator_sandboxes (job_id, created_at DESC) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_orch_idx          ON gateway_usage (orchestrator_id) WHERE orchestrator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_usage_session_idx       ON gateway_usage (session_id) WHERE session_id IS NOT NULL;
```

**Writers in `src/autoscaler.ts`:**

- **Launch failure** (around line 408): also set `launch_step` and `launch_error`, and insert `compute_events('launch_failed')`.
- **Reap paths** (213–288): set `reap_reason = coalesce(reap_reason, $reason)` and insert `compute_events('reaped')`.
- **Workers deleted with an orchestrator, orphan deletes and image-builder deletes:** insert the matching `compute_events`. This is the only place they are kept.
- **Tick error:** insert `compute_events('tick_error')`.
- **`autoscaler_ticks` writes:**
  - Only the leader writes, so the existing `WHERE holder=$1` behaviour is unchanged and non-leaders still write nothing.
  - It inserts when `acted`, or when the previous row is ≥ 60 s old (a sample row with `acted=false`).
  - That is about 1,440 sample rows a day, plus acting ticks.
- **Pruning:** in the daily cron and the VM archiver, run `DELETE FROM autoscaler_ticks WHERE id IN (SELECT id FROM autoscaler_ticks WHERE at < now()-interval '14 days' LIMIT 5000)`, plus the same statement for `compute_events` older than 90 days. It never runs inside the tick.
- **`scaleJobs`:** writes `free` into `TickState`.

**Credentials fix** (removes the false infrastructure requeue):

- `brokerSessionCredentials` (`src/gateway.ts:~70`) throws a 424 when no vault provider covers an env. The error is `Object.assign(new Error("No vault provider supplies X"), { status: 424, code: "missing_credential", env: "X" })`.
- The global handler already passes messages through for status < 500. Extend it to also include `code` and `env` when present.
- **Verify:** `withRetry` in the orchestrator does not retry 4xx except 429. Add that if it does.
- The message contains no 502/503/504/529, so `INFRA_FAILURE` does not match and the session fails once with the real cause.

---

## 3. Traces (Health)

### 3.1 Decision

Traces are built in the app from Postgres. New Relic is a deep link only, with no NerdGraph reads in v1. Reasons:

- New Relic holds no job, session or sandbox ids, and nothing from the sandboxes.
- Its span retention is short; the Health page defaults to 30 days.
- A trace appears in New Relic only about 90 s after its last span closes.
- Reading it needs a second secret (a User key) and has rate limits.
- Cost lives in our tables.

Within that decision:

- **Slice 1** is a read model with no new storage. The trace key is the job id.
- **Slice 2** stores `trace_id`/`span_id` and one row per model call (`trace_spans`).
- Server OTel spans are fixed in the same release as slice 1, so New Relic links become useful.

### 3.2 Correlation ids

| Hop | Slice 1 key | Slice 2 stored id | Propagation |
|---|---|---|---|
| MCP tool call (`src/server.ts:261`) | none (not linked) | `mcp_events.trace_id`, `span_id` | `runTool` passes `{trace_id, span_id}` into job creation |
| Simulation / research (`src/queries.ts:437`, `src/research.ts`) | `sim_…` / `rsh_…` | `simulations.trace_id`, `origin_span_id`; same columns on `product_research` | research ↔ simulation through `product_research.simulation_id` / `simulations.research_id` |
| Orchestrator launch (`src/autoscaler.ts:387`) | `orchestrator_sandboxes.job_id` | `orchestrator_sandboxes.trace_id` = the job's trace (a shared orchestrator gets its own) | `OCTILLION_TRACEPARENT` in the sandbox env (`boat-lib.ts launchOrchestrator`) |
| Session claim (`src/worker.ts:46`) | `agent_sessions.simulation_id`, `worker_id`, `sandbox_id` | `agent_sessions.trace_id`, `span_id` (columns, so they can be indexed) | `traceparent` returned per job and session in the `/claim` and `/research/claim` responses; `orchestrator/core/util.ts:37 api()` sends it back as a header; worker routes parent their spans to it |
| Gateway model call (`src/gateway.ts:199`) | `gateway_usage.session_id` / `orchestrator_id` (one aggregate span per session) | `trace_spans` row, layer `llm` | server-side: the `ogw_` token resolves to `gateway_tokens.session_id` / `orchestrator_id`, which gives the session span. The harness sends no header. |
| Autoscaler tick | none | `autoscaler_ticks.trace_id`, `compute_events.trace_id` | its own short trace; the launch span is also linked from the job's orchestrator span |

- When OTel is off, slice-2 ids are random W3C-format ids, so in-app traces still work. When OTel is on, they come from `span.spanContext()`.
- **Attributes on every server span:** `octillion.job_id`, `session_id`, `orchestrator_id`, `sandbox_id`, `agent_id`, `harness`, `org`, `reason`, `step`. LLM spans also get `gen_ai.request.model` and `gen_ai.usage.input_tokens` / `output_tokens`. Prompts, arguments and transcripts are never attributes, which keeps the `src/otel.ts` redaction rule.

### 3.3 Span model (slice 1, derived)

Synthetic span ids are deterministic: `job:<id>`, `orch:<row id>`, `step:<row id>:<step>`, `ses:<id>`, `llm:<ses id>`.

| Layer | Span | Start → end | Error when |
|---|---|---|---|
| job | `Simulation <account / product>` / `Research <domain>` | `created_at` → `finished_at` (or now; "running") | job status failed |
| orchestrator | `orchestrator <orch-id>` | `created_at` → `deleted_at` (or `last_seen` / now) | `launch_step` set, or `reap_reason` is stale / stuck booting / sandbox gone. Other reap reasons are shown as an end note. |
| orchestrator | `launch.<step>` | segments from the cumulative `timings` ms | failed launch: one red segment `launch.<launch_step>` sized from `(N s)` in the error |
| session | `session <agent_id>` with children `queue wait` (hatched) and `run` | `queued_at` → `started_at` → `ended_at` | status failed or timeout, or `completed_reason='error'`; carries `error_class` |
| llm | `model calls · <provider>` (aggregate) | spans the session run | `errors > 0` (shown as "n errors", not red, unless every request errored) |

- **Partial state for history:** api, research-stage, install and per-call LLM spans are missing for every job until slice 2 ships. The trace header then shows: "Showing the job, orchestrators and sessions. Tool-call and per-model-call detail is recorded for jobs created after {slice-2 date}."
- **Cost rollup** is computed on the server per subtree, following §2.1: session model $ from `cost_usd`, orchestrator model $ from `gateway_usage` by `orchestrator_id`, and sandbox est. shown on a separate line.

### 3.4 Trace list (Health page)

- **Placement:** a new "Traces" section in `HealthBody` (`web/src/features/admin/analytics.tsx:561`), below the tiles and above the errors table. It is a full-width outlined RecordView, 50 per page, using the page's period filter.
- **Summary line:** "N traces · M failed · K running · p95 job duration · median queue wait". Each part applies its filter when clicked.
- **Columns:**
  - Started.
  - Trace (root name; the id is on hover or copy).
  - Account.
  - Status: OK / Failed (n errors) / Running.
  - Duration.
  - Queue wait p50.
  - Sessions (done / failed / total).
  - Sandboxes (orchestrators + workers).
  - Model requests (Σ `gateway_usage.requests`).
  - Tokens in / out.
  - Cost (model + sandbox est.).
  - First error (class + message).
- **Filters:**
  - Status.
  - Kind: simulation, research product, research prospect (slice 2 adds tool call and autoscaler).
  - Account.
  - Agent.
  - Harness.
  - Model.
  - Error class.
  - Min duration.
  - An id search box that accepts `sim_`, `rsh_`, `ses_`, `bx_`, `orch-` or a 32-hex trace id. It resolves through `/traces/lookup`.
- **Sort:** Started descending, with a "Failed first" toggle.
- **Row peek** (no tabs): header (status, duration, cost), a mini waterfall (top two levels), an errors list (span, class, message), identifiers, an "Open trace" button, and "Open in New Relic" when `trace_id` is set and `NEW_RELIC_TRACE_URL` is set.
- **Existing errors table changes:**
  - Every session and onboarding row gets a "Trace" link (by `simulation_id` / `rsh_`). Tool rows get the link in slice 2.
  - Session rows gain the columns `agent_id`, `completed_reason`, `error_class`, `sandbox_id` and `infra_error`.
  - New error kind **`compute`** in `ERROR_KINDS` (`src/insights.ts:256`), sourced from `compute_events` with kind in (`launch_failed`, `tick_error`, `orphan_deleted`). Rows link to `/admin/compute?orch=<id>` and to the trace.
  - A new Health tile "Compute" shows the verdict level and top text from `/compute/summary` and links to `/admin/compute`.
- **`links.tracing`:** finally rendered. Off: "OpenTelemetry export is off (OTEL_EXPORTER_OTLP_ENDPOINT unset). In-app traces still work; New Relic links are hidden." On: "Tracing on (New Relic)."

### 3.5 Trace detail

- **Routes:**
  - `web/src/app/admin/health/traces/[traceId]/page.tsx` → `web/src/features/admin/trace.tsx`. It is a full-width page, not a side panel.
  - `web/src/app/admin/health/sessions/[sessionId]/page.tsx`: paged `transcript_events`. The admin has no transcript viewer today.
- **Header:** root name, status, start, duration, account and product, copyable ids, and totals (sessions, sandboxes, model requests, tokens, model $, sandbox est. $). Links: job record, Compute job peek, New Relic.
- **Toolbar:**
  - Error count with Previous / Next.
  - "Errors only" (error spans plus their ancestors).
  - Search in trace (name, id, agent, model) with match navigation.
  - Collapse to depth 1 / 2 / 3.
- **Body:** a tree on the left (indent, child-count collapse box, layer icon, name) and waterfall bars on a shared time axis on the right.
  - Layers use six categorical chart tokens: job, orchestrator, session, llm, plus api and autoscaler in slice 2.
  - Queue wait is hatched. Errors are red. Running spans have an open right edge, and the page refetches every 15 s while the trace is running.
  - Duration and subtree cost are shown on the right of each row.
  - More than 200 sessions collapse into one group row per agent ("codex ×38 · 2 failed · $4.10"), which expands to show 200 at a time, failed first.
  - In slice 2, a session's per-call LLM spans start collapsed as "214 model calls · 2 failed · 1.9M tokens · $1.32", paged 200 at a time.
- **Span peek** (side panel, no tabs, in this order):
  1. Summary: name, layer, status, start and end, duration, self time.
  2. Error: full message, class label and hint (from `src/error-classes.ts`).
  3. Identifiers, each with a copy button.
  4. Tokens and cost for this span and its subtree.
  5. Record fields by layer:
     - Session: agent, harness, model, attempt, completed_reason, infra_retries / infra_error, exit_code, agent_turns, wall_ms.
     - Orchestrator: pods, code_hash, from_image, timings, reap reason, worker count.
  6. Transcript (session spans): the last 20 events, plus "Open full transcript".
  7. Links: New Relic, Compute, job.

### 3.6 Endpoints (`src/traces.ts`, routes next to `ob.get("/analytics")` in `src/http.ts`)

| Method · path | Response |
|---|---|
| `GET /api/admin/onboarding/traces?from&to&status&kind&org&agent_id&harness&model&error_class&min_ms&q&sort&offset&limit=50` | `{ total, summary:{traces, failed, running, p95_ms, wait_p50_s}, rows:[{id, trace_id\|null, kind, name, org:{id,name}, status:'ok'\|'error'\|'running', errors, started_at, ended_at, duration_ms, wait_p50_s, sessions:{done, failed, total}, sandboxes:{orchestrators, workers}, model_requests, tokens:{in, out}, cost:{model_usd, sandbox_est_usd}, first_error:{class, label, message}\|null}] }` |
| `GET /api/admin/onboarding/traces/lookup?id=` | `{ id }` (the job id), or 404 |
| `GET /api/admin/onboarding/traces/:id` (job id, or a trace_id in slice 2) | `{ trace:<row>, partial:boolean, spans:[{span_id, parent_span_id, name, layer, start, end\|null, status, error\|null, error_class\|null, ids:{job_id, session_id, orchestrator_id, sandbox_id, trace_id}, tokens:{in,out}\|null, cost_usd\|null, subtree:{cost_usd, tokens_in, tokens_out, errors}, child_count, group?:{agent_id, count, failed}}], links:{newrelic:string\|null} }` |
| `GET /api/admin/onboarding/traces/:id/spans/:spanId` | `{ span, record:<layer fields>, transcript:[…≤20]\|null, hint:{text, href}\|null }` |
| `GET /api/admin/onboarding/sessions/:id/transcript?offset&limit=200` | `{ total, events:[{seq, ts, type, text}] }`, through `src/transcripts.ts` |

- `listTraces` is a UNION over `simulations` and `product_research` in the period, with `LATERAL` rollups over `agent_sessions` (by `simulation_id`), `orchestrator_sandboxes` (by `job_id`) and `gateway_usage` (by `session_id` / `orchestrator_id`).
- **New Relic link:** a new env var, `NEW_RELIC_TRACE_URL`, holds a template with `{trace_id}`. It is shown only when both the template and the `trace_id` exist, so slice 1 has no New Relic links. There are no dead links and no fallback to the dashboard URL.

### 3.7 Schema

- **Slice 1:** no new storage. It uses the §2.5 indexes plus:

  ```sql
  CREATE INDEX IF NOT EXISTS simulations_created_idx ON simulations (created_at DESC);
  CREATE INDEX IF NOT EXISTS product_research_created_desc_idx ON product_research (created_at DESC);
  ```

- **Slice 2:**

  ```sql
  ALTER TABLE mcp_events             ADD COLUMN IF NOT EXISTS trace_id TEXT, ADD COLUMN IF NOT EXISTS span_id TEXT;
  ALTER TABLE simulations            ADD COLUMN IF NOT EXISTS trace_id TEXT, ADD COLUMN IF NOT EXISTS origin_span_id TEXT;
  ALTER TABLE product_research       ADD COLUMN IF NOT EXISTS trace_id TEXT, ADD COLUMN IF NOT EXISTS origin_span_id TEXT;
  ALTER TABLE orchestrator_sandboxes ADD COLUMN IF NOT EXISTS trace_id TEXT;
  ALTER TABLE agent_sessions         ADD COLUMN IF NOT EXISTS trace_id TEXT, ADD COLUMN IF NOT EXISTS span_id TEXT;
  CREATE INDEX IF NOT EXISTS simulations_trace_idx ON simulations (trace_id) WHERE trace_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS trace_spans (
    trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('api','job','autoscaler','orchestrator','session','llm')),
    started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','running')), error TEXT,
    org_id INT, job_id TEXT, session_id TEXT, orchestrator_id TEXT, sandbox_id TEXT,
    provider TEXT, model TEXT, http_status INT,
    input_tokens INT, cached_input_tokens INT, output_tokens INT, cost_usd NUMERIC(12,6),
    attrs JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (trace_id, span_id));
  CREATE INDEX IF NOT EXISTS trace_spans_roots_idx   ON trace_spans (started_at DESC) WHERE parent_span_id IS NULL;
  CREATE INDEX IF NOT EXISTS trace_spans_session_idx ON trace_spans (session_id, started_at) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS trace_spans_errors_idx  ON trace_spans (started_at DESC) WHERE status = 'error';
  ```

- **Writes:**
  - `span()` (`src/telemetry.ts:82`) gains an optional `persist:{layer, ids}`.
  - `src/tracing.ts` `recordSpan()` buffers rows and inserts them every 2 s or every 200 rows. On Vercel the flush is wrapped in `keepAlive`. A failed batch is dropped.
  - Pruning: `llm` rows after 14 days, all others after 90 days, in the daily cron and the archiver.
  - **Volume gate:** before turning on llm rows, run `SELECT sum(requests) FROM gateway_usage WHERE last_at > now()-interval '14 days'`. Above about 20M, write llm spans to ClickHouse next to `transcript_events` instead.

### 3.8 Server OTel fixes (ship with slice 1)

- **Wrap in `span()` with `recordException` and ERROR status:**
  - `Autoscaler.tick` (`src/autoscaler.ts:191`). On the VM loop (`:148`) it is an explicit root span, so pg and boat calls nest under it instead of starting a new root trace every 15 s.
  - `launch` (`:387`), with child spans per step from `timings`.
  - reap.
  - `claimJobs` (`src/worker.ts:46`).
  - `completeSession` (`:205`).
  - `brokerSessionCredentials` (`src/gateway.ts:52`).
  - The gateway handler (`:199`).
- **Vercel:** `serverlessTick` (`src/http.ts:26`) and the kick in `src/prospect.ts:262` become `keepAlive(kickAutoscaler(...).finally(() => otelFlush()))`.
- **Global error handler:** add `trace.getActiveSpan()?.recordException(err)` and set the span status to ERROR.

---

## 4. Build order (each step can ship on its own)

1. **Credentials fix and error-class module.** The 424 from `brokerSessionCredentials`, `code`/`env` in the handler, the orchestrator `withRetry` check, and `src/error-classes.ts` with unit tests (including heartbeat before time cap). This fixes a real misrequeue bug.
2. **Orchestrator error split.** `launch_step`, `launch_error` and `reap_reason` columns plus backfill, the `compute_events` table, and the writers in `autoscaler.ts`.
3. **Read-only Compute v1, using existing data:**
   - `/compute/summary` with verdict, tick freshness, `kickConfigured()`, limits (with "our starts") and tiles.
   - The settings rows inside Limits.
   - Section I.
   - `classifiedSandboxes()` with cache and timeout.
4. **Orchestrators RecordView** with peek and the Unmatched chip, and **Sessions RecordView** with peek, runnability (`BOAT_SETUP_HARNESSES` and its test) and the §2.5 indexes.
5. **Jobs RecordView** with peek, plus Failures by reason.
6. **`autoscaler_ticks`** (leader-only, acted or once a minute), `free` in `TickState`, pruning, then the Decisions log and the Activity chart.
7. **Actions:** `POST /compute/tick` and `POST /compute/sessions/:id/cancel`, both audited, with confirm dialogs.
8. **Server OTel fixes (§3.8).** These can ship in parallel with steps 3–7.
9. **Traces slice 1:** `src/traces.ts`, the trace routes, the Health Traces section, the trace page, the span peek, the session transcript page, Trace links and new columns on Health errors, the `compute` error kind, the Compute tile on Health, and the `links.tracing` notice.
10. **Traces slice 2a:** `trace_id`/`span_id` columns. `runTool` → job creation; claim → session; launch → orchestrator. Add the `NEW_RELIC_TRACE_URL` links.
11. **Traces slice 2b:** `traceparent` in claim responses and the sandbox env; `orchestrator/core/util.ts api()` sends it back (this needs an orchestrator deploy). Then the volume check, then `trace_spans` llm rows in the gateway handler.
12. **Later (slice 3, not in v1):** OTel SDK in the orchestrator, orchestrator-reported `metadata.phases`, log shipping, agent turn spans from `transcript_events`, optional NerdGraph fetch.

**Not in v1:**

- Drain or delete orchestrator.
- Delete leaked or unknown sandbox.
- Requeue sessions.
- Tailing orchestrator logs from the server (copy the CLI command instead).
- Metered cost from boat `/sandboxes/{id}/usage`.
- CPU and RAM metrics.
- A spend-alert setting.
- A boat-backoff worker events endpoint.
- Research stage history (`stage_log`).
- Harness install timing (`install_ms`).

---

## 5. Open questions for the product owner

1. **Destructive actions in phase 2.** Should drain, delete orchestrator and delete leaked sandbox follow right after v1 (with server-side re-checks and audit), or wait until the read-only page has been used for a while?
2. **OTel in production.** Is OTel export actually on in prod (`OTEL_EXPORTER_OTLP_ENDPOINT`)? And what is the New Relic distributed-tracing URL format for this account, to put in `NEW_RELIC_TRACE_URL`?
3. **Namespaces.** Should each deployment get a unique `OCTILLION_BOAT_NAMESPACE` (for example per Vercel environment), so namespace collisions are prevented rather than only detected after orphan reaps?
4. **Vercel ticking.** Should a more frequent Vercel cron (for example every 5 min) replace "event-only plus 06:00 UTC", or is the freshness banner plus "Run a tick now" enough?
5. **Link targets.** Confirm that Harness mix is `/admin/configuration` and Agent configuration is `/admin/agents`. Should those pages accept `?harness=` / `?agent=` deep links?

---

## Main files

- **Web, edited:** `/root/octillion-live/octillion-admin/web/src/features/admin/compute.tsx`, `/root/octillion-live/octillion-admin/web/src/features/admin/analytics.tsx`, `/root/octillion-live/octillion-admin/web/src/components/layout/record-view.tsx` (used as is).
- **Web, new:**
  - `web/src/features/admin/compute-{jobs,sessions,orchestrators,failures,decisions}.tsx`
  - `web/src/features/admin/traces.tsx`
  - `web/src/features/admin/trace.tsx`
  - `web/src/app/admin/health/traces/[traceId]/page.tsx`
  - `web/src/app/admin/health/sessions/[sessionId]/page.tsx`
- **Server, edited:** `/root/octillion-live/octillion-admin/src/http.ts`, `src/autoscaler.ts`, `src/worker.ts`, `src/gateway.ts`, `src/insights.ts`, `src/telemetry.ts`, `src/server.ts`, `src/prospect.ts`, `src/library.ts`, `sql/schema.sql`.
- **Server, new:** `src/compute.ts`, `src/error-classes.ts`, `src/harness-setup.ts`, `src/traces.ts`, `src/tracing.ts` (slice 2).
- **Orchestrator:** `/root/octillion-live/octillion-admin/orchestrator/core/util.ts`, `orchestrator/deploy/boat-lib.ts` (slice 2b only).