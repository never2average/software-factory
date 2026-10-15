/**
 * One record per chat open, and the rows it sends, executed with a fake clock (lib/chat-open-timing.ts).
 *
 * No browser has ever timed a chat open: every figure came from a server or from reading code. The record is the
 * instrument, so this holds what it must do, and what it must never do:
 *
 *   1. the kinds exist: `thread-open`, `thread-open-count`, `snapshot-refused`, `snapshot-discarded` and
 *      `snapshot-skipped` are accepted by the telemetry route (its enum is derived from lib/chat-telemetry.ts; a kind
 *      missing there is accepted with a 202 and silently dropped);
 *   2. a local open (no request at all) writes a record: route, paint, composer-ready, one mount;
 *   3. a snapshot open whose seam read was empty and then kept: route, seam, reads, no shimmer, one mount;
 *   4. the counter covers EVERY open by route; the detailed row only a slow open, a returned shimmer or a remount;
 *   5. rows carry numbers only (no text, no raw id in the detail) and fit the route's limit;
 *   6. the specialist-stream probe (the Control Panel's half) adds up per open, and never crosses into the next open;
 *   7. nothing throws, whatever the page hands it: a post, a composer probe or a sampler that throws;
 *   8. the shell calls it where it says it does (the local mount included, which wrote nothing before).
 *
 * Run:  npm run test:chat-open-timing
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isChatTelemetryKind } from "../lib/chat-telemetry.ts";
import * as timing from "../lib/chat-open-timing.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* ---- a fake clock ------------------------------------------------------------------------------------------- */
function fakeClock() {
  let now = 1_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const h = ++id;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h) => timers.delete(h),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [h, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
  };
}

function setup(over = {}) {
  timing.resetChatOpenTimingForTest();
  const clock = fakeClock();
  const rows = [];
  let composer = false;
  timing.configureChatOpenTiming({
    clock,
    post: (row, keepalive) => rows.push({ ...row, keepalive }),
    composerReady: () => composer,
    lagSampler: () => () => ({ source: "drift", count: 2, totalMs: 300, maxMs: 200, windowMs: 30_000 }),
    storageChars: () => 4_200_000,
    windowStore: false,
    ...over,
  });
  return { clock, rows, setComposer: (v) => (composer = v) };
}

/* ---- 1. the kinds ---------------------------------------------------------------------------------------------- */
console.log("The kinds the route accepts:");
for (const kind of ["thread-open", "thread-open-count", "snapshot-refused", "snapshot-discarded", "snapshot-skipped"]) {
  check(`'${kind}' is a kind the route records (not a 202 into the void)`, isChatTelemetryKind(kind));
}

/* ---- 2. the local open ----------------------------------------------------------------------------------------- */
console.log("\nA local open (this browser's cache, no request):");
{
  const { clock, rows, setComposer } = setup();
  const h = timing.beginChatOpen({ chatId: "chat-1", sessionId: "sess-1", storedEvents: 120, storedToken: true });
  h.route("local");
  clock.advance(80);
  // The shell's commit hook: the open's chat committed with messages and no shimmer.
  timing.noteChatCommit({ mountKey: "chat-1", reactKey: "chat-1#0", hasMessages: true, shimmer: false });
  check("a record exists for an open that made no request", h.record.route === "local" && h.record.seq === 1);
  check("paint is click to the first commit with messages", h.record.paintMs === 80);
  check("one mount", h.record.mounts === 1 && h.record.mountCauses[0] === "open");
  setComposer(true);
  clock.advance(50);
  check("composer-ready is measured from the click, after paint", h.record.composerReadyMs === 130);
  check("what this browser held at the click is kept", h.record.stored.events === 120 && h.record.stored.token === true);
  clock.advance(timing.OPEN_WINDOW_MS);
  check("the record closes after the 30 s window", h.record.closed);
  check("…with the main thread's lag over the window", h.record.lag.source === "drift" && h.record.lag.count === 2 && h.record.lag.maxMs === 200);
  check("…and the origin's localStorage size", h.record.storageChars === 4_200_000);
  check("a fast, single-mount open posts no detailed row", !rows.some((r) => r.kind === "thread-open"));
  clock.advance(timing.COUNTER_FLUSH_MS);
  const count = rows.find((r) => r.kind === "thread-open-count");
  check("…but it is COUNTED, by route", count !== undefined && /opens=1/.test(count.detail) && /local=1/.test(count.detail));
}

/* ---- 3. the snapshot open with an empty seam read -------------------------------------------------------------- */
console.log("\nA snapshot open whose seam read came back empty, then kept:");
{
  const { clock, rows } = setup();
  const h = timing.beginChatOpen({ chatId: "chat-2", sessionId: "sess-2", storedEvents: 0, storedToken: true });
  // Commits of the PREVIOUS chat while the saved copy is fetched are not this open's.
  timing.noteChatCommit({ mountKey: "chat-1", reactKey: "chat-1#0", hasMessages: true, shimmer: true });
  clock.advance(300);
  h.snapshot(300, true);
  h.route("snapshot");
  timing.noteChatCommit({ mountKey: "chat-2", reactKey: "chat-2#0", hasMessages: true, shimmer: false });
  h.seam("empty", 900);
  h.seam("empty", 2_500);
  h.savedCopy("none");
  check("route snapshot, saved copy found in 300 ms", h.record.route === "snapshot" && h.record.snapshotMs === 300 && h.record.snapshotFound === true);
  check("seam empty, read twice, 3.4 s of tail reads", h.record.seam === "empty" && h.record.seamReads === 2 && h.record.tailMs === 3_400);
  check("paint at the saved copy's mount, not after the seam", h.record.paintMs === 300);
  check("the shimmer did not return", h.record.shimmerReturned === false);
  check("one mount (the previous chat's commits are not counted)", h.record.mounts === 1);
  clock.advance(timing.OPEN_WINDOW_MS);
  check("no detailed row for it", !rows.some((r) => r.kind === "thread-open"));
}

/* ---- 4. which opens get a detailed row ------------------------------------------------------------------------- */
console.log("\nThe detailed row:");
{
  const { clock, rows } = setup();
  const h = timing.beginChatOpen({ chatId: "c", sessionId: "sess-slow", storedEvents: 0, storedToken: false });
  h.route("full-replay");
  clock.advance(2_600);
  h.replay(2_500, 4_477);
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
  clock.advance(timing.OPEN_WINDOW_MS);
  const row = rows.find((r) => r.kind === "thread-open");
  check("an open over 2 s gets one", row !== undefined);
  check("…with the open's headline time", row?.elapsedMs === 2_600);
  check("…the session id in the body (the route hashes it), never in the detail", row?.sessionId === "sess-slow" && !row.detail.includes("sess-slow"));
  check("…and the detail fits the route's limit", row.detail.length <= timing.DETAIL_MAX);
  check("…and says what happened in numbers", /route=full-replay/.test(row.detail) && /paint=2600/.test(row.detail) && /replay=2500\/4477ev/.test(row.detail));
}
{
  const { clock, rows } = setup();
  const h = timing.beginChatOpen({ chatId: "c", storedEvents: 0, storedToken: true });
  h.route("snapshot");
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
  h.shimmerReturned();
  clock.advance(timing.OPEN_WINDOW_MS);
  check("the shimmer coming back over a painted chat gets one", rows.some((r) => r.kind === "thread-open" && /shimmer=1/.test(r.detail)));
}
{
  const { clock, rows } = setup();
  timing.beginChatOpen({ chatId: "c", storedEvents: 5, storedToken: true }).route("local");
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
  clock.advance(4_000);
  // A resync remount later in the window (chat-shell.tsx `resync` bumps the attach nonce).
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#1", hasMessages: true, shimmer: false, cause: "resync" });
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#1", hasMessages: true, shimmer: false });
  clock.advance(timing.OPEN_WINDOW_MS);
  const row = rows.find((r) => r.kind === "thread-open");
  check("a resync remount counts against the open, with its cause", row !== undefined && /mounts=2\(open,resync\)/.test(row.detail));
}
{
  const { clock, rows } = setup();
  for (let i = 0; i < timing.COUNTER_FLUSH_OPENS; i++) {
    const h = timing.beginChatOpen({ chatId: `c${i}`, storedEvents: 1, storedToken: true });
    h.route(i % 2 ? "local" : "snapshot");
  }
  clock.advance(timing.OPEN_WINDOW_MS);
  const count = rows.find((r) => r.kind === "thread-open-count");
  check("20 opens flush the counter at once, by route", count !== undefined && /opens=20/.test(count.detail) && /local=10/.test(count.detail) && /snapshot=10/.test(count.detail));
  check("…with the count in `attempt`, a number the route keeps", count.attempt === 20);
  timing.beginChatOpen({ chatId: "x", storedEvents: 1, storedToken: true }).route("local");
  clock.advance(timing.OPEN_WINDOW_MS);
  timing.flushOpenCounter(true);
  const last = rows.filter((r) => r.kind === "thread-open-count").at(-1);
  check("a hidden tab flushes what is left, with keepalive", last.keepalive === true && /opens=1/.test(last.detail));
}

/* ---- 5. one record per click ----------------------------------------------------------------------------------- */
console.log("\nOne record per click:");
{
  const { clock } = setup();
  const a = timing.beginChatOpen({ chatId: "A", storedEvents: 0, storedToken: true });
  clock.advance(100);
  const b = timing.beginChatOpen({ chatId: "B", storedEvents: 3, storedToken: true });
  check("a new click closes the previous record, marked cancelled", a.record.closed && a.record.cancelled);
  a.route("snapshot");
  a.seam("match", 10);
  check("…and the abandoned open's late calls do not write into it", a.record.route === "pending" && a.record.seam === "none");
  check("…nor into the new one", b.record.seam === "none" && b.record.route === "pending");
  check("the new one is current", timing.currentChatOpen() === b.record);
}

/* ---- the "open settled" signal ------------------------------------------------------------------------------ */
console.log("\nThe open-settled signal (what the Control Panel waits on before reading finished specialists):");
{
  const { clock } = setup();
  let early = false;
  await timing.whenChatOpenSettled().then(() => (early = true));
  check("with no open in progress it resolves at once", early);
  const h = timing.beginChatOpen({ chatId: "c", storedEvents: 0, storedToken: true });
  let woke = false;
  const p = timing.whenChatOpenSettled().then(() => (woke = true));
  clock.advance(700);
  await Promise.resolve();
  check("an open in progress holds it", !woke);
  h.settled();
  await p;
  check("…until the open settles", woke && h.record.settledMs === 700);
  let after = false;
  await timing.whenChatOpenSettled().then(() => (after = true));
  check("once settled, it resolves at once", after);
  const h2 = timing.beginChatOpen({ chatId: "d", storedEvents: 0, storedToken: true });
  let cancelled = false;
  const p2 = timing.whenChatOpenSettled().then(() => (cancelled = true));
  timing.beginChatOpen({ chatId: "e", storedEvents: 0, storedToken: true });
  await p2;
  check("an open superseded by a later click releases its waiters (nobody waits for ever)", cancelled && h2.record.closed);
  let closed = false;
  const p3 = timing.whenChatOpenSettled().then(() => (closed = true));
  clock.advance(timing.OPEN_WINDOW_MS);
  await p3;
  check("…and so does an open whose window closes unsettled", closed);
}

/* ---- 6. the specialist streams --------------------------------------------------------------------------------- */
console.log("\nThe specialist streams (the Control Panel's half reports through specialistStream):");
{
  const { clock, rows } = setup();
  const h = timing.beginChatOpen({ chatId: "c", storedEvents: 1, storedToken: true });
  h.route("local");
  timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
  const s1 = timing.specialistStream("child-1");
  s1.request();
  clock.advance(3_600);
  s1.headers();
  s1.bytes(1_000_000);
  clock.advance(2_000);
  s1.bytes(9_000_000);
  s1.settle("caught-up");
  s1.settle("failed");
  const s2 = timing.specialistStream("child-2", { live: true });
  s2.request();
  s2.headers();
  s2.bytes(500);
  clock.advance(timing.OPEN_WINDOW_MS);
  const late = timing.specialistStream("child-3");
  late.request();
  late.bytes(123);
  const [a, b] = h.record.specialists;
  check("two streams, in the order they started, without ids", h.record.specialists.length === 2 && !JSON.stringify(h.record.specialists).includes("child"));
  check("requests, time to headers and time to settle", a.requests === 1 && a.headersMs === 3_600 && a.settleMs === 5_600);
  check("bytes, and the bytes inside the first 5 s after the click", a.bytes === 10_000_000 && a.bytesFirst5s === 1_000_000);
  check("the first settle wins", a.outcome === "caught-up");
  check("a running specialist is marked live, and still pending when the window closed", b.live === true && b.outcome === "pending" && b.settleMs === null);
  check("a probe asked for after the window does nothing", h.record.specialists.length === 2);
  const t = timing.specialistTotals(h.record.specialists);
  check("totals add up", t.count === 2 && t.requests === 2 && t.bytes === 10_000_500 && t.pending === 1);
  const detail = timing.formatOpenDetail(h.record);
  check("the detail carries them", /spec=2 req=2 rx=9\.5M rx5=977K hdr=3600 settle=5600 pend=1/.test(detail));
  check("(a fast open with streams still posts no detailed row)", !rows.some((r) => r.kind === "thread-open"));
}
{
  const { clock } = setup();
  const h1 = timing.beginChatOpen({ chatId: "A", storedEvents: 1, storedToken: true });
  const probe = timing.specialistStream("child");
  probe.request();
  const h2 = timing.beginChatOpen({ chatId: "B", storedEvents: 1, storedToken: true });
  probe.bytes(5_000);
  clock.advance(10);
  check("a probe stays with the open it was made in: none of its bytes land in the next open", h2.record.specialists.length === 0 && h1.record.specialists[0].bytes === 0);
}

/* ---- 7. nothing throws ----------------------------------------------------------------------------------------- */
console.log("\nNothing here may throw into openChat:");
{
  const boom = () => {
    throw new Error("boom");
  };
  const { clock } = setup({ post: boom, composerReady: boom, lagSampler: boom, storageChars: boom });
  let threw = null;
  try {
    const h = timing.beginChatOpen({ chatId: "c", sessionId: "s", storedEvents: 0, storedToken: false });
    h.route("full-replay");
    h.snapshot(Number.NaN, false);
    h.seam("unknown", Number.POSITIVE_INFINITY);
    h.replay(-1, -1);
    timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
    clock.advance(3_000);
    h.shimmerReturned();
    h.savedCopy("refused", 413);
    timing.specialistStream("x").bytes(Number.NaN);
    timing.reportSnapshotEvent("snapshot-refused", { sessionId: "s", status: 413, reason: "write:too-large" });
    clock.advance(timing.OPEN_WINDOW_MS);
    timing.flushOpenCounter(true);
    h.cancel();
  } catch (e) {
    threw = e;
  }
  check("a throwing post, composer probe, sampler and storage read: no throw", threw === null);
  // A throwing clock is the worst case: every entry point still returns.
  timing.configureChatOpenTiming({ clock: { now: boom, setTimeout: boom, clearTimeout: boom } });
  let threw2 = null;
  try {
    const h = timing.beginChatOpen({ chatId: "c", storedEvents: 0, storedToken: false });
    h.route("local");
    timing.noteChatCommit({ mountKey: "c", reactKey: "c#0", hasMessages: true, shimmer: false });
    timing.specialistStream("x").request();
  } catch (e) {
    threw2 = e;
  }
  check("…and a throwing clock: no throw either", threw2 === null);
}

/* ---- the saved-copy kinds ---------------------------------------------------------------------------------- */
console.log("\nThe saved-copy rows that were swallowed:");
{
  const { rows } = setup();
  timing.reportSnapshotEvent("snapshot-refused", { sessionId: "s", status: 413, reason: "write:too-large bytes=5000000 events=4100" });
  timing.reportSnapshotEvent("snapshot-skipped", { sessionId: "s", reason: "shared" });
  timing.reportSnapshotEvent("snapshot-skipped", { sessionId: "s", reason: "shared" });
  timing.reportSnapshotEvent("snapshot-skipped", { sessionId: "s", reason: "shared" });
  timing.reportSnapshotEvent("snapshot-discarded", { sessionId: "s", reason: "mismatch" });
  const refused = rows.find((r) => r.kind === "snapshot-refused");
  check("refused: the status and the route's short code", refused?.detail === "status=413 reason=write:too-large bytes=5000000 events=4100");
  check("skipped: once per chat per page load (the persist that skips runs per text delta)", rows.filter((r) => r.kind === "snapshot-skipped").length === 1);
  check("discarded: why", rows.some((r) => r.kind === "snapshot-discarded" && r.detail === "reason=mismatch"));
  timing.reportSnapshotEvent("snapshot-refused", { sessionId: "s", reason: 'a "quoted" <sentence>\nwith text' });
  check("a reason is reduced to safe characters, never free text with markup", !/["<>\n]/.test(rows.at(-1).detail));
}

/* ---- 8. the shell calls it ----------------------------------------------------------------------------------- */
console.log("\nThe shell:");
// The replay reader moved out of the shell into lib/chat-replay-read.ts (unchanged), so it is read with it.
const shell = readFileSync("app/_components/chat-shell.tsx", "utf8") + readFileSync("lib/chat-replay-read.ts", "utf8");
const openChat = shell.slice(shell.indexOf("const openChat = useCallback("), shell.indexOf("// The last chat, when the cache could not show it"));
check("a record starts at the TOP of every openChat", openChat.indexOf("beginChatOpen(") > 0 && openChat.indexOf("beginChatOpen(") < openChat.indexOf("setReadOnlyOwner(undefined)"));
check("the local mount writes its route (it wrote nothing before)", /timing\.route\(!s\.events\?\.length \|\| endsAtRest\(s\.events\) \? "local" : "running"\)/.test(openChat));
check("every route is named", ["snapshot", "snapshot-discarded", "full-replay", "running"].every((r) => openChat.includes(`timing.route("${r}")`)));
check("the saved-copy and seam times are recorded", /timing\.snapshot\(/.test(openChat) && /timing\.seam\(verdict\.status, ms\)/.test(openChat));
check("the saved-copy write reports its outcome", /onOutcome: timing\.savedCopy/.test(shell) && /outcome\("refused", r\.status\)/.test(shell));
check("paint and mounts come from a layout effect that only writes the record", /useLayoutEffect\(\(\) => \{\s*noteChatCommit\(/.test(shell));
check("resync and reattach remounts carry their cause", /mountCauseRef\.current = "resync";\s*setAttachNonce/.test(shell) && /mountCauseRef\.current = "reattach";\s*setAttachNonce/.test(shell));
check("every exit of openChat settles the open (a finally, for the current open only)", /\} finally \{\s*if \(ticket\.current\(\)\) timing\.settled\(\);\s*\}/.test(openChat));
check("the chat being left is unmounted when a network open starts", /if \(mountKeyRef\.current !== s\.id\) \{\s*setInitialEvents\(undefined\);\s*setInitialSession\(undefined\);\s*setMountKey\(mintKey\("opening"\)\);/.test(openChat));
check("the page load's own chat is recorded too", /if \(boot\.instant\) \{\s*const t = beginChatOpen\(/.test(shell) && /pageLoadOpenRef\.current = true;\s*void openChat\(boot\.last\)/.test(shell));
check("rows go through the existing fire-and-forget route", /configureChatOpenTiming\(\{\s*post: \(row, keepalive\) => \{[\s\S]{0,120}\/api\/ops\/chat-telemetry/.test(shell));
check("the counter leaves with a hidden or closing tab", /flushOpenCounter\(true\)/.test(shell));
check("the refusals that were swallowed are reported", /reportSnapshotEvent\("snapshot-refused"/.test(shell) && /reportSnapshotEvent\("snapshot-skipped"/.test(shell) && /reportSnapshotEvent\("snapshot-discarded"/.test(shell));
check("the existing window.__threadOpens record keeps its fields", /quietMs: Math\.round\(quietMs\),\s*stopReason,\s*segments,\s*events: events\.length,\s*startIndex: base,\s*shared: bounded,\s*sessionId,/.test(shell));

const lib = readFileSync("lib/chat-open-timing.ts", "utf8");
check("the module imports no React and no server-only code", !/^import[^\n]*(from "react"|"server-only"|"node:)/m.test(lib));
check("records are kept on the window, the last 50", /__chatOpens = \[\.\.\.\(w\.__chatOpens \?\? \[\]\)\.slice\(-49\), record\]/.test(lib));

console.log(`\nchat open timing: ${passed}/${passed} checks passed`);
