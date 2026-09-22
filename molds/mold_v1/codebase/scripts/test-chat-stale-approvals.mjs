/**
 * "Permission decisions resurface and block streaming for chats that are
 * already completed."
 *
 * A reopened thread rebuilds its approval cards from the message PARTS, and a
 * part carries no expiry: `approval-requested` (or `inputRequest` with no
 * `inputResponse`) looks identical whether the turn is parked waiting for the
 * operator or died three days ago. The three sets that used to make the
 * difference — responded / dismissed / expired — are in-memory, so after a
 * reload they are empty and every such part was hoisted as a LIVE approval.
 * `sendGate` then held the composer on `awaiting-input`, permanently, on a chat
 * that had finished.
 *
 * This drives eve's OWN reducer (`defaultMessageReducer` from node_modules,
 * wrapped in the chat's `withSessionEpochs`) over persisted streams, applies the
 * chat's projection, and asserts the two states stay apart: a live park is still
 * answerable and still holds, a dead request neither holds nor offers a button.
 *
 * Run:  npm run test:chat-stale-approvals
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import { deadInputRequestIds, composerRoute, sendGate, withSessionEpochs } from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* -- a persisted stream, in eve's own event shapes ------------------------- */

const prologue = (turnId, text) => [
  { type: "session.started", data: {} },
  { type: "turn.started", data: { turnId } },
  { type: "message.received", data: { turnId, message: text } },
  { type: "step.started", data: { turnId, stepIndex: 0 } },
];
const askApproval = (turnId, requestId, callId) => ({
  type: "input.requested",
  data: {
    turnId,
    stepIndex: 0,
    requests: [
      {
        requestId,
        prompt: "Send this note?",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        action: { kind: "tool-call", toolName: "send_email", callId, input: { to: "a@b.c" } },
      },
    ],
  },
});
const park = { type: "session.waiting", data: { continuationToken: "ct_live" } };
const answered = (turnId, callId) => ({
  type: "action.result",
  data: {
    turnId,
    stepIndex: 0,
    status: "completed",
    result: { kind: "tool-result", toolName: "send_email", callId, output: "sent" },
  },
});
const finished = (turnId) => [
  { type: "message.appended", data: { turnId, stepIndex: 0, messageSoFar: "Done." } },
  { type: "message.completed", data: { turnId, stepIndex: 0, message: "Done." } },
  { type: "turn.completed", data: { turnId } },
  park,
];

/** Project a persisted stream exactly as a reopened chat does. */
const project = (events) => {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  return data;
};

/**
 * The chat's own selection over those parts, with the in-memory sets EMPTY —
 * which is the state every reopened thread starts in, and the whole bug.
 * `dead` is the only thing that can tell the two apart there.
 */
const cards = (events) => {
  const data = project(events);
  const dead = deadInputRequestIds(events);
  const out = [];
  for (const m of data.messages) {
    for (const p of m.parts ?? []) {
      if (p.type !== "dynamic-tool") continue;
      if (p.toolName?.startsWith("eve:subagent:")) continue;
      const terminal =
        p.state === "output-available" || p.state === "output-error" || p.state === "output-denied";
      const pending =
        !terminal &&
        (p.state === "approval-requested" ||
          (Boolean(p.toolMetadata?.eve?.inputRequest) && !p.toolMetadata?.eve?.inputResponse));
      if (!pending) continue;
      const requestId = p.toolMetadata?.eve?.inputRequest?.requestId;
      out.push({ requestId, state: p.state, expired: Boolean(requestId && dead.has(requestId)) });
    }
  }
  return { hoisted: out, open: out.filter((c) => !c.expired) };
};

/* -- 1. a live park: today's behaviour, unchanged -------------------------- */

console.log("a turn parked on an approval (the eve feature that must keep working):");
{
  const events = [...prologue("turn_0", "Email the summary"), askApproval("turn_0", "req_1", "call_1"), park];
  const { hoisted, open } = cards(events);
  check("the approval is hoisted", hoisted.length === 1);
  check("…as a live prompt, not a note", !hoisted[0].expired);
  check("the part is still eve's approval-requested", hoisted[0].state === "approval-requested");
  const gate = sendGate({ storeBusy: false, events, pendingInputs: open.length });
  check("the composer holds on it", gate.hold && gate.reason === "awaiting-input");
  check("…and typed text can still answer it", composerRoute({ gate, answers: 1, hasFiles: false }) === "answer");
}

/* -- 2. the reported bug: a finished thread, reopened ---------------------- */

console.log("\na finished thread reopened, its approval part never made terminal:");
{
  // The real shape: the operator answered through the direct-POST path, which
  // never writes `inputResponse` back onto the part, and the `action.result`
  // was not in what was persisted. The turn then ran to completion.
  const events = [
    ...prologue("turn_0", "Email the summary"),
    askApproval("turn_0", "req_1", "call_1"),
    park,
    ...finished("turn_0"),
  ];
  const { hoisted, open } = cards(events);
  check("the stale part is still `approval-requested` (nothing made it terminal)", hoisted[0]?.state === "approval-requested");
  check("it stays on screen", hoisted.length === 1);
  check("…but as the muted 'the run has stopped' note", hoisted[0].expired);
  check("nothing is awaiting the operator", open.length === 0);
  const gate = sendGate({ storeBusy: false, events, pendingInputs: open.length });
  check("the chat is sendable again", gate.hold === false && gate.reason === null);
  check("…and typed text goes out as a message", composerRoute({ gate, answers: 0, hasFiles: false }) === "send");
}

console.log("\n…and the other two ways a request dies:");
{
  const base = [...prologue("turn_0", "Email the summary"), askApproval("turn_0", "req_1", "call_1"), park];
  for (const [label, tail] of [
    ["its call resolved (approved through another channel)", [answered("turn_0", "call_1")]],
    ["its turn failed", [{ type: "turn.failed", data: { turnId: "turn_0", code: "STEP_FAILED", message: "boom" } }]],
    ["its turn was cancelled", [{ type: "turn.cancelled", data: { turnId: "turn_0" } }, park]],
    ["a later turn started", [...prologue("turn_1", "Never mind")]],
  ]) {
    const events = [...base, ...tail];
    const { open } = cards(events);
    const gate = sendGate({ storeBusy: false, events, pendingInputs: open.length });
    check(`${label} → nothing pending`, open.length === 0);
    check(
      `${label} → the gate does not hold on it`,
      gate.reason !== "awaiting-input",
    );
  }
}

/* -- 3. the wiring, so the projection above cannot drift from the chat ----- */

console.log("\nthe chat actually feeds this into the gate and the card:");
{
  const src = readFileSync(new URL("../app/_components/agent-chat.tsx", import.meta.url), "utf8");
  check("deadInputRequestIds is imported", src.includes("deadInputRequestIds"));
  check(
    "openInputRequests drops dead requests (this is what pendingInputs counts)",
    /openInputRequests[\s\S]{0,900}!deadRequests\.has\(req\.requestId\)/.test(src),
  );
  check(
    "the hoisted card renders a dead request as expired",
    /expired=\{Boolean\([\s\S]{0,200}deadRequests\.has\(requestId\)/.test(src),
  );
  check(
    "the sibling batch does not wait on a dead request",
    /openRequestIds[\s\S]{0,900}deadRequests\.has\(rid\)/.test(src),
  );
}

console.log(`\nchat stale approvals: ${passed}/${passed} checks passed`);
process.exit(0);
