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
  STORAGE_MAX_CHATS,
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
/** `events` big enough that stripping them is visible in the payload size. */
const transcript = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({
    type: "message.appended",
    data: { messageId: `m-${tag}`, i, text: `${tag}-${"x".repeat(200)}-${i}` },
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

console.log(`\nchat persist: ${passed}/${passed} checks passed`);
