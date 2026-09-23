// fde:chat-persist-perf — what ONE persist costs the main thread during a
// streaming turn, before and after, measured rather than reasoned about.
//
// The chat froze while it SAVED. Three costs, all synchronous, all sitting
// between an answer changing and the browser painting it:
//
//   1. dedupeEvents over the whole transcript      — lib/chat-snapshot.ts
//   2. JSON.stringify of the whole chat list       — the write payload
//   3. localStorage.setItem of that string         — the browser's own copy
//
// (1) was fixed by `createEventDeduper`. (2) and (3) are what lib/chat-persist.ts
// changes: the write moves off the React commit onto an animation frame, and the
// chats that did NOT change during the turn keep the JSON they already had.
//
// WHAT THIS CAN AND CANNOT MEASURE. (1) and (2) are pure computation and are
// measured here exactly as the browser performs them, on the real modules. (3)
// is the browser writing a string into a disk-backed store and has no honest
// analogue in node — the fake storage below only counts it. So the setItem term
// is reported as calls and bytes, never as milliseconds, and every millisecond
// in the summary is (1) + (2) alone. That makes the reported win a LOWER bound.
//
// THE QUOTA IS PART OF THE MEASUREMENT, which is the thing a no-quota harness
// gets wrong. localStorage is ~5 MB; over it, `setItem` THROWS and the back-off
// re-serialises the whole list with more event streams stripped, up to nine
// times. Those attempts are the dominant cost on a big thread, and they are
// exactly what the per-chat JSON cache removes. `--quota-mb 0` lifts it.
//
// The transcript is shaped like the one that produced the complaint: eve's
// `message.appended` carries `messageSoFar` — the WHOLE answer so far — on every
// delta, so a turn that ends in a 60 KB table is tens of megabytes of JSON long
// before anything tries to persist it.
//
//   npm run fde:chat-persist-perf
//   npm run fde:chat-persist-perf -- --events 3963 --table-kb 7   # the operator's real thread
//   npm run fde:chat-persist-perf -- --quota-mb 0 --persists 12
//   npm run fde:chat-persist-perf -- --json
import { createHash } from "node:crypto";
import { createEventDeduper, dedupeEvents } from "../../lib/chat-snapshot.ts";
import { createPersistWriter } from "../../lib/chat-persist.ts";
import { glyph, flag, hasFlag } from "./lib/fde.mjs";

const EVENTS = Math.max(10, Number(flag("events")) || 1500);
/**
 * How many times the turn persists. NOT once per delta any more: agent-chat's
 * `persistTick` already took the persist off the character and onto a 2 s tick
 * plus the real progress markers, so a two-minute turn persists a few dozen
 * times. Each one used to pay the whole cost below.
 */
const PERSISTS = Math.max(1, Number(flag("persists")) || 16);
/** Other threads in the sidebar — the ones a streaming turn does not touch. */
const CHATS = flag("chats") === "" ? 12 : Math.max(0, Number(flag("chats")));
const TABLE_KB = Math.max(1, Number(flag("table-kb")) || 60);
const QUOTA_MB = flag("quota-mb") === "" ? 5 : Math.max(0, Number(flag("quota-mb")));
const QUOTA = QUOTA_MB > 0 ? QUOTA_MB * 1024 * 1024 : Infinity;

/** Fixed, so the two paths build byte-identical rows and the comparison means something. */
const BASE_AT = 1_780_000_000_000;
const KEY = "fde-chats:perf@onfinance.in:default";

const ms = (n) => `${n.toFixed(1)}ms`;
const mb = (n) => `${(n / 1_048_576).toFixed(1)}MB`;

function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  console.log(`  ${line(headers)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rows) console.log(`  ${line(r)}`);
}

/** A markdown table of roughly `kb` kilobytes — the answer people actually ask for. */
function bigTable(kb) {
  let out = "| customer | tier | stage | owner | ARR | health | last touch |\n|---|---|---|---|---|---|---|\n";
  let i = 0;
  while (out.length < kb * 1024) {
    out += `| customer-${i} | enterprise | pilot | fde-${i % 7}@onfinance.in | $${(i * 1237) % 900000} | ${i % 3 ? "green" : "amber"} | 2026-0${(i % 9) + 1}-1${i % 9} |\n`;
    i++;
  }
  return out;
}

/**
 * One turn, as eve emits it: a park, a user message, then deltas that each carry
 * the whole answer so far, then a boundary. The `messageSoFar` growth is why the
 * transcript is tens of megabytes for a 60 KB answer, and why the old code could
 * not afford to look at all of it on every persist.
 */
function buildTurn(count, answer) {
  const events = [
    { type: "session.waiting", data: { continuationToken: "tok-0" } },
    { type: "message.received", data: { role: "user", content: [{ type: "text", text: "Give me the customer table." }] } },
  ];
  const deltas = Math.max(1, count - 4);
  for (let i = 1; i <= deltas; i++) {
    const cut = Math.max(1, Math.round((answer.length * i) / deltas));
    events.push({
      type: "message.appended",
      data: {
        messageId: "msg-1",
        role: "assistant",
        // The whole answer so far, every time. This is the quadratic term.
        messageSoFar: { role: "assistant", content: [{ type: "text", text: answer.slice(0, cut) }] },
      },
    });
  }
  events.push({ type: "turn.completed", data: { index: count } });
  events.push({ type: "session.waiting", data: { continuationToken: "tok-1" } });
  return events;
}

/** A sidebar of OTHER threads: real cached transcripts this turn never touches. */
function buildOtherChats(n, answer) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      id: `chat-${i}`,
      clientKey: `new-${i}`,
      title: `Thread ${i}`,
      preview: answer.slice(0, 200),
      messageCount: 8,
      customers: ["acme", "globex"],
      session: { sessionId: `sess-${i}`, continuationToken: `tok-${i}`, streamIndex: 120 },
      events: buildTurn(120, answer.slice(0, 8 * 1024)),
      updatedAt: BASE_AT - (i + 1) * 60_000,
      derivedCustomers: ["acme"],
      toolCounts: { artifacts: 1, emails: 0, subagents: 2 },
    });
  }
  return list;
}

/**
 * `writeSessions`, TRANSCRIBED from app/_components/chat-shell.tsx as it stood
 * on main (a586846) before this change. Copied rather than imported because the
 * point is to run both implementations in one process; if the original changes
 * this drifts and the comparison is void, which is why the SHA is written down.
 */
function writeSessionsBefore(storage, key, sessions, protect) {
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

/**
 * A storage that throws the way a browser's does, and is honest about what it
 * is not: it counts calls and bytes, it never claims to cost what a disk-backed
 * store costs.
 *
 * Every ATTEMPT is fingerprinted (length + a hash of the last one) so the two
 * paths can be compared on what they actually handed the browser, including the
 * attempts that were refused — an equivalence that only comparing the accepted
 * write would miss.
 */
function fakeStorage(quota) {
  const s = { attempts: 0, accepted: 0, bytes: 0, lengths: [], lastAccepted: "", lastAttempt: "" };
  return {
    stats: s,
    setItem(_key, value) {
      s.attempts++;
      s.bytes += value.length;
      s.lengths.push(value.length);
      s.lastAttempt = value;
      if (value.length > quota) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      s.accepted++;
      s.lastAccepted = value;
    },
  };
}

const sha = (v) => createHash("sha1").update(v).digest("hex").slice(0, 12);

function main() {
  const json = hasFlag("json");
  const answer = bigTable(TABLE_KB);
  const transcript = buildTurn(EVENTS, answer);
  const others = buildOtherChats(CHATS, answer);
  const transcriptBytes = JSON.stringify(transcript).length;

  // The persist points of one turn: an ever-growing prefix of the same stream,
  // element references stable — exactly what a live turn hands over.
  const prefixes = [];
  for (let p = 1; p <= PERSISTS; p++) {
    prefixes.push(transcript.slice(0, Math.max(2, Math.round((transcript.length * p) / PERSISTS))));
  }

  const activeChat = (events, p) => ({
    id: "chat-active",
    clientKey: "new-active",
    title: "Customer table",
    preview: answer.slice(0, 200),
    messageCount: 2,
    customers: ["acme"],
    session: { sessionId: "sess-active", continuationToken: "tok-1", streamIndex: events.length },
    events,
    updatedAt: BASE_AT + p,
    derivedCustomers: ["acme"],
    toolCounts: { artifacts: 0, emails: 0, subagents: 0 },
  });
  const protect = new Set(["chat-active", "new-active"]);

  /**
   * One run of the turn.
   *
   *   mode "before"  full dedupe + main's writeSessions, synchronously
   *   mode "after"   incremental dedupe + a coalesced, cache-backed write
   *
   * `framesPer` is how many persists share one animation frame. 1 is the WORST
   * case for coalescing — nothing is ever superseded, so the only saving left is
   * the per-chat JSON cache. Real bursts (a message, an answered input and a
   * tick landing together) drop writes on top of that.
   */
  function run(mode, framesPer = 1) {
    const store = fakeStorage(QUOTA);
    const deduper = mode === "before" ? null : createEventDeduper();
    let due = null;
    const writer =
      mode === "before"
        ? null
        : createPersistWriter({
            storage: () => store,
            // A scheduler under this script's control, so "one write per frame"
            // is something it OBSERVES rather than a timing it hopes for.
            schedule: (fn) => {
              due = fn;
              return () => {
                due = null;
              };
            },
          });
    let dedupeMs = 0;
    let writeMs = 0;
    for (let p = 0; p < prefixes.length; p++) {
      const t0 = performance.now();
      const clean = deduper ? deduper(prefixes[p]) : dedupeEvents(prefixes[p]);
      dedupeMs += performance.now() - t0;
      const list = [activeChat(clean, p), ...others];
      const t1 = performance.now();
      if (writer) {
        writer.queue(KEY, list, protect);
        if (p % framesPer === framesPer - 1) {
          const fn = due;
          due = null;
          fn?.();
        }
      } else {
        writeSessionsBefore(store, KEY, list, protect);
      }
      writeMs += performance.now() - t1;
    }
    writer?.flush();
    return {
      dedupeMs,
      writeMs,
      perDedupe: dedupeMs / PERSISTS,
      perWrite: writeMs / PERSISTS,
      perTotal: (dedupeMs + writeMs) / PERSISTS,
      ...store.stats,
      lastAccepted: undefined,
      lastAttempt: undefined,
      acceptedHash: store.stats.lastAccepted ? sha(store.stats.lastAccepted) : null,
      acceptedBytes: store.stats.lastAccepted.length,
      attemptHash: store.stats.lastAttempt ? sha(store.stats.lastAttempt) : null,
      lengths: store.stats.lengths,
    };
  }

  const before = run("before");
  const after = run("after");
  const burst = run("after", 3);

  /**
   * The claim the whole change rests on: the browser is handed the SAME bytes.
   * Compared on the last accepted write, on the last attempt (so a run where
   * nothing fits is still compared on something), and on the full sequence of
   * attempt sizes — which is the back-off's own shape.
   */
  const sameStored = before.acceptedHash === after.acceptedHash;
  const sameAttempt = before.attemptHash === after.attemptHash;
  const samePattern =
    JSON.stringify(before.lengths.slice(0, before.lengths.length / PERSISTS)) ===
    JSON.stringify(after.lengths.slice(0, after.lengths.length / PERSISTS));
  const equivalent = sameStored && sameAttempt;

  if (json) {
    console.log(
      JSON.stringify(
        {
          shape: { events: EVENTS, persists: PERSISTS, otherChats: CHATS, tableKb: TABLE_KB, quotaMb: QUOTA_MB, transcriptBytes },
          before: { ...before, lengths: undefined },
          after: { ...after, lengths: undefined },
          burst: { ...burst, lengths: undefined },
          equivalent,
          sameStored,
          sameAttempt,
          samePattern,
        },
        null,
        2,
      ),
    );
    return equivalent;
  }

  console.log(
    `\nChat persist cost — ${EVENTS}-event turn, a ${TABLE_KB} KB table, ${CHATS} other threads, ` +
      `${QUOTA_MB ? `${QUOTA_MB} MB quota` : "no quota"}\n`,
  );
  console.log(
    `  the active transcript alone is ${mb(transcriptBytes)} of JSON for a ${TABLE_KB} KB answer,\n` +
      `  because every delta carries the whole answer so far.\n`,
  );
  table(
    ["path", "dedupe/persist", "write/persist", "TOTAL/persist", "setItem calls", "…accepted", "bytes handed over"],
    [
      ["before (main)", ms(before.perDedupe), ms(before.perWrite), ms(before.perTotal), String(before.attempts), String(before.accepted), mb(before.bytes)],
      ["after", ms(after.perDedupe), ms(after.perWrite), ms(after.perTotal), String(after.attempts), String(after.accepted), mb(after.bytes)],
      ["after, 3/frame", ms(burst.perDedupe), ms(burst.perWrite), ms(burst.perTotal), String(burst.attempts), String(burst.accepted), mb(burst.bytes)],
    ],
  );
  const pct = (x, y) => (x > 0 ? `${Math.round((1 - y / x) * 100)}% less` : "—");
  console.log(
    `\n  ${glyph.ok} blocking main-thread work per persist: ${ms(before.perTotal)} → ${ms(after.perTotal)} (${pct(before.perTotal, after.perTotal)})\n` +
      `      dedupe  ${ms(before.perDedupe)} → ${ms(after.perDedupe)} (${pct(before.perDedupe, after.perDedupe)})  — createEventDeduper\n` +
      `      write   ${ms(before.perWrite)} → ${ms(after.perWrite)} (${pct(before.perWrite, after.perWrite)})  — per-chat JSON cache across the back-off\n` +
      `      and none of it runs inside the React commit any more, so the paint\n` +
      `      that shows the new text no longer waits for the save at all.\n`,
  );
  console.log(
    `  ${glyph.info} setItem's own cost is NOT in those milliseconds — node has no honest\n` +
      `      analogue. It is pure loss removed on top: ${before.attempts} → ${after.attempts} calls over the turn\n` +
      `      (${burst.attempts} when persists arrive in bursts), ${mb(before.bytes)} → ${mb(after.bytes)} of string.\n`,
  );
  if (before.accepted === 0) {
    console.log(
      `  ${glyph.warn} NOTHING FIT. At this size every back-off step overflows ${QUOTA_MB} MB, including\n` +
        `      the final metadata-only one, because the active chat is protected and its\n` +
        `      stream alone is ${mb(transcriptBytes)}. That is a real property of the code, not of this\n` +
        `      harness: a thread this size has no local cache and re-replays from the\n` +
        `      server on every open. Unchanged by this PR, and worth its own issue.\n`,
    );
  }
  console.log(
    equivalent
      ? `  ${glyph.ok} both paths handed the browser the same bytes` +
          ` (stored ${before.acceptedHash ?? "—"} / ${mb(before.acceptedBytes)}, last attempt ${before.attemptHash}),\n` +
          `      and the back-off tried the same sizes in the same order.\n`
      : `  ${glyph.bad} THE PAYLOADS DIFFER — the change is not equivalent.` +
          ` stored ${before.acceptedHash} vs ${after.acceptedHash},` +
          ` last attempt ${before.attemptHash} vs ${after.attemptHash}\n`,
  );
  return equivalent;
}

if (!main()) process.exit(1);
