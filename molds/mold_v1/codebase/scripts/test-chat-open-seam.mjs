/**
 * What a reopened chat does with its seam read, and who may write to the chat pane while it is read.
 *
 * A chat that reaches the server paints its saved copy at once and then reads ONE event, the seam, to check the copy
 * against the stream (lib/chat-snapshot.ts). The decision about that read was `checkSeam`, and it called every empty
 * read "behind": the open deleted a healthy saved copy, put the loading shimmer back over the painted chat and
 * replayed the conversation from event zero. A parked stream never ends, so "empty" is a timer's verdict, and the
 * timer lost to eve's first byte on 10-30% of measured seam reads.
 *
 * Executed here, not matched by a regex:
 *
 *   1. `seamVerdict`: empty and unknown reads are retried once and then KEEP the copy; a stream that closed with
 *      nothing at the seam is "behind" (positive) and replaces it after the retry confirms it; a different event at
 *      the seam replaces it at once; a stream that moved on extends it (the "ahead" case).
 *   2. `replaceDecision`: a replacement waits while the person has a draft, is forced from a fresh read once they have
 *      sent, and otherwise swaps now.
 *   3. `createOpenGuard`: a later open cancels the earlier one's requests and makes it stale for ever (the stale-click
 *      cancellation); an abandoned open cannot write.
 *   4. The shell uses all three: the guard and the mount-key comparison before every state write of a seam result,
 *      no DELETE and no shimmer on an empty or unknown read.
 *
 * The browser half (a slow seam read leaves the painted chat untouched; a click on another chat wins over a slow
 * open) is tests/chat-open.spec.ts.
 *
 * Run:  npm run test:chat-open-seam
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSnapshot, mountFromSnapshot, seamVerdict, replaceDecision } from "../lib/chat-snapshot.ts";
import { createOpenGuard } from "../lib/chat-open-guard.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

let seq = 0;
const ev = (type, data = {}) => ({ type, data: { ...data, sequence: seq++ } });
const STREAM = [
  ev("session.started"),
  ev("turn.started", { turnId: "t1" }),
  ev("message.received", { turnId: "t1", message: "ask" }),
  ev("message.completed", { turnId: "t1", stepIndex: 0, message: "Answer." }),
  ev("turn.completed", { turnId: "t1" }),
  ev("session.waiting", { continuationToken: "tok-1" }),
];
const MORE = [
  ev("turn.started", { turnId: "t2" }),
  ev("message.completed", { turnId: "t2", stepIndex: 0, message: "Second." }),
  ev("turn.completed", { turnId: "t2" }),
  ev("session.waiting", { continuationToken: "tok-2" }),
];
const snap = buildSnapshot({ eveSessionId: "s", streamIndex: STREAM.length, events: STREAM });
const seamEvent = STREAM.at(-1);

/* ---- 1. the verdict ---------------------------------------------------------------------------------------- */
console.log("The seam verdict:");
{
  const v = seamVerdict(snap, { events: [], stop: "marker", ended: false }, 1);
  check("EMPTY (the server's drained marker, nothing before it) is 'empty', not 'behind'", v.status === "empty");
  check("…and is read once more, not acted on", v.action === "retry");
  const v2 = seamVerdict(snap, { events: [], stop: "marker", ended: false }, 2);
  check("…and a second empty read KEEPS the copy (unverified), never replaces it", v2.status === "empty" && v2.action === "keep");
  const q = seamVerdict(snap, { events: [], stop: "eof", ended: false }, 1);
  check("the reader's own quiet window is empty too, not behind", q.status === "empty" && q.action === "retry");
}
{
  for (const stop of ["timeout", "error", "cancelled"]) {
    const v = seamVerdict(snap, { events: [], stop }, 1);
    check(`UNKNOWN: a read that stopped on '${stop}' says nothing about the copy`, v.status === "unknown" && v.action === "retry");
  }
  check("UNKNOWN: no read at all", seamVerdict(snap, null, 1).status === "unknown");
  check("…and the retry's unknown keeps the copy", seamVerdict(snap, undefined, 2).action === "keep");
  check(
    "UNKNOWN wins over a partial read that timed out with events in it",
    seamVerdict(snap, { events: [seamEvent], stop: "timeout" }, 2).status === "unknown",
  );
}
{
  const v = seamVerdict(snap, { events: [], stop: "eof", ended: true }, 1);
  check("BEHIND: the stream CLOSED with nothing at the seam (a finished session read past its end)", v.status === "behind");
  check("…is confirmed by the retry before anything is replaced", v.action === "retry");
  check("…and replaced once it is", seamVerdict(snap, { events: [], stop: "eof", ended: true }, 2).action === "replace");
}
{
  const v = seamVerdict(snap, { events: [ev("session.started"), ...MORE], stop: "marker" }, 1);
  check("MISMATCH: a different event at the seam replaces the copy at once", v.status === "mismatch" && v.action === "replace");
}
{
  const v = seamVerdict(snap, { events: [seamEvent], stop: "marker" }, 1);
  check("MATCH: the seam event and nothing after it keeps the copy", v.status === "match" && v.action === "keep" && v.tail.length === 0);
  const a = seamVerdict(snap, { events: [seamEvent, ...MORE], stop: "marker" }, 1);
  check("AHEAD: the stream moved on past the copy: extend with exactly the new events", a.status === "ahead" && a.action === "extend" && a.tail.length === MORE.length);
  const mounted = mountFromSnapshot(snap, a.tail);
  check("…and the extended mount is the whole stream", mounted.streamIndex === STREAM.length + MORE.length);
  const after = seamVerdict(snap, { events: [seamEvent, ...MORE], stop: "marker" }, 2);
  check("a retry that finds the seam extends just the same", after.action === "extend");
}

/* ---- 2. when a replacement may remount ----------------------------------------------------------------------- */
console.log("\nWhen a replacement may remount the chat:");
check("free: swap now", replaceDecision({ typing: false, sent: false }) === "swap");
check("typing a draft: wait (the draft is never thrown away)", replaceDecision({ typing: true, sent: false }) === "wait");
check("typing again after a send: still wait", replaceDecision({ typing: true, sent: true }) === "wait");
check("has sent: swap from a read taken after the send", replaceDecision({ typing: false, sent: true }) === "swap-fresh");

/* ---- 3. stale clicks -------------------------------------------------------------------------------------------- */
console.log("\nOne open at a time:");
{
  const guard = createOpenGuard();
  const a = guard.claim();
  check("the first open is current", a.current() && !a.signal.aborted);
  const b = guard.claim();
  check("a later click makes the earlier open stale", !a.current());
  check("…and cancels its requests", a.signal.aborted);
  check("…while the later one is current", b.current() && !b.signal.aborted);
  const c = guard.claim();
  check("a third click: only the last is current", !a.current() && !b.current() && c.current());
  check("latest() is the last ticket", guard.latest() === c);
}
{
  // An abandoned open's pending work cannot write: simulate the shell's pattern (await, then check, then write).
  const guard = createOpenGuard();
  const pane = { chat: null };
  const open = async (id, delay) => {
    const t = guard.claim();
    await new Promise((r) => setTimeout(r, delay));
    if (!t.current()) return "stale";
    pane.chat = id;
    return "mounted";
  };
  const slow = open("A", 60);
  const fast = open("B", 5);
  const [ra, rb] = await Promise.all([slow, fast]);
  check("a slow open of A then a fast open of B leaves B on screen", pane.chat === "B" && ra === "stale" && rb === "mounted");
}
{
  // A request bound to a stale ticket is aborted.
  const guard = createOpenGuard();
  const t = guard.claim();
  let aborted = false;
  t.signal.addEventListener("abort", () => (aborted = true));
  guard.claim();
  check("the abort reaches a request already listening on the stale ticket", aborted);
}

/* ---- 4. the shell uses them ----------------------------------------------------------------------------------- */
console.log("\nThe shell:");
const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
const openChat = shell.slice(shell.indexOf("const openChat = useCallback("), shell.indexOf("// The last chat, when the cache could not show it"));
check("openChat claims a ticket before anything else", /const ticket = openGuardRef\.current\.claim\(\);/.test(openChat.slice(0, 600)));
check("…and stops after the saved copy if a later click took over", /await fetchSnapshot\(sessionId, ticket\.signal\)[\s\S]{0,400}if \(!ticket\.current\(\)\) return;/.test(openChat));
check("the seam read decides through seamVerdict, with a second attempt", /seamVerdict\(cached, tail, 1\)/.test(openChat) && /seamVerdict\(cached, tail, 2\)/.test(openChat));
check("…never checkSeam's 'empty means behind'", !/checkSeam\(/.test(openChat));
check(
  "the chat-switch guard (as resync's) precedes every write of a seam result",
  (() => {
    const guard = openChat.indexOf("if (mountKeyRef.current !== s.id) return;");
    const extendWrite = openChat.indexOf('mountCauseRef.current = "seam-tail"');
    return guard > 0 && extendWrite > guard;
  })(),
);
check("…and the background replacement checks both before it mounts", /if \(!ticket\.current\(\) \|\| mountKeyRef\.current !== s\.id\) return;/.test(shell));
check(
  "the DELETE is only on the replace branch, after the keep and extend returns",
  (() => {
    const del = openChat.indexOf('method: "DELETE"');
    return del > openChat.indexOf('verdict.action === "extend"') && del > openChat.indexOf('verdict.action === "keep"');
  })(),
);
check("the shimmer never comes back over a painted chat (no setOpeningChat(true) after the paint)", (() => {
  const paint = openChat.indexOf('timing.route("snapshot")');
  const fullReplay = openChat.indexOf('timing.route("full-replay")');
  return paint > 0 && fullReplay > paint && !/setOpeningChat\(true\)/.test(openChat.slice(paint, fullReplay));
})());
check("a replacement remounts (the fetched-but-never-shown replay is shown)", /if \(remount\) \{\s*mountCauseRef\.current = "seam-replace";\s*setAttachNonce/.test(shell));
check("…and asks replaceDecision first", /replaceDecision\(\{ typing: composerHasDraft\(\), sent: sentAtRef\.current > 0 \}\)/.test(shell));
check("every other way into the pane cancels an open in flight", (shell.match(/supersedeOpen\(\)/g) ?? []).length >= 6);
check("the shared open uses the same verdict, with its retry bounded", /seamVerdict\(cached, tail, 2\)/.test(shell.slice(shell.indexOf("const replayFromCache"))) && /SHARED_SEAM_RETRY_WITHIN_MS/.test(shell));
check("the marker routes do not race the server with the reader's own pre-first-byte window", /tail && !markerRoute \? 1_200 : 0/.test(shell));

console.log(`\nchat open seam: ${passed}/${passed} checks passed`);
