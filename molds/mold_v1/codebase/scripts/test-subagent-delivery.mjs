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
  // A request whose call id the parent declared is not proxied, and must keep
  // its old lifecycle: killed by the turn that was suspended on it ending.
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
  const ended = [...events, { type: "turn.completed", data: { turnId } }];
  check(
    "and dies with its own turn, exactly as before",
    deadInputRequestIds(ended).has("r1"),
  );
}

console.log("\n7. Every declared subagent records its runs");
{
  const { readdirSync, existsSync } = await import("node:fs");
  const keys = readdirSync("agent/subagents", { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`agent/subagents/${d.name}/agent.ts`))
    .map((d) => d.name);
  check("there are declared subagents to check", keys.length > 0);
  for (const key of keys) {
    const path = `agent/subagents/${key}/hooks/usage.ts`;
    // FAILS BEFORE THE FIX for app-author, browser and workflow-author, which
    // had no usage hook at all — their runs could never appear in any history.
    assert.ok(existsSync(path), `${key} has no hooks/usage.ts — its runs are never recorded`);
    const src = readFileSync(path, "utf8");
    assert.ok(
      src.includes(`const WORKFLOW = "${key}";`),
      `${key}'s usage hook files its runs under another workflow name`,
    );
    // FAILS BEFORE THE FIX for all of them: the row was created by the first
    // step that reported TOKENS, so a turn whose provider reported none left no
    // row and finishWorkflowRun (an UPDATE) had nothing to close. The operator's
    // automation_runs table was completely empty.
    assert.ok(
      src.includes('"turn.started"') && src.includes("openWorkflowRun"),
      `${key} opens no run row on turn.started — an invocation with no token usage leaves no history`,
    );
    passed++;
  }
  console.log(`  ok   ${keys.length} subagents open a run row per invocation and file it under their own key`);

  const usage = readFileSync("agent/lib/workflow-usage.ts", "utf8");
  check(
    "a missing workflows row is a warning naming the fix, not silence",
    usage.includes("fde:seed-subagent-rows"),
  );
  // A pack's workflows row is seeded AFTER the deploy that introduced the
  // subagent, so a permanently cached miss meant seeding fixed nothing until
  // the instance was recycled.
  check("a lookup MISS expires", usage.includes("NEGATIVE_TTL_MS"));
}

console.log(`\ntest-subagent-delivery: ${passed} assertions passed`);
