Recorded 2026-09-24 from THIS repo's agent under `eve dev` (eve 0.25.1) with a scripted OpenAI-compatible model:
the real eve runtime, the real `configuration` specialist parking on `ask_question`, the real HTTP channel.

- `buffered-behind-park.ndjson`: MSG-1 delegates; the specialist parks on a question (session.waiting at index 9).
  MSG-2 is POSTed while it is parked: eve answers 200 and emits NOTHING. The answer (one POST) then releases the
  delegation's reply (session.waiting at index 20) AND MSG-2's turn (session.waiting at index 31).
- `buffered-mid-turn.ndjson`: MSG-2 is POSTed while turn_0 is still streaming: eve answers 200 and runs it as
  turn_1 after turn_0's session.waiting.

`*.deliveries.json` is the absolute stream index at which each POST was made, which is what the replay server in
scripts/test-chat-buffered-turns.mjs uses to release each POST's events.
- `stop-before-first-token.ndjson` (recorded 2026-09-29, same rig): MSG-1's model is still thinking before its first
  token when Stop POSTs `/cancel {turnId: "turn_0"}` (202 accepted): eve emits `turn.cancelled` then
  `session.waiting`, and the turn put nothing of its own on screen. Used by section 7e (mold_v1-125).
