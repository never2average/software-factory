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
| Two called together, one finishes first | nothing yet: the finished result is **held** | when the other is back too, both together |
| A specialist is stopped on its own | a plain note: it was stopped, no result | within seconds (this repo, below) |

"Held" is eve's design, not a loss: a model that called two tools needs both results before its next step.

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
turn and fails at once, naming the specialist and what it asked for.

## Checking a running app

```
RIG_BASE=https://<the app> RIG_TOKEN=<a signed-in session token> [RIG_ORG=<workspace id>] \
  node scripts/rig-specialist-handback.mjs --shapes single,question,two,stopped
```

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

## Deploying and rolling back

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
