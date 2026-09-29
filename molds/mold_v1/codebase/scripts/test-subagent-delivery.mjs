/**
 * "A subagent that wanted to bring things into the main chat."
 *
 * THE DEFECT, measured 2026-09-23 against the live deployment. Across six eve
 * sessions in the operator's workspace, every `actions.requested` was matched to
 * its `action.result` by `callId`. The built-in generic `agent` tool returned
 * fine (one delegation, `kind=subagent-result`, 10,105 bytes). NOT ONE DECLARED
 * SPECIALIST EVER RETURNED A RESULT. One session's tail is literally
 * `subagent.called → subagent.called → input.requested → turn.completed →
 * session.waiting` twice over. The operator's workaround was to paste a
 * specialist's finished output into the chat by hand as a 21 KB message, which
 * is that chat's title to this day.
 *
 * THE CAUSE is a difference the built-in tool never runs into: a declared
 * specialist PARKS. eve proxies the child's `input.requested` onto the parent's
 * stream and routes the answer back to the child — but ONLY if the answer is a
 * structured `inputResponses[]` keyed by `requestId`
 * (`routeDeliverPayload`, eve/dist/src/execution/subagent-hitl-proxy.js, splits
 * the delivery on that field and hands everything else to the parent). This chat
 * never produced one, because `pendingInputParts` dropped every proxied child
 * request ("Subagent-proxied approvals live in the rail, never in this thread")
 * and three things are derived from that list: the answer card, the send gate's
 * `pendingInputs`, and the text `composerRoute` resolves into an answer. So the
 * composer reopened as if the chat were idle and the operator's typed answer
 * left as a plain `message` — which eve buffers behind the very delegation it
 * was meant to release. It vanished with `{"ok":true}`.
 *
 * THE FIXTURES ARE REAL. Each `.ndjson` under scripts/fixtures/subagent-delivery
 * was recorded on 2026-09-23 from THIS repo's agent running under `eve dev`
 * against a scripted OpenAI-compatible model (scripts/fake-model-server.mjs) —
 * the real eve runtime, the real declared subagent, the real HTTP channel, no
 * provider and no spend. `child-parks-never-answered.ndjson` is the swallow
 * reproduced end to end.
 *
 * Run:  npm run test:subagent-delivery
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer, resolveTextToResponses } from "eve/client";
import {
  composerRoute,
  deadInputRequestIds,
  pendingInputRequestParts,
  proxiedChildRequestIds,
  sendGate,
  withSessionEpochs,
} from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

const NONE = new Set();

const load = (name) =>
  readFileSync(`scripts/fixtures/subagent-delivery/${name}.ndjson`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** The chat's own projection of a stream: eve's reducer, then this repo's rules. */
function project(events) {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  const dead = deadInputRequestIds(events);
  const parts = pendingInputRequestParts({
    messages: data.messages ?? [],
    dismissed: NONE,
    responded: NONE,
    expired: NONE,
  });
  const open = [];
  for (const p of parts) {
    const req = p.toolMetadata?.eve?.inputRequest;
    if (req?.requestId && !dead.has(req.requestId)) open.push(req);
  }
  const gate = sendGate({
    storeBusy: false,
    events,
    pendingInputs: open.length,
    abandoned: false,
    remoteTurn: false,
  });
  return { messages: data.messages ?? [], dead, parts, open, gate };
}

/** Did the parent's stream actually carry the child's output back? */
const subagentResults = (events) =>
  events.filter((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result");

console.log("\n1. A child that completes normally delivers its result to the parent");
{
  const events = load("child-completes");
  const results = subagentResults(events);
  check("the delegation produced exactly one subagent-result", results.length === 1);
  check("it is not an error", results[0].data.result.isError !== true);
  check(
    "the child's output is the tool result the parent reads",
    String(results[0].data.result.output).includes("CHILD-RESULT"),
  );
  check(
    "eve also announced it as subagent.completed",
    events.some((e) => e.type === "subagent.completed"),
  );
  const { open, gate } = project(events);
  check("nothing is left awaiting the operator", open.length === 0);
  check("the composer is free", gate.hold === false);
}

console.log("\n2. A child that parks on a question is ANSWERABLE from the parent chat");
{
  const events = load("child-parks-never-answered");
  const proxied = proxiedChildRequestIds(events);
  check("the parked request is recognised as proxied from a child", proxied.size === 1);

  const { dead, open, gate, parts } = project(events);
  const [requestId] = [...proxied];
  // FAILS BEFORE THE FIX, twice over: `pendingInputParts` dropped proxied
  // requests outright, and `deadInputRequestIds` then killed this one on the
  // parent's own `turn.completed` — the epilogue eve emits WHILE the child is
  // parked (emitProxiedInputRequest → emitTurnEpilogue). Either alone empties
  // this list.
  check("it survives the parent's park epilogue", !dead.has(requestId));
  check("it is hoisted to the tail as an answerable card", parts.length === 1);
  check("it counts as an open request", open.length === 1 && open[0].requestId === requestId);

  // FAILS BEFORE THE FIX: with zero open requests the gate did not hold, so
  // `composerRoute` returned "send" and the text left as a plain `message` —
  // which eve never routes to a parked child.
  check("the send gate holds on awaiting-input", gate.hold && gate.reason === "awaiting-input");

  const answers = resolveTextToResponses("FY26", open);
  check("typed text resolves against the CHILD's requestId", answers.length === 1 && answers[0].requestId === requestId);
  check(
    "the composer routes it as the ANSWER, not as a message",
    composerRoute({ gate, answers: answers.length, hasFiles: false }) === "answer",
  );
}

console.log("\n3. Answered part-way, the child still delivers");
{
  const events = load("child-parks-then-answered");
  // This fixture IS the proof that the answer path works against the real
  // runtime: the same session, after a POST of `{inputResponses:[{requestId,
  // optionId}]}` to the PARENT, resumed the child and carried its output home.
  check(
    "the stream parked on a proxied request",
    proxiedChildRequestIds(events).size === 1,
  );
  const results = subagentResults(events);
  check("and still produced the subagent-result", results.length === 1);
  check(
    "carrying the child's own output",
    String(results[0].data.result.output).includes("CHILD-RESULT"),
  );
  const { open, gate, dead } = project(events);
  const [requestId] = [...proxiedChildRequestIds(events)];
  // The delegation settling is the ONLY thing that can retire a proxied
  // request: it carries the child's turn id and the child's call id, so neither
  // the parent's turn ending nor the delegation's own action.result reaches it
  // by id. Without that rule the answered question stayed "open" for ever and,
  // now that open requests hold the gate, wedged the composer.
  check("the answered request is retired once the delegation settles", dead.has(requestId));
  check("nothing is left awaiting the operator", open.length === 0);
  check("the composer is free again", gate.hold === false);
}

console.log("\n4. A child that is never answered is REPORTED, never silently dropped");
{
  const events = load("child-parks-never-answered");
  const { gate, open } = project(events);
  // The measured swallow: on this exact stream the next POST was
  // `{"message":"Use FY26 please."}`. eve answered {"ok":true} and the text
  // produced no `message.received`, no turn and no result — it was buffered
  // behind the parked child for ever. The chat's job is to never send it.
  check("the stream shows a live park and no result", subagentResults(events).length === 0);
  check("so the chat holds rather than sends", gate.hold === true);
  check("and says why", gate.reason === "awaiting-input");
  check("with the question visible to answer", open.length === 1);
  // Text that answers NOTHING (a strict-options approval, an unrelated remark)
  // is queued — held, visible, re-sent when the session frees up — instead of
  // being handed to eve to lose.
  const unrelated = resolveTextToResponses("", open);
  check(
    "text that resolves to no answer is queued, not sent",
    composerRoute({ gate, answers: unrelated.length, hasFiles: false }) === "queue",
  );
}

console.log("\n5. A child that dies still reports back to the parent");
{
  const events = load("child-fails");
  const results = subagentResults(events);
  check("the failure arrives as a subagent-result", results.length === 1);
  check("flagged as an error", results[0].data.result.isError === true);
  check(
    "naming the cause",
    String(results[0].data.result.output?.code ?? "") === "SUBAGENT_EXECUTION_FAILED",
  );
  const { gate } = project(events);
  check("and the chat is sendable again", gate.hold === false);
}

console.log("\n6. The parent's OWN approvals are untouched by any of this");
{
  // A request whose call id the parent declared is not proxied, and keeps the
  // parent's lifecycle: eve's park epilogue (`turn.completed`, then
  // `session.waiting`) is the park, not an end; the turn completing AFTER the
  // park, or a later turn running a step, ends it.
  const turnId = "t1";
  const events = [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId } },
    { type: "actions.requested", data: { turnId, actions: [{ kind: "tool-call", callId: "c1", toolName: "send_email" }] } },
    {
      type: "input.requested",
      data: {
        turnId,
        requests: [
          {
            requestId: "r1",
            prompt: "Send it?",
            action: { callId: "c1", toolName: "send_email" },
            options: [
              { id: "approve", label: "Approve" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      },
    },
  ];
  check("a parent-declared request is not proxied", proxiedChildRequestIds(events).size === 0);
  check("it is alive while its turn is open", !deadInputRequestIds(events).has("r1"));
  const parked = [...events, { type: "turn.completed", data: { turnId } }, { type: "session.waiting", data: {} }];
  check("its own turn's park epilogue leaves it alive", !deadInputRequestIds(parked).has("r1"));
  const ended = [...parked, { type: "turn.completed", data: { turnId } }];
  check("and it dies with its own turn once parked", deadInputRequestIds(ended).has("r1"));
  const resumed = [...parked, { type: "turn.started", data: { turnId: "t2" } }, { type: "step.started", data: { turnId: "t2", stepIndex: 0 } }];
  check("or when a later turn runs a step", deadInputRequestIds(resumed).has("r1"));
}

console.log("\n7. Every declared subagent records its runs, once per invocation");
{
  const { readdirSync, existsSync } = await import("node:fs");
  const { runKeyFor } = await import("../agent/lib/workflow-usage.ts");
  const keys = readdirSync("agent/subagents", { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`agent/subagents/${d.name}/agent.ts`))
    .map((d) => d.name);
  check("there are declared subagents to check", keys.length > 0);
  for (const key of keys) {
    const path = `agent/subagents/${key}/hooks/usage.ts`;
    assert.ok(existsSync(path), `${key} has no hooks/usage.ts — its runs are never recorded`);
    const src = readFileSync(path, "utf8");
    assert.ok(
      src.includes(`const WORKFLOW = "${key}";`),
      `${key}'s usage hook files its runs under another workflow name`,
    );
    assert.ok(
      src.includes('"turn.started"') && src.includes("openWorkflowRun"),
      `${key} opens no run row on turn.started — an invocation with no token usage leaves no history`,
    );
    assert.ok(
      src.includes("ctx.session.id"),
      `${key} does not pass ctx.session.id — every invocation would share one run_key`,
    );
    passed++;
  }
  console.log(`  ok   ${keys.length} subagents open a run row per invocation, keyed by session, under their own key`);

  // THE COLLISION. eve numbers turns within a session (`turn_${sequence}`,
  // eve/dist/src/protocol/message.js) and a delegated child session is created
  // fresh for every invocation, so its first turn is ALWAYS `turn_0`. Keyed on
  // the turn id alone, every run of a specialist shared one run_key and the
  // step upsert (onConflictDoUpdate) merged them. Measured 2026-09-23 against a
  // local Postgres carrying the real fail-closed tenancy model: three separate
  // invocations left ONE row, keyed `…:turn_0`.
  check(
    "two invocations of the same specialist do not share a run key",
    runKeyFor("wf1", "child-session-a", "turn_0") !== runKeyFor("wf1", "child-session-b", "turn_0"),
  );
  check(
    "two turns of the SAME session still differ",
    runKeyFor("wf1", "child-session-a", "turn_0") !== runKeyFor("wf1", "child-session-a", "turn_1"),
  );
  check(
    "a caller with no session id keeps the old key shape rather than inventing one",
    runKeyFor("wf1", undefined, "turn_0") === "wf1:turn_0",
  );

  const usage = readFileSync("agent/lib/workflow-usage.ts", "utf8");
  check(
    "a missing workflows row is a warning naming the fix, not silence",
    usage.includes("fde:seed-subagent-rows"),
  );
  check("a lookup MISS expires", usage.includes("NEGATIVE_TTL_MS"));
}

// THE PACK BLIND SPOT. Section 7 walks agent/subagents/ — and the four
// specialists that actually run in production do not live there. They ship in a
// pack (docs/SUBAGENT_PACKS.md) that is copied INTO agent/subagents/ at build
// time, each with its own copy of hooks/usage.ts. So this file passed while the
// deployed specialists were untouched, and the operator's run history stayed
// empty after a fix that reported itself green. The contract now lives in
// check-subagents.py's CODEBASE-WIDE registry pass, which runs over whatever is
// in agent/subagents/ — a pack's subagents included, once applied.
console.log("\n8. The run-accounting contract is enforced where a pack can be seen");
{
  const checker = readFileSync("scripts/check-subagents.py", "utf8");
  check("check_usage_hook exists", checker.includes("def check_usage_hook("));
  check(
    "and is called from the codebase-wide registry pass, not the per-workspace one",
    /def check_registry\([\s\S]*?check_usage_hook\(r, root, key\)/.test(checker),
  );
  for (const rule of ["turn.started", "ctx.session.id", "const WORKFLOW ="]) {
    check(`it holds the "${rule}" rule`, checker.includes(rule));
  }
}

// ---------------------------------------------------------------------------
// GAP 1: an invocation that dies BEFORE the child's first turn.
//
// Sections 7 and 8 hold the child's side of the run history. This is the half
// the child cannot record: the usage hooks fire on TURN events, and a child
// that dies during bootstrap never emits one, so the invocation left no row at
// all — not "a failed run", nothing. The parent IS told (section 5 proves the
// failure reaches it as a subagent-result flagged isError), so the parent
// records it.
//
// Driven over the REAL recorded streams, through the module the hook actually
// calls, with the session ids and the counter-shaped call ids the runtime
// really produced.
console.log("\n9. A specialist that dies before its first turn still leaves a run");
{
  const { existsSync } = await import("node:fs");
  check(
    "there is a parent-side recorder for a delegation that never started",
    existsSync("agent/lib/delegation-failures.ts") && existsSync("agent/lib/session-delegation-runs.ts"),
  );
  const { createDelegationTracker } = await import("../agent/lib/delegation-failures.ts");
  const { delegatedRunKey, runKeyFor } = await import("../agent/lib/workflow-usage.ts");

  /** The recorder's own event loop (agent/lib/session-delegation-runs.ts), minus the database. */
  function drive(events) {
    const tracker = createDelegationTracker();
    // ctx.session.id in the parent — which is what `subagent.called` also
    // reports as `sessionId`, so the fixtures carry it.
    const sessionId = events.find((e) => e.type === "subagent.called")?.data?.sessionId;
    const recorded = [];
    const parked = [];
    for (const e of events) {
      if (e.type === "subagent.called") tracker.called(sessionId, e.data);
      else if (e.type === "input.requested") parked.push(...tracker.parked(sessionId, e.data));
      else if (e.type === "action.result") {
        const settled = tracker.settled(sessionId, e.data);
        if (settled) recorded.push(settled);
      }
    }
    return { sessionId, recorded, parked, tracker };
  }

  {
    // THE MEASURED CASE: a real sandbox bootstrap failure, recorded from this
    // repo's agent under `eve dev`. subagent.called → action.result, and not one
    // turn event from the child in between, which is why nothing was recorded.
    const events = load("child-fails");
    const { recorded } = drive(events);
    check("the failed invocation is recognised from the parent's stream", recorded.length === 1);
    check("it ended in failure", recorded[0].failed === true);
    check("filed under the specialist that was called", recorded[0].name === "research");
    check(
      "carrying the CHILD's session — the run key is nothing without it",
      recorded[0].childSessionId === "wrun_01M36ARFBE2WW4S9443H4T8RHM",
    );
    check(
      "and eve's reason, which names the bootstrap that failed",
      String(recorded[0].message).startsWith('Step "step//eve@0.25.1//turnStep" failed after 3 retries'),
    );
    // WHY IT CANNOT DOUBLE-WRITE. The row the parent writes is keyed on exactly
    // the key the child's own openWorkflowRun uses for its first turn — eve
    // numbers turns within a session and a delegated child session is fresh, so
    // that turn is always turn_0. run_key is UNIQUE and the insert is
    // onConflictDoNothing, so whichever side writes second is a no-op.
    check(
      "the parent writes the key the child's own first turn would have written",
      delegatedRunKey("wf1", recorded[0].childSessionId) ===
        runKeyFor("wf1", recorded[0].childSessionId, "turn_0"),
    );
  }

  {
    // The other side of the same rule: when the child DOES start and return,
    // the parent records nothing at all, so there is no second row to collide.
    const events = load("child-completes");
    const { recorded } = drive(events);
    check("a child that returns normally settles its delegation", recorded.length === 1);
    check("and is NOT recorded as a failure by the parent", recorded[0].failed === false);
    const answered = drive(load("child-parks-then-answered")).recorded;
    check("nor is one that parked and was then answered", answered.length === 1 && answered[0].failed === false);
  }

  {
    // THE WARM-INSTANCE HAZARD, with the ids the runtime really minted. Both
    // recorded streams delegate under the literal call id
    // `call_000000000000000000000002` (agent/lib/unique-tool-call-ids.ts: some
    // models COUNT instead of minting ids). A module-scope map keyed on the
    // call id alone would file session B's failure against session A's child —
    // inventing a failed run for a specialist that is still working, which is
    // exactly the mis-close that ruled out module-scope turn tracking.
    const callId = "call_000000000000000000000002";
    const tracker = createDelegationTracker();
    tracker.called("parent-A", { callId, childSessionId: "child-A", name: "research" });
    tracker.called("parent-B", { callId, childSessionId: "child-B", name: "research" });
    const b = tracker.settled("parent-B", {
      result: { callId, kind: "subagent-result", isError: true, output: { code: "SUBAGENT_EXECUTION_FAILED" } },
    });
    check("a shared call id does not cross sessions", b?.childSessionId === "child-B");
    const a = tracker.settled("parent-A", {
      result: { callId, kind: "subagent-result", output: "CHILD-RESULT" },
    });
    check("and the other session's delegation is untouched by it", a?.childSessionId === "child-A" && a.failed === false);
  }

  {
    // A result for a delegation this instance never saw start (it was recycled
    // mid-session) carries no child session id, and one keyed on a guess would
    // collide with some real invocation's row. Nothing is written.
    const tracker = createDelegationTracker();
    check(
      "a failure with no remembered delegation writes nothing",
      tracker.settled("parent-A", {
        result: { callId: "call_unseen", kind: "subagent-result", isError: true, output: {} },
      }) === null,
    );
    // Unbounded, this map would grow for the life of a warm instance.
    for (let i = 0; i < 600; i++) {
      tracker.called("parent-A", { callId: `call_${i}`, childSessionId: `child_${i}`, name: "research" });
    }
    check("outstanding delegations are bounded", tracker.size <= 512);
    check(
      "and the OLDEST is what goes: an unresolved delegation from hours ago never resolves",
      tracker.settled("parent-A", { result: { callId: "call_599", kind: "subagent-result", isError: true, output: {} } })
        ?.childSessionId === "child_599" &&
        tracker.settled("parent-A", { result: { callId: "call_0", kind: "subagent-result", isError: true, output: {} } }) ===
          null,
    );
  }
}

// ---------------------------------------------------------------------------
// GAP 2: a row that stays `running` for ever.
//
// `session.failed` carries no turnId, so a child that dies mid-turn without a
// `turn.failed` leaves its row open — measured live: icici-hfc holds three rows
// and one is still `running`. The fix is a clock, not a remembered turn id: a
// warm instance serves several sessions, so the turn id it remembers may belong
// to a LIVE run and closing that is worse than leaving one open.
//
// The closing itself is a database statement and is proved against a real
// Postgres by scripts/test-run-history-db.mjs. What is held HERE is everything
// that decides whether it is safe: the interval, and the exclusion that keeps a
// parked run out of its way.
console.log("\n10. A run that nobody closes is closed by the clock — and a live one never is");
{
  const { existsSync } = await import("node:fs");
  const CRON = "/api/cron/close-abandoned-runs";
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  check(
    "a cron sweeps abandoned runs",
    (vercel.crons ?? []).some((c) => c.path === CRON),
  );
  check("and the route it calls exists", existsSync(`app${CRON}/route.ts`));
  const route = readFileSync(`app${CRON}/route.ts`, "utf8");
  // The same fail-closed guard the other four crons carry: `if (secret && …)`
  // skips the check when CRON_SECRET is unset, and it is set on Production
  // ONLY — which left every preview deployment's crons open.
  check(
    "it fails closed when CRON_SECRET is unset, like its four siblings",
    /if \(!secret\)/.test(route) && /status: 503/.test(route),
  );

  const { ABANDONED_RUN_MS, ABANDONED_RUN_ERROR, AWAITING_ANSWER_SUMMARY } = await import(
    "../agent/lib/workflow-usage.ts"
  );
  // THE INTERVAL, against the longest a row can legitimately still be live.
  // One attempt of a turn runs under `maxDuration: "max"`, which this repo pins
  // at 800s where it controls it (app/eve/v1/session/[...segments]/route.ts),
  // and eve retries a failed turn step three times — "failed after 3 retries",
  // measured verbatim in child-fails.ndjson — so four attempts can be live.
  const RETRY_BOUND_MS = 4 * 800_000;
  check("the interval clears four 800s attempts of one turn", ABANDONED_RUN_MS > RETRY_BOUND_MS);
  check(
    "which is the bound eve's own retry count sets",
    load("child-fails").some((e) =>
      String(e.data?.result?.output?.message ?? "").includes("failed after 3 retries"),
    ),
  );
  // The longest specialist run anyone has actually observed on the live
  // deployment: lodr-filings, 5m30s (2026-09-23).
  check("and is many times the longest run ever measured", ABANDONED_RUN_MS > 10 * 5.5 * 60_000);

  // The status stays inside the closed set the API type mirrors exactly; the
  // SENTENCE is what makes an abandoned run distinguishable from a completed
  // one and from one that genuinely failed.
  const apiRun = readFileSync("app/_components/ops/lib.ts", "utf8");
  check(
    "automation run status is still the three values every consumer handles",
    /status: "success" \| "failed" \| "running";/.test(apiRun),
  );
  check("an abandoned run says it was never heard from again", /never heard from again/.test(ABANDONED_RUN_ERROR));

  // A PARKED CHILD IS LIVE, for as long as nobody answers — six live sessions
  // ended exactly that way (#42). No interval is long enough for a question,
  // so the sweeper excludes marked rows instead of waiting longer.
  const usage = readFileSync("agent/lib/workflow-usage.ts", "utf8");
  check("the sweeper skips a run that is waiting on a person", /summary} is null/.test(usage));
  check("which is marked, not guessed", AWAITING_ANSWER_SUMMARY.length > 0 && /markDelegationParked/.test(usage));
  check("and unmarked when the delegation comes back", /clearDelegationPark/.test(usage));

  // The mark is set from the PARENT's stream, because the specialists that park
  // in production ship in a pack with their own hooks/usage.ts — the blind spot
  // section 8 exists for.
  // Not an authored hook: in eve 0.25.1 no hook ever receives `subagent.called` (section 10), so the recorder is fed
  // from the parent's stream as the session guard serves it.
  const { DELEGATION_EVENT_TYPES } = await import("../agent/lib/session-delegation-runs.ts");
  for (const event of ["actions.requested", "subagent.called", "input.requested", "action.result"]) {
    check(`the parent-stream recorder watches ${event}`, DELEGATION_EVENT_TYPES.has(event));
  }
  const guard = readFileSync("agent/lib/session-guard.ts", "utf8");
  check("…and the session guard feeds it every stream it serves", /delegationRunRecorder\(sessionId\)/.test(guard));
  const { createDelegationTracker } = await import("../agent/lib/delegation-failures.ts");
  {
    // THE SWALLOW ITSELF, as the parent recorded it: the child asked a
    // question and the session is still sitting on it. Its run row is
    // `running` and must stay that way.
    const events = load("child-parks-never-answered");
    const sessionId = events.find((e) => e.type === "subagent.called")?.data?.sessionId;
    const tracker = createDelegationTracker();
    const parked = [];
    for (const e of events) {
      if (e.type === "actions.requested") tracker.declared(sessionId, e.data);
      else if (e.type === "subagent.called") tracker.called(sessionId, e.data);
      else if (e.type === "input.requested") parked.push(...tracker.parked(sessionId, e.data));
    }
    check("the live park is seen from the parent's stream", parked.length === 1);
    check("naming the child whose row must not be swept", parked[0].childSessionId === "wrun_01M36BB9YBDWYYSK9ANGQ8SC1P");
    check("and the delegation stays outstanding, so a re-park finds it again", tracker.size === 1);
    // The proxied request does NOT name the delegation: eve passes the child's
    // own `ask_question` call through verbatim, so the id on the request
    // (call_…0a) is not the id of the delegation (call_…09). Attribution is by
    // exclusion, which is why the rule above cannot be "match the call id".
    const request = events.find((e) => e.type === "input.requested").data.requests[0];
    const delegation = events.find((e) => e.type === "subagent.called").data.callId;
    check("the proxied question does not carry the delegation's call id", request.action.callId !== delegation);
  }
  {
    // The parent's OWN approval is not a child park. It was declared in this
    // session's `actions.requested`, so it marks nothing and an ordinary run
    // stays sweepable — otherwise one `send_email?` prompt would exempt every
    // open run in the session from the sweep for ever.
    const tracker = createDelegationTracker();
    tracker.declared("parent-A", { actions: [{ callId: "c-own", kind: "tool-call" }] });
    tracker.called("parent-A", { callId: "c-child", childSessionId: "child-A", name: "research" });
    check(
      "a parent-declared approval marks nothing",
      tracker.parked("parent-A", { requests: [{ requestId: "r1", action: { callId: "c-own" } }] }).length === 0,
    );
    check(
      "a request with no call id at all marks nothing either",
      tracker.parked("parent-A", { requests: [{ requestId: "r2" }] }).length === 0,
    );
    // And a park in ANOTHER session never exempts this session's run — the
    // warm-instance hazard again, on the other write path.
    tracker.declared("parent-B", { actions: [{ callId: "c-own-b", kind: "tool-call" }] });
    check(
      "a park in another session exempts nothing here",
      tracker.parked("parent-B", { requests: [{ requestId: "r3", action: { callId: "c-proxied" } }] }).length === 0,
    );
  }
}

// mold_v1-129(a). agent/hooks/delegation-runs.ts subscribed to `subagent.called` and no row it should have written
// ever appeared. The cause is in eve itself, so it is asserted against the INSTALLED eve: the event is built and
// written by the action-dispatch step, which hands it to the channel adapter only — authored hooks are dispatched by
// the turn step alone — and a channel cannot subscribe to it either. If a later eve delivers it to hooks, this
// section fails and says so, and the hook route becomes an option again.
console.log("\n10. eve 0.25.1 never hands `subagent.called` to an authored hook");
{
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const src = (p) => readFileSync(join(eveRoot, "dist/src", p), "utf8");
  const version = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version;
  const dispatch = src("execution/dispatch-runtime-actions-step.js");
  const steps = src("execution/workflow-steps.js");
  const channel = src("public/definitions/channel.js");
  check(`(eve ${version})`, typeof version === "string");
  check(
    "`subagent.called` is written by the action-dispatch step, through the channel adapter",
    /callAdapterEventHandler\([^,]+,createSubagentCalledEvent\(/.test(dispatch),
  );
  check("…which never dispatches authored hooks", !dispatch.includes("dispatchStreamEventHooks"));
  check("authored hooks are dispatched by the turn step's own events", steps.includes("dispatchStreamEventHooks"));
  const eventTypes = /const eventTypes=Object\.keys\(\{([^}]*)\}\)/.exec(channel)?.[1] ?? "";
  check("a channel's `events` cannot subscribe to it either", eventTypes.length > 0 && !eventTypes.includes("subagent.called"));
  const { existsSync } = await import("node:fs");
  check("so no hook pretends to record from it", !existsSync("agent/hooks/delegation-runs.ts"));
}

// #75 review: call ids are per-turn counters, and a replay of an OLD turn runs beside a live read of the current
// one. One process-wide tracker let them overwrite each other: an old failure was filed against the LIVE child
// (dated in the past, pre-empting its own row) and the live child's outcome was lost.
console.log("\n11. A replay and a live read of one parent never cross their delegations");
{
  const { delegationRunRecorder } = await import("../agent/lib/session-delegation-runs.ts");
  const writes = [];
  const w = {
    recordFailedDelegation: async (name, child, _msg, at) => void writes.push(["failed", child, at?.toISOString()]),
    markDelegationParked: async (name, child) => void writes.push(["parked", child]),
    clearDelegationPark: async (name, child) => void writes.push(["clear", child]),
  };
  const P = "wrun_parent";
  const CALL = "call_000000000000000000000002";
  const called = (child, turnId, at) => ({ type: "subagent.called", data: { callId: CALL, childSessionId: child, name: "research", turnId }, meta: { at } });
  const failed = (turnId, at) => ({ type: "action.result", data: { turnId, result: { callId: CALL, kind: "subagent-result", isError: true, output: { message: "boom" } } }, meta: { at } });
  const ok = (turnId) => ({ type: "action.result", data: { turnId, result: { callId: CALL, kind: "subagent-result", isError: false, output: "fine" } } });
  for (const withTurns of [true, false]) {
    const t = (turn) => (withTurns ? turn : undefined);
    const label = withTurns ? "" : " (events without turn ids)";
    writes.length = 0;
    const live = delegationRunRecorder(P, w);
    const replay = delegationRunRecorder(P, w);
    await live(called("wrun_NEW", t("turn_2"), "2026-09-29T07:00:00Z"));
    await replay(called("wrun_OLD", t("turn_1"), "2026-09-20T07:00:00Z"));
    await replay(failed(t("turn_1"), "2026-09-20T07:00:05Z"));
    await live(ok(t("turn_2")));
    check(`the replay's old failure is filed against the OLD child, at its own date${label}`, writes.some((x) => x[0] === "failed" && x[1] === "wrun_OLD" && x[2] === "2026-09-20T07:00:05.000Z"));
    check(`…and never against the live child${label}`, !writes.some((x) => x[0] === "failed" && x[1] === "wrun_NEW"));
    check(`…while the live child's own completion is still seen${label}`, writes.some((x) => x[0] === "clear" && x[1] === "wrun_NEW"));
    writes.length = 0;
    const live2 = delegationRunRecorder(P, w);
    const replay2 = delegationRunRecorder(P, w);
    await replay2(called("wrun_OLD2", t("turn_1"), "2026-09-20T07:00:00Z"));
    await live2(called("wrun_NEW2", t("turn_2"), "2026-09-29T07:10:00Z"));
    await replay2(failed(t("turn_1"), "2026-09-20T07:00:05Z"));
    await live2(failed(t("turn_2"), "2026-09-29T07:10:05Z"));
    check(
      `reverse interleave: each failure is filed against its own child, at its own date${label}`,
      writes.length === 2 &&
        writes.some((x) => x[1] === "wrun_OLD2" && x[2] === "2026-09-20T07:00:05.000Z") &&
        writes.some((x) => x[1] === "wrun_NEW2" && x[2] === "2026-09-29T07:10:05.000Z"),
      writes,
    );
  }
  // One read from index 0 over two turns that reuse the call id: each result settles its own turn's child.
  writes.length = 0;
  const one = delegationRunRecorder(P, w);
  await one(called("wrun_T1", "turn_1"));
  await one(called("wrun_T2", "turn_2")); // turn 1's delegation never came back (abandoned)
  await one(failed("turn_2", "2026-09-29T08:00:00Z"));
  check("within one read, a reused call id in a later turn settles the later turn's child", writes.length === 1 && writes[0][1] === "wrun_T2", writes);
}

console.log(`\ntest-subagent-delivery: ${passed} assertions passed`);
