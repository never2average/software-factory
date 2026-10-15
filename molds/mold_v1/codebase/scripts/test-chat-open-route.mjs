/**
 * Which copy of a chat an open uses, and which copy may overwrite which (lib/chat-open-route.ts).
 *
 *   1. A RUNNING chat this browser holds mounts locally, with no request: its events end inside a turn and were
 *      written a moment ago, token or no token (a first turn has none until it parks). Before, `openChat`'s gate sent
 *      every tokenless chat to the server, where the replay loop read the running turn until it fell silent
 *      (4.5 s at the least, up to 60-75 s under the shimmer).
 *   2. The absolute index such a mount resumes from survives the browser cache's round trip (`writeChats` →
 *      `cacheTranscript` → JSON → back): the live reader starts at exactly the stream position the copy ends at, and
 *      `attachDecision` answers "live-turn".
 *   3. A replay that stopped early (deadline, segment cap, error, cancelled, live) is never stored over a LONGER copy;
 *      a complete replay always is (a stream only grows, so a longer copy is the wrong one).
 *   4. The shell uses both: the gate is `openRoute`, and the replay's mount and both writes ask `replayMayReplace`.
 *
 * Run:  npm run test:chat-open-route
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as route from "../lib/chat-open-route.ts";
import { writeChats } from "../lib/chat-persist.ts";
import { absoluteIndexBase, attachDecision, serverEventCount } from "../lib/chat-turn-state.ts";

const { openRoute, replayMayReplace, RUNNING_REOPEN_WINDOW_MS } = route;

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? ` (${detail})` : ""}`);
  passed++;
  console.log(`  ok   ${label}${detail ? `  [${detail}]` : ""}`);
};

let seq = 0;
const ev = (type, data = {}) => ({ type, data: { ...data, sequence: seq++ }, meta: { at: "2026-10-14T10:00:00.000Z" } });

/** A first turn still running: prologue, then `deltas` streamed text deltas (each carries the whole text so far). */
function runningFirstTurn(deltas) {
  const T = "turn_0";
  const out = [ev("session.started"), ev("turn.started", { turnId: T }), ev("message.received", { turnId: T, message: "q" }), ev("step.started", { turnId: T, stepIndex: 0 })];
  let soFar = "";
  for (let i = 0; i < deltas; i++) {
    soFar += `w${i} `;
    out.push(ev("message.appended", { turnId: T, stepIndex: 0, messageDelta: `w${i} `, messageSoFar: soFar }));
  }
  return out;
}
const parked = () => [ev("session.started"), ev("turn.started", { turnId: "turn_0" }), ev("turn.completed", { turnId: "turn_0" }), ev("session.waiting", { continuationToken: "tok" })];

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

/* ---- 1. the gate -------------------------------------------------------------------------------------------- */
console.log("Where an open reads from:");
{
  const events = runningFirstTurn(40);
  check(
    "a running chat held here, no token, written a moment ago: LOCAL, no request",
    openRoute({ sessionId: "s", token: false, events, updatedAt: NOW - 3_000, now: NOW }) === "local",
  );
  check("…with a token (a running second turn): local, as before", openRoute({ sessionId: "s", token: true, events, updatedAt: NOW - 3_000, now: NOW }) === "local");
  check(
    "…written longer ago than the window: network (a run that died mid-turn is replayed, not attached to)",
    openRoute({ sessionId: "s", token: false, events, updatedAt: NOW - RUNNING_REOPEN_WINDOW_MS - 1_000, now: NOW }) === "network",
  );
  check("…a row stamped in the future is not recent: network", openRoute({ sessionId: "s", token: false, events, updatedAt: NOW + 60_000, now: NOW }) === "network");
  check("…with no updatedAt: network", openRoute({ sessionId: "s", token: false, events, now: NOW }) === "network");
  check("a parked chat with its token: local", openRoute({ sessionId: "s", token: true, events: parked(), updatedAt: NOW - 86_400_000, now: NOW }) === "local");
  check(
    "a tokenless chat whose turn FINISHED (persisted before the park): network, as before",
    openRoute({ sessionId: "s", token: false, events: [...events, ev("turn.completed", { turnId: "turn_0" })], updatedAt: NOW, now: NOW }) === "network",
  );
  check("events pruned for the quota: network", openRoute({ sessionId: "s", token: true, events: [], updatedAt: NOW, now: NOW }) === "network");
  check("no session yet (never sent): local", openRoute({ sessionId: undefined, token: false, events: undefined, now: NOW }) === "local");
}

/* ---- 2. the absolute index through the browser cache ------------------------------------------------------- */
console.log("\nThe absolute index survives a cacheTranscript round trip:");
{
  const roundTrip = (chat) => {
    let stored = "";
    const ok = writeChats({ setItem: (_k, v) => (stored = v) }, "k", [chat], new Set([chat.id]));
    assert.ok(ok, "written");
    return JSON.parse(stored)[0];
  };
  const N = 4 + 300;
  const events = runningFirstTurn(300);
  // A first turn mid-stream: the store's cursor is still the pre-send one (streamIndex 0, no token).
  const chat = { id: "c1", clientKey: "c1", updatedAt: NOW - 2_000, session: { sessionId: "s1", streamIndex: 0 }, events: [...events, { type: "client.input.responded", data: { requestId: "r" } }] };
  const back = roundTrip(chat);
  check("the cache compacted the deltas (placeholders, not copies)", JSON.stringify(back.events).length < JSON.stringify(chat.events).length / 3, `${JSON.stringify(back.events).length} vs ${JSON.stringify(chat.events).length} chars`);
  check("…and kept one entry per event", back.events.length === chat.events.length);
  const base = absoluteIndexBase(back.session.streamIndex, back.events);
  const next = serverEventCount(back.events) + base;
  check("the live reader's start (serverEventCount + absoluteIndexBase) is exactly N", next === N, `${next} vs ${N}`);
  check("…the same as before the round trip", serverEventCount(chat.events) + absoluteIndexBase(chat.session.streamIndex, chat.events) === next);
  check("the round-tripped chat still opens locally", openRoute({ sessionId: "s1", token: false, events: back.events, updatedAt: back.updatedAt, now: NOW }) === "local");
  const verdict = attachDecision({ sessionId: "s1", storeBusy: false, events: back.events });
  check("…and its mount attaches the live reader (\"live-turn\")", verdict.attach && verdict.reason === "live-turn", verdict.reason);

  // A chat mounted from a compacted saved copy and parked: the cursor runs ahead of the events held.
  const M = 900;
  const copy = { id: "c2", clientKey: "c2", updatedAt: NOW, session: { sessionId: "s2", streamIndex: M, continuationToken: "tok" }, events: parked() };
  const back2 = roundTrip(copy);
  check(
    "a compacted copy's cursor (ahead of the events) survives too",
    serverEventCount(back2.events) + absoluteIndexBase(back2.session.streamIndex, back2.events) === M,
  );
}

/* ---- 3. a shorter copy never overwrites a longer one -------------------------------------------------------- */
console.log("\nWhich replay may be stored over the copy we hold:");
{
  check("a replay that hit its deadline at 603, over a copy at 3,963: NOT stored", !replayMayReplace({ stop: "timeout", index: 603 }, 3963));
  check("…nor one that hit its segment cap", !replayMayReplace({ stop: "segment-cap", index: 3000 }, 3963));
  check("…nor one that failed or was cancelled", !replayMayReplace({ stop: "error", index: 10 }, 3963) && !replayMayReplace({ stop: "cancelled", index: 10 }, 3963));
  check("…nor a read that stopped at a running turn's live edge", !replayMayReplace({ stop: "live", index: 10 }, 20));
  check("a deadline replay that still reaches as far: stored", replayMayReplace({ stop: "timeout", index: 3963 }, 3963));
  check("a COMPLETE replay is always stored, even shorter (the longer copy is the wrong one)", replayMayReplace({ stop: "marker", index: 603 }, 3963) && replayMayReplace({ stop: "terminal", index: 1 }, 2) && replayMayReplace({ stop: "park-quiet", index: 1 }, 2));
  check("nothing held: stored", replayMayReplace({ stop: "timeout", index: 603 }, undefined) && replayMayReplace({ stop: "timeout", index: 603 }, 0));
}

/* ---- 4. the shell ------------------------------------------------------------------------------------------- */
console.log("\nThe shell:");
{
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  const openChat = shell.slice(shell.indexOf("const openChat = useCallback("), shell.indexOf("// The last chat, when the cache could not show it"));
  const mountReplayed = shell.slice(shell.indexOf("const mountReplayed = useCallback("), shell.indexOf("const replaceBehindPaint = useCallback("));
  check("openChat's gate is openRoute (no tokenless shortcut to the network)", /const route = openRoute\(\{/.test(openChat) && /if \(s\.session\?\.sessionId && route === "network"\)/.test(openChat) && !/!s\.session\.continuationToken \|\| !s\.events\?\.length/.test(openChat));
  check("…and the page load's own instant mount uses the same rule", /openRoute\(\{\s*sessionId: last\.session\.sessionId,/.test(shell));
  const guard = mountReplayed.indexOf("if (!replayMayReplace(fresh, longer))");
  check("mountReplayed asks replayMayReplace before it writes anything", guard > 0 && guard < mountReplayed.indexOf("persist(") && guard < mountReplayed.indexOf("storeSnapshot("));
  check("…and a live-edge read is never written as a saved copy", /if \(fresh\.stop === "live"\) \{\s*timing\.savedCopy\("skipped"\);\s*return;\s*\}/.test(mountReplayed));
  check("the foreground replay keeps this browser's longer copy instead of mounting a short one", /!replayMayReplace\(fresh, longestCopyIndex\(s, sessionId, snapshotIndexRef\.current\.get\(sessionId\)\)\)/.test(openChat));
  check("a seam tail that stopped live extends the mount but stores nothing", /if \(tail\?\.stop === "live"\) \{\s*timing\.route\("running"\);\s*timing\.savedCopy\("skipped"\);\s*return;/.test(openChat));
}

console.log(`\nchat open route: ${passed}/${passed} checks passed`);
