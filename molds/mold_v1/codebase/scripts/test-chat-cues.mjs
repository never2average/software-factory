/**
 * THE CHAT'S CUES, executed (mold_v1-287..290): the pure rules behind the completed cue, the chat list's done marker,
 * the typing line, the order open approvals stack in and the one-line record an answered approval folds to.
 *
 * Imports the real modules and runs them; the browser half is held by tests/chat-cues.spec.ts, the queue's database
 * half by scripts/test-thread-queue-db.mjs.
 *
 * Run:  npm run test:chat-cues
 */
import assert from "node:assert/strict";
import {
  EMPTY_WATCH,
  WATCH_MAX,
  WATCH_MAX_MS,
  afterTail,
  completionDue,
  markedTitle,
  seen,
  startWatch,
  tailAtRest,
  turnOutcome,
  unmarkedTitle,
} from "../lib/completion-cue.ts";
import {
  TYPING_BEAT_MS,
  TYPING_WINDOW_MS,
  onlineFrom,
  personLabel,
  queueFrom,
  typingBeatDue,
  typingLine,
} from "../lib/chat-presence.ts";
import { approvalClock, approvalOutcome, approvalTimes, isApproval } from "../lib/approval-record.ts";
import { pendingInputRequestParts, requestArrival } from "../lib/chat-turn-state.ts";
import { CHAT_CUES } from "../lib/ui-words.ts";
import { backoff, fromLine, invalidMessage } from "../lib/thread-queue-server.ts";

let passed = 0;
const failed = [];
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed.push(label);
    console.log(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ───────── 287: how a turn ended ───────── */
const ev = (type, data = {}) => ({ type, data });
const answered = [ev("turn.started"), ev("message.completed", { message: "hi", finishReason: "stop" }), ev("turn.completed"), ev("session.waiting")];
check("a turn that ends with an answer is completed", () => assert.equal(turnOutcome(answered), "completed"));
check("…also before its session.waiting arrives", () => assert.equal(turnOutcome(answered.slice(0, 3)), "completed"));
check("a turn still going is running", () => assert.equal(turnOutcome(answered.slice(0, 2)), "running"));
check("a turn that asked the person is waiting, not done", () =>
  assert.equal(turnOutcome([ev("turn.started"), ev("input.requested", { requests: [] }), ev("session.waiting")]), "waiting"));
check("a failed turn is failed", () => assert.equal(turnOutcome([ev("turn.started"), ev("turn.failed")]), "failed"));
check("a stopped turn is stopped", () => assert.equal(turnOutcome([...answered.slice(0, 2), ev("client.turn.stopped")]), "stopped"));
check("an empty transcript has no turn", () => assert.equal(turnOutcome([]), "none"));
check("the cue is due only for a turn seen running that completed", () => {
  assert.equal(completionDue({ wasRunning: true, outcome: "completed" }), true);
  assert.equal(completionDue({ wasRunning: false, outcome: "completed" }), false, "history is quiet");
  assert.equal(completionDue({ wasRunning: true, outcome: "failed" }), false);
  assert.equal(completionDue({ wasRunning: true, outcome: "waiting" }), false);
});
check("the tab mark goes on once and comes off", () => {
  const t = markedTitle(markedTitle("Workspace", CHAT_CUES.tabDone), CHAT_CUES.tabDone);
  assert.equal(t, `${CHAT_CUES.tabDone} Workspace`);
  assert.equal(unmarkedTitle(t, CHAT_CUES.tabDone), "Workspace");
  assert.equal(unmarkedTitle("Workspace", CHAT_CUES.tabDone), "Workspace");
});

/* ───────── 287: a chat left running ───────── */
check("a tail at rest is a finished session", () => {
  for (const t of ["session.waiting", "turn.completed", "turn.failed", "session.completed"]) assert.equal(tailAtRest({ type: t }), true, t);
  assert.equal(tailAtRest({ type: "message.appended" }), false);
  assert.equal(tailAtRest(null), false);
});
check("a chat left running is done once its tail rests with an answer, and seen clears it", () => {
  let w = startWatch(EMPTY_WATCH, "chat-a", "sess-a", 0);
  w = afterTail(w, "chat-a", [ev("turn.started"), ev("message.appended")], 1000);
  assert.equal(w.ended.has("chat-a"), false);
  assert.equal(w.watching.has("chat-a"), true);
  w = afterTail(w, "chat-a", answered, 2000);
  assert.equal(w.ended.get("chat-a"), "done");
  assert.equal(w.watching.has("chat-a"), false);
  w = seen(w, "chat-a");
  assert.equal(w.ended.has("chat-a"), false);
});
check("a chat that stopped on a question or an approval NEEDS YOU, one that failed FAILED — never a false done", () => {
  const parked = [ev("turn.started"), ev("input.requested", { requests: [] }), ev("turn.completed"), ev("session.waiting")];
  const failedTail = [ev("turn.started"), ev("turn.failed"), ev("session.waiting")];
  const stopped = [ev("turn.started"), ev("client.turn.stopped"), ev("session.waiting")];
  let w = startWatch(startWatch(startWatch(EMPTY_WATCH, "p", "sp", 0), "f", "sf", 0), "s", "ss", 0);
  w = afterTail(afterTail(afterTail(w, "p", parked, 1), "f", failedTail, 1), "s", stopped, 1);
  assert.equal(w.ended.get("p"), "needs-you");
  assert.equal(w.ended.get("f"), "failed");
  assert.equal(w.ended.has("s"), false, "a stop says nothing");
});
check("watching is bounded in number and in time", () => {
  let w = EMPTY_WATCH;
  for (let i = 0; i < WATCH_MAX + 3; i++) w = startWatch(w, `c${i}`, `s${i}`, 0);
  assert.equal(w.watching.size, WATCH_MAX);
  assert.equal(w.watching.has("c0"), false, "the oldest made room");
  w = afterTail(w, `c${WATCH_MAX + 2}`, [ev("message.appended")], WATCH_MAX_MS + 1);
  assert.equal(w.watching.has(`c${WATCH_MAX + 2}`), false);
  assert.equal(w.ended.has(`c${WATCH_MAX + 2}`), false, "given up on, not marked");
});

/* ───────── 288: typing ───────── */
check("a typing beat goes at most once a second, and the window is about four seconds", () => {
  assert.equal(typingBeatDue(null, 5), true);
  assert.equal(typingBeatDue(1000, 1000 + TYPING_BEAT_MS - 1), false);
  assert.equal(typingBeatDue(1000, 1000 + TYPING_BEAT_MS), true);
  assert.ok(TYPING_WINDOW_MS >= 3000 && TYPING_WINDOW_MS <= 5000);
});
check("the typing line names who types, never yourself, never a guest by name", () => {
  const online = onlineFrom([
    { email: "ana@x.test", name: "Ana Ray", guest: false, typing: true },
    { email: "me@x.test", name: "Me", guest: false, typing: true },
    { name: null, guest: true, typing: true },
    { email: "bo@x.test", name: null, guest: false, typing: false },
  ]);
  assert.equal(typingLine(online, "me@x.test"), CHAT_CUES.typing(["Ana Ray"]));
  assert.equal(typingLine(online.slice(3)), null);
  assert.equal(personLabel(online[2]), CHAT_CUES.guest);
  assert.equal(personLabel(online[3]), "bo");
  assert.equal(CHAT_CUES.typing(["A", "B"]), "A and B are typing…");
  assert.equal(CHAT_CUES.typing(["A", "B", "C"]), "A and 2 others are typing…");
});
check("a malformed presence answer reads as nobody", () => {
  assert.deepEqual(onlineFrom(null), []);
  assert.deepEqual(onlineFrom([null, 3]), []);
  assert.deepEqual(queueFrom({}), []);
  assert.deepEqual(queueFrom([{ id: "a", text: "x", state: "weird", author: "Ana" }])[0].state, "queued");
});

/* ───────── 289: approvals ───────── */
const approval = (requestId, callId, extra = {}) => ({
  type: "dynamic-tool",
  toolName: "write_file",
  toolCallId: callId,
  state: "input-available",
  toolMetadata: {
    eve: {
      inputRequest: {
        requestId,
        display: "confirmation",
        prompt: "Write the file?",
        options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
        action: { callId, kind: "tool-call", toolName: "write_file", input: {} },
      },
      ...extra,
    },
  },
});
check("an approval is an approval; a question is not", () => {
  assert.equal(isApproval(approval("r1", "c1")), true);
  assert.equal(isApproval({ ...approval("r1", "c1"), toolName: "ask_question" }), false);
});
check("an answered approval's outcome", () => {
  assert.equal(approvalOutcome(approval("r1", "c1")), null, "still open");
  assert.equal(approvalOutcome(approval("r1", "c1", { inputResponse: { requestId: "r1", optionId: "approve" } })), "allowed");
  assert.equal(approvalOutcome(approval("r1", "c1", { inputResponse: { requestId: "r1", optionId: "deny" } })), "denied");
  assert.equal(approvalOutcome({ ...approval("r1", "c1"), state: "output-denied" }), "denied");
  assert.equal(approvalOutcome({ ...approval("r1", "c1"), state: "output-available" }), "allowed");
});
check("an approval's time is its call's result, or the recorded answer", () => {
  const times = approvalTimes([
    { type: "input.requested", data: { requests: [{ requestId: "r1", action: { callId: "c1" } }] }, meta: { at: "2026-10-18T10:00:00Z" } },
    { type: "action.result", data: { result: { callId: "c1" } }, meta: { at: "2026-10-18T10:05:00Z" } },
    { type: "client.input.responded", data: { responses: [{ requestId: "r2" }], at: "2026-10-18T10:07:00Z" } },
  ]);
  assert.equal(times.get("r1"), Date.parse("2026-10-18T10:05:00Z"));
  assert.equal(times.get("r2"), Date.parse("2026-10-18T10:07:00Z"));
  assert.equal(approvalClock(undefined), null);
  assert.equal(typeof approvalClock(Date.parse("2026-10-18T10:05:00Z")), "string");
});
check("open requests stack in the order they were asked, newest last — a specialist's included", () => {
  // eve's reducer puts a specialist's (proxied) request in an EARLIER message, by its stale turn id: transcript order
  // would put it first although it was asked last.
  const messages = [
    { parts: [{ type: "text", text: "earlier" }, approval("r-child", "child-call")] },
    { parts: [approval("r-own", "own-call")] },
  ];
  const events = [
    { type: "input.requested", data: { requests: [{ requestId: "r-own" }] } },
    { type: "input.requested", data: { requests: [{ requestId: "r-child" }] } },
  ];
  const none = new Set();
  const transcriptOrder = pendingInputRequestParts({ messages, dismissed: none, responded: none, expired: none });
  assert.deepEqual(transcriptOrder.map((p) => p.toolCallId), ["child-call", "own-call"], "the bug, as it was");
  const arrival = requestArrival(events);
  const ordered = pendingInputRequestParts({ messages, dismissed: none, responded: none, expired: none, arrival });
  assert.deepEqual(ordered.map((p) => p.toolCallId), ["own-call", "child-call"]);
});
check("a request asked on a delegation card joins the stack only when asked for", () => {
  const card = { ...approval("r-card", "deleg"), toolName: "eve:subagent:beta" };
  const none = new Set();
  assert.equal(pendingInputRequestParts({ messages: [{ parts: [card] }], dismissed: none, responded: none, expired: none }).length, 0);
  assert.equal(
    pendingInputRequestParts({ messages: [{ parts: [card] }], dismissed: none, responded: none, expired: none, delegations: true }).length,
    1,
  );
});

/* ───────── 290: the shared queue's message rules ───────── */
check("a queued message names its sender to the agent", () => assert.equal(fromLine("ana@x.test", "hello"), "[from: ana@x.test]\n\nhello"));
check("back-off doubles from five seconds, at most two minutes", () => {
  assert.equal(backoff(1), 5_000);
  assert.equal(backoff(2), 10_000);
  assert.equal(backoff(20), 120_000);
});
check("a queued message needs an id and words", () => {
  assert.equal(invalidMessage({ id: "abcdef", text: "hi" }), null);
  assert.equal(invalidMessage({ id: "ab", text: "hi" }), "bad id");
  assert.equal(invalidMessage({ id: "abcdef", text: "   " }), "empty");
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
