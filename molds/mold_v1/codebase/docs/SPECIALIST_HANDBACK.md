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
the stable prompt is at 1,311 of its 1,400 words (`test:prompt-context`; `test:specialist-batch` holds it at 1,350 or
less). This is guidance to the model, not a guarantee: a model can still batch a specialist that asks. The `apart` rig shape (below) measures what a deployed model actually does. Everything
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
`step_failed` / `step_retrying` (mold_v1-191, below). New modules:
`harness/detached-delegations.js`, `execution/parent-session-delivery.js`.

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
