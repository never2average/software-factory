# The workspace agent: a long-lived agent driven through a harness (mold_v0-243)

Design note. It maps each piece of the reference product's agent harness onto mold_v0's existing machinery, and
lists what is deliberately not copied. The reference is a private product; this note names its approach, not its names.
The capability is the features flag `agent_harness` ("Workspace agent"), **off by default**: off, nothing below exists
(no route, no MCP tool, no console page, no top-bar icon, no setting listed, no claimable kind) and the generated files
are byte for byte what they were.

## What the reference does

A person talks to a coding-agent CLI that runs in a sandbox. The CLI is started once per *wake* with its prompt on
**stdin as stream-json** (`--input-format stream-json --output-format stream-json --replay-user-messages`), and stdin
is **held open**: every further instruction is one more stream-json user line. The control plane is a database row per
run (a *conversation*) and one *attempt* per wake. The harness heartbeats; the heartbeat's answer carries the
person's queued instructions (*steer*), a pause request and an end request. Around that:

| Reference piece | What it is |
|---|---|
| Harness flavours and the hooks directory | Each harness flavour declares its lifecycle hooks (`on_start`, `on_resume`, `append_system`); a run snapshots the resolved hook text at launch and writes it beside the agent |
| stdin ledger | A turn's result closes stdin only when no injected message is still unconsumed (the CLI's replay echo tells which were taken in); else an idle grace closes it |
| Steer | Queued `pending`; delivered on the next heartbeat; `discarded` when stdin is gone, then carried to the next wake |
| Approvals | A tool call outside the run's policy (a web domain not granted) pauses the run with a request; Approve grants exactly that and resumes the same session; Decline ends the wait with the refusal as the reason |
| Pause / resume / stop | Pause = SIGTERM so the CLI flushes its session file, attempt ends `paused`; resume = a new attempt with `--resume <session>` and the `on_resume` prompt; stop = EOF (a turn in progress finishes) |
| Parking | An idle conversation (or one past a wake's duration cap) closes stdin and its attempt ends `conversation_parked`: no sandbox, no slot, not counted against the attempt ceiling; the next message wakes it on the same session |
| Crash recovery | A wake that dies is reaped; with a session id and a checkpoint it can resume (operator, or automatically under a master switch and a crash-loop spend fraction); at most N consecutive crashes; what the dead wake left unanswered is asked again |
| Spend once per session | Cumulative cost per heartbeat, charged as the climb over a per-attempt high-water mark; a resumed session's CLI restarts its running total from the saved figure, so the baseline is `min(saved, charged)` |
| Budget increase | A per-run raise, with a reason, up to the platform ceiling, refused while executing, recorded as its own fact |
| Retention and workload budgets | Short-lived payloads (messages, events, steer lines) pruned N days after a run ends; a workload's own allowance is authoritative and frozen at admission |
| Multi-provider credentials | The run never holds a provider key: a per-attempt token to a metering broker that refuses past the allowance |
| Web tools policy | Web tools off by default, opted in per workload; allowed hosts exact or suffix; calls counted against a ceiling; anything else becomes an approval |
| Agent image: process and exec guards, the CLI's permission file | The CLI's own permission file denies by default; a preload library keeps provider secrets out of every child's environment |
| Domain MCP tools | The platform's own MCP servers reach the agent through an MCP config the harness writes per attempt (`--mcp-config` with `--strict-mcp-config`): each server over HTTP, its `Authorization` a `${...}` reference to the attempt's token in the CLI's environment, its tools allowed by name (`mcp__<server>__<tool>`). The server takes the tenant and the run from the token, never from the input, and re-reads the acting person's membership and role on every call |
| Context | Per-workload and platform text appended to the system prompt (`append_system`) at launch |

## Where each piece lives in mold_v0

Nothing here is a second engine: a conversation is a row of its own, and **each wake is a run of the generic run
engine** (mold_v0-041), claimed, leased, metered, sandboxed and limited exactly as every other run.

| Reference | mold_v0 home |
|---|---|
| Conversation (run) | `harness_sessions` (migration 0044; named apart from the session engine's own `agent_sessions`, a host pack's table): one row per conversation or task, its state, its frozen policy (harness, model, provider, limits, web tools, the resolved hooks), its budget and ledger, its harness session id and checkpoint, its retention deadline. Control plane: `src/harness-sessions.ts` |
| Attempt / wake | A row of `runs`: the built-in kind `_agent/session` (`runner: "agent-harness"`, `src/agent-harness-config.ts`), not a pack's; listed by `runnableKinds()` for claims and the run sandboxes' demand only when the flag is on (never by `jobKinds()`, so schedules, the developer API, Compute's kinds and the MCP's `start_<kind>` tools do not see it). `runs.harness_session_id` links a wake to its session |
| Harness runner | `src/agent-harness.ts`, dispatched from `src/run-harness.ts runWorkspaceHarness` for `runner: "agent-harness"`: the same run user per run (`run-users.ts`), the same egress proxy and sandbox lockdown, the same run tools (`claude-code`, pinned in `run-tools.ts`), and the same `RunnerClient` (in process, or over `/api/worker/runs` with the fleet or a run sandbox's token). Runs on boat or docker run sandboxes and on-premises runners unchanged |
| Flavours and hooks directory | `src/agent-harness-config.ts` `AGENT_FLAVOURS` and `AGENT_HOOKS`: a typed declaration bundled with the server (the API and the runner read the same module, so they cannot disagree, which is the reference's reason for the directory). `claude-code` has `on_start`, `on_resume`, `append_system`; a flavour that reads stdin to EOF is declared `holds_stdin_open: false` and gets no steer (refused at the API, discarded at the runner). The resolved hooks are frozen into the session at start and written to `<scratch>/hooks/<event>/{prompt.md,source}` before the CLI starts |
| Heartbeat carrying steer, pause, end | `POST /api/worker/runs/:id/agent/beat` (lease-checked like every worker step): renews the lease (`heartbeatRun`), accrues spend, and answers `{steer: [...], pause, end, budget, cancel}`; `/agent/turn`, `/agent/request`, `/agent/checkpoint`, `/agent/end` |
| stdin ledger, replay echo, idle close, transient retry | `src/agent-harness.ts` (`encodeStdinMessage`, `replayedUuid`, `SteerLedger`, `transientUpstreamError`), pure and unit-tested |
| Spend accounting | The gateway already meters every request of a run (`gateway_usage.run_id`): each request counted once, to the wake that made it. The harness's cumulative report is accrued too (`accrueSpend`: high-water per wake, baseline `min(saved, charged)` on a resumed session) and the session's spend is the greater of the two ledgers, never their sum |
| Budgets (run, workload, platform) | The session's budget (frozen at start from the setting, clamped to the ceiling) less what it spent and the crash reserve becomes each wake's `budget_usd`, so the gateway refuses past it as for any run. The workload budget is the built-in kind's month budget per workspace (`run-limits.ts`), and the account's allowance applies as for every run (`checkRunStart`, `runSpendRefusal`) |
| Budget increase | `harness_budget_grants`: per session, a reason required, up to the ceiling setting (itself at most the platform's `runs.budget_usd_max`), refused while a wake runs, recorded with who and why; it moves the session's budget and so the next wake's |
| Approvals | `harness_session_requests` (`web` a host, `tool` a tool outside the policy, `budget` a stop on budget): pending → approved / declined / expired. Approve grants exactly that to the session and wakes it on the same session; Decline records the refusal and parks it with the refusal said on the next wake. A pause past `AGENT_APPROVAL_WINDOW_HOURS` expires |
| Parking, waking | Phase `parked` (no run, no slot); a message wakes it: a new wake run with `--resume`; messages sent while starting or waking wait `pending` for the next beat |
| Crash recovery | A wake that ends without saying how (the run engine's lease sweep: its runner stopped heartbeating; or the harness CLI died) parks the session with its last checkpoint and the messages it left unanswered pending again; the next message (or, with `AGENT_AUTO_RESUME` on, at once) wakes it on the same harness session, at most `AGENT_CRASH_RESUMES` in a row and not once crashes have spent half its budget; the silent window's estimated cost is held back from the next wake (`reserve_usd`). `reconcileWake` is called from `completeRun`, `sweepRuns` and the sweep, for agent wakes only |
| Working directory | Each wake works in the session's own scratch, `<tmp>/agent-sessions-<runner uid>/<session id>/` (`sessionScratch`, mold_v0-246): the same path on every wake, so the CLI's working directory (`state/work`) never changes under it and the CLI finds its saved session under the same project. The parent is the runner's (0711, refused if it is a link or another user's); each session's directory is its own (0700, the state its run user's). A wake writes its run id beside the state; the directory is removed when the wake ends unless a later wake holds it, and one a dead runner left is taken away by the next wake |
| Session checkpoints | The CLI's session directory and the working directory, a gzipped bundle (`workspace-bundle.ts` format) sent with the lease (`PUT .../agent/checkpoint`, at most the API's one-request size, `APP_WORKER_INLINE_MAX_BYTES`, 4 MiB: a larger one is refused and the previous stays), sealed with the workspace's key and kept in the object store (`storage.ts`: a bucket, or `APP_STORAGE_DIR`) under `workspaces/org-<id>/.agent/<session>/<seq>.wse`. Each checkpoint takes a newer sequence; the pointer only moves forward and the older object goes |
| Retention | `retention_until` per session (`AGENT_RETENTION_DAYS` after it ends or is archived); the scheduler job `harness_sessions` (`src/schedules.ts` tick) removes its messages, requests and checkpoint, keeps the session's spend, its budget raises and the run rows. Parked sessions quiet for `AGENT_ARCHIVE_AFTER_DAYS` are archived; requests past `AGENT_APPROVAL_WINDOW_HOURS` expire |
| Credentials broker  | Already the shell's gateway (`src/gateway.ts`): a per-attempt token, gateway-mode providers only, refused past the run's budget |
| Web tools | Settings `AGENT_WEB_TOOLS` (off, fetch, search and fetch), `AGENT_WEB_HOSTS` (allowed without asking: exact or `*.suffix`) and `AGENT_WEB_CALLS_MAX`; frozen into the session; the harness renders them into the CLI's allow and deny rules, refuses a call past the ceiling and turns a host not granted into an approval request. The run's egress proxy allowlist is the session's hosts plus the gateway |
| Process guards | The shell's run user per run already keeps the runner's environment unreadable (`/proc`), and the CLI gets only the gateway token and `RUN_*`; the harness redacts the token from every line it posts |
| Console | The top bar's last item, after Search, Docs and the theme switcher: one icon button (`aria-label="Workspace agent"`) that opens `/app/agent` (staff: `/admin/agent`). The agent opens as a **full in-page view**: the sessions list in the standard layout (four cards, the search row with Start a session, the table), a row opening the session's full card: the transcript, the composer, approval cards, Pause / Resume / Stop, the budget and Raise budget, and "How this session runs" (what it reaches of the workspace, its limits, its wakes). **One exception to the console's full-card rule, the operator's (mold_v0-249): Start a session opens as a modal dialog** (the first message; the model, shown, set by staff; the budget, the setting's unless the person lowers it, or up to the ceiling for a billing manager or owner; the kind and an optional title; Start), with its focus held inside, Esc closing it and its title naming it; on Start the new session opens as its full card. Nothing else on the page is a dialog. Staff see every workspace's sessions and may pause, stop and raise, never message (a session acts for the person who started it) |
| Platform settings | Group `agent` ("Workspace agent") in `src/settings.ts`, `readBy: "agent_harness"`: listed by `list_settings`, editable by `update_setting` and on the staff Agent configuration page only with the flag on; each with plain words; every change is kept in `platform_setting_changes` (key, value before and after, who, when), beside the existing `settings.save` staff log line (and the platform trail's admin entry when it is on) |
| Domain MCP tools (mold_v0-250) | The app's own customer MCP server (`/mcp`, `src/server.ts`) as the MCP server `app`: `src/harness-reach.ts`. See "What a session reaches" below |
| Context (mold_v0-250) | The workspace's context and memory and the server's own instructions, appended to the standing instructions: see below |
| API and MCP | `/api/agent` (customer), `/api/admin/onboarding/agent` (staff); MCP tools `list_agent_sessions`, `start_agent_session`, `read_agent_session`, `message_agent_session`, `pause_agent_session`, `resume_agent_session`, `stop_agent_session`, `decide_agent_request`, `raise_agent_budget` (customer), `list_agent_sessions` and `stop_agent_session` (admin) |

## What a session reaches (mold_v0-250)

The reference's agent works with its platform's own MCP tools and is told its tenant's context; until mold_v0-250 the
mold's agent had an empty working directory and nothing else. Now, with the flag on, a session reaches its workspace the
same way (`src/harness-reach.ts`; nothing changes with the flag off):

- **The app's own tools, as the person who started it.** At its start the session asks the customer MCP server what it
  lists to that person (an in-memory client, as the client skill does): the host packs' and packs' tools, the record
  tools, the memory tools; never the agent's own session tools (an agent does not start or steer sessions). Each wake gets
  one token (`hst_...`, only its sha256 kept, `harness_session_tokens`, migration 0047) and its CLI an MCP config naming
  the server `app` at the API's `/mcp` (not `workspace`: the pinned Claude Code reserves that name and silently drops a server called so) (the gateway's own address, so the run's egress already allows it), its
  `Authorization` a `${RUN_WORKSPACE_TOKEN}` reference to the wake's environment; the runner redacts the token from every
  line it posts. `/mcp` resolves the token on every call: the workspace is the session's (no argument names another),
  the person's membership and role are read again (gone or suspended: refused), and it works only while its wake is the
  session's current one and running, the session is not pausing or stopping and has budget left. It is revoked when its
  wake ends (parked, paused, awaiting a decision, budget, stopped, a crash), when a pause or stop is asked, at budget and
  when the session ends, and expires with its wake's deadline.
- **Reads free, writes asked.** A tool is a read when it says so (`readOnlyHint`). The platform setting
  `AGENT_WORKSPACE_TOOLS` ("Workspace tools used without asking": reads (default), reads and the tools named in
  `AGENT_WORKSPACE_TOOLS_NAMED`, or all) decides which go into the session's allowed tools (`mcp__app__<tool>`),
  frozen at its start like the other settings. Calling any other is an approval request of kind `tool` (the existing
  `harness_session_requests` flow): the wake stops, the request carries what the call wanted to send, Approve lets that
  session use the tool from now on and wakes it, Decline parks it. The server refuses such a call too (403), so a token
  taken out of the sandbox can do no more than the session may. A tool's own role check still applies (a viewer's
  session cannot write whatever the setting says).
- **Context as standing instructions.** Appended to the `append_system` hook's text on every wake: who the session works
  for and with which role, the workspace's tools (which are free, which ask first), then the server's own instructions
  (the profile's or the packs', as an AI client gets them) and the company's and the person's context and memory
  (`connectContext`: the memory component's, then a host pack's own), each cut to its share of `AGENT_CONTEXT_MAX_CHARS`
  (12,000 by default; a third for the instructions, the rest for the context; 0 gives none). Frozen at the start; for
  anything newer the session searches memory with the tool.
- **The session card says what it reaches.** "How this session runs" lists who it acts as (and that the role is checked
  again on every call), the tools it uses without asking and those that ask first, and the context it was given with each
  part's size (and whether it was shortened). No internal id is shown (its wakes are numbered).
- **Isolation.** A token opens `/mcp` only (never a URL, never another route); its workspace is the session's. The test
  proves another workspace's record is not found through it, and that its list and memory searches return only its own.

## Deliberately not copied

- **The reference's product surfaces**: its pipelines, entities, report proposals, checklists, eval datasets and
  use-case picker. The agent's domain tools are copied the reference's way (mold_v0-250, "What a session reaches"): the
  app's own customer MCP tools, whatever its packs declare; the mold adds no domain tool of its own.
- **A governed gateway in front of the MCP servers.** The reference serves its MCP servers through an egress gateway
  that ledgers every call per attempt. Here the CLI calls the app's `/mcp` directly with the wake's token; each call is
  in the MCP usage log (`mcp_events`, client `workspace-agent`) and, with `audit.data` on, the data trail.
- **A refreshed context per wake.** The context is frozen at the session's start (as the reference freezes a run's
  hooks); a session reads anything newer through the memory and record tools.
- **Per-workload prompts overriding hooks.** The reference lets each workload override `on_start`/`on_resume`/
  `append_system`. The mold has no workloads: the flavour's defaults apply and the person's message is the turn. The
  hook resolution still records each hook's `source`, so a pack-level override can be added without changing the record.
- **A second harness flavour that runs.** The catalogue declares the contract for a stdin-to-EOF flavour (no steer),
  but only `claude-code` is pinned in the run tools' catalogue; another CLI is offered only once it is pinned with its
  checksums. The harness choice setting lists the flavours that can run.
- **The preload process guard and the exec guard (C libraries).** The run user per run and the clean environment cover
  what they protect in the mold's sandbox model; adding a native library to every run image is a separate change.
- **Provider-side billing reconciliation and an IAM credential per run.** The gateway is the ledger the budget guard
  trusts; there is no per-run cloud identity to retain or revoke.
- **Model-call tracing, voice input, shared threads, the thread sidebar.** Not part of steering.
- **Native web search.** `search` only allows the CLI's own search tool where the provider serves it; no search
  backend is added.

## Mold pieces this does not use yet, and why

Since mold_v0-250 a session does use the customer MCP server (and through it the record areas, the packs' tools and the
memory component), the account context and the member role check: "What a session reaches" above.

- **The workspace credentials vault.** A session receives no workspace credential: the reference's agent works with what
  its platform's tools give it, and the mold has no declaration yet of which credentials a session may hold. A kind's
  `credentials` list is the model to follow when one is wanted (the run engine already delivers and redacts them).
- **Record clocks.** A request's window is the session's own deadline (`AGENT_APPROVAL_WINDOW_HOURS`, expired by the
  sweep), not a record's clock: sessions are not records of a declared area, so a clock has nothing to attach to.
- **The event outbox.** The reference raises an alert row in the transaction that resumes a crash automatically. Here
  that decision is a run event (`agent_crashed`, the next wake's `agent_wake`) and a staff log line
  (`agent.auto_resume`); a declared developer event (`agent.session.*` webhooks) is left for when an app asks for one.
- **The data audit trail.** Steering is recorded in the session's own tables and the run's events; staff actions on a
  session are in the staff log and, with `audit.platform` on, the platform trail (every `/api/admin` request).

## Proofs

`npm run test:agent-harness` (offline, an embedded database, a stand-in CLI speaking stream-json): steer mid-run,
approvals, pause / resume / stop, parking and waking, crash recovery, spend counted once, budgets and a raise,
retention, the settings' audit, and what a session reaches (the context composed and capped; the tools as the person,
reads free and writes as approvals; a wake end to end with the stand-in CLI calling the server through its MCP config;
the token scoped, refused on another workspace's records, revoked at pause, park, stop, budget and when the person
leaves); `test:features`, `test:zero-pack` (the zero-pack hash unchanged), the run tests,
Octillion parity with the flag off, and screenshots on the example app's lane copy with the flag on.

### A real session (mold_v0-245, measured once, 2026-11-05)

On the example app's lane copy with the flag on (the lane world: its API on an embedded database, its gateway), one
session ran the **real** Claude Code: the pinned `claude-code` 2.1.316, installed and verified by `run-tools.ts` as a
wake verifies it, `claude-sonnet-5-5` on Claude on Vertex AI (global) through the lane's own gateway, budget $1.
Egress was off (the lane gateway listens on 127.0.0.1, which the run's proxy does not allow) and the CLI ran as the
runner's user; everything else was the shipped path (`runWorkspaceHarness`, the beat, the stdin ledger, checkpoints in
the object store).

- **Steer mid-turn.** A message sent while the first turn worked was delivered on the next beat (1 s later, the CLI
  still in its turn) and answered by that same turn: the file it was asked for got the extra item.
- **Park and restore.** The watcher's clock was moved past the quiet window: stdin closed, the CLI exited, checkpoint
  1 (22 KB, sealed) was kept and the wake's directory removed. The next message woke a new run that unpacked the
  checkpoint into a fresh directory and ran `--resume <the CLI's session>`.
- **Coherent.** The restored session gave back a code word said only in the first wake and written nowhere, and read
  the file the first wake wrote (all four items). It also noticed its working directory's path had changed (each wake
  has its own scratch directory); harmless, but the path is visible to the model.
- **Spend against the provider's usage.** 6 model calls, none refused. The gateway's tokens equal the provider's,
  call for call (input with cache 60,045, output 744). In dollars, at the platform's own price for the model ($2 input,
  $0.20 cache read, $10 output per million) with the provider's 1.25x cache-write rate: **$0.115553**. The session
  counted **$0.113755** (its larger ledger, the CLI's own total), 1.6% under: the CLI prices cache reads at $0.10 per
  million (17,986 of them: exactly the $0.001798 gap). The gateway's meter counted **$0.095156**, 18% under: it prices
  cache writes at the plain input rate (40,796 of them: exactly the $0.020398 gap). A resumed CLI re-reports what it had
  already spent (its total went on from $0.078566), and the baseline took that out: the second wake was charged $0.035189,
  nothing twice.

Its three findings were fixed in mold_v0-246:

- **Cache writes at their own price.** The gateway meters Anthropic's cache writes apart (`cache_creation_input_tokens`,
  and the 1-hour ones among them) and prices them at the row's `cache_write_per_mtok` / `cache_write_1h_per_mtok`, or
  1.25x / 2x the input price when those are empty (migration 0045); cache reads stay at the cached price. The session
  above, priced by the gateway now: **$0.115553**, the provider's list-price figure (`npm run test:gateway-pricing`).
- **Haiku priced.** `claude-haiku-5-5` and `claude-haiku-4-5` have rows (0045), and the gateway refuses a request for
  a model with no row (400, in words: nothing is sent) instead of metering it at $0.
- **A stable working directory.** See "Working directory" above: the path is the session's, not the wake's.

## The agent's icon (mold_v0-252)

Everyone brings their own. The top bar's agent button (the shared outline button) and the agent pages' heading show, in
order: the workspace's own (an owner uploads it in Settings › Workspace agent: an SVG, PNG, JPG or WebP of at most 256 KB;
`src/agent-icon.ts` sanitises an SVG and resizes a picture, and keeps it sealed under the workspace's prefix), the app's
(its brand: `branding.py <app> set --agent-icon <file>` or `--agent-icon-name <name>`, light and dark), else the default.
An icon drawn in one colour follows the theme's text colour. Reset goes back to the app's. See MOLD.md "Workspace agent".

### A real session that reaches its workspace (mold_v0-250, measured once, 2026-11-06)

On the example app's lane copy with the flag on (the lane world, its seeded records, its gateway to Claude on Vertex AI
(global)), the pinned Claude Code 2.1.316, budget $1. The two Haiku models were refused by that Vertex project ("there's
an issue with the selected model", nothing spent), so the session ran on `claude-sonnet-5-5`.

- **Its tools.** The CLI connected to the app's server (`app`, by `--mcp-config`, the token expanded from the wake's
  environment): 58 tools as the lane workspace's owner, 43 reads without asking, 15 asking first. Asked "Summarise this
  workspace's findings", it called the app's metrics tool and its findings list tool (the API logged both for the
  session's client) and answered from the eight seeded records: each by key, severity, status and fix-by date.
- **A change asks first.** Asked to create a record, it called the app's create tool: the wake stopped with a `tool`
  request carrying what it wanted to send, the server ran no such call, and the wake's token was revoked ("awaiting a
  decision"). Spend: $0.23 of $1 (the gateway and the session agree).
- **Found and fixed on the way.** The pinned CLI reserves the MCP server name `workspace` and drops a server called so
  (said only in its init event): the server is `app`. The start dialog's budget field stepped by 0.5 from 0.1, so the
  browser refused the default $1: it steps by 0.01. The dialog library let Tab leave the dialog after its last control
  and did not give focus back to Start a session on Esc: the dialog wraps Tab itself and names where focus returns.
