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
