/**
 * "REPORTS LATER" AS EVERY READER OF A MAIN THREAD SEES IT (mold_v1-184) — offline, over streams recorded from the
 * real runtime with the eve patch (scripts/fixtures/specialist-detach/*.ndjson, written by
 * `EVE_DETACH_RECORD_STREAMS=1 npm run test:specialist-detach`), plus the patch's own pure helpers as installed.
 *
 * Under `subagents: { batch: "detach" }` a delegation's `action.result` is either its result or a stand-in
 * (`{ status: "running", childSessionId, name }`). Every app reader that took "an action.result arrived" to mean "the
 * delegation is over" must tell the two apart, or a question becomes unanswerable, a working specialist reads as lost,
 * a step returns half an answer, or a Stop hands back twice. This holds each reader to the recorded truth:
 *
 *   1. the stand-in test itself (lib/detached-delegation.ts)
 *   2. the chat: a detached specialist's question stays answerable; it is live, "reports later"; never lost
 *   3. a program's step (lib/step-handback.ts): not over until the late result's turn
 *   4. a Stop (agent/lib/specialist-handback.ts): eve reports a detachable delegation's stop itself; a lone stop of one
 *      it does not report is refused while a "reports later" specialist works
 *   5. the run history (agent/lib/session-delegation-runs.ts): the stand-in settles nothing; the late result settles it
 *   6. the eve patch's pure helpers (node_modules/eve/dist/src/harness/detached-delegations.js): exactly once
 *
 * Run: npm run test:detached-delegation
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`}`);
};
const stream = (name) =>
  readFileSync(join(ROOT, "scripts/fixtures/specialist-detach", `${name}.ndjson`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const asks = stream("asks-main-thread");
const slow = stream("slow-main-thread");
const stopped = stream("stopped-main-thread");
const mainStopped = stream("main-stopped-main-thread");
const calls = (h) => Object.fromEntries(h.filter((e) => e.type === "subagent.called").map((e) => [e.data.name, e.data]));
const A = calls(asks);
/** The main thread as it stood when the person was asked (after the hand-over, before any answer or late result). */
const handedOver = asks.slice(0, asks.findIndex((e) => e.type === "turn.started" && e.data?.turnId !== asks.find((x) => x.type === "turn.started").data.turnId));

const D = await import("../lib/detached-delegation.ts");
const T = await import("../lib/chat-turn-state.ts");

console.log("1. the stand-in");
{
  const stand = asks.filter(D.isDetachedPlaceholderEvent);
  check("the recorded hand-over carries exactly one stand-in, beta's", stand.length === 1 && stand[0].data.result.callId === A.beta.callId, stand.map((e) => e.data.result));
  check("…and alpha's real result is not one", !D.isDetachedResult(asks.find((e) => e.type === "action.result" && e.data.result.callId === A.alpha.callId).data.result));
  check("a real result that happens to say status 'running' without a child session is not one", !D.isDetachedResult({ kind: "subagent-result", callId: "x", subagentName: "s", output: { status: "running" } }));
  check("an error is never a stand-in", !D.isDetachedResult({ kind: "subagent-result", callId: "x", subagentName: "s", isError: true, output: { status: "running", childSessionId: "c" } }));
  check("eve marked both delegations detachable", D.isDetachableCall(asks.find((e) => e.type === "subagent.called")));
  check("beta is outstanding after the hand-over, and not after its late result", JSON.stringify(D.detachedOutstanding(handedOver).map((d) => d.name)) === '["beta"]' && D.detachedOutstanding(asks).length === 0);
  const stop = stopped.filter((e) => e.type === "action.result" && e.data?.result?.isError);
  check("a stopped one's late result is recognised as stopped (by its output, and by the text a client keeps)", stop.length === 1 && D.isStoppedDelegation(stop[0].data.result.output) && D.isStoppedDelegation(stop[0].data.error?.message ?? ""), stop.map((e) => e.data));
  check("…and so is the main thread's close of a detached one when the main thread was stopped", D.isStoppedDelegation(mainStopped.filter((e) => e.type === "action.result").at(-1)?.data?.result?.output));
}

console.log("\n2. the chat");
{
  const question = handedOver.find((e) => e.type === "input.requested").data.requests[0].requestId;
  check("beta's question is proxied (the child's, not the main agent's)", T.proxiedChildRequestIds(handedOver).has(question));
  check("…and stays ANSWERABLE after the hand-over (the stand-in does not retire it)", !T.deadInputRequestIds(handedOver).has(question), [...T.deadInputRequestIds(handedOver)]);
  check("…and is retired once beta's real result has come", T.deadInputRequestIds(asks).has(question));
  const live = T.liveDelegations(handedOver);
  check("beta is still a live delegation, marked detached; alpha is settled", live.length === 1 && live[0].name === "beta" && live[0].detached === true, live);
  check("nothing is live once beta reported", T.liveDelegations(asks).length === 0);
  check(
    "the working line says a reports-later specialist comes back by itself",
    /^Beta is still working — its result comes back to the main agent by itself\.$/.test(T.specialistWorkingLine([], [], ["beta"])),
    T.specialistWorkingLine([], [], ["beta"]),
  );
  const finished = { [A.beta.childSessionId]: { completed: true, result: "CHILD-RESULT beta" } };
  const states = T.handbackStates([{ callId: A.beta.callId, name: "beta", status: "running", childSessionId: A.beta.childSessionId, detached: true }], finished);
  check("a detached specialist that has finished before its late result shows is 'reports later' — never lost, never offered the rescue", states.lost.length === 0 && states.held.length === 0 && states.reportsLater.length === 1, states);
  const owed = D.detachedOutstanding(handedOver).length > 0;
  const verdict = T.attachDecision({ sessionId: "P", storeBusy: false, events: handedOver, failures: 0, maxFailures: 4, outstanding: owed ? 1 : 0 });
  check("a main thread at rest that still owes a 'reports later' result keeps a reader on its stream (agent-chat.tsx counts it), so the result shows when it lands", verdict.attach === true && verdict.reason === "buffered", verdict);
  check("…and once it reported, nothing is owed: no reader", D.detachedOutstanding(asks).length === 0 && T.attachDecision({ sessionId: "P", storeBusy: false, events: asks, failures: 0, maxFailures: 4, outstanding: 0 }).attach === false);
  check("its question does not hold the composer as a running turn (the thread is at rest)", !T.turnUnfinished(handedOver));
  const before = T.handbackStates([{ callId: A.beta.callId, name: "beta", status: "running", childSessionId: A.beta.childSessionId }], finished);
  check("…while the same delegation NOT detached keeps its old reading (lost, offered the rescue)", before.lost.length === 1 && before.reportsLater.length === 0, before);
}

console.log("\n3. a program's step");
{
  const { createStepWatch } = await import("../lib/step-handback.ts");
  const verdicts = (h) => {
    const watch = createStepWatch();
    return h.map((e) => watch.see(e).kind);
  };
  const v = verdicts(asks);
  const firstDone = v.indexOf("done");
  const lateTurnDone = asks.findLastIndex((e) => e.type === "turn.completed");
  check("a step whose specialist asked is waiting on the person (as before), and stays so through the hand-over", v.includes("waiting-on-person") && v.slice(0, asks.indexOf(handedOver.at(-1)) + 1).every((k) => k !== "done"), v);
  check("…and is done only at the end of the late result's turn", firstDone === lateTurnDone, { firstDone, lateTurnDone });
  const s = verdicts(slow);
  const handOverDone = slow.findIndex((e) => e.type === "turn.completed");
  check("a step whose specialist is merely slow is NOT done when the hand-over turn ends (it would return half an answer)", s[handOverDone] === "open", { at: handOverDone, verdict: s[handOverDone] });
  check("…it is done when the late turn ends", s.indexOf("done") === slow.findLastIndex((e) => e.type === "turn.completed"));
}

console.log("\n4. a Stop");
{
  const { planStop, refusalMessage } = await import("../agent/lib/specialist-handback.ts");
  const world = (map) => ({ history: async (id) => map[id] });
  const plan = await planStop(world({ P: handedOver }), "P", A.beta.childSessionId);
  check("stopping a detachable (detached) specialist is a plain cancel: eve reports the stop itself, once", plan.kind === "plain", plan);
  const inBatch = asks.slice(0, asks.findIndex((e) => e.type === "input.requested"));
  check("…and so is one still in its batch (eve resolves the batch with its stop)", (await planStop(world({ P: inBatch }), "P", A.alpha.childSessionId)).kind === "plain");
  // A later turn delegates to a specialist eve does NOT report (no `detachable`: a remote agent, the Workflow tool, a
  // session started before the patch) while beta still reports later.
  const remote = { callId: "call_remote", childSessionId: "child-remote", name: "remote-agent", turnId: "turn_9" };
  const later = [...handedOver, { type: "turn.started", data: { turnId: "turn_9" } }, { type: "subagent.called", data: remote }];
  const live = [{ type: "turn.started", data: {} }, { type: "step.started", data: {} }];
  const refused = await planStop(world({ P: later, "child-remote": live }), "P", "child-remote");
  check("a lone stop of a specialist eve does not report is REFUSED while a 'reports later' one works (ending that turn would stop it)", refused.kind === "refuse" && refused.working.includes("beta"), refused);
  check("…saying who is still working", /"beta" is still working/.test(refusalMessage(refused.name, refused.working, refused.asking)));
}

console.log("\n5. the run history");
{
  const { delegationRunRecorder } = await import("../agent/lib/session-delegation-runs.ts");
  const writes = [];
  const rec = delegationRunRecorder("P", {
    recordFailedDelegation: async (name, child) => writes.push(["failed", name, child]),
    markDelegationParked: async (name, child) => writes.push(["parked", name, child]),
    clearDelegationPark: async (name, child) => writes.push(["clear", name, child]),
  });
  for (const e of handedOver) await rec(e);
  const atHandOver = writes.map((w) => w.join(":"));
  check("the stand-in does not clear beta's park mark (beta is still waiting on the person)", !atHandOver.includes(`clear:beta:${A.beta.childSessionId}`) && atHandOver.includes(`parked:beta:${A.beta.childSessionId}`), atHandOver);
  for (const e of asks.slice(handedOver.length)) await rec(e);
  check("…the late result, in a later turn, clears it", writes.map((w) => w.join(":")).includes(`clear:beta:${A.beta.childSessionId}`), writes);
}

console.log("\n5b. who gets per-result delegation: a person in the chat, never a program's session");
{
  const { withSubagentBatch } = await import("../agent/lib/subagent-batch-auth.ts");
  const { SUBAGENT_BATCH_HEADER, SUBAGENT_BATCH_AUTH_ATTRIBUTE } = await import("../lib/subagent-batch.ts");
  const person = { authenticator: "jwt", principalId: "p", principalType: "user", attributes: { email: "a@b.co" } };
  check("a person's chat session is created as it was (no override: the agent's \"detach\" applies)", JSON.stringify(withSubagentBatch(person, new Headers())) === JSON.stringify(person));
  const program = withSubagentBatch(person, new Headers({ [SUBAGENT_BATCH_HEADER]: "all" }));
  check("a session a program opens (the header) is created with eve_subagent_batch: \"all\" (eve's own batch)", program.attributes[SUBAGENT_BATCH_AUTH_ATTRIBUTE] === "all" && program.attributes.email === "a@b.co");
  const delegate = readFileSync(join(ROOT, "lib/workflow-delegate.ts"), "utf8");
  check("every step a program opens (workflow step, app refresh, cron step: lib/workflow-delegate.ts startStep) sends that header", /\[SUBAGENT_BATCH_HEADER\]: "all"/.test(delegate) && (delegate.match(/fetch\(`\$\{AGENT_URL\}\/eve\/v1\/session`/g) ?? []).length === 1);
  const channel = readFileSync(join(ROOT, "agent/channels/eve.ts"), "utf8");
  check("…and the agent's channel stamps it on the auth a session is created with", /onMessage: \(\{ eve \}\) => \(\{ auth: withSubagentBatch\(sessionAuthForRequest\(/.test(channel));
}

console.log("\n6. the eve patch's pure helpers (as installed)");
{
  const H = await import(join(ROOT, "node_modules/eve/dist/src/harness/detached-delegations.js"));
  const key = (r) => `subagent-call:${r.subagentName}:${r.callId}`;
  const delegations = new Map([
    ["subagent-call:alpha:a", { callId: "a", childContinuationToken: "ta", childSessionId: "ca", key: "subagent-call:alpha:a", name: "alpha", subagentName: "alpha" }],
    ["subagent-call:beta:b", { callId: "b", childContinuationToken: "tb", childSessionId: "cb", key: "subagent-call:beta:b", name: "beta", subagentName: "beta" }],
  ]);
  const pendingKeys = [...delegations.keys()];
  const alphaResult = { callId: "a", kind: "subagent-result", output: "A", subagentName: "alpha" };
  const plan = (results, asked, timerFired) => H.planDetach({ asked: new Set(asked), delegations, pendingKeys, resultKey: key, results, timerFired });
  check("nothing is handed over while nothing is in", plan([], ["b"], true) === undefined);
  check("…nor while the one out is merely working and the bound has not passed", plan([alphaResult], [], false) === undefined);
  const now = plan([alphaResult], ["b"], false);
  check("one in and the other asking: handed over at once, the other 'running'", now?.results.length === 2 && now.results[1].output.status === "running" && now.results[1].output.childSessionId === "cb" && now.detached.map((d) => d.callId).join() === "b", now);
  check("one in and the bound passed: handed over", plan([alphaResult], [], true)?.detached.length === 1);
  const remoteOut = H.planDetach({ asked: new Set(["r"]), delegations, pendingKeys: [...pendingKeys, "subagent-call:remote:r"], resultKey: key, results: [alphaResult], timerFired: true });
  check("never while one still out is not a local delegation of this turn (a remote agent: no way home)", remoteOut === undefined);

  let session = { history: [], state: { "eve.runtime.proxyInputRequests": { req1: "tb", other: "tx" } }, sessionId: "P" };
  session = H.recordDetachedDelegations(session, [delegations.get("subagent-call:beta:b")]);
  const late = { callId: "b", kind: "subagent-result", output: "B", subagentName: "beta" };
  const filtered = H.filterDelegationDelivery(
    { kind: "deliver", payloads: [{ message: "hello" }, { delegationResults: [late, { ...late, output: "B copy" }, alphaResult] }, { delegationRequests: [{ callId: "b", kind: "subagent-input-request", event: { requests: [{ requestId: "req1" }] } }, { callId: "b", kind: "subagent-input-request", event: { requests: [{ requestId: "req2" }] } }, { callId: "a", kind: "subagent-input-request", event: { requests: [{ requestId: "req3" }] } }] }] },
    session.state,
  );
  check("the driver keeps a person's message as it is", JSON.stringify(filtered.delivery.payloads[0]) === '{"message":"hello"}');
  check("…keeps ONE copy of a detached delegation's result, and drops a result of one that was never detached", JSON.stringify(filtered.delivery.payloads.at(-1)) === JSON.stringify({ delegationResults: [late] }), filtered.delivery.payloads);
  check("…proxies only a detached delegation's question the main thread does not hold yet", filtered.requests.length === 1 && filtered.requests[0].event.requests[0].requestId === "req2", filtered.requests);
  check("a delivery with nothing still owed starts no turn", H.filterDelegationDelivery({ kind: "deliver", payloads: [{ delegationResults: [alphaResult] }] }, session.state).delivery === null);
  const plain = { kind: "deliver", payloads: [{ message: "hi" }] };
  check("a delivery without delegation fields is passed through untouched (the same object)", H.filterDelegationDelivery(plain, session.state).delivery === plain);
  const first = H.takeDelegationResults(session, [late, late]);
  check("the turn takes a late result once (two copies in one input: one delivered)", first.delivered.length === 1);
  check("…removes the record, so a copy that comes later finds nothing", H.takeDelegationResults(first.session, [late]).delivered.length === 0 && Object.keys(H.getDetachedDelegations(first.session.state)).length === 0);
  check("…and clears that child's proxied questions (only that child's)", first.session.state["eve.runtime.proxyInputRequests"]?.req1 === undefined && first.session.state["eve.runtime.proxyInputRequests"]?.other === "tx", first.session.state);
  const msgs = H.buildLateResultMessages(first.delivered);
  check(
    "the late result is a TOOL message answering a synthetic call of the delegation's own tool (never a user message)",
    msgs.length === 2 && msgs[0].role === "assistant" && msgs[0].content[0].type === "tool-call" && msgs[0].content[0].toolName === "beta" && msgs[1].role === "tool" && msgs[1].content[0].toolCallId === msgs[0].content[0].toolCallId && msgs[1].content[0].output.value === "B",
    msgs,
  );
  const merged = H.mergeDelegationFields({}, { delegationResults: [late] }, { delegationResults: [alphaResult] });
  check("two inputs' late results are concatenated, never overwritten", merged.delegationResults.length === 2);
  const cleared = H.clearDetachedDelegations(session);
  check("stopping the main thread clears every record (none can be delivered after)", cleared.records.length === 1 && Object.keys(H.getDetachedDelegations(cleared.session.state)).length === 0);
  check("a session whose creator carries eve_subagent_batch: \"all\" keeps eve's own batch, and nothing turns detach on", Object.keys(H.subagentBatchStepFields({ subagents: { batch: "detach" } }, { state: { "eve.runtime.pendingActionBatch": {} } }, { attributes: { eve_subagent_batch: "all" } })).length === 0 && H.subagentBatchStepFields({ subagents: { batch: "detach" } }, { state: { "eve.runtime.pendingActionBatch": {} } }, { attributes: {} }).subagentBatch?.mode === "detach" && Object.keys(H.subagentBatchStepFields({}, { state: { "eve.runtime.pendingActionBatch": {} } }, { attributes: { eve_subagent_batch: "detach" } })).length === 0);
  const coalesced = H.mergeDelegationFields({}, { runtimeActionResults: [alphaResult], delegationResults: [late] }, { runtimeActionResults: [late] });
  check("a deferred input merged into a batch's results keeps the batch's results and the late ones (nothing dropped)", coalesced.runtimeActionResults.length === 2 && coalesced.delegationResults.length === 1);
  {
    // A question (and an approval-gated call) made in the same step as a specialist call: eve dropped it, unanswered.
    const response = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "alpha", input: {} }, { type: "tool-call", toolCallId: "q1", toolName: "ask_question", input: {} }, { type: "tool-call", toolCallId: "w1", toolName: "write_file", input: {} }, { type: "tool-call", toolCallId: "p1", toolName: "web_search", input: {}, providerExecuted: true }, { type: "tool-call", toolCallId: "r1", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "r1", toolName: "read", output: { type: "text", value: "ok" } }] },
    ];
    const extra = H.answerUnrunToolCalls(response, [{ type: "tool-result", toolCallId: "c1", toolName: "alpha", output: { type: "text", value: "A" } }]);
    check(
      "a call left with no result beside a batch's results is answered (question: 'not asked'; approval: 'not run'), once; answered, provider-run and specialist calls are left alone",
      extra.length === 2 && extra[0].toolCallId === "q1" && /^Not asked:/.test(extra[0].output.value) && extra[0].output.type === "error-text" && extra[1].toolCallId === "w1" && /^Not run:/.test(extra[1].output.value) && H.answerUnrunToolCalls(response, [{ toolCallId: "c1" }, ...extra]).length === 0,
      extra,
    );
  }
  check("only an agent that opted in detaches; the default is eve's own batch", H.resolveSubagentBatch({}) === undefined && H.resolveSubagentBatch({ subagents: { batch: "all" } }) === undefined && H.resolveSubagentBatch({ subagents: { batch: "detach" } })?.detachAfterMs === 10_000 && H.resolveSubagentBatch({ subagents: { batch: "detach", detachAfterMs: 2500 } })?.detachAfterMs === 2500);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
