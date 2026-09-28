/**
 * "The subagent always fails to return back gracefully to the main thread."
 *
 * THE DEFECT, measured 2026-09-28 on onfinance_hfc. Server-side the hand-back
 * worked every time: the orchestrator delegated, the specialist parked a
 * question, the operator answered, and the parent got `action.result`
 * (`subagent-result`) and carried on. The BROWSER did not follow it: right after
 * the answer the chat's reader ended ("stream ended mid-turn … last event:
 * client.input.responded"), restarted ("reader restart 1..4"), and the
 * orchestrator's follow-on appeared only after a reattach — 80 s, once 279 s.
 *
 * THE CAUSE. Between the answer and the child's result the PARENT's stream is
 * silent: the child does the work on its own session. The recorded stream shows
 * it — scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson,
 * index 9 (`session.waiting`, the park) → 10 (`subagent.completed`) is the whole
 * of the child's resumed run. Every segment of that silence ends cleanly at the
 * seam with no events, and `readLiveTail` counted each one as fruitless: four,
 * and it returned `stream-failed`; the component spent its attach budget the
 * same way and then fell back to rounds that back off from 5 s to a minute. A
 * specialist working for a few minutes therefore handed back to a chat that
 * would look again up to a minute later.
 *
 * Everything here EXECUTES the real modules — `lib/chat-attach.ts`'s
 * `readLiveTail`, `lib/chat-turn-state.ts`, eve's own `defaultMessageReducer`
 * — over the RECORDED stream, replayed on a virtual clock with the ~120 s seam
 * production has. The first section is the regression: on main it fails
 * (`stream-failed` after four quiet seams, the continuation never read).
 *
 * Run:  npm run test:subagent-handback
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import { readLiveTail } from "../lib/chat-attach.ts";
import { liveDelegations, isSessionBoundary, withSessionEpochs } from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label} — got ${JSON.stringify(detail)}`);
  passed++;
  console.log(`  ok   ${label}`);
};

const recorded = readFileSync("scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson", "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const PARK = recorded.findIndex((e) => e.type === "session.waiting"); // the child's question parks the parent
const RESUME = PARK + 1; // the first event after the answer
check("the recording parks on the child's question and resumes with subagent.completed", recorded[RESUME]?.type === "subagent.completed");
check(
  "…and carries the subagent-result and the orchestrator's continuation after it",
  recorded.some((e, i) => i > RESUME && e.type === "action.result" && e.data?.result?.kind === "subagent-result") &&
    recorded.some((e, i) => i > RESUME && e.type === "message.appended" && /PARENT-DONE/.test(e.data?.messageDelta ?? "")),
);

/* ─── a virtual clock, and eve's stream as production serves it ─────────────── */

let now = 0;
const realNow = Date.now;
Date.now = () => now;
const sleep = async (ms) => {
  now += ms;
};

/**
 * One opener per scenario: the recorded events after the park, emitted by the
 * server at `at(i)`; every segment ends CLEANLY at `seamMs` after it opened,
 * with whatever it had delivered — the ~120 s severance measured in production
 * (121/241/362/482/602/723 s), which a silent stream meets with zero events.
 */
function server({ at, seamMs = 120_000, opens }) {
  return (startIndex) =>
    (async function* () {
      opens.push({ at: now, startIndex });
      const closesAt = now + seamMs;
      let i = startIndex;
      while (i < recorded.length) {
        const t = at(i);
        if (t > closesAt) break;
        if (t > now) now = t;
        yield recorded[i];
        i += 1;
      }
      if (i >= recorded.length || at(i) > closesAt) now = Math.max(now, closesAt);
    })();
}

/** The chat's own reader, as agent-chat wires it: quiet is expected while a specialist works. */
async function follow({ at, seamMs, quiet = true }) {
  now = 0;
  const opens = [];
  const seen = recorded.slice(0, RESUME);
  const deliveredAt = new Map();
  const result = await readLiveTail({
    open: server({ at, seamMs, opens }),
    startIndex: RESUME,
    signal: new AbortController().signal,
    sleep,
    idleTimeoutMs: 0,
    quietExpected: quiet ? () => liveDelegations(seen).length > 0 : undefined,
    onEvent: ({ index, event }) => {
      seen.push(event);
      deliveredAt.set(index, now);
    },
  });
  return { result, opens, seen, deliveredAt };
}

const CHILD_WORKS_MS = 10 * 60_000 + 1_000; // an hfc-kpi-extraction over a long deck
const at = (i) => (i < RESUME ? 0 : CHILD_WORKS_MS + (i - RESUME) * 200);
const resultIndex = recorded.findIndex((e) => e.type === "action.result");
const continuationIndex = recorded.findIndex((e, i) => i > RESUME && e.type === "message.appended");

console.log("one reader follows a specialist's quiet work through to the orchestrator's continuation:");
{
  const { result, opens, seen, deliveredAt } = await follow({ at, seamMs: 120_000 });
  check("the reader reaches the session boundary — not `stream-failed` after four quiet seams", result.outcome === "terminal", result);
  check(
    "…having read the hand-back: subagent.completed → subagent-result → the orchestrator's text",
    seen.some((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result") &&
      seen.some((e) => e.type === "message.appended" && /PARENT-DONE/.test(e.data?.messageDelta ?? "")),
  );
  check("…and the turn's end, with its fresh continuation token", isSessionBoundary(seen[seen.length - 1]));
  const lagResult = deliveredAt.get(resultIndex) - at(resultIndex);
  const lagText = deliveredAt.get(continuationIndex) - at(continuationIndex);
  check("the subagent-result is on screen the moment the server emits it — no reattach delay", lagResult === 0, lagResult);
  check("…and so is the orchestrator's continuation", lagText === 0, lagText);
  const gaps = opens.slice(1).map((o, i) => o.at - (opens[i].at + 120_000));
  check(
    "each quiet seam is reopened at once (never a 0.5–4 s fruitless backoff, never a 5–60 s round)",
    gaps.every((g) => g <= 250),
    gaps,
  );
  check("one open per seam of silence, no storm", opens.length === Math.floor(CHILD_WORKS_MS / 120_000) + 1, opens.length);
}

console.log("\nthe projection follows: the specialist's tile settles and the continuation is the main thread's:");
{
  const { seen } = await follow({ at, seamMs: 120_000 });
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of recorded.slice(0, RESUME)) data = reducer.reduce(data, e);
  const tile = (d) =>
    (d.messages ?? []).flatMap((m) => m.parts ?? []).find((p) => p.type === "dynamic-tool" && p.toolName?.startsWith("eve:subagent:"));
  check("while it works, the tile is not done", tile(data)?.state !== "output-available", tile(data)?.state);
  check("…and the delegation is live", liveDelegations(recorded.slice(0, RESUME)).length === 1);
  for (const e of seen.slice(RESUME)) data = reducer.reduce(data, e);
  check("after the hand-back the tile is done", tile(data)?.state === "output-available", tile(data)?.state);
  check("…and no delegation is live", liveDelegations(seen).length === 0);
  const text = (data.messages ?? [])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ");
  check("the orchestrator's continuation is in the transcript", /PARENT-DONE/.test(text), text);
}

console.log("\nwhat did NOT change — silence is only forgiven while a specialist works:");
{
  // An ordinary detached turn with nothing delegated: silence still reaches the
  // poll through maxFailures, exactly as before.
  const { result } = await follow({ at, seamMs: 120_000, quiet: false });
  check("no `quietExpected`: four quiet seams are still `stream-failed`", result.outcome === "stream-failed", result);
  // The storm shape: a stream that ends the moment it opens is never "quiet".
  now = 0;
  const opens = [];
  const instant = await readLiveTail({
    open: server({ at, seamMs: 0, opens }),
    startIndex: RESUME,
    signal: new AbortController().signal,
    sleep,
    idleTimeoutMs: 0,
    quietExpected: () => true,
  });
  check("a segment that ends at once is fruitless even while a specialist works", instant.outcome === "stream-failed", instant);
  check("…after the usual four opens, not a tight loop", opens.length === 4, opens.length);
  // An open that throws (a 503 from the ownership gate) is a failure, quiet or not.
  now = 0;
  let n = 0;
  const refused = await readLiveTail({
    open: () =>
      (async function* () {
        n += 1;
        now += 5_000;
        throw Object.assign(new Error("gate 503"), { status: 503 });
      })(),
    startIndex: RESUME,
    signal: new AbortController().signal,
    sleep,
    idleTimeoutMs: 0,
    quietExpected: () => true,
  });
  check("an open that fails is still counted, whatever the specialist is doing", refused.outcome === "stream-failed" && n === 4, { refused, n });
  // The same silence arriving as a gateway timeout: eve holds a stream's headers until its first event, so a seam in
  // pure silence can come back as a 504 (after eve's own client has retried it) instead of an empty body.
  now = 0;
  let gatewayOpens = 0;
  const seen = recorded.slice(0, RESUME);
  const viaGateway = await readLiveTail({
    open: (startIndex) =>
      (async function* () {
        gatewayOpens += 1;
        if (now + 120_000 < CHILD_WORKS_MS) {
          now += 120_000;
          throw Object.assign(new Error("gateway timeout"), { status: 504 });
        }
        if (now < at(startIndex)) now = at(startIndex);
        for (let i = startIndex; i < recorded.length; i++) {
          if (at(i) > now) now = at(i);
          yield recorded[i];
        }
      })(),
    startIndex: RESUME,
    signal: new AbortController().signal,
    sleep,
    idleTimeoutMs: 0,
    quietExpected: () => liveDelegations(seen).length > 0,
    onEvent: ({ event }) => seen.push(event),
  });
  check("a seam that arrives as a 504 in the silence is quiet too — the reader follows through", viaGateway.outcome === "terminal", viaGateway);
  check("…one open per seam, a second apart, no storm", gatewayOpens <= Math.ceil(CHILD_WORKS_MS / 120_000) + 1, gatewayOpens);
  // A 403 still stops at once: a revoked share is final.
  now = 0;
  const revoked = await readLiveTail({
    open: () =>
      (async function* () {
        now += 3_000;
        throw Object.assign(new Error("gone"), { status: 403 });
      })(),
    startIndex: RESUME,
    signal: new AbortController().signal,
    sleep,
    idleTimeoutMs: 0,
    quietExpected: () => true,
  });
  check("a revoked share (403) still stops the reader", revoked.outcome === "forbidden", revoked);
}

console.log("\nwho the main thread is waiting on, said out loud:");
{
  const { awaitingSpecialists, specialistWorkingLine, specialistDisplayName } = await import("../lib/chat-turn-state.ts");
  const parked = recorded.slice(0, RESUME);
  check("a live delegation with its question answered is a specialist at work", awaitingSpecialists({ events: parked, openRequests: 0 }).length === 1);
  check("…but not while its question is still open (then the person is who it waits on)", awaitingSpecialists({ events: parked, openRequests: 1 }).length === 0);
  check("…and not once it has handed back", awaitingSpecialists({ events: recorded, openRequests: 0 }).length === 0);
  check("tool names read as names", specialistDisplayName("investor-presentations") === "Investor Presentations");
  const line = specialistWorkingLine(["configuration"]);
  check("the status line names the specialist instead of reading as a stall", /Configuration specialist is working/.test(line) && /main thread continues/.test(line), line);
  check("two at once are both named", /2 specialists are working \(Hfc Kpi Extraction, Configuration\)/.test(specialistWorkingLine(["hfc-kpi-extraction", "configuration"])));
  check("an unnamed delegation falls back to the old words", /a specialist is running/.test(specialistWorkingLine(["specialist"])));
}

Date.now = realNow;
console.log(`\n${passed} checks passed`);
