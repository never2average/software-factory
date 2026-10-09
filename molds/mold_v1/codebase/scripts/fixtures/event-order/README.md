Recorded 2026-09-28 from THIS repo's agent under `eve dev` (eve 0.25.1) with a scripted OpenAI-compatible model
that streams `reasoning_content`: the real eve runtime, the real `configuration` specialist, the real HTTP channel
(`GET /eve/v1/session/:id/stream`). No provider, no spend, no production data.

- `reasoning-around-subagent.ndjson`: the orchestrator thinks ("ORCH-THINK-1"), delegates to `configuration`, the
  specialist answers, the orchestrator thinks again ("ORCH-THINK-2") and answers ("FINAL-ANSWER").
- `text-before-subagent.ndjson`: the same, but the orchestrator also writes a sentence ("PRE-DELEGATION") before it
  delegates.

Both show the eve behaviour the transcript has to absorb: after the specialist's `action.result`, the resumed turn
emits `step.started` with `stepIndex: 0` AGAIN, for a step that already completed. See `withResumedSteps` in
lib/chat-turn-state.ts and scripts/test-chat-event-order.mjs.

- `two-parked-handbacks.ndjson` (recorded 2026-09-29, same rig): MSG-1 delegates to `configuration`, which parks on
  `ask_question`; the answer releases the specialist and the orchestrator's reply ("ORCH-CONTINUE") arrives with
  `turnId: ""` at `sequence: 1` and no `turn.started`. MSG-3 (`turn_2`) does the same; its hand-back is `turnId: ""`
  again, at `sequence: 3`. eve's reducer keys the assistant message by turn id, so both replies folded into ONE
  message above MSG-3. See `continuationTurnId` in lib/chat-turn-state.ts.
