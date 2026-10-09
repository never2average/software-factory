# How a specialist's result reaches the main agent

A person asks the main agent for something; the main agent hands part of it to a specialist (a subagent). This page
says when the main agent gets the specialist's result back, what it waits for, and what happens when a specialist
cannot finish. It was written after the report "subagents don't automatically message back the main agent"
(2026-10-05) and states only what was measured on the live runtime (eve 0.25.1).

## The rule eve applies

**This repo runs eve 0.25.1 with a patch (mold_v1-184; [Per-result delegation](#per-result-delegation-the-eve-patch)):**
the root agent sets `subagents: { batch: "detach" }`, so specialists called in one step report one at a time. Without
the setting (any other agent, a specialist's own delegations) eve's own rule applies, unchanged, and everything this
page measured about it still holds.

eve's own rule ("all"): the main agent's turn waits for **every specialist it called in the same step**, and continues
when all of them are back. Each specialist tells the waiting turn in exactly two cases: it **finished**, or it
**failed**. That hand-back is direct (the specialist's last step wakes the main agent's turn through the workflow
queue); no cron and no timer is involved, on Vercel or self-hosted, and it does not need a browser tab to be open.
Measured: 1 to 9 seconds from the specialist's last event to its result on the main thread.

| What happens | eve's own batch ("all") | Per-result ("detach", the root agent here) |
|---|---|---|
| One specialist finishes | its result, within seconds | the same |
| One specialist fails | the failure, as that delegation's result | the same |
| A specialist asks a question or needs an approval | nothing yet: it waits for the person | the same |
| Two called together, one finishes while the other asks | the finished result is **held** until the person answers and the other finishes | the finished result at once; the other as "reports later"; its result as a turn of its own when it finishes |
| Two called together, one finishes while the other is merely slow | held until the other finishes | handed over after 10 s (`detachAfterMs`); the other reports later |
| Two finish together | both together | the same (one hand-over) |
| A specialist is stopped on its own | a plain note from this repo: stopped, no result ([below](#what-this-repo-adds-around-that-rule)) | eve reports it as that delegation's result (`SUBAGENT_STOPPED`), once |
| The main thread is stopped | every specialist of the waiting turn stops | the same, and every "reports later" one stops too |
| Nothing is back yet and the step also ran tools of its own | the turn waits | handed over after `detachAfterMs` (10 s): every specialist "reports later" ([below](#the-main-thread-keeps-working-mold_v1-197)) |
| Nothing is back yet, 45 s after the call | the turn waits | handed over (`detachIdleAfterMs`): the main agent replies with what it has |
| A specialist froze, or its result or stop never came home | the turn waits for ever | the [specialist sweep](#the-specialist-sweep-mold_v1-196) settles it once |

"Held" is eve's design, not a loss: a model that called two tools needs both results before its next step. "Reports
later" is the patch's: the model gets a tool result that says so, and the real one arrives by itself.

## Called together

This section is what eve's own batch does, measured before the patch; it is still what an agent without
`subagents: { batch: "detach" }` gets. The root agent here has the setting
([Per-result delegation](#per-result-delegation-the-eve-patch)).

When the main agent calls two specialists in one step, eve resumes it only when both are back. A finished result
waits for its sibling: 6 minutes measured while a sibling worked, and for as long as nobody answers when the sibling
asks the person a question or for an approval. Read in eve 0.25.1 and run on its real runtime
(`npm run test:specialist-batch`), this is what can and cannot be done about it.

**eve has no mode that resumes on each result.** A step's delegations are one batch
(`setPendingRuntimeActionBatch`, harness/runtime-actions.js). The waiting turn loops in `waitForRuntimeActionResults`
(execution/turn-workflow.js) until `resolveRuntimeActionResultsForKeys` finds a result for EVERY key, and only then
is the model called again (`resolvePendingRuntimeActions` returns `unresolved` otherwise). Each child resumes the
turn's inbox hook (`<completion token>:inbox`) with its own result from `notifyDelegatedParentStep`, so results do
arrive one at a time; nothing in eve hands an incomplete batch to the model. No agent setting, tool option or
`experimental` flag changes this (`docs/subagents.mdx`: "eve runs the batch concurrently and returns every result
before the root continues"; the experimental `Workflow` tool is the same barrier, run as one step).

**The app cannot deliver a finished result early without a duplicate or a loss.** Two ways were examined:

- *A message to the main thread while it waits* (the system-attributed hand-back #114 uses). eve accepts it (200),
  emits nothing, and keeps it: the session driver buffers deliveries during a turn (`TurnControlReceiver`), and the
  only delivery a waiting turn takes is routed to the children by request id (`routeDeliverPayload`; a plain message
  is "for self" and buffered). It runs as a turn of its own after eve has delivered the batch. Measured: the note
  reached the main agent AFTER both results and after its reply on them. So the result would reach it twice, and no
  sooner.
- *Ending the waiting turn, then telling it* (what #114 does for a stopped specialist). Cancelling the turn cancels
  every child still at work (`cancelDescendantTurnsStep`), and settling it clears the turn's pending delegations and
  every proxied question (`settleCancelledTurnStep`). A sibling waiting on the person is left parked on a token
  nothing can address, its question gone from the main thread: the person's work is lost. That is why a lone Stop
  is refused while a sibling is live, and it is the same here.

**What this repo did first (#121): it avoided the shape.** The root agent's delegation rule (`delegate-rules` in
`agent/prompt-neutral.md` and `agent/prompt-persona.md`) said: "Specialists called in one step return together, so if
one will need the person's answer or an approval, get that first or run that specialist on its own." The sentence
must be true in both batch modes (a program's session keeps eve's batch), so it keeps that advice and adds how a late
result reaches the main agent: "Specialists called in one step may return together, so if one will need the person's
answer or an approval, ask for that first, in a step of its own, or run that specialist alone. One marked "reports
later" sends its result to you by itself: answer with what you have and do not call it again." ("in a step of its
own" was added after the live rig of 2026-10-06, below: a model read "get that first" as asking in the same step.) A specialist told in its brief to return a question instead of asking holds
nothing either; on the real runtime such a batch handed a finished result to the main agent 0.8 s after its
specialist finished. To make room, five passages of `agent/prompt-core.md` were reworded without dropping a rule, and
the stable prompt was at 1,311 of its 1,400 words (`test:prompt-context`; `test:specialist-batch` holds it at 1,350 or
less; 1,347 since mold_v1-197, whose rewording of the same bullet is [below](#the-main-thread-keeps-working-mold_v1-197)). This is guidance to the model, not a guarantee: a model can still batch a specialist that asks. The `apart` rig shape (below) measures what a deployed model actually does. Everything
#114 established is unchanged (no new message is sent, no new record is kept).

## Per-result delegation (the eve patch)

Implemented in `patches/eve+0.25.1.patch` (how it is applied and checked: docs/EVE_PATCH.md; every edit, readable,
with its reason: `scripts/eve-patch/changes.mjs` and `scripts/eve-patch/files/`). Run on the real runtime by
`npm run test:specialist-detach`, over recorded streams by `npm run test:detached-delegation`, and against a running
app by the rig ([below](#checking-a-running-app)).

**The setting.** `defineAgent({ subagents: { batch: "all" | "detach", detachAfterMs } })`, default `"all"`: eve's own
batch, the same code path as before (the "all" scenario of `test:specialist-detach` holds a main thread to unpatched
eve 0.25.1, event for event). The root agent (`agent/agent.ts`) sets `"detach"`; `detachAfterMs` defaults to 10 000.
It applies to conversation sessions (the main thread), never to a task session (a specialist's own delegations or a
schedule).

**Only for a person in the chat.** A session a PROGRAM opens — a workflow step, an app refresh, a cron step, all through
`lib/workflow-delegate.ts` — reads the main agent's LAST reply as its value; after a hand-over that would be the late
result's own turn, perhaps a short addendum. So such a session keeps eve's own batch: the program sends
`x-eve-subagent-batch: all`, the agent's channel puts `eve_subagent_batch: "all"` on the auth the session is created
with (also for any service principal, header or not: `agent/lib/subagent-batch-auth.ts`), and the patched eve reads it
from the session's creator. The attribute can only narrow; nothing turns "detach" on for a session (lib/subagent-batch.ts).

**When a batch is handed over early.** In the turn's wait (`waitForRuntimeActionResultsDetaching`, beside eve's
`waitForRuntimeActionResults`), once at least one delegation's result is in and another is still out:

- at once, when one still out has asked the person something (its proxied question or approval reached the turn);
- otherwise after `detachAfterMs`, counted from the first result. This bound is deliberately NOT durable. A durable
  workflow `sleep` cannot be cancelled: when the batch resolved before it, it woke the turn's run later anyway, while
  the next model call ran, and whether such a late wake can run a step twice on Vercel's world is decided by Vercel's
  queue and server, not by code here. So the wait creates a hook of its own (`<inbox>:detach-timer:<n>`), a step arms
  an in-process timer that resumes it after the bound (kept alive on Vercel with the request's `waitUntil`), and every
  way out of the wait disposes the hook: a timer that fires after the batch resolved finds no hook and wakes nothing.
  The hook acts only on `{ kind: "detach-timer" }` (eve's callback routes can resume any hook by token, with other
  kinds). The cost: a process that stops before the bound loses its timer, and that batch waits as eve's own does
  (unless a question hands it over);
- never when one still out is not a local delegation of this turn (a remote agent, the experimental Workflow tool):
  those have no way home and are waited for as before.

The main agent then gets the results that are in, and for each one still out a stand-in tool result:
`{ status: "running", childSessionId, name, note }` (the note tells the model its result will arrive by itself and not
to call it again). The chat draws that delegation as **"Working — reports later"**; its question, if it asked one, stays
on screen and answerable.

**Durable state.** The session records each detached delegation in `eve.runtime.detachedDelegations` (call id → name,
specialist, child session, child continuation token). It is the one source of truth for "still owed".

**The way home.** A delegation started under "detach" carries its parent SESSION's delivery token
(`parentSessionContinuationToken`, in the subagent adapter state) beside the turn's inbox token, and its
`subagent.called` says `detachable: true`. What it sends home (its result, its stop, its question) goes to the turn's
inbox as before AND to the session's delivery hook as a `deliver` whose payload is only `delegationResults` (or
`delegationRequests`) — when its batch has two or more actions, the only batches that can be handed over early. A lone
delegation sends the session copy only if the turn's inbox is gone, so most delegations add no extra wake-up of the
session driver. Exactly one of the two counts:

- if the batch still waits for it, the turn's wait consumes the inbox copy; the session copy reaches the driver later,
  finds the call not recorded as detached, and is dropped;
- if it was detached, the turn ignores the inbox copy (or the inbox is gone); the session driver, between turns, keeps
  the session copy because the call is recorded as detached, and runs a turn with it.

That turn shows the result to the model as a TOOL-role message answering a synthetic call of the specialist's own
tool (`<call id>_result`, input `{ resultOf: <call id> }`); never a user-role message. eve's own `subagent.completed`
and `action.result` (same call id) are emitted, so the chat writes the result over the stand-in on the same card. The
turn removes the record, so any later copy (a retried step, a second instance) finds nothing to deliver: **exactly
once**, decided by the durable session state, not by timing. Measured: five copies of one result sent through the
durable queue at once, one delivered (`test:specialist-detach`, "twice").

**Mid-turn.** A late result that lands while the main thread is in another turn waits in the driver's delivery queue (or
in the turn's buffered deliveries) and runs as a turn of its own when that turn ends: never lost
(`test:specialist-detach`, "midturn"). One that lands while the main agent waits on ITS OWN question or approval is
deferred to the turn that answers it, and only while that question is still unanswered (decided after eve resolves
pending input, never before): the answering turn delivers it, also when it then calls specialists of its own
("ownq", "ownqthen"; a first version deferred it again there, and the batch that followed lost its results and was
dispatched twice). A late result is also deferred, not dropped, when the session's token limit ends the step.

**The person's question stays answerable.** A detached specialist's proxied question is not cleared when its batch is
handed over (eve cleared a child's questions when its result came; a stand-in is not a result). An answer between turns
reaches the specialist as it did during the wait (the driver routes `inputResponses` by request id); a question a
detached specialist asks later reaches the main thread through the session too, emitted between turns without a turn
epilogue.

**Stopping.**

- A detachable delegation stopped on its own reports it: after its cancelled turn settles, it sends home
  `{ isError: true, output: { code: "SUBAGENT_STOPPED", … } }` like any result. Into its batch if the batch still waits
  (the batch goes on, nobody cancels the main thread's turn), as a late result if it was detached; once either way. So
  this repo's own hand-back (#114, below) is not used for it: the session guard leaves the cancel to eve and sends no
  message (`planStop` answers "plain" for a detachable delegation).
- Stopping the main thread stops its "reports later" specialists too: eve's cancel of the turn now also cancels the
  detached ones (`cancelDescendantTurnsStep`), and the settle of the cancelled turn closes each on the stream (its
  `action.result`: stopped) and in the history (the model reads it on its next turn), and clears the records, so
  nothing is delivered after the Stop. With no turn running eve has nothing to cancel; the session guard then stops
  them itself, and each reports its stop.
- A specialist waiting on the person's answer (or an approval) has no turn running, so eve's cancel used to answer
  `no_active_turn` and nothing stopped it: inside a waiting batch the batch went on waiting, and once handed over the
  card said "Working — reports later" for ever. Now a detachable delegation, while parked between turns, listens on a
  hook of its own (`<session>:stop-parked`), and eve's cancel route, finding no turn, stops it there (a cancel that
  names a turn id never does). The hook acts only on the payload eve's cancel sends, `{ kind: "stop-parked" }`; eve's
  unauthenticated callback routes, which can resume any hook by token, send `runtime-action-result` or `deliver`, and
  are ignored (the hook stays, `test:specialist-detach` "forgery"). It settles like a stopped turn, reports `SUBAGENT_STOPPED` once — into its batch, or as a
  late result — and its session ends, so a second Stop answers `no_active_turn`. Its question on the main thread is
  retired with it. This is the path for the Control Panel's Stop, for stopping the main thread (eve's cascade, and the
  session guard when the main thread is idle), and for a program step stopping what it cannot answer.

**Mixed versions.** A driver with the patch announces `driverCapabilities.delegationResults` in each turn's input, and
a turn detaches only under such a driver. See [Deploying and rolling back](#deploying-and-rolling-back).

**Every eve function the patch changes**: `normalizeAgentDefinition`, `compileAgentConfig`,
`compiledAgentConfigSchema` / `createCompiledAgentNodeManifest`, `resolveAgent` (the setting); `createTurnWorkflowInput`; `turnStep`; `dispatchRuntimeActionsStep`, `buildSubagentRunInput`;
`runTurnOwnedWorkflow` (+ new `waitForRuntimeActionResultsDetaching`, and the new step `armDetachTimerStep` beside
`forwardTurnDeliveryStep`); `resolvePendingRuntimeActions`; `hasStepInput`,
`compactStepInput`, `coalesceTurnInputs`, `coalesceDeliverPayloads`; `executeStepBody` (+ new
`deliverLateDelegationResults`); `notifyDelegatedParentStep`, the subagent adapter's `forwardSubagentInputRequestStep`
and `forwardSubagentAuthorizationEventStep`; `runDriverLoop`; `runProxySubagentEventStep` /
`emitProxiedSubagentEvent`; `cancelDescendantTurnsStep`; `settleCancelledTurnStep`; `requestWorkflowTurnCancellation`
(the parked stop); and in eve's local workflow world, `events.create` for `step_started` / `step_completed` /
`step_failed` / `step_retrying` (mold_v1-191, below); `public/channels/index.js` (exports `delegationSweep`,
mold_v1-196). New modules: `harness/detached-delegations.js`, `execution/parent-session-delivery.js`,
`execution/delegation-sweep.js`.

### Found by the live rig (2026-10-06, self-hosted, Kimi K2.6)

Two of seven shapes failed on the first deploy. Neither was a lost or doubled result.

- **`apart`: a question asked in the same step as a specialist call failed the turn.** The main agent called one
  specialist and, in the same step, asked the person its own question (`ask_question`) instead of delegating the
  other piece of work. eve 0.25.1 (`harness/tool-loop.js`) sends a step's runtime actions and drops a question or an
  approval request made in that step: nothing is shown to the person, and the call is left with no tool result. When
  the specialist's result came back, the next model call failed with `AI_MissingToolResultsError` (`step.failed`
  `MODEL_CALL_FAILED`, then `turn.failed`). This is eve's own batch code, so it fails the same way with `batch: "all"`.
  It is not the sandbox guard, the bound's timer or the local world's refusal (none of them logged anything for this
  session). Fixed in the patch (`resolvePendingRuntimeActions`, both modes): each such call is answered, with the batch's
  results, by a tool error saying it was not asked and to ask again on its own. The prompt sentence now says "in a step
  of its own". `test:specialist-detach` scenario `samestep` (and a check in `all`) reproduces the exact error without
  the fix.
- **`two`: resumed, but slowly, and the rig read the wait as "not resumed".** One specialist asked, so the batch was
  handed over at once, and the main agent's next model call began. It reasoned for three minutes (about 47,000
  characters) over "reply when both are back" versus the placeholder's "do not wait for it". The asking specialist
  finished 10 s into that, and its late result waited for that turn to end, as designed: one turn at a time. It was
  then delivered once, as its own turn, and the main agent replied with both. Two changes:
  - The placeholder's note now settles the choice: "Reply now with what you have and say this one is still working".
  - The rig counts a late result's lag from when the main thread is free again, and says "mid-turn" rather than "not
    resumed" when it is still in a turn.

### With the sandbox guard (agent/lib/sandbox-guard.ts)

On a self-hosted server with `SANDBOX_BACKEND=microsandbox`, the guard queues sandboxes past the running cap, stops idle
ones, and replaces a VM that stopped answering. None of that changes how a specialist's result comes back:

- **Waiting in the guard's queue is not "asking the person".** The detaching wait hands a batch over at once only for
  a question or an approval from that batch (eve's `subagent-input-request`, `authorization.required`). The guard
  emits no event: a queued sandbox call is a tool call that has not returned, so its specialist is slow. It is handed
  over after the bound as "reports later", and a call the queue gives up on comes back to it as the tool's result
  ("Waiting for a free sandbox: ...").
- **A parked or replaced sandbox still reports once.** Parking and the watchdog act below the tool call. The
  specialist's turn, its finish and its one result do not depend on which VM ran its commands. A watchdog stop is a
  tool error ("The sandbox stopped responding ..."), and the next command gets a fresh VM with the step's files.
- **A Stop does not wait for the queue.** The specialist's turn is cancelled at once and reported "stopped" once. Its
  queued call keeps its place until it gets a VM or reaches `SANDBOX_WAIT_S`, as it would under eve's own batch.

`scripts/test-sandbox-guard.mjs` (28 checks) and `npm run test:specialist-detach` (63) pass run side by side on the
same tree.

### Two results written twice (mold_v1-191) — fixed in eve's local world

eve sometimes wrote a delegation's `action.result` — and the main agent's following reply and `turn.completed` — twice,
tens of milliseconds apart, when two specialists finished together. It is not eve's batch; it is the workflow runtime
eve bundles, with eve's local world (`eve dev` and the self-hosted server). Read off `DEBUG=workflow:*` on duplicated
runs:

1. Two hook payloads reaching one run together (two results; or a result and anything else that resumes the turn —
   per-result delegation adds a timer and, for a batch of two or more, a session copy to the driver) start two
   invocations of the workflow at once, each replaying the run. (The bound's timer no longer adds a late wake: it
   resumes a hook the wait disposes when it ends.)
2. One of them runs the next step (`turnStep`) INLINE: it creates and starts the step itself.
3. The other, replaying from just before, finds the same step pending, fails to create it ("Step already exists,
   continuing") and still enqueues it. The queued executor's `step_started` is accepted on a running step (attempt 2:
   the path a crashed executor needs), so the step's body runs twice: the model is called twice and every stream
   write happens twice. One completes the step; the other logs "Tried completing step, but step has already
   finished". The session's durable state has the step's result once.

**The fix (in the patch, `compiled/@workflow/world-local`):** the local world notes, in its process, each step started
inline, and refuses a NON-inline start of it by another invocation while the runtime's own inline-ownership lease runs
(`WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`, 860 s, parsed and clamped to 1..900 as the core does) — as a conflict,
which the executor treats as "already taken" and skips. The lease is counted as the core's backstop counts it: from the
inline start event's `createdAt` to the new event's `createdAt`, so the backstop, due at exactly that boundary, is
accepted (a first version took the time after the note's file write, and refused a backstop landing within that
write's latency of the boundary, which the core never re-arms: `npm run test:eve-local-world-inline`). The note goes when the step completes, fails or is set to retry (so a retry starts), and with the process (so a
crashed owner's step is recovered as before). It applies to every workflow on the local world ("all" agents too).

**Measured** on `eve dev`, two specialists finishing together, counting from the debug log the steps run twice and the
second starts refused, and from the stream any repeated `action.result` / `message.completed`:

| | runs | duplicated runs | steps run twice | second starts refused |
|---|---|---|---|---|
| previous patch (no fix) | 150 (120 + 30) | 3 | 3 | — |
| this patch | 210 (120 + 90) | 0 | 0 | 4 |

(the 90 include 30 runs of per-result delegation with both results together and 30 with the 10 s-style bound outliving
its batch while the next model call runs — the stray-timer case, which showed no duplicate on either patch). Earlier,
on unpatched eve: 1 in 25 with its defaults, 18 in 60 with optimistic inline start forced on. Not covered: optimistic
inline start forced on for every step (`WORKFLOW_OPTIMISTIC_INLINE_START=1`; not set here), where two invocations can
both run a body inline before either start is recorded. Not verified: Vercel's world, whose queue and `step_started` are not this
code.

#### Re-measured on the current patch (2026-10-06)

`npm run stress:specialist-together` (scripts/stress-specialist-together.mjs) runs the shape many times on `eve dev`
and counts, per run, every `action.result`, `turn.completed` and finished `message.completed` on the main thread, and,
from the scripted model's own request log, how many times the main agent's model was called for its reply. Nothing is
collapsed. The scripted model hands both specialists' answers back in the same tick (`--child-barrier 2`), so the two
finish together; four runs go at once. `--jitter-ms` slows the local world's file reads and writes at random
(scripts/lib/world-io-jitter.mjs). "Fix off" is the current patch with the local world's refusal disabled.

| eve | batch | world jitter | runs | runs written twice | model called twice | second starts refused |
|---|---|---|---|---|---|---|
| current patch | detach | none, answers not held together | 160 | 0 | 0 | 0 |
| fix off | detach | none, answers not held together | 160 | 0 | 0 | — |
| current patch | detach | 0..25 ms | 200 | 0 | 0 | 0 |
| fix off | detach | 0..25 ms | 200 | 0 | 0 | — |
| current patch | all | none | 199 | 0 | 0 | 6 |
| fix off | all | none | 200 | 5 | 5 | — |
| current patch | all | 0..25 ms | 500 | 0 | 0 | 8 |
| fix off | all | 0..25 ms | 200 | 5 | 5 | — |

- **Every duplicated run called the model twice.** It is a double charge and a double reply, not only a double write.
- **What happens, from the debug log** of the 200 runs "fix off, all, no jitter". In every run two invocations replay
  the turn at once, one per result. Three outcomes:
  - both find the next step not yet created, and both try to create it. The world's create claim lets one through and
    the other skips it (115 times);
  - the second finds the first one's start and arms the core's delayed backstop instead (121 times);
  - the second reads the run's records after the first has written `step_created` and before its `step_started`.
    The local world writes these as separate files. The second sees a step that is created and has not started, owned
    by nobody, so it queues the step at once. The queued start is accepted, and the step body runs twice (5 times).
    With the patch that queued start is refused (6 times in 199 runs without jitter, 8 in 500 with it). The world handles one step's
    events one at a time in a process, so the refusal cannot be bypassed by arriving in the middle of the inline start:
    `test:eve-local-world-inline` holds an inline start between those writes and checks the queued start is refused
    (it is accepted as attempt 2 without the fix).
- **Why `detach` showed none, even with the fix off:** when the first result arrives while another is out, the
  detaching wait first runs its bound's timer step. Then the turn step does not start from two results arriving
  together. The race moves to that short timer step, where a late queued start finds the step already finished (3 in
  400 runs).

**The production backends.**

- **Self-hosted (example_app_vm): covered.** eve runs on its local world in one Node process
  (`node .output/server/index.mjs`, one systemd unit), the world and process the patch's note covers. Live, the rig
  against the server, 10 times `--shapes two,together`: 20 of 20 passed, nothing written twice
  (`rig-specialist-handback.mjs` now fails any shape that ends in the main agent's reply if the main thread has a
  repeated write; its new `together` shape calls two specialists that answer at once). A real model rarely finishes two
  specialists within milliseconds: they finished 46 to 3456 ms apart.
- **Vercel (example_app): not verifiable from here, and not covered by the patch.** The decision that queues the step
  is the shared workflow core's, so it is the same on Vercel. It only goes wrong if Vercel's backend can show a replay
  a step that is created and not yet started. That depends on whether the backend writes a lazy start's two records
  together, and Vercel's backend code is not public. If it can, the queued start is accepted there too: the core's own
  notes (workflow#2780) say a bare start of a running step runs it again. The patch's note lives in the local world
  only. The other two outcomes are safe on any backend. On Vercel the main thread's conversations run `detach`, which
  showed none here even with the fix off. `all` is used by sessions a program opens.

## The main thread keeps working (mold_v1-197)

With per-result delegation a specialist that finished never waited for a slow sibling, but the main agent still
STOPPED for its specialists in two ways, both measured on the real runtime (`npm run test:specialist-detach`, scenarios
`parallel` and `idle`, which fail without this change):

- **A batch with nothing back yet was always waited for.** `planDetach` handed a batch over only once at least one
  result was in. A lone delegation, or a batch whose specialists were all still at work, held the main agent's turn for
  as long as they took (minutes, for a real specialist), even when the request had parts that needed no specialist.
- **Work done beside the call could not be used.** The main agent may run its own tools in the step that calls a
  specialist (eve runs them; the specialist call is the step's runtime action). Their results sat in the step until the
  batch resolved: the main agent could not reply with them before the specialist came back.

**What changed in the patch.** Under a driver that announces `driverCapabilities.delegationSweep` (the new driver; a
turn whose input an older driver wrote replays unchanged) the detaching wait may hand a batch over with NOTHING back:

- `independentWork`: the step that called the batch also ran a tool of its own (its response messages hold a tool
  result for a call that is not one of the batch's actions; a question asked in the same step never ran, so it does not
  count). The batch is handed over `detachAfterMs` (10 s) after it was called: a fast specialist still comes back in the
  same reply, a slow one becomes "reports later" while the main agent answers with its own work.
- `detachIdleAfterMs` (a new setting; the root agent sets 45 s in `agent/agent.ts`; unset = never): a batch nothing has
  come back from for that long is handed over all the same, so the main thread never sits silent behind a specialist.
- Both arm a second in-process timer beside the bound's (`<timer token>:idle`, the same non-durable kind, disposed on
  every way out of the wait). `planDetach` takes `forceAll` for them (and for the sweep below).

A session a program opens keeps eve's own batch and is untouched: it reads the main agent's last reply.

**What changed in the prompt.** The delegation rule (`delegate-rules`, both prompt variants) now says: "In the step
that calls a specialist, also do the parts that need no specialist, then reply with what you have; hold back only a step
that needs its output. One marked "reports later" sends its result to you by itself: add it then, and do not call it
again." It keeps #126's lesson word for word ("ask for that first, in a step of its own, or run that specialist alone"):
a question to the person is never made in the step that calls a specialist. The stand-in's note says the same at the
moment it matters: "Now do the parts of the request that do not need this result, then reply with what you have and say
this one is still working. Do not call it again." Neither tells the model to wait for both, so the old "wait for both" /
"don't wait" choice does not come back: a person's "when both are back" is answered by the late result's own turn ("you
will reply again then"). To keep the stable prompt in its word budget, the ground rule that repeated the publish rule
went (the "Deliverables & artifacts" section says the same).

**Measured by the rig.** `parallel` asks for one delegated part (a 1500-word essay) and one that needs no specialist
(17 × 23). It passes only if the independent part reached the main thread BEFORE the specialist came to rest and the
specialist's result then reached the main agent once and was folded into a reply of its own, and it says how the
independent part got there (written in the step that called the specialist, or replied after the hand-over).

## The specialist sweep (mold_v1-196)

The factory's own operator hit this with their helpers: some finished and their final report never reached the main
thread; one sat silent for hours and nobody noticed. The app's main agent now gets the same hygiene for its specialists
(`agent/lib/specialist-sweep.ts`; wired in `agent/lib/specialist-sweep-run.ts`).

**What existed before.** The run-history sweeper (`closeAbandonedWorkflowRuns`, agent/lib/workflow-usage.ts) closes a
specialist's `automation_runs` row after 90 minutes untouched, exempting one parked on a question. It only fixes the
Control Panel's run list: it tells the main agent nothing, stops nothing and frees no sandbox, and a result that never
came home stays lost.

**When it runs.** Every 5 minutes (`agent/schedules/sweep-specialists.ts`: every workspace, each in its own row-level
scope, the main threads with a delegation within `SPECIALIST_SWEEP_LOOKBACK_H` not yet seen settled, or that its ledger
still has something open for), and whenever a message to a main thread reaches the session guard (that thread only, in the background: the
person's message is never held for it; at most once every 30 s per thread per process). Every scheduled pass writes one line to the
agent's log, also when it finds nothing (mold_v1-198): `[specialist-sweep] pass: 4 thread(s) checked in 2 workspace(s),
1 delegation(s) outstanding, acted on 1 (frozen 1, undelivered 0, unreported 0, surfaced 0) in 812 ms`. Counts only. A
pass that stops early writes the same line to the error log with `; stopped early: <the error>`.

**What a pass reads (mold_v1-199).** Only the main threads with a delegation still outstanding. The first version read
the stream of every main thread that delegated within the window: on the self-hosted server, 158 threads and 46–62 s a
pass for one delegation still out. Now a delegation has two marks in the database, both written by the agent from eve's
own streams: CALLED, its child's owner record (`agent_session_owners`, written as `subagent.called` passes through the
session guard, so the call is already in the main thread's history), and SETTLED, a row in `specialist_sweep_settled`
(`drizzle/0035`) written whenever a sweep (scheduled or at a turn start) reads the main thread and sees that the sweep
can never act on that delegation again: its real result is there, eve settled its batch (a later turn, a cancelled or
failed turn), or it is not one eve reports home itself. All final in an append-only stream, so a mark is never removed.
The schedule reads only main threads with a child that is called and not settled (or with something open in the
ledger): an old finished thread costs one index probe and no stream read, and a pass is proportional to the delegations
still outstanding. A delegation the sweep acts on is seen settled on the next pass's read, once. A nested specialist (a
specialist's own delegation) does not hold its main thread open: only a main thread's direct children are counted.

**Reading a long history (mold_v1-199, second part).** On the self-hosted local world a session's stream is one file
per event, and reading it from the start costs about 2 ms an event (`npm run test:specialist-detach`, `sweeptiming`). A
research thread or specialist with thousands of events did not fit the sweep's 10 s read at all: after the candidate
list was cut to 2 threads, each pass still took 20 s, two reads giving up at 10 s and the waiting specialist never
judged. The reader (`wholeHistory`, agent/lib/specialist-sweep-world.ts) now keeps, per process, what it has read of
each session (its events without the `.delta` / `.appended` streaming noise, the last event always kept) and how far it
got: a session is read from the start once, a read that runs out of time keeps what it got and the next pass goes on
from there (with one log line saying so), and after that a pass reads the tail and what is new. Two reads of one
session at once (a turn start's sweep and the schedule's) take turns. At most 128 sessions are kept; a restart starts
over.

**The catch-up.** Every delegation recorded before the marks existed has none, so the first pass after the deploy reads
exactly what a pass read before (the same window, under the same 240 s budget; what does not fit is read on the next
pass), finds any delegation lost before then (and settles it as always), and marks the rest. No separate backfill
step. An agent deployed before `drizzle/0035` is applied reads every thread in the window, as before (the log says
once to apply it).

**What it finds.** For each delegation the main thread has had no result for (its `subagent.called` has no
`action.result` but the "reports later" stand-in), from the specialist's own stream:

| | When | What the sweep does |
|---|---|---|
| (a) frozen | nothing written (no event, no progress) for `SPECIALIST_SWEEP_FROZEN_MIN` (30; never under 10), not waiting on a person, not waiting for a free sandbox | delivers "Stopped by the system: this specialist showed no progress for N minutes (the limit is 30). It returned no result. If the work is still needed, call it again." as the delegation's result (`SUBAGENT_STOPPED`), once; then stops it (eve's cancel); a run the cancel does not reach is ended on a later pass, which frees its sandbox |
| (b) finished, result never handed back | `session.completed`, and the main agent still has nothing `SPECIALIST_SWEEP_GRACE_S` (120) later | delivers the specialist's final answer as its result, once |
| (c) stopped or crashed, never reported | `turn.cancelled` at rest, or `session.failed`, and nothing after the grace period | delivers `SUBAGENT_STOPPED`, or `SUBAGENT_EXECUTION_FAILED` with eve's message, once |
| (d) waiting on a person | its question or approval unanswered for `SPECIALIST_SWEEP_WAITING_H` (4) | leaves it alone, and the chat says so |

It never closes a specialist that wrote anything within the bound or that waits on a person: the line
`delegation-failures.ts` draws for the run-history sweeper. "Not started yet" is not "frozen": a specialist that has
written nothing is dated from its call, and the bound is never under 10 minutes, past Vercel's 300 s queue delay. A
specialist whose stream cannot be read whole is not judged at all. A command waiting for a free sandbox (off Vercel) is a
tool call that has not returned, bounded by `SANDBOX_WAIT_S`: the sandbox line exempts it. Only delegations eve reports
home itself (`detachable`) are swept.

**Exactly once.** The sweep delivers only through eve's own late-result path, so the main agent reads each outcome as
that delegation's tool result, on its card, and never twice:

- A delegation handed over as "reports later" is owed in the main thread's durable session state. The sweep's copy is a
  `delegationResults` delivery to the main thread's session (`delegationSweep.deliverLateResult`, the payload a
  detachable specialist sends home itself); whichever copy the session takes first, the sweep's or the specialist's own
  arriving late, removes the record, and every later copy is dropped. A frozen specialist is told FIRST and stopped
  after, so its own stop report finds the delegation settled.
- A delegation whose turn still waits on it is first HANDED OVER: the patched wait listens on
  `<session>:delegation-sweep:<first call id>` for `{ kind: "sweep-detach" }` and goes on as at its bound, every
  delegation still out "reports later". One whose result the turn was holding (the bound's timer is in-process, so it is
  lost with a restarted process) hands its OWN result over there and then, and the sweep has nothing to deliver. A turn
  started under an older build has no sweep hook: the sweep waits (a frozen one is stopped all the same, and eve reports
  the stop itself, without the reason).
- Two sweeps (the schedule and a turn start, two instances) claim the delegation first: one row per (main thread, call)
  in `specialist_sweeps` (`drizzle/0034`), the INSERT is the claim, and a stale or unfinished row is taken over by a
  later pass (eve drops a second copy anyway).

`npm run test:specialist-sweep` holds (a)–(d) and the races offline; `npm run test:specialist-detach` runs the sweep's
operations and the app's own sweep, wired as in production, on the real runtime (`sweephandover`, `sweeprace`,
`sweepstale`, `sweeprun`); `npm run test:specialist-sweep-db` holds the claim across processes and workspaces.

**Workspaces and owners.** A main thread is swept only as a main thread of the workspace its owner record is in (the
record names no root), and only in that workspace's scope; the specialists it looks at are the ones its own stream
announced (eve's history, never a client's), and what it delivers goes to that main thread only. The ledger is a tenant
table under the same row-level policy as its neighbours.

**What the person sees.** The chat asks `GET /eve/v1/session/:id/specialist-sweep` (the session guard's own route, gated
like the stream: the owner, a shared chat's participants and viewers) once it has delegated, every minute, and shows one
quiet line per note in the deployment profile's words (`chat.specialist_sweep`): "research showed no progress for 34
minutes, so it was stopped. The main agent has been told.", "reviewer has been waiting for your answer for 5 hours." The
delegation's card shows the result itself.

**Backends.** Both run the same code: the sweep acts through eve's runtime (`delegationSweep` from `eve/channels`, the
eve patch's `execution/delegation-sweep.js`: read a stream, cancel or end a run, hand a batch over, deliver a late
result), on Vercel's world and on the local world alike. On Vercel the schedule is a Vercel Cron Job; a self-hosted
`eve start` runs it itself.


## Resume on a stopped specialist

The Control Panel offered "Resume" on a stopped specialist. It posted a message to the specialist's own session with
the token that session parks on. On the real runtime (`npm run test:specialist-batch`): that token is the one eve
mints for the delegation, `<main thread>:<call id>`; eve's HTTP channel namespaces every token it is given, so it
matches no session, and eve answered 200 and started a NEW conversation that began with "Resume — continue the task…"
and no context. The specialist and the main thread received nothing.

**Resume is not offered for a specialist the main agent called, and the panel says what to do instead.** Continuing
it within its parent's turn is not possible in eve's model: a specialist hands back only into the inbox of the turn
that called it, and by the time it is stopped that turn has been ended (by the hand-back above, which also told the
main agent "stopped, no result", or by the person stopping the main thread), and eve's settle of an ended turn
clears its pending delegations. A result produced afterwards would reach nobody and contradict what the main agent
was told. So for a stopped specialist the Control Panel shows: "Stopped. A specialist cannot be resumed on its own …
ask the main agent in the chat to run it again." (`lib/specialist-run-actions.ts`). Stop stays beside it while the
panel still counts the turn active, because pressing Stop again is how a hand-back that could not be delivered is
retried. Resume stays for a workflow step's own session, which a message on its token does continue (shown on the
same runtime).

The agent enforces it too: a message posted to a delegated specialist's own session is answered **409** with
`code: "specialist-session-not-addressable"` and the same advice, before anything is started
(`agent/lib/session-guard.ts`). And so that no panel offers such a message in the first place, every stream the guard
serves says whether its session is a delegation (`x-eve-session-delegation: 1` or `0`, from the same lineage record),
and the web app's /eve proxy passes it through. The Control Panel's steer box and Resume, and the run timeline's step
steer, are offered only when it says `0`. A workflow step's row usually opens the specialist the step called, so the
journal alone cannot decide this. Where a refusal can still happen, the panel shows the agent's own text, never a
bare status code. An answer to a specialist's question still goes through the main thread, as the chat
sends it. A stranger still gets the plain 404.

## What this repo adds around that rule

**A stopped specialist hands back** (`agent/lib/specialist-handback.ts`, run by the session guard on
`POST /eve/v1/session/<child>/cancel`). With the eve patch a delegation the root agent makes is `detachable` and eve
reports its stop itself ([above](#per-result-delegation-the-eve-patch)); for such a delegation the guard leaves the
cancel to eve and everything below is skipped (`planStop` answers "plain"), so it is told once, not twice. What follows
is for a delegation eve does not report: a session started before the patch, a remote agent, the experimental
Workflow tool. For those, eve has no exit for a specialist cancelled on its own: it parks, tells nobody,
and the main thread waits for ever. So stopping a specialist ends the turn that is waiting for it and sends the main
agent one message: who was stopped, that there is no result, and the result of any specialist of the same turn that
had already finished. The main agent continues from that message by itself. If another specialist of the turn is
still working, or waiting for the person's answer, the lone stop is refused with the reason; so it is while a "reports
later" specialist of the main thread works (ending a turn now stops those too).

What makes that safe:

- **Once, on any number of instances.** The right to send is a row in `specialist_handbacks`, keyed by (main
  thread's session, stopped specialist's session, the turn). Its INSERT is the claim; a second request conflicts and
  sends nothing. The row is written inside the workspace's row-level scope.
- **Nothing is lost.** The message, held results included, is written into that row before the waiting turn is
  ended. If delivery then fails, the answer to the Stop says `handback: "not-delivered"`, the Control Panel says so,
  and pressing Stop on that specialist again delivers the saved text.
- **Only what happened is reported.** `main-thread-told` means the message is on the main thread's own stream.
  A specialist that finished just as it was stopped is left to eve (`finished-anyway`); a main thread the person has
  since stopped or moved on is left alone (`main-thread-moved-on`), and the turn is always cancelled by its id, so a
  new turn is never the one ended.
- **A specialist's words are data.** The message is a user-role message: eve has no other way to put anything in
  front of a session from outside a turn (a delivery's `message` and its `context` both become user messages, and a
  waiting turn's result inbox is not addressable). So `lib/handback-text.ts` keeps two kinds of text apart. The
  framing and the status list are the system's and come first. Each specialist's output sits in a block whose
  delimiter carries a random value minted for that one message; the heading, the delimiter's shape and that value
  are neutralised wherever they occur inside it; and the framing says a block is data, not instructions. The chat
  draws the message as a system note (`app/_components/handback-note.tsx`) showing the status list only.

Not covered: a specialist's own nested specialist (the guard knows a session's root, not its direct parent), which is
cancelled as before.

**A specialist's question notifies the person** (`agent/channels/eve.ts` `events`, `agent/lib/turn-notify.ts`). eve
copies a specialist's question or approval onto the main thread without running any hook, so the desktop notification
never fired for one. The channel's own event handler reports it; each request notifies once.

**A finished specialist is shown as held, not lost** (`handbackStates` in `lib/chat-turn-state.ts`). The chat no
longer offers "Bring result into chat" while a sibling is still working: that action cancels the turn and the
sibling with it. It is offered only when everything the main agent waits for has finished and it still has nothing.
A delegation handed over as "reports later" is neither: it is `reportsLater`, drawn as "Working — reports later" on
its card and in the Control Panel (`lib/detached-delegation.ts` is the one test for its stand-in), its question stays
answerable, and its result (or "Stopped") is written over the stand-in on the same card when it comes.

**A step run by a program waits for the hand-back** (`lib/step-handback.ts`, used by `lib/workflow-delegate.ts`).
A workflow step, a cron step and an app refreshed from a specialist read the main agent's stream. A turn that ends
while a specialist is still out is eve parking on that specialist's question, not the end of the step. A person's
step keeps reading; a step that runs on the platform's own identity has nobody to answer, so it stops the parked
turn and fails at once, naming the specialist and what it asked for. An app refresh is always the latter: it runs in
the background as the platform's identity (`lib/app-refresh.ts`), so a refresh whose specialist asks a question ends
as a failed refresh that says what was asked, never as one that waits. Nor is a turn that ends with a delegation still
out as "reports later" the end of a step: its result comes as a turn of its own, and that turn's reply is the step's
value.

## Checking a running app

```
RIG_BASE=https://<the app> RIG_TOKEN=<a signed-in session token> [RIG_ORG=<workspace id>] \
  node scripts/rig-specialist-handback.mjs --shapes single,question,two,stopped
```

`parallel` (mold_v1-197) asks for one delegated part and one that needs no specialist, and fails unless the
independent part reached the main thread before the specialist came to rest and the result was then folded in once.
`apart` and `resume` are the two added for mold_v1-184: `apart` asks for two independent pieces of work, one of
which needs the person's choice, plays a person who answers a specialist's question only after `--max-ms` + 5 s, and
fails if any specialist's result waited longer than `--max-ms` after it finished (scripted, the second specialist
ASKS, called together with the first: the shape that failed on the live server, "held behind a question"); `resume`
stops a specialist and then sends the old Resume, which must be refused (409) with nothing started. Against a build
with the eve patch, a stop of a `detachable` delegation is expected to be reported by eve itself, as the delegation's
`SUBAGENT_STOPPED` result, once and with no hand-back message; against one without it, by the hand-back message. A
"reports later" stand-in is never counted as a result.

It starts one test chat per shape, closes its read of the main thread as soon as the specialist is called, follows
the specialist to its end, and then reads what the main thread did on its own. It exits 0 only if, in every shape,
the main agent received the result (or the plain failure) and finished a reply within `--max-ms` (default 15000) of
the specialist coming to rest, exactly once, with no message sent to nudge it. Exit 1 names the shape and the reason;
exit 3 means the address or the token was not given. Use `--specialists a,b` to name the deployment's own
specialists (the default is the built-in `agent` tool, which every deployment has).

The same script runs against `eve dev` with a scripted model (`--scripted`,
`node scripts/fake-model-server.mjs --script handback`), which adds two shapes a real model cannot be asked for on
demand: `sibling` (without the patch: a lone stop refused while another specialist works; with it: the stop accepted
and reported into the batch, the other going on as "reports later", then the idle main thread stopped, which stops it
too) and `failed`.

`npm run test:specialist-handback` runs the same rules offline, over streams recorded from the live runtime;
`npm run test:detached-delegation` holds every reader of a main thread to the "reports later" streams recorded from the
patched runtime, and `npm run test:specialist-detach` runs per-result delegation itself on the real runtime.
`npm run test:specialist-batch` runs a two-specialist app on the real eve runtime (eve dev, a scripted model,
in-process sandboxes) and shows the batch rule, why an early message duplicates, and the Resume defect and fix.

## Deploying and rolling back

### Per-result delegation (the eve patch, mold_v1-184)

**What it adds to deploy:** no table, no migration. Two installs change: eve is pinned to exactly 0.25.1 and patched in
`postinstall` (docs/EVE_PATCH.md: how Vercel and the self-hosted server apply it, and the check that fails a build
on an unpatched eve). New per-session durable state: `eve.runtime.detachedDelegations` in a main thread's session state;
new fields: `parentSessionContinuationToken` in a delegation's adapter state, `detachable` on `subagent.called`,
`driverCapabilities.delegationResults` in each turn's input, and `delegationResults` / `delegationRequests` in a
delivery a specialist sends to its main thread's session; the `eve_subagent_batch` attribute on a session creator's
auth and the `x-eve-subagent-batch` header a program sends to set it; a `<session>:stop-parked` hook on a detachable
delegation while it waits on the person; and, in eve's local world, a process-local note of steps running inline.

**A turn waiting on a batch when the new code arrives** finishes under eve's own batch ("all"), as it began:

- *Vercel.* A workflow run stays on the deployment that started it (the queue pins its messages to its deployment
  id), so the waiting turn, its specialists and the session's driver all go on running the old build. The session's
  next turn starts on the latest deployment (`startWorkflowPreferLatest`), but its input is written by the session's
  driver, which is still the old build and does not announce `delegationResults`: the new turn code takes eve's own
  path for it. **So a chat started before the deploy keeps eve's batch for good on Vercel; a chat started after it gets
  per-result delegation.**
- *Self-hosted* (eve's local world, rebuilt in place): runs are not pinned (the local world's deployment id is
  `dpl_local@<version>` for every build), so after the restart every in-flight run is recovered and replayed with the
  new code. The waiting turn's input was written by the old driver, without `delegationResults`, so it runs eve's own
  wait, which the patch leaves as it was: the replay matches the recorded run, and the turn waits for all its
  specialists as before. Those specialists were started without the session's token, so they report to the turn as
  before. The session's driver replays with the new code too; what is new in it acts only on delivery fields no
  older run recorded. **So a chat started before the deploy finishes its waiting turn as before, and gets per-result
  delegation from its next turn on** (the new driver code writes that turn's input).

In both cases nothing an old session holds is reinterpreted: an old turn never detaches, and an old specialist never
reports through the session.

**Rolling back: the ONLY supported rollback, on either target, is a build that keeps the patch and sets
`subagents: { batch: "all" }` in `agent/agent.ts`** (one line). New batches then wait for all again; every delegation
already handed over as "reports later" is still delivered, once, and still stopped with its main thread; and every run
recorded since the deploy replays, because the code that recorded it is still there (the late-result path, the parked
stop and the session copies are the patch's, not the setting's).

Rolling back to a build WITHOUT the patch breaks things, and not only for chats with something still out:

- *Self-hosted (rebuilt in place, every run replayed with the code on disk).* Every delegation started after the deploy
  sends its result (and any question) home twice: to its turn, and a copy to the main thread's session. The patched
  session driver records each copy and, unless it was owed, consumes it with no step after it. An unpatched driver,
  replaying that log, takes the same copy as a delivery and starts a turn for it: a step the log does not have where
  it has other events, so step ids shift and eve fails the run ("Replay could not consume event"). That is the main
  thread's session itself: **every chat that delegated after the deploy stops working.** Turns that were in, or went
  past, a per-result wait fail the same way (their log has a durable sleep the unpatched code does not make). Chats
  that never delegated after the deploy are unaffected.
- *Vercel.* A chat started on the patched build keeps its session driver on that deployment while the deployment
  exists, so the driver keeps working; but each new turn starts on the deployment eve's `deploymentId: "latest"`
  resolves to. If that is the unpatched build, a late result's turn drops the result (eve's channel finds no message
  in it): the main agent never gets it, and the chat keeps the stand-in (an unpatched chat draws it as "Completed"
  with a `running` output). A specialist parked on a question can no longer be stopped. Turns that were waiting when
  the rollback happened stay on the build that started them.
- *What "latest" is after a Vercel instant rollback is not visible here:* eve's Vercel world asks Vercel's API
  (`GET https://api.vercel.com/v1/workflow/resolve-latest-deployment/<deployment id>`); the code does not say whether
  that follows the production alias an instant rollback moves, and it was not tested. If it does, every chat's new
  turns run on the rolled-back build (the consequences above); if it does not, they keep running on the newest build
  until a new one is promoted. Either way the supported rollback above avoids the question.

### The main thread keeps working, and the specialist sweep (mold_v1-196/197)

**Before the agent:** apply `drizzle/0034_specialist_sweeps.sql` (`npm run db:migrate:production`). It adds one table
and nothing else. Without it the sweep claims nothing and so does nothing; the chat shows no sweep notes.

**The patch** adds the `delegationSweep` capability to a new driver's turn input, and everything new in the turn's wait
(the idle bound, the independent-work hand-over, the sweep hook) is gated on it: a turn whose input an older driver
wrote replays exactly as recorded, on either target (docs/EVE_PATCH.md "Replay compatibility"). Self-hosted, a chat
started before the deploy gets it from its next turn on; on Vercel such a chat keeps the old behaviour for good (its
driver stays on its deployment). For those turns the sweep has no hook to hand a batch over through: it delivers to
"reports later" delegations as before, and stops a frozen specialist (eve then reports the stop itself).

**Rolling back:** as for per-result delegation, keep the patch. Dropping `detachIdleAfterMs` from `agent/agent.ts`
turns the idle bound off; `SPECIALIST_SWEEP=off` turns the sweep off; the table can stay.

**The sweep reads only outstanding delegations (mold_v1-199). Before the agent:** apply
`drizzle/0035_specialist_sweep_settled.sql` (`npm run db:migrate:production`). It adds one table and nothing else (row-level
security like its neighbours). Without it the agent still works: the schedule reads every thread in the window, as
before, and logs once that the table is missing. The first pass after the deploy is the catch-up (as long as a pass was
before); the ones after it are proportional to the delegations outstanding. Rolling back: the old agent ignores the
table; it can stay.


### The specialist hand-back (mold_v1-184, #114/#121)

**#121 (the first half of mold_v1-184) added nothing to deploy:** no table, no migration, no new message sent to any
session, and nothing new recorded per session. It changed the root agent's system prompt (the delegation rule), one
HTTP answer (a message to a delegated specialist's own session is now 409 instead of a new, unrelated session), and
the Control Panel.

**Before the agent:** apply `drizzle/0031_specialist_handbacks.sql` (`npm run db:migrate:production`). It adds one
table and nothing else. Without it a Stop on a specialist still stops it and is reported as `not-delivered`.

**This change is roll-forward.** `agent/channels/eve.ts` now declares an event handler, and eve records the channel
of every session started from then on as `channel:eve` instead of `http`. Chats started before the deploy keep
working on the new build. Chats started after it can only be continued by a build that registers `channel:eve`.

To build a safe rollback, keep a real no-op handler in `agent/channels/eve.ts`:

```ts
events: { "input.requested"() {} },
```

An empty `events: {}`, or removing `events`, reverts the kind to `http`, and every chat started since the deploy
fails on its next turn with `Unknown adapter kind: "channel:eve"`. Everything else in this change can be reverted
freely; the table can stay.

**On Vercel**, where an older deployment can still be running: a workflow run stays on the deployment that started
it (the queue pins each run's messages to its deployment id), so a session's own run is stepped by the build that
created it. Each new turn is a new run that eve starts on the deployment Vercel reports as the latest production one
(`startWorkflowPreferLatest`). Going forward that is the new build, which reads both kinds. The one way a session
created by the new build meets old code is production being pointed back at a build without the handler (a rollback
or a promotion of an older deployment): its next turn would start there and fail. Nothing else protects that case;
the no-op handler above is the protection. Not verified here: exactly which deployment Vercel's "latest" names in
the seconds while a new production deployment is being promoted.
