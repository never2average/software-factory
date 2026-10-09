/**
 * "The answer keeps streaming ABOVE my newest prompt."
 *
 * Each scenario here is reproduced against the REAL eve client store
 * (`EveAgentStore` + `defaultMessageReducer` from node_modules) talking to a
 * fake eve server over a stubbed `fetch` — not a hand-copied twin of either.
 * The first half of every scenario shows the corruption is real when a message
 * is delivered; the second half shows `sendGate` holds exactly that message.
 *
 * Run:  npm run test:chat-send-gate
 */
import assert from "node:assert/strict";
import { EveAgentStore, defaultMessageReducer, resolveTextToResponses } from "eve/client";
import {
  composerRoute,
  holdLabel,
  isSessionBoundary,
  sendGate,
  turnsStarted,
  withSessionEpochs,
} from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake eve channel: create/continue POSTs and a live NDJSON tail per session. */
function fakeEve() {
  const sessions = new Map();
  const posts = [];
  let minted = 0;
  const server = {
    sessions,
    posts,
    /** What a delivery does server-side. Default: start the next turn. */
    onPost: (id, body, s) => server.push(id, ...server.prologue(s.seq++, body.message)),
    push: (id, ...events) => sessions.get(id).log.push(...events),
    prologue: (seq, text) => {
      const turnId = `turn_${seq}`;
      return [
        ...(seq === 0 ? [{ type: "session.started", data: {} }] : []),
        { type: "turn.started", data: { turnId } },
        { type: "message.received", data: { turnId, message: text } },
        { type: "step.started", data: { turnId, stepIndex: 0 } },
      ];
    },
    text: (seq, soFar) => ({
      type: "message.appended",
      data: { turnId: `turn_${seq}`, stepIndex: 0, messageSoFar: soFar },
    }),
    settle: (seq, token) => [
      { type: "turn.completed", data: { turnId: `turn_${seq}` } },
      { type: "session.waiting", data: { continuationToken: token } },
    ],
    fetch: async (url, init = {}) => {
      const u = new URL(String(url));
      const m = u.pathname.match(/^\/eve\/v1\/session(?:\/([^/]+))?(\/stream)?$/);
      if (!m) return new Response("not found", { status: 404 });
      if ((init.method ?? "GET") === "POST") {
        let id = m[1];
        if (!id) {
          id = `ses_${++minted}`;
          sessions.set(id, { log: [], seq: 0 });
        }
        const body = JSON.parse(init.body);
        posts.push({ created: !m[1], id, body });
        server.onPost(id, body, sessions.get(id));
        return Response.json({ sessionId: id });
      }
      const s = sessions.get(m[1]);
      let i = Number(u.searchParams.get("startIndex") ?? 0);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(c) {
            for (;;) {
              if (init.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
              if (s.cut) return c.error(new TypeError("fetch failed"));
              if (i < s.log.length) return c.enqueue(enc.encode(`${JSON.stringify(s.log[i++])}\n`));
              await sleep(2);
            }
          },
        }),
      );
    },
  };
  globalThis.fetch = server.fetch;
  return server;
}
const makeStore = (options = {}) =>
  new EveAgentStore({
    host: "http://eve.test",
    maxReconnectAttempts: 0,
    reducer: defaultMessageReducer(),
    ...options,
  });
const busy = (store) => ["submitted", "streaming"].includes(store.snapshot.status);
const transcript = (store) =>
  store.snapshot.data.messages.map(
    (m) =>
      `${m.role}: ${m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")}`,
  );
const gateOf = (store, pendingInputs = 0) =>
  sendGate({ storeBusy: busy(store), events: store.snapshot.events, pendingInputs });

// ───────────────────────────────────────────────────────────────────────────
console.log("scenario 1 — Stop (a local detach) and then send:");
{
  const eve = fakeEve();
  const store = makeStore();
  const first = store.send({ message: "q1" });
  await sleep(25);
  eve.push("ses_1", eve.text(0, "A1 so far"));
  await sleep(25);
  store.stop();
  await first;
  check("stop() leaves the store idle…", store.snapshot.status === "ready");
  check("…with the session cursor RESET (no session id)", store.snapshot.session.sessionId === undefined);
  check("the gate holds: the turn never finished", gateOf(store).reason === "detached");

  // What delivering anyway does — the bug.
  const second = store.send({ message: "q2" });
  await sleep(25);
  eve.push("ses_2", eve.text(0, "A2"));
  await sleep(25);
  check("delivering anyway opens a SECOND eve session", eve.posts[1].created === true);
  check(
    "whose turn_0 overwrites the first exchange in place",
    JSON.stringify(transcript(store)) === JSON.stringify(["user: q2", "assistant: A2"]),
  );
  store.stop();
  await second;
}

console.log("scenario 2 — the stream drops mid-turn (network, reconnect budget, slept tab):");
{
  const eve = fakeEve();
  const store = makeStore();
  const first = store.send({ message: "q1" });
  await sleep(25);
  eve.push("ses_1", eve.text(0, "A1 so far"));
  await sleep(25);
  // A severed body with no reconnect budget left: eve's reader just ends.
  eve.sessions.get("ses_1").cut = true;
  await first;
  check("the store settles with NO error and NO terminal event", store.snapshot.status === "ready");
  check("idle store, unfinished turn → held as detached", gateOf(store).reason === "detached");
  check("the label says so", /Still working/.test(holdLabel("detached")));
  check("…and names the specialist when one is running", /specialist is running/.test(holdLabel("detached", true)));
}

console.log("scenario 3 — thread reopened mid-turn, cursor valid, then send:");
{
  const eve = fakeEve();
  eve.sessions.set("ses_1", { log: [], seq: 1 });
  const soFar = [...eve.prologue(0, "q1"), eve.text(0, "A1 part one")];
  eve.push("ses_1", ...soFar);
  const store = makeStore({
    initialEvents: soFar,
    initialSession: { sessionId: "ses_1", continuationToken: "tok", streamIndex: soFar.length },
  });
  check("mounts idle over a running turn", store.snapshot.status === "ready");
  check("the gate holds it", gateOf(store).reason === "detached");

  // eve accepts a delivery during an active turn and folds it into the NEXT one.
  eve.onPost = () => {};
  const send = store.send({ message: "q2" });
  await sleep(25);
  eve.push("ses_1", eve.text(0, "A1 part one … still streaming"));
  await sleep(25);
  const mid = transcript(store);
  check(
    "delivering anyway: the OLD answer keeps growing above the new bubble",
    mid[1] === "assistant: A1 part one … still streaming" && mid[2] === "user: q2",
  );
  eve.push("ses_1", ...eve.settle(0, "tok2"));
  await send;
  eve.push("ses_1", ...eve.prologue(1, "q2"), eve.text(1, "A2"));
  await sleep(25);
  check("…and the reader stops at the OLD turn's boundary", store.snapshot.status === "ready");
  check("…so the new turn's reply is never read", !transcript(store).some((l) => l.includes("A2")));
}

console.log("scenario 4 — parked on an approval, the person types instead of answering:");
{
  const eve = fakeEve();
  const store = makeStore();
  const first = store.send({ message: "q1" });
  await sleep(25);
  eve.push(
    "ses_1",
    {
      type: "input.requested",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        requests: [
          {
            requestId: "req_1",
            prompt: "Run it?",
            options: [],
            action: { kind: "tool-call", toolName: "write_file", callId: "call_1", input: {} },
          },
        ],
      },
    },
    { type: "session.waiting", data: { continuationToken: "tok1" } },
  );
  await first;
  check("parked: store idle, turn at a boundary", store.snapshot.status === "ready");
  check("no open request → free to send", gateOf(store, 0).hold === false);
  check("an open request → held as awaiting-input", gateOf(store, 1).reason === "awaiting-input");

  // eve holds unrelated text until the approval is answered, then resumes turn_0 FIRST.
  eve.onPost = () => {};
  const send = store.send({ message: "also, one more thing" });
  await sleep(25);
  eve.push("ses_1", eve.text(0, "Approved — continuing the earlier answer"));
  await sleep(25);
  const lines = transcript(store);
  check(
    "delivering anyway: the resumed turn writes above the new bubble",
    lines[1] === "assistant: Approved — continuing the earlier answer" && lines[2] === "user: also, one more thing",
  );
  eve.push("ses_1", ...eve.settle(0, "tok2"));
  await send;
}

console.log("scenario 5 — a session ends for good; the next send is a NEW session (turn_0 again):");
for (const scoped of [false, true]) {
  const eve = fakeEve();
  const base = defaultMessageReducer();
  const store = makeStore({ reducer: scoped ? withSessionEpochs(base) : base });
  let send = store.send({ message: "q1" });
  await sleep(25);
  eve.push("ses_1", { type: "message.completed", data: { turnId: "turn_0", stepIndex: 0, message: "A1" } }, ...eve.settle(0, "t1"));
  await send;
  send = store.send({ message: "q2" });
  await sleep(25);
  eve.push("ses_1", { type: "turn.failed", data: { turnId: "turn_1" } }, { type: "session.failed", data: { message: "boom", code: "X" } });
  await send;
  check(`[${scoped ? "scoped" : "stock"}] a failed session is over, not held`, gateOf(store).hold === false);
  send = store.send({ message: "q3" });
  await sleep(25);
  eve.push("ses_2", eve.text(0, "A3"));
  await sleep(25);
  const lines = transcript(store);
  if (!scoped) {
    check("[stock] the new session's turn_0 overwrites the FIRST exchange", lines[0] === "user: q3" && lines[1] === "assistant: A3");
  } else {
    check("[scoped] the first exchange is untouched", lines[0] === "user: q1" && lines[1] === "assistant: A1");
    check("[scoped] the new prompt and its answer are LAST, in order", lines.at(-2) === "user: q3" && lines.at(-1) === "assistant: A3");
    check("[scoped] the epoch marker never leaks into the data", JSON.stringify(Object.keys(store.snapshot.data)) === '["messages"]');
  }
  store.stop();
  await send;
}

console.log("withSessionEpochs leaves ordinary transcripts alone:");
{
  const base = defaultMessageReducer();
  const scoped = withSessionEpochs(base);
  const eve = fakeEve();
  // A retry replay re-emits session.started INSIDE one session: same ids, must upsert in place.
  const events = [
    ...eve.prologue(0, "q1"),
    ...eve.prologue(0, "q1"),
    eve.text(0, "A1"),
    ...eve.settle(0, "t"),
    ...eve.prologue(1, "q2"),
    eve.text(1, "A2"),
  ];
  const run = (r) => events.reduce((d, e) => r.reduce(d, e), r.initial());
  check("identical projection, including across a retry replay", JSON.stringify(run(scoped)) === JSON.stringify(run(base)));
  check("…with exactly one bubble per turn", run(scoped).messages.length === 4);
}

console.log("sendGate:");
{
  const ev = (...types) => types.map((type) => ({ type }));
  check("empty transcript → send", sendGate({ storeBusy: false, events: [], pendingInputs: 0 }).hold === false);
  check("store busy → streaming", sendGate({ storeBusy: true, events: [], pendingInputs: 0 }).reason === "streaming");
  check(
    "store busy wins over everything else",
    sendGate({ storeBusy: true, events: ev("turn.started"), pendingInputs: 2 }).reason === "streaming",
  );
  for (const terminal of ["turn.completed", "session.waiting", "turn.failed", "turn.cancelled", "session.failed", "session.completed"]) {
    check(`settled by ${terminal} → send`, sendGate({ storeBusy: false, events: ev("turn.started", terminal), pendingInputs: 0 }).hold === false);
  }
  const storm = ev("turn.started", "message.received", "turn.started", "message.received", "turn.started", "message.received");
  check("a retry storm is a dead turn, not a live one → send", sendGate({ storeBusy: false, events: storm, pendingInputs: 0 }).hold === false);
  check(
    "a turn the server says is not running (no_active_turn) → send",
    sendGate({ storeBusy: false, events: ev("turn.started", "step.started"), pendingInputs: 0, abandoned: true }).hold === false,
  );
  check(
    "a turn delivered around the store (direct POST) is live though the events look idle",
    sendGate({ storeBusy: false, events: ev("turn.started", "session.waiting"), pendingInputs: 0, remoteTurn: true }).reason === "detached",
  );
  check("turnsStarted counts turn ordinals", turnsStarted(ev("turn.started", "x", "turn.started")) === 2);
  check("session.waiting is a boundary", isSessionBoundary({ type: "session.waiting" }));
  check("message.appended is not", !isSessionBoundary({ type: "message.appended" }));
  check("nothing is not", !isSessionBoundary(undefined));
}

console.log("composerRoute (typed text while a request is open — resolved by eve's own resolver):");
{
  const parked = { hold: true, reason: "awaiting-input" };
  const freeform = [{ requestId: "q1", prompt: "Which entity?", allowFreeform: true }];
  const approval = [{ requestId: "a1", prompt: "Run it?", options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }] }];
  const n = (text, requests) => resolveTextToResponses(text, requests).length;
  check("idle → send", composerRoute({ gate: { hold: false, reason: null }, answers: 0, hasFiles: false }) === "send");
  check("text for a freeform question IS its answer", composerRoute({ gate: parked, answers: n("HFC only", freeform), hasFiles: false }) === "answer");
  check("unrelated text under an approval is held", composerRoute({ gate: parked, answers: n("also do X", approval), hasFiles: false }) === "queue");
  check("'yes' under an approval answers it", composerRoute({ gate: parked, answers: n("yes", approval), hasFiles: false }) === "answer");
  check("attachments are never an answer", composerRoute({ gate: parked, answers: 1, hasFiles: true }) === "queue");
  check("a detached turn never takes an answer", composerRoute({ gate: { hold: true, reason: "detached" }, answers: 1, hasFiles: false }) === "queue");
}

console.log(`\nchat send gate: ${passed}/${passed} checks passed`);
process.exit(0);
