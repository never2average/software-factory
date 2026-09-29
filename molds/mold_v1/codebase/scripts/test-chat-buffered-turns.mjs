/**
 * "When I send a second message, only then does it load the second message."
 * "If something is stuck, the messages keep getting stacked and unanswered
 *  messages cannot be deleted."
 *
 * Both are one defect, reproduced end to end in the real UI against the real eve
 * runtime (next dev + eve dev + a scripted model; the steps are in the PR) and
 * held here over streams RECORDED from that runtime
 * (scripts/fixtures/buffered-turns):
 *
 *   1. eve answers `200 {ok:true}` to a message sent while a turn is running,
 *      or while a delegated specialist is parked on a question — and emits
 *      NOTHING for it. It is buffered, and runs as a turn of its own after the
 *      next `session.waiting`. One delivery can therefore produce TWO
 *      boundaries.
 *   2. Every reader stops at the FIRST boundary — eve's send-path reader
 *      (node_modules/eve/dist/src/client/session.js) and this app's
 *      `readLiveTail` — and `attachDecision` / `sendGate` read a
 *      `session.waiting` tail as "at rest". So the buffered turn was read only
 *      when the NEXT send opened a stream at the stale cursor, read THAT reply,
 *      and stopped at its boundary: one reply behind, for good.
 *   3. The gate let such messages out: dismissing a LIVE specialist's question
 *      dropped it from the pending count, and every message typed after that
 *      went into eve's buffer — "Working…" for ever, nothing to answer, nothing
 *      to remove.
 *
 * Everything here EXECUTES the real code: eve's own `EveAgentStore`,
 * `defaultMessageReducer` and `ClientSession.stream`, this repo's
 * `lib/chat-turn-state.ts`, `lib/chat-attach.ts` and `lib/chat-queue.ts`, over a
 * fake eve server on a stubbed `fetch` that releases each POST's RECORDED events.
 *
 * Failures are collected rather than thrown, so a run on the unfixed code lists
 * every broken rule at once.
 *
 * Run:  npm run test:chat-buffered-turns
 */
import { readFileSync } from "node:fs";
import { EveAgentStore, defaultMessageReducer } from "eve/client";
import * as state from "../lib/chat-turn-state.ts";
import { eveSessionStream, readLiveTail } from "../lib/chat-attach.ts";

let passed = 0;
const failed = [];
const check = (label, condition) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fn = (name) => (typeof state[name] === "function" ? state[name] : null);

const load = (name) => ({
  events: readFileSync(`scripts/fixtures/buffered-turns/${name}.ndjson`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l)),
  deliveries: JSON.parse(readFileSync(`scripts/fixtures/buffered-turns/${name}.deliveries.json`, "utf8"))
    .deliveries,
});

/**
 * A fake eve that replays a RECORDED session: POST k releases the events the
 * real runtime emitted between delivery k and delivery k+1 (the last one
 * releases the rest). GET /stream is a live tail from `startIndex`, held open
 * like the real one.
 */
function replayEve(recorded) {
  const log = [];
  let posts = 0;
  const release = () => {
    const from = recorded.deliveries[posts]?.at ?? recorded.events.length;
    const to = recorded.deliveries[posts + 1]?.at ?? recorded.events.length;
    posts++;
    log.push(...recorded.events.slice(from, to));
  };
  const server = {
    log,
    get posts() {
      return posts;
    },
    fetch: async (url, init = {}) => {
      const u = new URL(String(url), "http://eve.test");
      const m = u.pathname.match(/^\/eve\/v1\/session(?:\/([^/]+))?(\/stream)?$/);
      if (!m) return new Response("not found", { status: 404 });
      if ((init.method ?? "GET") === "POST") {
        release();
        return Response.json({ ok: true, sessionId: "ses_rec" });
      }
      let i = Number(u.searchParams.get("startIndex") ?? 0);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(c) {
            for (;;) {
              if (init.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
              if (i < log.length) return c.enqueue(enc.encode(`${JSON.stringify(log[i++])}\n`));
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

const makeStore = () =>
  new EveAgentStore({
    host: "http://eve.test",
    maxReconnectAttempts: 0,
    reducer: defaultMessageReducer(),
  });
const busy = (store) => ["submitted", "streaming"].includes(store.snapshot.status);
const texts = (data) =>
  data.messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
    )
    .join(" | ");
const until = async (pred, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (pred()) return true;
    await sleep(5);
  }
  return false;
};
/** A delivery as the component records it: the text and the index it was sent at. */
const delivered = (text, at) => ({ text, at, sentAt: Date.now() });
const owedCount = (deliveries, events) =>
  fn("outstandingDeliveries") ? fn("outstandingDeliveries")({ deliveries, events }).length : 0;

/**
 * What the chat does once the store has gone idle: ask `attachDecision`, and if
 * it says attach, run the REAL `readLiveTail` over eve's REAL
 * `ClientSession.stream` from the transcript's absolute index — exactly the
 * reattach effect in agent-chat — until the decision says stop. Returns the
 * transcript as the person would see it.
 */
async function readWhatTheChatWouldRead(store, deliveries) {
  let events = [...store.snapshot.events];
  let data = store.snapshot.data;
  for (let round = 0; round < 5; round++) {
    const verdict = state.attachDecision({
      sessionId: "ses_rec",
      storeBusy: busy(store),
      events,
      outstanding: owedCount(deliveries, events),
    });
    if (!verdict.attach) break;
    const tail = [];
    const ctrl = new AbortController();
    const result = await Promise.race([
      readLiveTail({
        open: eveSessionStream({ sessionId: "ses_rec", headers: () => ({}) }),
        startIndex: state.serverEventCount(events),
        signal: ctrl.signal,
        onEvent: (entry) => tail.push(entry),
        sleep: () => Promise.resolve(),
      }),
      sleep(3000).then(() => ({ outcome: "timeout" })),
    ]);
    ctrl.abort();
    const merged = state.mergeAttachedEvents(events, tail, state.serverEventCount(events));
    data = state.projectAttached(
      defaultMessageReducer(),
      data,
      merged.slice(events.length),
    );
    events = merged;
    if (result.outcome !== "terminal") break;
  }
  return { events, data };
}

// ───────────────────────────────────────────────────────────────────────────
console.log("1. A message buffered behind a PARKED specialist, then the answer (recorded):");
{
  const rec = load("buffered-behind-park");
  const eve = replayEve(rec);
  const store = makeStore();
  await store.send({ message: "MSG-1 ASK please delegate" });
  check("the store stops at the specialist's park (index 9)", store.snapshot.events.length === 10);
  const rid = store.snapshot.events.find((e) => e.type === "input.requested").data.requests[0].requestId;

  // THE STUCK HALF. The old gate let this message out once the question was
  // dismissed; eve takes it and says nothing at all.
  const dismissed = new Set([rid]);
  const counted = fn("effectiveDismissals") ? fn("effectiveDismissals")(dismissed, store.snapshot.events) : dismissed;
  check(
    "a LIVE specialist's question still holds the gate after it is dismissed",
    !counted.has(rid),
  );
  const pending = state.pendingInputRequestParts({
    messages: store.snapshot.data.messages,
    dismissed: counted,
    responded: new Set(),
    expired: new Set(),
  }).length;
  check(
    "…so a typed message is HELD in the queue (removable) instead of delivered into eve's buffer",
    state.sendGate({ storeBusy: false, events: store.snapshot.events, pendingInputs: pending }).hold,
  );

  // Deliver it anyway (a second tab, or the unfixed gate) and watch what eve does.
  const deliveries = [delivered("MSG-1 ASK please delegate", 0), delivered("MSG-2 unrelated while the specialist waits", 10)];
  const second = store.send({ message: "MSG-2 unrelated while the specialist waits" });
  await sleep(50);
  check("eve emits NOTHING for a message sent while the specialist is parked", eve.log.length === 10);
  check(
    "while eve holds it, the gate holds new messages ('delivering'), not the old 'send'",
    state.sendGate({
      storeBusy: false,
      events: store.snapshot.events,
      pendingInputs: 0,
      outstanding: owedCount(deliveries, store.snapshot.events),
    }).reason === "delivering",
  );

  // The answer goes out around the busy store (agent-chat respondToInput's direct POST).
  await fetch("http://eve.test/eve/v1/session/ses_rec", {
    method: "POST",
    body: JSON.stringify({ inputResponses: [{ requestId: rid, optionId: "fy26" }] }),
  });
  await second;
  check("that ONE answer releases two boundaries on the server", eve.log.filter((e) => e.type === "session.waiting").length === 3);
  check("the store's own reader stops at the FIRST of them (index 20)", store.snapshot.events.length === 21);
  check("…so the store alone shows REPLY-1 and NOT REPLY-2", /REPLY-1 END/.test(texts(store.snapshot.data)) && !/REPLY-2/.test(texts(store.snapshot.data)));

  check(
    "the chat knows eve still owes it MSG-2",
    owedCount(deliveries, store.snapshot.events) === 1,
  );
  check(
    "a reader stays on the stream PAST that boundary",
    state.attachDecision({
      sessionId: "ses_rec",
      storeBusy: false,
      events: store.snapshot.events,
      outstanding: owedCount(deliveries, store.snapshot.events),
    }).attach === true,
  );
  const seen = await readWhatTheChatWouldRead(store, deliveries);
  check("REPLY-2 is on screen WITHOUT sending another message", /REPLY-2 END/.test(texts(seen.data)));
  check("…and nothing is owed any more", owedCount(deliveries, seen.events) === 0);
  check(
    "…so the chat is at rest again: no reader, no hold",
    !state.attachDecision({ sessionId: "ses_rec", storeBusy: false, events: seen.events, outstanding: 0 }).attach &&
      !state.sendGate({ storeBusy: false, events: seen.events, pendingInputs: 0, outstanding: 0 }).hold,
  );
  check(
    "once the delegation settled, dismissing its question counts again (it is dead)",
    fn("effectiveDismissals") ? fn("effectiveDismissals")(dismissed, seen.events).has(rid) : false,
  );

  // What the person saw instead: the NEXT send reads the previous reply.
  const store2 = makeStore();
  const eve2 = replayEve({
    events: [...rec.events, ...rec.events.slice(21, 32)],
    deliveries: [...rec.deliveries, { at: 32, message: "MSG-3" }],
  });
  await store2.send({ message: "MSG-1 ASK please delegate" });
  const s2 = store2.send({ message: "MSG-2 unrelated while the specialist waits" });
  await sleep(30);
  await fetch("http://eve.test/eve/v1/session/ses_rec", { method: "POST", body: "{}" });
  await s2;
  await store2.send({ message: "MSG-3" });
  check(
    "(the symptom) without the reader, sending MSG-3 is what finally shows REPLY-2",
    /REPLY-2 END/.test(texts(store2.snapshot.data)) && eve2.posts === 4,
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n2. A message POSTed while a turn is still RUNNING (recorded):");
{
  const rec = load("buffered-mid-turn");
  replayEve(rec);
  const store = makeStore();
  const first = store.send({ message: "MSG-1 slow" });
  await until(() => store.snapshot.events.length >= 5);
  // Delivered around the store while it reads turn_0 (directDeliver).
  const deliveries = [delivered("MSG-1 slow", 0), delivered("MSG-2 sent mid-turn", 5)];
  await fetch("http://eve.test/eve/v1/session/ses_rec", { method: "POST", body: "{}" });
  await first;
  check("the store stops at turn_0's boundary", store.snapshot.events.at(-1)?.type === "session.waiting");
  check("MSG-2 is still owed", owedCount(deliveries, store.snapshot.events) === 1);
  const seen = await readWhatTheChatWouldRead(store, deliveries);
  check("MSG-2's reply is read past the boundary", /REPLY-2 END/.test(texts(seen.data)));
  check("…and nothing is owed any more", owedCount(deliveries, seen.events) === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n3. What counts as received:");
{
  const od = fn("outstandingDeliveries");
  check("outstandingDeliveries exists", Boolean(od));
  if (od) {
    const rx = (message, extra = {}) => ({ type: "message.received", data: { message, ...extra } });
    const evs = [{ type: "session.started" }, rx("same"), { type: "session.waiting" }, rx("same")];
    const two = [delivered("same", 1), delivered("same", 3)];
    check("two identical messages need two arrivals", od({ deliveries: two, events: evs.slice(0, 3) }).length === 1);
    check("…and are both settled by two", od({ deliveries: two, events: evs }).length === 0);
    check(
      "an arrival BEFORE the delivery index is not this delivery's",
      od({ deliveries: [delivered("same", 2)], events: evs.slice(0, 3) }).length === 1,
    );
    check(
      "client.* markers do not move the absolute index",
      od({ deliveries: [delivered("x", 1)], events: [{ type: "session.started" }, { type: "client.input.responded" }, rx("x")] })
        .length === 0,
    );
    check(
      "a compacted mount's index base is honoured",
      od({ deliveries: [delivered("x", 40)], events: [rx("x")], indexBase: 40 }).length === 0,
    );
    check(
      "a message with files matches on its text parts (eve's summary adds [file: …])",
      od({
        deliveries: [delivered("look at this", 0)],
        events: [rx("look at this\n[file: a.pdf (application/pdf)]", { parts: [{ type: "text", text: "look at this" }] })],
      }).length === 0,
    );
    check(
      "a delivery never seen for 15 minutes stops holding anything",
      od({ deliveries: [{ text: "lost", at: 0, sentAt: 0 }], events: [], now: 16 * 60_000 }).length === 0,
    );
    const none = [delivered("a", 0)];
    check("a settled list keeps its identity when nothing changed", od({ deliveries: none, events: [] }) === none);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n4. The reader does not give up on a turn that is still running:");
{
  const delay = fn("attachRetryDelayMs");
  check("attachRetryDelayMs exists", Boolean(delay));
  if (delay) {
    const d = [0, 1, 2, 3, 4, 5, 9].map(delay);
    check("a spent budget re-arms after a backoff (5s first)", d[0] === 5_000);
    check("…growing", d[1] > d[0] && d[2] > d[1] && d[3] > d[2]);
    check("…and capped at one open a minute, never zero", d[5] === 60_000 && d[6] === 60_000);
  }
  const running = [{ type: "turn.started" }, { type: "message.appended" }];
  check(
    "a spent budget is still 'open-failed' (the component owns the re-arm)",
    state.attachDecision({ sessionId: "s", storeBusy: false, events: running, failures: 4, maxFailures: 4 }).reason ===
      "open-failed",
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n5. A visible Stop on a hold that feels stuck:");
{
  const stop = fn("stopAvailable");
  check("stopAvailable exists", Boolean(stop));
  if (stop) {
    const g = (reason) => ({ hold: reason !== null, reason });
    check("detached, store idle → Stop", stop({ gate: g("detached"), storeBusy: false }));
    check("eve holding a message of ours → Stop", stop({ gate: g("delivering"), storeBusy: false }));
    check("a question with messages queued behind it → Stop", stop({ gate: g("awaiting-input"), storeBusy: false, queued: 2 }));
    check("a question and an empty queue is not stuck → no extra Stop", !stop({ gate: g("awaiting-input"), storeBusy: false, queued: 0 }));
    check("store reading → the composer's own Stop, not this one", !stop({ gate: g("streaming"), storeBusy: true }));
    check("read-only → never", !stop({ gate: g("detached"), storeBusy: false, readOnly: true }));
    check("at rest → never", !stop({ gate: g(null), storeBusy: false }));
  }
  check(
    "the queue's label says why it is waiting",
    /waiting its turn/.test(state.holdLabel("delivering")),
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n6. The queue is held on the SERVER (one per chat, every tab); what eve owes is shared, one record per tab:");
{
  let q = null;
  let dr = null;
  try {
    q = await import("../lib/chat-queue.ts");
    dr = await import("../lib/chat-queue-drain.ts");
  } catch {
    q = null;
  }
  const api = q && typeof q.updateOwed === "function" ? q : null;
  check("lib/chat-queue: per-tab owed records; lib/chat-queue-drain: the server's send decision", Boolean(api && dr?.sessionRest));
  const makeStorage = () => {
    const mem = new Map();
    return {
      mem,
      get length() {
        return mem.size;
      },
      key: (i) => [...mem.keys()][i] ?? null,
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  };
  try {
  if (api && dr) {
    // THE QUEUE: no tab keeps one. (#59's per-tab sessionStorage queue is why a closed tab's messages were never sent.)
    const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
    const hook = readFileSync("app/_components/use-chat-queue.ts", "utf8");
    check(
      "closedtab: no tab stores the queue in its own storage — it is queued on the server (POST /api/ops/chat-queue)",
      !/saveQueue|loadQueue|adoptQueue/.test(chat) && typeof q.saveQueue !== "function" && /"\/api\/ops\/chat-queue"/.test(hook),
    );
    check(
      "twotab / dup: a tab never sends a server-held item itself — it asks the server, whose claim is exactly-once",
      !/\/eve\/v1/.test(hook) && /\/api\/ops\/chat-queue\/drain/.test(hook) && /queue\.drain\(\)/.test(chat),
    );
    check(
      "planmode: an item is composed with the settings it was QUEUED under (withDirectives(…, s)), not the composer's",
      /const composeQueued = \(/.test(chat) && /withDirectives\(body, false, s\)/.test(chat),
    );
    check(
      "reload: a reopened chat reads its queue back from the server (every tab, every device)",
      /\/api\/ops\/chat-queue\?session=/.test(hook) && /useEffect\(\(\) => \{\s*void refresh\(\);\s*\}, \[sessionId, refresh\]\)/.test(hook),
    );
    check(
      "plain words: \"Your earlier message is queued and will be sent after this reply.\" (not \"waiting its turn on the server\")",
      chat.includes("Your earlier message is queued and will be sent after this reply.") && !/another tab is (still )?waiting its turn on the server/i.test(chat),
    );
    const bell = readFileSync("app/_components/notifications-bell.tsx", "utf8");
    check(
      "without the push keys the bell still turns on and says so plainly (in-tab notifications work)",
      bell.includes("Your administrator hasn&apos;t turned on notifications for closed tabs yet. You&apos;ll still get them") &&
        !bell.includes("aren&apos;t available here yet"),
    );
    check("a delivery that could not be confirmed says \"Didn't send\" and offers \"Send again\"", chat.includes("Didn't send") && chat.includes("Send again"));
    check(
      "a message queued before the chat HAS a session (its first message still being created) stays in the tab and is sent by it — the server queue only holds follow-ups, and its tokens can never create a session",
      /const serverOk = sid && ref\.current\.serverAllowed/.test(hook) && /where: "local"/.test(hook) &&
        /sessionIdOfRoute/.test(readFileSync("agent/lib/queue-delivery-auth.ts", "utf8")),
    );
    const server = readFileSync("lib/chat-queue-server.ts", "utf8");
    check(
      "stale: an item still queued after a day is EXPIRED (shown, never sent on its own) — see test:chat-queue-db",
      /export const QUEUE_EXPIRE_MS = 24 \* 60 \* 60_000/.test(server) && /state = 'expired'/.test(server),
    );

    // WHEN the server sends: at rest, judged from eve's own tail.
    const waiting = (k) => ({ type: "session.waiting", data: { continuationToken: `ct-${k}` }, meta: { at: `2026-09-28T10:00:0${k}.000Z` } });
    const rest = dr.sessionRest([{ type: "step.completed" }, { type: "turn.completed" }, waiting(1)]);
    check("at rest after a finished turn (and the token to send with)", rest.rest && rest.token === "ct-1");
    check("a running turn is not at rest", !dr.sessionRest([{ type: "turn.started" }, { type: "message.appended" }]).rest);
    const parked = dr.sessionRest([{ type: "step.completed" }, { type: "input.requested", data: { requests: [{ requestId: "r1" }] } }, { type: "turn.completed" }, waiting(2)]);
    check("a turn parked on the person's question or approval is NOT at rest (a queued message would answer or clear it)", !parked.rest && parked.reason === "parked" && parked.parkedOn[0] === "r1");
    check(
      "…unless the person stopped that question (eve emits nothing for it; the chat's Stop marker says so)",
      dr.sessionRest([{ type: "input.requested", data: { requests: [{ requestId: "r1" }] } }, { type: "turn.completed" }, waiting(2)], dr.stoppedRequestIds([{ type: "client.turn.stopped", data: { requestIds: ["r1"] } }])).rest,
    );
    check("a cancelled turn is at rest (Stop releases the queue)", dr.sessionRest([{ type: "turn.cancelled" }, waiting(3)]).rest);
    check("an ended session is never sent into", dr.sessionRest([{ type: "session.completed" }]).reason === "ended");
    check("an unreadable tail is \"unknown\", never \"at rest\"", dr.sessionRest(null).reason === "unknown" && dr.sessionRest([]).reason === "unknown");
    check(
      "two rests are told apart by eve's own stamps (the next item waits for the NEXT rest)",
      dr.sessionRest([waiting(1)]).mark !== dr.sessionRest([waiting(2)]).mark,
    );
    check(
      "eve's \"target session was not found\" is a delivery that did not happen (retried); a 5xx without it is not",
      dr.parkNotVisible({ status: 500, text: '{"error":"target session was not found"}' }) && !dr.parkNotVisible({ status: 500, text: "boom" }) && !dr.parkNotVisible({ status: 200 }),
    );
    // A message the SERVER sent, learned after the fact, is owed only if it has not arrived yet.
    const st = await import("../lib/chat-turn-state.ts");
    const now = Date.parse("2026-09-28T10:00:10.000Z");
    const evs = [{ type: "message.received", data: { message: "MSG-2 queued" }, meta: { at: "2026-09-28T10:00:05.000Z" } }];
    check("a server-sent message already on screen is not owed again (no 15-minute hold)", st.receivedSince(evs, "MSG-2 queued", now - 60_000));
    check("…one not on screen yet is", !st.receivedSince(evs, "MSG-3 next", now - 60_000));
    check("…and an identical OLDER message is not mistaken for it", !st.receivedSince(evs, "MSG-2 queued", now + 10 * 60_000));

    // WHAT IS OWED: shared through localStorage, one record per tab.
    const local = makeStorage();
    const owed = api.owedKey("tester@example.com:org_a", "ses_1");
    api.updateOwed(local, owed, "A", (o) => ({ ...o, deliveries: [{ text: "MSG-2", at: 12, sentAt: 1000 }] }), 1000);
    const staleView = api.readOwed(local, owed);
    api.updateOwed(local, owed, "B", (o) => ({ ...o, deliveries: [{ text: "MSG-5", at: 20, sentAt: 2000 }] }), 2000);
    api.updateOwed(local, owed, "A", (o) => o, 2001); // A writes from its stale view
    void staleView;
    check("a tab writing from a stale view can NOT erase another tab's delivery", api.readOwed(local, owed).some((d) => d.text === "MSG-5"));
    // A Stop in tab A, whose view last moved at t=1500: its own, and older ones, only.
    const rel = api.releasable(api.readOwed(local, owed), "A", 1500, 2010);
    check("a Stop releases its own deliveries…", rel.some((d) => d.text === "MSG-2"));
    check("…but NOT another tab's newer one (that would put that tab one reply behind)", !api.releasable(api.readOwed(local, owed), "A", 1500, 2010).some((d) => d.text === "MSG-5"));
    const late = 2000 + api.OTHER_TAB_GRACE_MS;
    check(
      "past the grace, another tab's message is released when the session is AT REST (an idle tab is never locked for 15 minutes)",
      api.releasable(api.readOwed(local, owed), "A", 1500, late, { sessionAtRest: true }).some((d) => d.text === "MSG-5"),
    );
    check(
      "…but NOT while a turn is running (a message queued behind a long specialist run is waiting legitimately)",
      !api.releasable(api.readOwed(local, owed), "A", 1500, late, { sessionAtRest: false }).some((d) => d.text === "MSG-5"),
    );
    check(
      "a reloaded tab's OWN earlier message is its own (\"your earlier message\"), not another tab's",
      api.releasable(api.readOwed(local, owed), new Set(["A", "B"]), 0, 2010).some((d) => d.text === "MSG-5"),
    );
    // A reload: the page wrote "gone" into its own tab's sessionStorage as it unloaded.
    const reloadStorage = makeStorage();
    api.markGone(reloadStorage, "tabA");
    check("a RELOADED tab knows its earlier page's id (its deliveries are its own)", api.readGone(reloadStorage).has("tabA"));
    api.unmarkGone(reloadStorage, "tabA");
    check("a page restored from the back/forward cache is no longer gone", !api.readGone(reloadStorage).has("tabA"));
    api.updateOwed(local, owed, "A", (o) => ({ ...o, deliveries: [], released: [] }), 2100);
    check("…and what it released is gone for every tab", !api.readOwed(local, owed).some((d) => d.text === "MSG-2"));
    const later = 2000 + api.OWED_MAX_AGE_MS + 1;
    api.updateOwed(local, owed, "C", (o) => o, later);
    check("records expire with their deliveries (no unbounded storage)", api.readOwed(local, owed).length === 0 && ![...local.mem.keys()].some((k) => k.endsWith(":t:B")));
    // Sign-out.
    const tabA = makeStorage();
    tabA.setItem(`${api.QUEUE_KEY_PREFIX}:tester@example.com:org_a:ses_1`, "[]"); // an old per-tab queue
    api.updateOwed(local, owed, "A", (o) => ({ ...o, deliveries: [{ text: "x", at: 1, sentAt: later }] }), later);
    local.mem.set("workspace-chats:tester@example.com:org_a", "[]");
    api.clearAllPending(local, tabA);
    check(
      "sign-out clears every owed record (and any old per-tab queue) of the person, and nothing else",
      tabA.mem.size === 0 && [...local.mem.keys()].every((k) => k.startsWith("workspace-chats:")),
    );
  }
  } catch (e) {
    check(`the queue checks run on this code (${String(e?.message ?? e).slice(0, 80)})`, false);
  }
}

console.log("\n7. Stop is aimed at the turn on screen — never a guess — and says what it did:");
{
  const target = fn("stopTarget");
  check("stopTarget exists", Boolean(target));
  if (target) {
    const running = [{ type: "turn.started", data: { turnId: "turn_2", sequence: 2 } }, { type: "message.appended" }];
    check("a running turn: that turn", target(running).turnId === "turn_2");
    const rec = load("buffered-behind-park").events;
    const parked = rec.slice(0, 10);
    check("a park: the parked turn (not the whole session)", target(parked).turnId === "turn_0" && target(parked).parked === true);
    const resumed = rec.slice(0, 15); // answered: the delegation settled and the reply is streaming
    check("a reply RESUMED after an answer: the parked turn, marked resumed (eve sends no turn.cancelled)", target(resumed).turnId === "turn_0" && target(resumed).resumed === true);
    const rest = [{ type: "turn.started", data: { turnId: "turn_4", sequence: 4 } }, { type: "turn.completed" }, { type: "session.waiting" }];
    check("at rest: NO target — nothing is cancelled, nothing is guessed", target(rest).turnId === undefined);
  }
  const live = fn("liveDelegations");
  const mark = fn("stoppedMarker");
  const read = fn("stoppedFromEvents");
  check("the stopped marker helpers exist", Boolean(live && mark && read));
  if (live && mark && read) {
    const parked = load("buffered-behind-park").events.slice(0, 10);
    const dels = live(parked);
    check("the parked specialist is found", dels.length === 1 && dels[0].name === "configuration");
    const rid = parked.find((e) => e.type === "input.requested").data.requests[0].requestId;
    const stoppedState = read([...parked, mark({ requestIds: [rid], delegations: dels, at: 10 })]);
    check("the marker retires the question (it no longer holds the gate after a reload)", stoppedState.requestIds.has(rid));
    check("…settles the specialist's tile", stoppedState.delegations.get(dels[0].callId) === "configuration");
    check("…names what was discarded, for the note", stoppedState.requestNames.get(rid) === "configuration");
    check("…and says WHERE the Stop was, so a stopped resumed reply gets its \"Stopped.\"", stoppedState.latestAt === 10);
  }
  const notes = fn("stoppedTurnNotes");
  check("stoppedTurnNotes exists", Boolean(notes));
  if (notes && mark) {
    const resumedStop = notes([mark({ requestIds: [], delegations: [], at: 20, turnId: "turn_0" })]);
    check("a stopped RESUMED reply (eve sends no turn.cancelled) is noted \"Stopped.\" under it", resumedStop.get("turn_0") === "Stopped.");
    const cancelled = [{ type: "turn.cancelled", data: { turnId: "turn_3" } }];
    check("a turn stopped in ANOTHER tab says so", notes(cancelled).get("turn_3") === "Stopped from another tab or device.");
    check("…and one stopped here just says \"Stopped.\"", notes(cancelled, new Set(["turn_3"])).get("turn_3") === "Stopped.");
    check(
      "a Stop that discarded a specialist is said on its tile, not twice",
      !notes([mark({ requestIds: ["r"], delegations: [{ callId: "c", name: "configuration" }], at: 9, turnId: "turn_0" })]).has("turn_0"),
    );
  }
  const persisted = fn("isPersistedMarker");
  check(
    "a Stop's marker is carried across full-replay and shared-thread opens (not only answered inputs)",
    Boolean(persisted) && persisted({ type: "client.turn.stopped" }) && persisted({ type: "client.input.responded" }) && !persisted({ type: "client.message.submitted" }),
  );
  const stop = fn("stopAvailable");
  if (stop) {
    check(
      "a specialist's question offers Stop even with nothing queued (its delegation may never settle)",
      stop({ gate: { hold: true, reason: "awaiting-input" }, storeBusy: false, queued: 0, specialistWaiting: true }),
    );
  }
  const allowed = fn("attachRearmAllowed");
  check("the reader's re-arming is capped", Boolean(allowed));
  if (allowed) {
    check("…it re-arms while under the cap", allowed(0, false) && allowed(state.ATTACH_MAX_ROUNDS - 1, false));
    check("…stops at the cap (then the chat offers Reconnect)", !allowed(state.ATTACH_MAX_ROUNDS, false));
    check("…and never re-arms an IDLE hidden tab", !allowed(0, true) && !allowed(0, true, false));
    check("…but a hidden tab keeps re-arming while its turn is RUNNING (it must be current when the person returns)", allowed(0, true, true) && !allowed(state.ATTACH_MAX_ROUNDS, true, true));
  }
}

console.log("\n7b. After a Stop, the released message is read; a refused answer is not an answer:");
{
  const rest = [{ type: "turn.started" }, { type: "turn.completed" }, { type: "session.waiting" }];
  check(
    "a Stop's `abandoned` verdict does not stop the reader for a message delivered AFTER it",
    state.attachDecision({ sessionId: "s", storeBusy: false, events: rest, abandoned: true, outstanding: 1 }).attach === true,
  );
  check(
    "…while an abandoned UNFINISHED turn is still left alone",
    state.attachDecision({ sessionId: "s", storeBusy: false, events: [{ type: "turn.started" }], abandoned: true, outstanding: 0 }).attach === false,
  );
  const unanswer = fn("withoutResponses");
  check("withoutResponses exists", Boolean(unanswer));
  if (unanswer) {
    const answered = [{ role: "assistant", parts: [{ type: "dynamic-tool", state: "approval-responded", approval: { id: "r1" }, toolMetadata: { eve: { inputRequest: { requestId: "r1" }, inputResponse: { requestId: "r1", optionId: "fy25" } } } }] }];
    const back = unanswer(answered, new Set(["r1"]));
    const part = back[0].parts[0];
    check("an answer the server REFUSED is taken back: the question is live again", part.state === "approval-requested" && !part.toolMetadata.eve.inputResponse);
    check("…and nothing else is touched", unanswer(answered, new Set(["other"])) === answered);
  }
  // Source gates for the two orderings a pure test cannot hold.
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const stop = chat.slice(chat.indexOf("const stopTurn = useCallback"), chat.indexOf("}, [agent, chatKey, getAuthHeaders, report, onResync]);"));
  const staleAt = stop.indexOf("streamHasMoved(");
  const atRestRelease = stop.indexOf("releaseDeliveries(toRelease)");
  const aimedRelease = stop.indexOf("releaseDeliveries(await withGrace())");
  check(
    "a Stop releases deliveries only AFTER the stale-view check (or when nothing is running at all)",
    staleAt > 0 && aimedRelease > staleAt && atRestRelease > stop.indexOf("if (!target.turnId)") && atRestRelease < staleAt,
  );
  check(
    "an accepted Stop releases the hold of a turn delivered around the store (an answer's resumed reply sends no end)",
    /if \(body\.status === "accepted"\) setRemoteTurn\(false\)/.test(stop),
  );
  check("a Stop with no turn on screen cancels nothing", /if \(!target\.turnId\) \{[\s\S]*?return;\n    \}/.test(stop) && !/turnId: target\.turnId \}\s*:/.test(stop));
  check(
    "a refused answer leaves no delivery behind (one is recorded only once the POST is accepted), so the composer is never locked on it",
    /if \(outcome\.ok\) \{\s*recordDelivery\("", "answer"\)/.test(chat) && !/recordDelivery\("", "answer"\);\s*await agent\.send/.test(chat),
  );
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  check(
    "every open (full replay, shared thread) keeps the Stop markers",
    (shell.match(/isPersistedMarker/g) ?? []).length >= 3 && !/type === "client\.input\.responded",\n/.test(shell),
  );
}

console.log("\n7c. A Stop follows the chat to every device; an accepted answer stays answered:");
{
  let snap = null;
  try {
    snap = await import("../lib/chat-snapshot.ts");
  } catch {
    snap = null;
  }
  check("snapshotWriteNeeded exists", typeof snap?.snapshotWriteNeeded === "function");
  if (typeof snap?.snapshotWriteNeeded === "function") {
    const w = snap.snapshotWriteNeeded;
    check(
      "a Stop that produced NO server event is still written (same index, one more marker)",
      w({ eventIndex: 10, clientEvents: [{ type: "client.turn.stopped" }] }, { eventIndex: 10, markers: 0 }),
    );
    check("…but an unchanged transcript is not rewritten", !w({ eventIndex: 10, clientEvents: [] }, { eventIndex: 10, markers: 0 }));
    check("…and a transcript never moves backwards", !w({ eventIndex: 9, clientEvents: [{}, {}] }, { eventIndex: 10, markers: 0 }));
  }
  const route = readFileSync("app/api/ops/chat-sessions/route.ts", "utf8");
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  const schema = readFileSync("agent/lib/db/schema.ts", "utf8");
  check(
    "the chat's markers are kept on the server mirror too (for a device with no snapshot)",
    /clientMarkers: jsonb\("client_markers"\)/.test(schema) &&
      readFileSync("drizzle/0020_chat_session_markers.sql", "utf8").includes('ADD COLUMN IF NOT EXISTS "client_markers" jsonb'),
  );
  const mirrorSrc = (() => {
    try {
      return readFileSync("lib/chat-sessions-mirror.ts", "utf8");
    } catch {
      return ""; // older code wrote the mirror inline in the route
    }
  })();
  check("…only ever grow on write (a device with fewer never erases another's Stop)", /jsonb_agg\(DISTINCT m\)/.test(mirrorSrc) && /clientMarkers: r\.clientMarkers/.test(route));
  check(
    "…and every open path reads them (snapshot, full replay, the local cache)",
    (shell.match(/s\.markers/g) ?? []).length >= 3 && /const answered = markersOf\(s\)/.test(shell) && /clientMarkers: capMarkers\(markersOf\(s\)/.test(shell),
  );
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const respond = chat.slice(chat.indexOf("const respondToInput = async ("), chat.indexOf("// Case (c): the store surfaces"));
  check(
    "an answer is judged by its OWN POST's status — never by a stream read that fails after eve accepted it",
    /let outcome = await postAnswer\(inputResponses\)/.test(respond) &&
      !/storeErrorsRef\.current !== errorsBefore/.test(respond) &&
      /outcome\.status >= 400 && outcome\.status < 500 \? "refused"/.test(respond),
  );
  const answer = fn("withResponses");
  check("withResponses exists", Boolean(answer));
  if (answer) {
    const open = [{ role: "assistant", parts: [{ type: "dynamic-tool", state: "approval-requested", toolMetadata: { eve: { inputRequest: { requestId: "r1" } } } }] }];
    const shown = answer(open, { r1: { requestId: "r1", text: "FY26 please" } });
    check("an answer posted by the app shows as answered at once (the store never recorded it)", shown[0].parts[0].toolMetadata.eve.inputResponse?.text === "FY26 please");
  }
  const msg = readFileSync("app/_components/agent-message.tsx", "utf8");
  check("a typed answer stays in the thread as the person's own words", /<YourAnswer text=\{said\} \/>/.test(msg) && /Your answer/.test(msg));
  check("the composer says when the next message will answer the question", /Your next message will answer the question above\./.test(chat));
  check("a refused answer offers a one-click resend of what they answered", /data-answer-retry/.test(chat) && /again\n?\s*<\/button>|” again/.test(chat));
  // Plain words (review of #63): the waiting message is the person's own, from another tab or not.
  check("an idle tab says a waiting message will be sent after this reply", /owedFromOtherTab\s*\?\s*"Your earlier message is queued and will be sent after this reply/.test(chat));
}

console.log("\n7d. Markers never break the chat-list sync; answers are retried and verified:");
{
  const cap = fn("capMarkers");
  check("capMarkers exists", Boolean(cap));
  if (cap) {
    const stop = { type: "client.turn.stopped", data: { requestIds: ["r"], delegations: [], at: 3 } };
    const huge = { type: "client.input.responded", data: { responses: [{ requestId: "b", text: "x".repeat(40_000) }] } };
    const many = Array.from({ length: 400 }, (_, i) => ({ type: "client.input.responded", data: { responses: [{ requestId: `q${i}`, text: "an answer of about fifty characters, give or take." }] } }));
    const a = cap([stop, huge], state.MARKERS_MAX_BYTES_CLIENT);
    check("one 40 KB answer is trimmed to fit, the Stop kept", JSON.stringify(a).length <= state.MARKERS_MAX_BYTES_CLIENT && a.some((m) => m.type === "client.turn.stopped"));
    const b = cap([stop, ...many], state.MARKERS_MAX_BYTES_CLIENT);
    check("hundreds of answers are capped (newest kept), the Stop kept", JSON.stringify(b).length <= state.MARKERS_MAX_BYTES_CLIENT && b.some((m) => m.type === "client.turn.stopped") && b.at(-1)?.data?.responses?.[0]?.requestId === "q399");
    check("anything but the two persisted kinds is dropped", cap([{ type: "client.message.submitted" }, stop], 1000).length === 1);
  }
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  check("the browser sends each chat's markers capped by bytes", /clientMarkers: capMarkers\(markersOf\(s\), MARKERS_MAX_BYTES_CLIENT\)/.test(shell));
  const route = readFileSync("app/api/ops/chat-sessions/route.ts", "utf8");
  check(
    "the server never rejects a batch over one chat's markers (no size check in the schema; trimmed per chat)",
    !/\.refine\(\(m\) => JSON\.stringify\(m\)\.length/.test(route) && /clientMarkers: z\.unknown\(\)\.optional\(\)/.test(route) && /writeMirrorRows\(inOrg/.test(route),
  );
  check("the list is read by NAMED columns (either side of migration 0020)", !/\.select\(\)\s*\.from\(chatSessions\)/.test(route) && /readMirrorRows\(inOrg/.test(route));
  const retry = fn("answerPostRetryable");
  check("answerPostRetryable exists", Boolean(retry));
  if (retry) {
    check("an answer that meets eve's 500 \"target session was not found\" (the park not visible yet) is retried", retry(500, "Error: target session was not found"));
    check("…and nothing else is (a refusal or an unknown 5xx is decided once)", !retry(409, "conflict") && !retry(500, "boom") && !retry(0, "network"));
  }
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const respond = chat.slice(chat.indexOf("const respondToInput = async ("), chat.indexOf("// Case (c): the store surfaces"));
  check(
    "a 5xx or lost response on an answer is VERIFIED against the stream before the question comes back",
    /if \(answerNeedsCheck\(outcome\)\) \{/.test(respond) &&
      /const provisional = recordDelivery\("", "answer"\)/.test(respond) &&
      /answeredAt,\s*ANSWER_VERIFY_MS/.test(respond) &&
      /const ANSWER_VERIFY_MS = 60_000/.test(chat),
  );
  check(
    "Stop checks the session is at rest before releasing another tab's message after the grace",
    /readTailEvent\(\{ sessionId: sid/.test(chat) && /isSessionBoundary\(tail/.test(chat),
  );
  check("a reloaded tab recognises its own deliveries (its earlier pages' ids)", /SELF_IDS\.has\(/.test(chat) && /markGone\(window\.sessionStorage, TAB_ID\)/.test(chat));
}

console.log("\n7e. A Stop before the reply said anything is said under that turn, on every open (mold_v1-125):");
{
  // Recorded: a message whose model has not produced its first token, stopped
  // (POST /cancel {turnId}) while nothing had streamed. What eve sends for it is
  // in the fixture; what a reopened chat has is exactly these events plus the
  // chat's persisted markers.
  const rec = load("stop-before-first-token").events;
  const nothing = fn("turnShowedNothing");
  const hosts = fn("stoppedNoteHosts");
  const notes = fn("stoppedTurnNotes");
  const mark = fn("stoppedMarker");
  check("turnShowedNothing and stoppedNoteHosts exist", Boolean(nothing && hosts));
  if (nothing && hosts && notes && mark) {
    const cancelAt = rec.findIndex((e) => e.type === "turn.cancelled" || e.type === "session.waiting");
    check("the recording: the turn was stopped with nothing of its own on screen", cancelAt > 0 && nothing(rec, "turn_0"));
    const said = load("buffered-mid-turn").events;
    check("…and a turn that streamed text is not \"nothing\"", !nothing(said, "turn_0"));
    const withReasoning = [{ type: "reasoning.appended", data: { turnId: "turn_5", reasoningSoFar: "hm" } }];
    const withTool = [{ type: "actions.requested", data: { turnId: "turn_5", actions: [] } }];
    check("…nor one that thought or called a tool", !nothing(withReasoning, "turn_5") && !nothing(withTool, "turn_5"));

    // The view: eve's reducer over the recording, and AgentMessage's own "renders anything" rule, restated.
    const reducer = state.withSessionEpochs(defaultMessageReducer());
    let data = reducer.initial();
    for (const e of rec) data = reducer.reduce(data, e);
    const renders = (m) =>
      m.parts.some((p) => (p.type === "text" && p.text?.trim()) || (p.type === "reasoning" && p.text?.trim()) || p.type === "dynamic-tool" || p.type === "file");
    const assistant = data.messages.find((m) => m.role === "assistant" && m.metadata?.turnId === "turn_0");
    check("the stopped turn's reply renders nothing (so a note under it was never shown)", !assistant || !renders(assistant));

    // A reopen: the server's events, then the persisted marker the Stop left.
    const marker = mark({ requestIds: [], delegations: [], at: rec.length, turnId: "turn_0" });
    const reopened = notes([...rec, marker]);
    const at = hosts(data.messages, reopened, renders);
    const user = data.messages.find((m) => m.role === "user" && m.metadata?.turnId === "turn_0");
    check("after a reopen the note is said under the person's own message, in place", at.get(user?.id) === "Stopped.");
    check("…exactly once", at.size === 1);
    // Whatever the cached transcript held of eve's own end of the turn, the marker alone carries it.
    const serverOnly = rec.filter((e) => e.type !== "turn.cancelled");
    check(
      "…even when the reopened events hold no turn.cancelled (the marker is what persists)",
      hosts(data.messages, notes([...serverOnly, marker]), renders).get(user?.id) === "Stopped.",
    );
    // A stopped reply that DID say something keeps its note under the reply.
    const reply = { id: "turn_3:assistant", role: "assistant", metadata: { turnId: "turn_3" }, parts: [{ type: "text", text: "half a reply" }] };
    const ask = { id: "turn_3:user", role: "user", metadata: { turnId: "turn_3" }, parts: [{ type: "text", text: "q" }] };
    const later = { id: "turn_4:user", role: "user", metadata: { turnId: "turn_4" }, parts: [{ type: "text", text: "next" }] };
    const placed = hosts([ask, reply, later], new Map([["turn_3", "Stopped."]]), renders);
    check("a stopped reply with content carries the note under the reply, not the question", placed.get(reply.id) === "Stopped." && !placed.has(ask.id));
    check("a turn with nothing on screen gets no host (the composer note is the fallback)", hosts([later], new Map([["turn_9", "Stopped."]]), renders).size === 0);
  }
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const stop = chat.slice(chat.indexOf("const stopTurn = useCallback"), chat.indexOf("}, [agent, chatKey, getAuthHeaders, report, onResync]);"));
  check(
    "an accepted Stop of a turn that showed nothing leaves a persisted marker",
    /turnShowedNothing\(mergedEventsRef\.current as readonly TurnEvent\[\], target\.turnId\)[\s\S]{0,700}stoppedMarker\(\{ requestIds: \[\], delegations: \[\], at: absoluteIndex\(events\), turnId: target\.turnId \}\)/.test(stop),
  );
  check(
    "every message is given the note stoppedNoteHosts chose for it (a user message included)",
    /stoppedNote=\{stoppedNoteAt\.get\(message\.id\)\}/.test(chat) &&
      /stoppedNoteHosts\(viewMessages, stoppedNotes, \(m\) => messageRendersContent\(m, true, isProxiedChildApproval\)\)/.test(chat),
  );
  const msg = readFileSync("app/_components/agent-message.tsx", "utf8");
  check(
    "the host test is AgentMessage's own (the one that drops an empty message)",
    /export function messageRendersContent\(/.test(msg) && /const hasRenderableContent = messageRendersContent\(message, hoistPendingInput, isProxiedApproval\);/.test(msg),
  );
}

console.log("\n7f. Checking an answer says what is happening; an answer never sent is said at once (review of #59, mold_v1-122):");
{
  const needs = fn("answerNeedsCheck");
  check("answerNeedsCheck exists", Boolean(needs));
  if (needs) {
    check("NO POST MADE (no session) is not checked for a minute: it fails at once", !needs({ ok: false, status: 0, body: "no session", notSent: "no-session" }));
    check("…nor with no resume token", !needs({ ok: false, status: 0, body: "no resume token", notSent: "no-token" }));
    check("a request whose response went missing IS checked (it may have landed)", needs({ ok: false, status: 0, body: "network" }));
    check("…and a 5xx", needs({ ok: false, status: 502, body: "bad gateway" }));
    check("…but not a refusal, nor an accepted answer", !needs({ ok: false, status: 409, body: "conflict" }) && !needs({ ok: true, status: 200, body: "" }));
  }
  const label = state.holdLabel("detached", true, false, false, true);
  check("while an answer is checked, the queue line does not claim a specialist is running", !/specialist/i.test(label) && label.includes(state.ANSWER_CHECKING_LINE));
  check("…and says so only while checking", /a specialist is running/.test(state.holdLabel("detached", true, false, false, false)));
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const respond = chat.slice(chat.indexOf("const respondToInput = async ("), chat.indexOf("// Case (c): the store surfaces"));
  check(
    "respondToInput returns the question with a plain reason BEFORE any check when nothing was posted",
    /if \(outcome\.notSent\) \{\s*answerRejected\(requestIds, inputResponses, "not-sent"\);\s*return;\s*\}/.test(respond) &&
      respond.indexOf("if (outcome.notSent)") < respond.indexOf("if (answerNeedsCheck(outcome))"),
  );
  check(
    "postAnswer marks both no-POST paths",
    /return \{ ok: false, status: 0, body: "no session", notSent: "no-session" \}/.test(chat) &&
      /return \{ ok: false, status: 0, body: "no resume token", notSent: "no-token" \}/.test(chat),
  );
  check("the not-sent message tells the person what to do", /Your answer wasn't sent — [^"]*Reload the page/.test(chat));
  const statusLine = chat.slice(chat.indexOf('"Stopping the earlier reply…"'), chat.indexOf("specialistWorkingLine(workingSpecialists"));
  check(
    "the status line says the answer is being checked, ahead of any \"specialist is working\"",
    /: answerChecking\s*\?[\s\S]*?ANSWER_CHECKING_LINE/.test(statusLine),
  );
  check("the queue line is told when an answer is being checked", /holdLabel\(gate\.reason, specialistRunning, attachLive, authExpired, answerChecking\)/.test(chat));
}

console.log("\n7g. Stopping a parked specialist's resumed reply says so under THAT reply (review of #72/#74):");
{
  // Recorded: two parked delegations; cut the stream while the FIRST hand-back streams (turnId "", sequence 1).
  const all = readFileSync("scripts/fixtures/event-order/two-parked-handbacks.ndjson", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cut = all.findIndex((e) => e.type === "message.appended" && e.data.sequence === 1) + 2;
  const events = all.slice(0, cut);
  const target = state.stopTarget(events);
  check("the Stop still aims at the parked turn (what eve's cancel matches), marked resumed", target.turnId === "turn_0" && target.resumed === true);
  check("…and names the reply's own turn, as the transcript does (turn_<sequence>)", target.replyTurnId === "turn_1");
  const marker = state.stoppedMarker({ requestIds: [], delegations: state.liveDelegations(events), at: events.length, turnId: target.replyTurnId ?? target.turnId });
  const reducer = state.withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  const renders = (m) => m.parts.some((p) => (p.type === "text" && p.text?.trim()) || p.type === "dynamic-tool");
  const hosts = state.stoppedNoteHosts(data.messages, state.stoppedTurnNotes([...events, marker]), renders);
  check("\"Stopped.\" is said under the stopped hand-back reply, not above it", hosts.get("turn_1:assistant") === "Stopped." && hosts.size === 1);
  const before = state.stoppedNoteHosts(data.messages, state.stoppedTurnNotes([...events, { ...marker, data: { ...marker.data, turnId: "turn_0" } }]), renders);
  check("(keyed to the parked turn, as before, it sat above the reply, under the specialist's card)", before.get("turn_0:assistant") === "Stopped.");
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  check("the Stop handler keys the marker to the reply's turn", /turnId: target\.replyTurnId \?\? target\.turnId \}/.test(chat));
  check(
    "a Stop's marker outlives the hand-back remount that races the cancel's answer (module scope, every instance listens)",
    /const stopMarkersByChat = new Map<string, TurnEvent\[\]>\(\);/.test(chat) &&
      /useState<TurnEvent\[\]>\(\(\) => stopMarkersByChat\.get\(chatKey\) \?\? \[\]\)/.test(chat) &&
      !/setStoppedMarkers\(\(prev\)/.test(chat) &&
      (chat.match(/recordStopMarker\(\s*chatKey,/g) ?? []).length === 2,
  );
}

console.log("\n8. An owed delivery always ends:");
{
  const od = fn("outstandingDeliveries");
  if (od) {
    const ans = [{ text: "", at: 10, sentAt: Date.now(), kind: "answer" }];
    const evs = Array.from({ length: 10 }, () => ({ type: "message.appended" }));
    check("an answer is owed until the stream moves past it", od({ deliveries: ans, events: evs }).length === 1);
    check(
      "…including while the reply it resumed is still streaming (a resumed reply has no turn.started)",
      od({ deliveries: ans, events: [...evs, { type: "subagent.completed" }, { type: "message.appended" }] }).length === 1,
    );
    check(
      "…and settled once that reply reaches a boundary",
      od({ deliveries: ans, events: [...evs, { type: "subagent.completed" }, { type: "turn.completed" }, { type: "session.waiting" }] }).length === 0,
    );
    const msg = [{ text: "MSG-2", at: 3, sentAt: Date.now() }];
    check(
      "a session that ENDED never acks what was sent before it — the delivery is dropped",
      od({ deliveries: msg, events: [...Array.from({ length: 3 }, () => ({ type: "x" })), { type: "session.failed" }] }).length === 0,
    );
    check(
      "the 15-minute escape uses the clock it is given (not a clock frozen at the first render)",
      od({ deliveries: msg, events: [], now: Date.now() + 16 * 60_000 }).length === 0,
    );
  } else check("outstandingDeliveries exists", false);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
// The replay server's live tails never end on their own, exactly like eve's.
process.exit(0);
