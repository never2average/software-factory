/**
 * Behavioural tests for the two functions that decide whether a user is told
 * their reply is dead.
 *
 * This imports the REAL module and runs it. Every other chat assertion in this
 * repo is a regex over source text, which passes through a behavioural
 * regression and breaks on an innocent rename — the workflow-runtime test even
 * copied its subject and drifted into greenlighting an implementation that was
 * deleted for crashing. These are the functions where a wrong answer is visible
 * to a customer ("this failed, send again" over a turn that was merely slow), so
 * they get executed, not grepped.
 *
 * Fixtures are traces observed in production on 2026-08-08.
 *
 * Run:  npm run test:chat-turn-state
 */
import assert from "node:assert/strict";
import { retryStormDetected, turnUnfinished } from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const ev = (...types) => types.map((type) => ({ type }));

console.log("turnUnfinished:");
check("nothing running", !turnUnfinished([]));
check("a started turn is unfinished", turnUnfinished(ev("session.started", "turn.started")));
check(
  "…and mid-stream it is still unfinished",
  turnUnfinished(ev("turn.started", "step.started", "message.appended")),
);
for (const terminal of [
  "turn.completed",
  "session.completed",
  "session.waiting",
  "turn.failed",
  "turn.cancelled",
  "session.failed",
]) {
  check(`${terminal} ends the turn`, !turnUnfinished(ev("turn.started", "step.started", terminal)));
}
check(
  "a NEW turn after a completed one counts as unfinished",
  turnUnfinished(ev("turn.started", "turn.completed", "turn.started")),
);

console.log("\nretryStormDetected:");
// The exact shape of the stuck run: four prologues, no step, frozen.
const stuck = ev(
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started",
);
check("the real stuck trace is caught", retryStormDetected(stuck));

// A slow turn is the case that must NOT be misread — 443 events over 63s.
const slow = ev(
  "session.started", "turn.started", "message.received", "step.started",
  ...Array.from({ length: 400 }, () => "message.appended"),
  "actions.requested", "action.result", "step.completed",
);
check("a long, busy turn is NOT called dead", !retryStormDetected(slow));
check(
  "one retry that then runs is not a storm",
  !retryStormDetected(ev("turn.started", "message.received", "turn.started", "message.received", "step.started")),
);
check("a single prologue is never a storm", !retryStormDetected(ev("session.started", "turn.started", "message.received")));
check("two prologues are below the threshold", !retryStormDetected(ev("message.received", "message.received")));

// Prologues from EARLIER turns must not accumulate into a false positive: a
// long conversation would otherwise eventually report itself as broken.
const manyTurns = ev(
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started",
);
check("earlier turns do not accumulate into a false storm", !retryStormDetected(manyTurns));
check(
  "…and a storm AFTER a healthy turn is still caught",
  retryStormDetected(ev("message.received", "step.started", "turn.completed",
    "message.received", "message.received", "message.received")),
);
check("the threshold is adjustable", retryStormDetected(ev("message.received", "message.received"), 2));

console.log(`\nchat turn state: ${passed}/${passed} behavioural checks passed`);
