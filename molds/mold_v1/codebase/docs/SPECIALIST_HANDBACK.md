# How a specialist's result reaches the main agent

A person asks the main agent for something; the main agent hands part of it to a specialist (a subagent). This page
says when the main agent gets the specialist's result back, what it waits for, and what happens when a specialist
cannot finish. It was written after the report "subagents don't automatically message back the main agent"
(2026-10-05) and states only what was measured on the live runtime (eve 0.25.1).

## The rule eve applies

The main agent's turn waits for **every specialist it called in the same step**, and continues when all of them are
back. Each specialist tells the waiting turn in exactly two cases: it **finished**, or it **failed**. That hand-back
is direct (the specialist's last step wakes the main agent's turn through the workflow queue); no cron and no timer
is involved, on Vercel or self-hosted, and it does not need a browser tab to be open. Measured: 1 to 9 seconds from
the specialist's last event to its result on the main thread.

| What happens | What the main agent gets | When |
|---|---|---|
| One specialist finishes | its result | within seconds |
| One specialist fails | the failure, as that delegation's result | within seconds |
| A specialist asks a question or needs an approval | nothing yet: it is waiting for the person | when the person answers and it finishes |
| Two called together, one finishes first | nothing yet: the finished result is **held** | when the other is back too, both together ([below](#called-together)) |
| A specialist is stopped on its own | a plain note: it was stopped, no result | within seconds (this repo, below) |

"Held" is eve's design, not a loss: a model that called two tools needs both results before its next step.

## Called together

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

**What this repo does instead: it avoids the shape.** The root agent's delegation rule (`delegate-rules` in
`agent/prompt-neutral.md` and `agent/prompt-persona.md`) still says to fan out independent work, and now adds:
"Specialists called in one step return together, so if one will need the person's answer or an approval, get that
first or run that specialist on its own." A specialist told in its brief to return a question instead of asking holds
nothing either; on the real runtime such a batch handed a finished result to the main agent 0.8 s after its
specialist finished. To make room, five passages of `agent/prompt-core.md` were reworded without dropping a rule, and
the stable prompt is at 1,311 of its 1,400 words (`test:prompt-context`; `test:specialist-batch` holds it at 1,350 or
less). This is guidance to the model, not a guarantee: a model can still batch a specialist that asks. The `apart` rig shape (below) measures what a deployed model actually does. Everything
#114 established is unchanged (no new message is sent, no new record is kept).

### Proposal: per-result delegation in eve (not filed)

The smallest change upstream that would remove the wait, for a maintainer to judge. Nothing was filed.

1. **An opt-in setting.** `defineAgent({ subagents: { batch: "all" | "detach" } })`, default `"all"` (today).
2. **Detach the rest when the batch would wait on a person.** In `waitForRuntimeActionResults`, under `"detach"`,
   when at least one result is in and a still-pending child has a proxied input request (the session's
   `hasProxyInputRequests`), resolve the batch with the results that are in plus, for each delegation still out, a
   synthetic `subagent-result` `{ status: "running", childSessionId }` the model reads as "this one reports later".
   Record those as `eve.runtime.detachedDelegations` (callId, name, childSessionId) in the session state.
   (Optionally also after `detachAfterMs`, for a sibling that is merely slow.)
3. **Give a detached child a way home.** At dispatch, add the parent SESSION's delivery token to the subagent adapter
   state beside `parentContinuationToken`. In `notifyDelegatedParentStep`, when the callId is detached (or the inbox
   hook is gone), resume the session's delivery hook with a new payload `{ delegationResult }`, which the session
   driver turns into the next turn's input as a TOOL-role message (never user-role), and removes from
   `detachedDelegations`: once per child, through the durable queue.
4. **Keep the person's question routable.** Wherever a turn's end clears proxied input requests
   (`settleCancelledTurnStep` clears all of them today), keep those whose child is detached, and let the session
   driver route an `inputResponses` delivery to a child between turns as the waiting turn does now
   (`routeProxiedDeliverStep`), so the person's answer still reaches it. `cancelDescendantTurnsStep` cancels detached
   children too, so stopping the main thread stops them.

With that in eve, this repo would set `batch: "detach"`, and the rule above could relax to "approval work alone".

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
`POST /eve/v1/session/<child>/cancel`). eve has no exit for a specialist cancelled on its own: it parks, tells nobody,
and the main thread waits for ever. So stopping a specialist ends the turn that is waiting for it and sends the main
agent one message: who was stopped, that there is no result, and the result of any specialist of the same turn that
had already finished. The main agent continues from that message by itself. If another specialist of the turn is
still working, or waiting for the person's answer, the lone stop is refused with the reason.

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

**A step run by a program waits for the hand-back** (`lib/step-handback.ts`, used by `lib/workflow-delegate.ts`).
A workflow step, a cron step and an app refreshed from a specialist read the main agent's stream. A turn that ends
while a specialist is still out is eve parking on that specialist's question, not the end of the step. A person's
step keeps reading; a step that runs on the platform's own identity has nobody to answer, so it stops the parked
turn and fails at once, naming the specialist and what it asked for. An app refresh is always the latter: it runs in
the background as the platform's identity (`lib/app-refresh.ts`), so a refresh whose specialist asks a question ends
as a failed refresh that says what was asked, never as one that waits.

## Checking a running app

```
RIG_BASE=https://<the app> RIG_TOKEN=<a signed-in session token> [RIG_ORG=<workspace id>] \
  node scripts/rig-specialist-handback.mjs --shapes single,question,two,stopped
```

`apart` and `resume` are the two added for mold_v1-184: `apart` asks for two independent pieces of work, one of
which needs the person's choice, plays a person who answers a specialist's question only after `--max-ms` + 5 s, and
fails if any specialist's result waited longer than `--max-ms` after it finished; `resume` stops a specialist and then
sends the old Resume, which must be refused (409) with nothing started.

It starts one test chat per shape, closes its read of the main thread as soon as the specialist is called, follows
the specialist to its end, and then reads what the main thread did on its own. It exits 0 only if, in every shape,
the main agent received the result (or the plain failure) and finished a reply within `--max-ms` (default 15000) of
the specialist coming to rest, exactly once, with no message sent to nudge it. Exit 1 names the shape and the reason;
exit 3 means the address or the token was not given. Use `--specialists a,b` to name the deployment's own
specialists (the default is the built-in `agent` tool, which every deployment has).

The same script runs against `eve dev` with a scripted model (`--scripted`,
`node scripts/fake-model-server.mjs --script handback`), which adds two shapes a real model cannot be asked for on
demand: `sibling` (a lone stop refused while another specialist works) and `failed`.

`npm run test:specialist-handback` runs the same rules offline, over streams recorded from the live runtime.
`npm run test:specialist-batch` runs a two-specialist app on the real eve runtime (eve dev, a scripted model,
in-process sandboxes) and shows the batch rule, why an early message duplicates, and the Resume defect and fix.

## Deploying and rolling back

**mold_v1-184 adds nothing to deploy:** no table, no migration, no new message sent to any session, and nothing new
recorded per session. It changes the root agent's system prompt (the delegation rule), one HTTP answer (a message to
a delegated specialist's own session is now 409 instead of a new, unrelated session), and the Control Panel.

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
