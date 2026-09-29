/**
 * The chat list write, EXECUTED — because this is the function whose bugs lose
 * conversations.
 *
 * Saving the sidebar to localStorage has been rewritten twice under pressure,
 * and both rewrites lost something: the first evicted old chats on overflow
 * ("the sidebar is pruning chats from the beginning"), the second stripped every
 * event stream but the newest four ("switching threads went very very slow").
 * Neither could have been caught by the test that guarded this code, because
 * that test was a regex over a .tsx file.
 *
 * So the rules now live in lib/chat-persist.ts and this runs them: against a
 * fake storage that really does throw QuotaExceededError, against a scheduler
 * this file drives frame by frame, and against the ORIGINAL implementation
 * transcribed from main — every assertion below compares bytes with what the
 * old code would have written, not with an idea of what it should write.
 *
 * What the coalescing is allowed to change: WHEN the write happens and how many
 * happen. What it is not allowed to change, and what is checked here:
 *
 *   - the final stored state (a coalesced write == one write per change)
 *   - the bytes (byte-identical to the pre-change implementation)
 *   - that a departing page still persists, synchronously, with no frame
 *   - that a half-updated list can never be stored
 *   - the quota back-off: still strips oldest-first, still spares the protected
 *     chat, still caps the count when nothing else fits
 *
 * And the claim the second half of the fix rests on, measured rather than
 * asserted: a chat that did not change is not serialised again.
 *
 * Run:  npm run test:chat-persist-coalesce
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_CACHE_MAX_CHARS,
  STORAGE_MAX_CHATS,
  chatCacheable,
  createPersistWriter,
  persistStats,
  serializeChats,
  writeChats,
} from "../lib/chat-persist.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const equal = (label, actual, expected) => {
  assert.deepEqual(actual, expected, `${label}\n   actual:   ${JSON.stringify(actual)?.slice(0, 400)}\n   expected: ${JSON.stringify(expected)?.slice(0, 400)}`);
  passed++;
  console.log(`  ok   ${label}`);
};

const KEY = "workspace-chats:someone@onfinance.in:default";

/** A localStorage that throws exactly where a browser's does. */
function fakeStorage(quota = Infinity) {
  const s = { value: null, attempts: [], accepted: 0 };
  return {
    stats: s,
    setItem(key, value) {
      s.attempts.push(value.length);
      if (value.length > quota) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      s.accepted++;
      s.value = value;
    },
  };
}

/** A scheduler this file drives: nothing happens until `frame()` is called. */
function manualFrames() {
  let due = null;
  return {
    schedule: (run) => {
      due = run;
      return () => {
        due = null;
      };
    },
    pending: () => due !== null,
    frame: () => {
      const run = due;
      due = null;
      run?.();
      return run !== null;
    },
  };
}

/**
 * `writeSessions`, TRANSCRIBED from app/_components/chat-shell.tsx as it stood
 * on main (a586846). The equivalence claims below are made against THIS, so
 * that "the same bytes" means the same bytes as the code people are running,
 * not the same bytes as a second copy of the new code.
 */
function writeSessionsOnMain(storage, key, sessions, protect) {
  const list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = (s) => protect.has(s.id) || protect.has(s.clientKey ?? "");
  const stripBeyond = (n) => list.map((s, i) => (i < n || kept(s) ? s : { ...s, events: undefined }));
  const tryWrite = (l) => {
    try {
      storage.setItem(key, JSON.stringify(l));
      return true;
    } catch {
      return false;
    }
  };
  const steps = [list.length, 64, 32, 16, 8, 4, 2, 0].filter((n, i, a) => n <= list.length && a.indexOf(n) === i);
  for (const n of steps) if (tryWrite(stripBeyond(n))) return true;
  return tryWrite(stripBeyond(0).slice(0, 300));
}

const AT = 1_780_000_000_000;
/**
 * `events` big enough that stripping them is visible in the payload size. Each
 * on its own step, so none supersedes another and the cache's compaction
 * (section 5) leaves them all: the back-off below is compared byte for byte
 * with main's, and that comparison is only about the back-off.
 */
const transcript = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({
    type: "message.appended",
    data: { messageId: `m-${tag}`, i, stepIndex: i, text: `${tag}-${"x".repeat(200)}-${i}` },
  }));

const chat = (i, { events = 40, at = AT - i * 1000 } = {}) => ({
  id: `chat-${i}`,
  clientKey: `new-${i}`,
  title: `Thread ${i}`,
  preview: "the last line of the answer",
  messageCount: 4,
  customers: ["acme"],
  session: { sessionId: `sess-${i}`, continuationToken: `tok-${i}`, streamIndex: events },
  events: transcript(events, i),
  updatedAt: at,
  derivedCustomers: ["acme"],
  toolCounts: { artifacts: 0, emails: 0, subagents: 0 },
});

/* ---------------------------------------------------------------------------
 * 1. A coalesced write ends with the same stored state as one write per change.
 * ------------------------------------------------------------------------ */

console.log("A turn's worth of writes:");
{
  // Ten persists of one streaming turn: the active chat grows, the other nine
  // threads are untouched and keep their identity — which is what a live turn
  // hands over, and what the JSON cache keys on.
  const others = Array.from({ length: 9 }, (_, i) => chat(i + 1));
  const states = [];
  for (let p = 1; p <= 10; p++) {
    states.push([{ ...chat(0, { events: p * 20, at: AT + p }) }, ...others]);
  }
  const protect = new Set(["chat-0", "new-0"]);

  const eager = fakeStorage();
  for (const list of states) writeSessionsOnMain(eager, KEY, list, protect);

  const frames = manualFrames();
  const lazy = fakeStorage();
  const writer = createPersistWriter({ storage: () => lazy, schedule: frames.schedule });
  for (const list of states) writer.queue(KEY, list, protect);
  // Every persist of the turn landed inside ONE frame: the worst case for
  // losing state and the best case for showing the coalescing works.
  frames.frame();

  equal("a coalesced write stores exactly what one-write-per-change stores", lazy.stats.value, eager.stats.value);
  check("…and it took one setItem instead of ten", lazy.stats.attempts.length === 1 && eager.stats.attempts.length === 10);
  check("…with nothing left owed", !writer.hasPending() && !frames.pending());

  // A half-updated list is the failure this would have if it batched CHANGES
  // instead of superseding whole lists. What is stored must be one of the
  // states exactly, never a mixture.
  const parsed = JSON.parse(lazy.stats.value);
  equal("the stored list is one complete state, never a mixture", parsed.length, 10);
  equal("…the newest one", parsed[0].events.length, 200);
  check("…and every other thread is still in it, unmangled", parsed.slice(1).every((s, i) => s.id === `chat-${i + 1}`));
}

/* ---------------------------------------------------------------------------
 * 2. A page that is going away gets no frame — and must still persist.
 * ------------------------------------------------------------------------ */

console.log("\nA closing page:");
{
  const frames = manualFrames();
  const store = fakeStorage();
  const writer = createPersistWriter({ storage: () => store, schedule: frames.schedule });
  const list = [chat(0, { events: 300, at: AT + 9 }), chat(1), chat(2)];
  writer.queue(KEY, list, new Set(["chat-0"]));

  check("before the frame, nothing is stored yet", store.stats.value === null && writer.hasPending());
  // `pagehide` gets one synchronous stack and then the page is gone: no frame,
  // no idle callback, no promise continuation. This is that stack.
  const wrote = writer.flush();
  check("flush() writes on the calling stack, with no frame in between", wrote && store.stats.value !== null);
  equal("…and it is the last state, not an earlier one", JSON.parse(store.stats.value)[0].events.length, 300);
  check("…and the frame that arrives later is a no-op, not a second write", !frames.frame() && store.stats.attempts.length === 1);
  check("flush() with nothing owed does nothing", !writer.flush() && store.stats.attempts.length === 1);
}

{
  // The same thing at the level where it is actually wired: the departure
  // handlers must flush the STORAGE write before the network write, because the
  // network one may never complete and the cached transcript cannot be rebuilt
  // from the server the way the mirror row can.
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  check(
    "pagehide/hidden/unmount flush the pending storage write, first",
    /const onHide = \(\) => \{\s*\n\s*flushSessionWrite\(\);\s*\n\s*flushSessions\(true\);/.test(shell),
  );
  check(
    "…including on unmount",
    /flushSessionWrite\(\);\s*\n\s*flushSessions\(true\);\s*\n\s*\};\s*\n\s*\}, \[flushSessions\]\)/.test(shell),
  );
  check(
    "…and the tab going hidden takes the same path (a phone's last event)",
    /document\.visibilityState === "hidden"\) onHide\(\)/.test(shell),
  );
  // The regression this file exists to prevent: putting the string building and
  // the setItem back inside the React commit.
  check(
    "the write is not performed inside the setSessions updater any more",
    !/localStorage\.setItem\(key, JSON\.stringify/.test(shell) && /persistWriter\.queue\(/.test(shell),
  );
  check(
    "the deliberate-action path (open/delete/archive) still writes through",
    /writeSessions\(email, next, new Set\(\[activeIdForWrite\.current \?\? ""\]\)\);\s*\n\s*flushSessionWrite\(\);/.test(shell),
  );
}

/* ---------------------------------------------------------------------------
 * 3. The quota back-off: still strips oldest-first, still caps.
 * ------------------------------------------------------------------------ */

console.log("\nOver quota:");
{
  // Twelve chats with real transcripts, and a quota only a few of them fit in.
  // The oldest must lose their streams; the ACTIVE one must keep its own
  // wherever it sits in the list, because it is the one being written to.
  const list = Array.from({ length: 12 }, (_, i) => chat(i, { events: 60 }));
  const protect = new Set(["chat-11"]); // the oldest — deliberately not near the top
  const full = serializeChats(list, () => true).length;
  const quota = Math.round(full / 3);

  const mine = fakeStorage(quota);
  const theirs = fakeStorage(quota);
  writeChats(mine, KEY, list, protect);
  writeSessionsOnMain(theirs, KEY, list, protect);

  equal("byte-identical to the implementation on main", mine.stats.value, theirs.stats.value);
  equal("…including the sizes it tried, in order", mine.stats.attempts, theirs.stats.attempts);
  check("…and it tried more than once (the back-off really ran)", mine.stats.attempts.length > 1);

  const stored = JSON.parse(mine.stats.value);
  equal("every chat is still in the list — metadata is never dropped for quota", stored.length, 12);
  check("the newest chats keep their transcripts", stored[0].events?.length === 60);
  check("the oldest ones are stripped to metadata", stored.at(-1).events === undefined || stored.at(-2).events === undefined);
  check(
    "a stripped chat keeps the second row the sidebar draws from",
    stored.every((s) => Array.isArray(s.derivedCustomers) && s.toolCounts),
  );
  const active = stored.find((s) => s.id === "chat-11");
  equal("the protected chat keeps its events wherever it sits", active.events.length, 60);
}

{
  // Nothing fits, not even metadata for everything: the last resort is to cap
  // the COUNT. Deliberately more chats than the ceiling.
  const many = Array.from({ length: 400 }, (_, i) => chat(i, { events: 2 }));
  const metaOnly = serializeChats(many, () => false).length;
  const capped = serializeChats(many.slice(0, STORAGE_MAX_CHATS), () => false).length;
  check("the harness is set up so only a capped write can fit", capped < metaOnly);

  const warnings = [];
  const store = fakeStorage(Math.round((metaOnly + capped) / 2));
  const ok = writeChats(store, KEY, many, new Set(), (m) => warnings.push(m));
  const theirs = fakeStorage(Math.round((metaOnly + capped) / 2));
  writeSessionsOnMain(theirs, KEY, many, new Set());

  check("it still writes something rather than giving up", ok && store.stats.value);
  equal("…capped to the ceiling", JSON.parse(store.stats.value).length, STORAGE_MAX_CHATS);
  equal("…byte-identical to main's last resort", store.stats.value, theirs.stats.value);
  check("…and it says so out loud", warnings.length === 1 && /capping chat count/.test(warnings[0]));
}

{
  // A storage that is switched off entirely (private window, "block all
  // cookies"). Reading `localStorage` can throw on ACCESS, so the writer must
  // survive having no storage at all rather than throwing out of a persist.
  const writer = createPersistWriter({ storage: () => null, schedule: manualFrames().schedule });
  writer.queue(KEY, [chat(0)], new Set());
  check("no storage at all is survivable, not throwable", writer.flush() === false);
}

/* ---------------------------------------------------------------------------
 * 4. An unchanged chat is not re-serialised. (The second half of the fix.)
 * ------------------------------------------------------------------------ */

console.log("\nWhat a turn actually re-serialises:");
{
  const others = Array.from({ length: 11 }, (_, i) => chat(i + 1));
  const store = fakeStorage();
  const before = { ...persistStats };
  writeChats(store, KEY, [chat(0, { at: AT + 1 }), ...others], new Set(["chat-0"]));
  const first = persistStats.serialized - before.serialized;
  equal("the first write serialises every chat once", first, 12);

  // One more persist of the same turn: only the active chat is a new object.
  const mark = { ...persistStats };
  writeChats(store, KEY, [chat(0, { events: 80, at: AT + 2 }), ...others], new Set(["chat-0"]));
  equal("the next write serialises only the chat that changed", persistStats.serialized - mark.serialized, 1);
  equal("…and reuses the other eleven", persistStats.reused - mark.reused, 11);

  // And the guard against the one way the cache could serve a lie: a chat
  // edited in place. Every update in chat-shell.tsx is a spread, so this cannot
  // happen today — the check is here so that it stays that way.
  const mutable = chat(99);
  writeChats(store, KEY, [mutable], new Set());
  const mutated = { ...persistStats };
  mutable.title = "renamed in place";
  mutable.updatedAt += 1;
  writeChats(store, KEY, [mutable], new Set());
  check("a chat mutated in place is serialised again, not served from cache", persistStats.serialized - mutated.serialized === 1);
  check("…and the new title reaches storage", /renamed in place/.test(store.stats.value));
}

{
  // The back-off pays for the stripped forms once, not once per step. Under
  // quota pressure this is the dominant saving: main re-stringified the WHOLE
  // list at every step, up to nine times per persist.
  const list = Array.from({ length: 12 }, (_, i) => chat(i, { events: 60 }));
  const quota = Math.round(serializeChats(list, () => true).length / 3);
  const store = fakeStorage(quota);
  const mark = { ...persistStats };
  writeChats(store, KEY, list, new Set());
  check("the back-off's steps ran", store.stats.attempts.length >= 2);
  check(
    "…and no chat was serialised more than twice (full + stripped) across them",
    persistStats.serialized - mark.serialized <= list.length * 2,
  );
}

/* ---------------------------------------------------------------------------
 * 5. The ways a queued write could go to the wrong place.
 * ------------------------------------------------------------------------ */

console.log("\nThe queue's own hazards:");
{
  // A workspace switch changes the storage key. A write queued under the old
  // key must land under the OLD key — filing one tenant's conversations under
  // another's is the bug `storageKey` was rewritten to fix.
  const keys = [];
  const store = {
    setItem(key, value) {
      keys.push([key, JSON.parse(value).length]);
    },
  };
  const frames = manualFrames();
  const writer = createPersistWriter({ storage: () => store, schedule: frames.schedule });
  writer.queue("workspace-chats:me:org-a", [chat(0), chat(1)], new Set());
  writer.queue("workspace-chats:me:org-b", [chat(2)], new Set());
  equal("a key change flushes the previous key first", keys, [["workspace-chats:me:org-a", 2]]);
  frames.frame();
  equal("…and the new key lands on its own frame", keys, [
    ["workspace-chats:me:org-a", 2],
    ["workspace-chats:me:org-b", 1],
  ]);
}

{
  // Two callers in one frame protect different chats (persist() protects the
  // active chat, handlePersist protects the one being written). Taking the last
  // caller's set would strip the loser's events. They are unioned.
  const list = [chat(0, { events: 60 }), chat(1, { events: 60 }), chat(2, { events: 60 }), chat(3, { events: 60 })];
  const quota = serializeChats(list, (s, i) => i < 2).length; // room for two streams
  const store = fakeStorage(quota);
  const frames = manualFrames();
  const writer = createPersistWriter({ storage: () => store, schedule: frames.schedule });
  writer.queue(KEY, list, new Set(["chat-3"]));
  writer.queue(KEY, list, new Set(["chat-2"]));
  frames.frame();
  const stored = JSON.parse(store.stats.value);
  const kept = stored.filter((s) => s.events).map((s) => s.id);
  check(`both frames' protected chats kept their events (kept ${kept.join(", ")})`, kept.includes("chat-2") && kept.includes("chat-3"));
}

{
  // The serialiser's central claim, stated as bytes: assembling the payload from
  // per-chat pieces is the same string JSON.stringify of the whole array makes.
  const list = Array.from({ length: 6 }, (_, i) => chat(i, { events: 10 }));
  const stripped = list.map((s, i) => (i < 3 ? s : { ...s, events: undefined }));
  equal(
    "serializeChats is byte-identical to JSON.stringify of the same list",
    serializeChats(list, (_s, i) => i < 3),
    JSON.stringify(stripped),
  );
}

/* ---------------------------------------------------------------------------
 * 5. A thread bigger than the quota (mold_v1-104).
 *
 * The operator's real thread was 44.6 MB of JSON for a 60 KB answer: eve's
 * `message.appended` carries the whole text so far on every delta. As the open
 * chat it is protected, so on main every step of the back-off kept it, every
 * step failed, and so did the last resort: NOTHING was stored — not even the
 * other chats' titles — after one failed 45 MB serialisation per step.
 * ------------------------------------------------------------------------ */

console.log("\nA thread bigger than the quota (mold_v1-104):");
{
  const { defaultMessageReducer } = await import("eve/client");
  const { withSessionEpochs, absoluteIndexBase, serverEventCount } = await import("../lib/chat-turn-state.ts");
  // The real shape: a turn that thinks (reasoning deltas), then streams a 60 KB
  // answer in 40-character deltas, each carrying everything so far.
  const ANSWER = Array.from({ length: 1500 }, (_, i) => `| row ${String(i).padStart(4, "0")} | ${"v".repeat(24)} |\n`).join("").slice(0, 60_000);
  const THINK = "I should build the table from the filings. ".repeat(60);
  const big = [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId: "turn_0", sequence: 0 } },
    { type: "message.received", data: { turnId: "turn_0", message: "the table please", sequence: 0 } },
    { type: "step.started", data: { turnId: "turn_0", stepIndex: 0, sequence: 0 } },
  ];
  for (let i = 40; i <= THINK.length; i += 40) big.push({ type: "reasoning.appended", data: { turnId: "turn_0", stepIndex: 0, reasoningDelta: THINK.slice(i - 40, i), reasoningSoFar: THINK.slice(0, i) } });
  big.push({ type: "reasoning.completed", data: { turnId: "turn_0", stepIndex: 0, reasoning: THINK } });
  for (let i = 40; i <= ANSWER.length; i += 40) big.push({ type: "message.appended", data: { turnId: "turn_0", stepIndex: 0, messageDelta: ANSWER.slice(i - 40, i), messageSoFar: ANSWER.slice(0, i) } });
  big.push({ type: "message.completed", data: { turnId: "turn_0", stepIndex: 0, message: ANSWER, finishReason: "stop" } });
  big.push({ type: "step.completed", data: { turnId: "turn_0", stepIndex: 0 } }, { type: "turn.completed", data: { turnId: "turn_0" } });
  big.push({ type: "session.waiting", data: { continuationToken: "tok-big" } }, { type: "client.input.responded", data: { responses: [] } });
  const huge = { ...chat(0, { at: AT + 50 }), events: big, session: { sessionId: "sess-big", continuationToken: "tok-big", streamIndex: 1 + serverEventCount(big) - 1 } };
  const rawChars = JSON.stringify(huge).length;
  check(`the harness thread is the real shape: ${(rawChars / 1e6).toFixed(1)} MB of JSON for a ${ANSWER.length / 1000} KB answer`, rawChars > 40e6);

  const others = Array.from({ length: 5 }, (_, i) => chat(i + 1, { events: 20 }));
  const list = [huge, ...others];
  const protect = new Set(["chat-0", "new-0"]);
  const QUOTA = 5_000_000; // characters, as browsers count localStorage

  const theirs = fakeStorage(QUOTA);
  const mainOk = writeSessionsOnMain(theirs, KEY, list, protect);
  check(
    `before: nothing at all was stored (${theirs.stats.attempts.length} attempts of ${(theirs.stats.attempts[0] / 1e6).toFixed(0)} MB, every one refused)`,
    !mainOk && theirs.stats.value === null && theirs.stats.attempts.length >= 5,
  );

  const mine = fakeStorage(QUOTA);
  const ok = writeChats(mine, KEY, list, protect);
  check("now the list is stored, first try", ok && mine.stats.attempts.length === 1);
  const stored = JSON.parse(mine.stats.value);
  const cached = stored.find((s) => s.id === "chat-0");
  check(
    `…with the open thread's transcript cached, compacted: ${(JSON.stringify(cached).length / 1e3).toFixed(0)} KB instead of ${(rawChars / 1e6).toFixed(1)} MB`,
    Array.isArray(cached.events) && JSON.stringify(cached).length < 500_000,
  );
  check("…and every other chat with its own", stored.filter((s) => s.id !== "chat-0").every((s) => s.events?.length === 20));
  const fold = (events) => {
    const reducer = withSessionEpochs(defaultMessageReducer());
    let data = reducer.initial();
    for (const e of events) data = reducer.reduce(data, e);
    return JSON.stringify(data.messages);
  };
  check("the cached transcript projects EXACTLY what the full one does (thinking and answer, finished)", fold(cached.events) === fold(big));
  check("…and keeps the chat's browser-made markers", cached.events.some((e) => e.type === "client.input.responded"));

  // Reopening from it: the mount measures the gap between the cursor and the
  // events it was given, and resumes the stream exactly where it stood.
  const base = absoluteIndexBase(cached.session.streamIndex, cached.events);
  check("a reopen resumes at the true stream index, not before it", serverEventCount(cached.events) + base === serverEventCount(big));

  // MID-TURN: the store's own cursor stands at the last boundary while the reply
  // streams, and a persist files it beside every event since. The cache keeps
  // one event per event, so the mount's count covers the gap exactly as the
  // full transcript's would.
  const midTurn = big.slice(0, 1000);
  const lagging = 0;
  const compacted = JSON.parse(chatJsonOf({ ...chat(9), events: midTurn })).events;
  check(
    "mid-turn, with the store's lagging cursor, the cache mounts at the index the full transcript does",
    compacted.length === midTurn.length &&
      serverEventCount(compacted) + absoluteIndexBase(lagging, compacted) === serverEventCount(midTurn) + absoluteIndexBase(lagging, midTurn),
  );
  check("…and it is still small", JSON.stringify(compacted).length < JSON.stringify(midTurn).length / 20);

  // A transcript that is heavy even compacted: over the per-chat cap it is
  // cached as metadata (the server's snapshot rebuilds it), protected or not.
  const distinct = Array.from({ length: 900 }, (_, i) => ({ type: "action.result", data: { turnId: "turn_0", stepIndex: i, result: { callId: `c${i}`, output: "o".repeat(2_000) } } }));
  const heavy = { ...chat(0, { at: AT + 60 }), events: distinct };
  check("the harness: this one is over the per-chat cap even compacted", !chatCacheable(heavy) && JSON.stringify(heavy).length > CHAT_CACHE_MAX_CHARS);
  const warnings = [];
  const store = fakeStorage(QUOTA);
  check("a chat over the cap never blocks the write", writeChats(store, KEY, [heavy, ...others], protect, (m) => warnings.push(m)) && store.stats.attempts.length === 1);
  const heavyStored = JSON.parse(store.stats.value).find((s) => s.id === "chat-0");
  check("…it is kept as metadata (title, session to reopen), without the transcript", heavyStored.events === undefined && heavyStored.session?.sessionId === "sess-0");
  const again = persistStats.serialized;
  writeChats(fakeStorage(QUOTA), KEY, [heavy, ...others], protect);
  check(`…and the next persist does not build its full JSON again (${persistStats.serialized - again} rebuilt)`, persistStats.serialized === again);

  // FAIL GRACEFULLY: a quota so small that even the open chat's COMPACTED
  // transcript does not fit beside the list. The list is what must survive.
  const tiny = fakeStorage(Math.round(JSON.stringify(cached).length / 2));
  const survived = writeChats(tiny, KEY, list, protect, (m) => warnings.push(m));
  const tinyStored = survived ? JSON.parse(tiny.stats.value) : [];
  check(
    "with no room even for that, the chat list is still stored (metadata for every chat)",
    survived && tinyStored.length === list.length && tinyStored.every((s) => s.events === undefined),
  );
  check("…and it says so", warnings.some((m) => /does not fit in localStorage — storing the chat list without it/.test(m)));
}

/* ---------------------------------------------------------------------------
 * 6. PARITY: a chat mounted from the cache decides exactly what the full stream
 *    decides (review of #81).
 *
 * The cache used to DROP superseded deltas. A mount measures its absolute-index
 * deficit once (`absoluteIndexBase` = cursor − events held), so every event kept
 * before a dropped delta was read at an index shifted UP by the deltas dropped
 * after it. `outstandingDeliveries` then saw the park's `session.waiting` at or
 * past the answer's `at` and settled the answer early, `attachDecision` said
 * "terminal", and a reload during a resumed hand-back froze it at two parts. The
 * same shift can drop a delivery made after a `session.completed` (`ended`) and
 * loosen `message.received` matching. So: at EVERY prefix of every recorded
 * stream with deliveries, and with the store's own lagging cursor as well as
 * the exact one, the cached mount must give the same outstanding deliveries and
 * the same attach decision as the full one.
 * ------------------------------------------------------------------------ */

console.log("\nParity: a mount from the cache decides what the full stream decides (review of #81):");
{
  const { absoluteIndexBase, attachDecision, isSessionBoundary, outstandingDeliveries, serverEventCount } = await import("../lib/chat-turn-state.ts");
  const loadNd = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cases = [];
  for (const name of ["buffered-behind-park", "buffered-mid-turn", "stop-before-first-token"]) {
    const events = loadNd(`scripts/fixtures/buffered-turns/${name}.ndjson`);
    const recorded = JSON.parse(readFileSync(`scripts/fixtures/buffered-turns/${name}.deliveries.json`, "utf8")).deliveries;
    const deliveries = recorded
      .filter((d) => d.message !== undefined || d.inputResponses)
      .map((d) => ({ text: d.message ?? "", at: d.at, kind: d.inputResponses ? "answer" : "message" }));
    cases.push({ name, events, deliveries });
  }
  // Two parked delegations, each answered right after its park (recorded, event-order fixtures).
  const two = loadNd("scripts/fixtures/event-order/two-parked-handbacks.ndjson");
  const parks = two.map((e, i) => (e.type === "session.waiting" ? i + 1 : -1)).filter((i) => i > 0);
  cases.push({ name: "two-parked-handbacks", events: two, deliveries: [{ text: "", at: parks[0], kind: "answer" }, { text: "MSG-3 ASK delegate again", at: parks[1], kind: "message" }, { text: "", at: parks[2], kind: "answer" }] });
  // The review's PARK scenario: a question parks, the answer is POSTed, the resumed hand-back streams many deltas.
  const E = (type, data) => ({ type, data, meta: { at: "2026-09-29T00:00:00Z" } });
  const park = [E("session.started", {}), E("turn.started", { sequence: 0, turnId: "turn_0" }), E("message.received", { message: "q", parts: [{ type: "text", text: "q" }], sequence: 0, turnId: "turn_0" }),
    E("step.started", { sequence: 0, stepIndex: 0, turnId: "turn_0" }), E("actions.requested", { actions: [{ kind: "subagent-call", callId: "c1", subagentName: "configuration", input: {} }], sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    E("input.requested", { requests: [{ requestId: "r1", action: { callId: "r1", kind: "tool-call", toolName: "ask_question", input: {} } }], sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    E("turn.completed", { sequence: 0, turnId: "turn_0" }), E("session.waiting", { continuationToken: "tokP", wait: "next-user-message" })];
  const answeredAt = park.length;
  park.push(E("step.started", { sequence: 1, stepIndex: 0, turnId: "" }));
  let so = "";
  for (let i = 0; i < 30; i++) { so += `HANDBACK part ${i}. `; park.push(E("message.appended", { messageDelta: `HANDBACK part ${i}. `, messageSoFar: so, sequence: 1, stepIndex: 0, turnId: "" })); }
  park.push(E("message.completed", { message: so, finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "" }), E("step.completed", { sequence: 1, stepIndex: 0, turnId: "" }), E("turn.completed", { sequence: 1, turnId: "" }), E("session.waiting", { continuationToken: "tokP", wait: "next-user-message" }));
  cases.push({ name: "PARK, reload during the resumed hand-back", events: park, deliveries: [{ text: "q", at: 0, kind: "message" }, { text: "", at: answeredAt, kind: "answer" }] });

  const NOW = Date.now();
  const cacheOf = (events) => JSON.parse(chatJsonOf({ ...chat(7), events })).events;
  const verdict = (events, base, deliveries) => {
    const out = outstandingDeliveries({ deliveries, events, indexBase: base, now: NOW });
    const d = attachDecision({ sessionId: "s", storeBusy: false, events, outstanding: out.length });
    return JSON.stringify({ owed: out.map((x) => `${x.kind}@${x.at}`), attach: d.attach, reason: d.reason });
  };
  const { defaultMessageReducer } = await import("eve/client");
  const { withSessionEpochs } = await import("../lib/chat-turn-state.ts");
  const projection = (events) => {
    const r = withSessionEpochs(defaultMessageReducer());
    let data = r.initial();
    for (const e of events) data = r.reduce(data, e);
    return JSON.stringify(data.messages);
  };
  let prefixes = 0;
  for (const c of cases) {
    const mismatches = [];
    for (let n = 1; n <= c.events.length; n++) {
      const prefix = c.events.slice(0, n);
      const deliveries = c.deliveries.filter((d) => d.at <= n).map((d) => ({ ...d, sentAt: NOW - 1_000 }));
      const cached = cacheOf(prefix);
      // The cursor a persist files: what was read (exact), or the store's own, which only moves at a boundary.
      let lastBoundary = 0;
      prefix.forEach((e, i) => { if (isSessionBoundary(e)) lastBoundary = i + 1; });
      for (const cursor of [serverEventCount(prefix), lastBoundary]) {
        const full = verdict(prefix, absoluteIndexBase(cursor, prefix), deliveries);
        const mounted = verdict(cached, absoluteIndexBase(cursor, cached), deliveries);
        if (full !== mounted) mismatches.push({ n, cursor, full, mounted });
      }
      if (projection(prefix) !== projection(cached)) mismatches.push({ n, projection: "differs" });
      prefixes++;
    }
    check(`${c.name}: at all ${c.events.length} prefixes, the cached mount owes, attaches and projects exactly as the full one`, mismatches.length === 0 || (console.log("     first:", JSON.stringify(mismatches[0])), false));
  }
  check(`(${prefixes} prefixes compared, each with two cursors)`, prefixes > 100);
  const cachedPark = cacheOf(park);
  check("every cached event keeps its stream position (one event per event)", cachedPark.length === park.length);
  const texts = (evs) => evs.reduce((n, e) => n + (typeof e.data?.messageSoFar === "string" ? e.data.messageSoFar.length : 0) + (typeof e.data?.message === "string" && e.type === "message.completed" ? e.data.message.length : 0), 0);
  check("…and the quadratic text is gone: the hand-back's text is held once (by its completion)", texts(cachedPark) === so.length && texts(park) > 10 * so.length);
}

/** The JSON the cache stores for one chat, with its events. */
function chatJsonOf(c) {
  return serializeChats([c], () => true).slice(1, -1);
}

console.log(`\nchat persist: ${passed}/${passed} checks passed`);
