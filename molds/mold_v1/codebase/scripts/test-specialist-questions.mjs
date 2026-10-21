/**
 * "A subagent's question does not keep context of the subagent tag or ID… the answer is to the subagent… Instead, it
 * just writes it as a user input in the main chat thread" (mold_v1-234).
 *
 * THE CAUSE, read off recorded streams. eve forwards a delegated specialist's question onto the main thread as a bare
 * `input.requested`: the hook payload it is built from names the delegation (`callId`, `subagentName`,
 * `childSessionId`), and `emitProxiedInputRequest` dropped all three. Nothing on the main thread records the answer
 * either (it goes to the specialist by request id). So the chat could not name the asker, and it rendered the reply as
 * the person's own "Your answer" bubble in the main thread, with nothing to say whom it went to, before or after a
 * reload.
 *
 * WHAT THIS HOLDS (lib/specialist-questions.ts, patches/eve+0.25.1.patch):
 *   1. The patched runtime's forwarded question carries `data.subagent` (a stream recorded by
 *      scripts/test-specialist-detach.mjs "asks" against the real runtime), and the chat attributes it from that.
 *   2. A stream recorded before the patch is attributed only when one delegation could have asked; two live
 *      delegations leave it unattributed (today's rendering).
 *   3. The reply is PERSISTED with the specialist and its run: the chat's `client.input.responded` marker carries
 *      `data.subagent`, survives the server's marker cap, and alone attributes the reply on reload.
 *   4. The specialist's progress after the reply, and whom the composer is answering.
 *   5. Where the reply renders: with the specialist's question while it works, under its delegation card after.
 *
 * Run:  npm run test:specialist-questions
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import { MARKERS_MAX_BYTES_SERVER, capMarkers, isPersistedMarker, withResponses, withSessionEpochs } from "../lib/chat-turn-state.ts";
import {
  answerMarker,
  answeringWhom,
  delegationProgress,
  progressIsLive,
  delegationCards,
  placeSpecialistAnswers,
  placeSteeringNotes,
  readAsker,
  respondedInputMarkers,
  specialistAskers,
  withoutPlacedAnswers,
} from "../lib/specialist-questions.ts";
import { noteForModel, notRunningMessage, validNote, STEER_NOTE_MAX_CHARS } from "../lib/steering-client.ts";

let passed = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? "" : `\n    ${JSON.stringify(detail).slice(0, 600)}`}`);
  passed++;
  console.log(`  ok   ${label}`);
};
const load = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const project = (events) => {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  return data.messages ?? [];
};

const ATTRIBUTED = load("scripts/fixtures/specialist-question/asks-attributed.ndjson");
const UNPATCHED = load("scripts/fixtures/specialist-detach/asks-main-thread.ndjson");
const ONE_CHILD = load("scripts/fixtures/subagent-delivery/child-parks-then-answered.ndjson");

console.log("\n1. The forwarded question names the specialist that asked it (patched runtime, recorded)");
{
  const question = ATTRIBUTED.find((e) => e.type === "input.requested");
  const beta = ATTRIBUTED.find((e) => e.type === "subagent.called" && e.data.name === "beta");
  check("the stream event carries data.subagent", Boolean(question?.data?.subagent), question?.data);
  check(
    "…naming beta's delegation: its call id, its name, its run (child session)",
    question.data.subagent.callId === beta.data.callId &&
      question.data.subagent.name === "beta" &&
      question.data.subagent.childSessionId === beta.data.childSessionId,
    question.data.subagent,
  );
  const askers = specialistAskers(ATTRIBUTED);
  const rid = question.data.requests[0].requestId;
  const a = askers.get(rid);
  check("the chat attributes the question to beta from the event", a?.name === "beta" && a.callId === beta.data.callId && a.source === "event", a);
  check("…with its run", a.childSessionId === beta.data.childSessionId);
  check("nothing else on the stream is taken for a specialist's question", askers.size === 1);
}

console.log("\n2. Before the patch: attributed only when it cannot be anybody else");
{
  const question = UNPATCHED.find((e) => e.type === "input.requested");
  // FAILS BEFORE THE FIX on a stream like this one: there is nothing to read.
  check("an unpatched stream's question carries no attribution (what the chat used to get)", question.data.subagent === undefined);
  const askers = specialistAskers(UNPATCHED);
  check("two delegations live when it was asked (alpha and beta): left unattributed, rendered as before", askers.size === 0, [...askers]);
  const one = specialistAskers(ONE_CHILD);
  const rid = ONE_CHILD.find((e) => e.type === "input.requested").data.requests[0].requestId;
  check("one delegation live: attributed to it, marked inferred", one.get(rid)?.name === "configuration" && one.get(rid)?.source === "inferred", one.get(rid));
  const own = [
    { type: "turn.started", data: { turnId: "t" } },
    { type: "actions.requested", data: { actions: [{ callId: "own_q", kind: "tool-call" }] } },
    { type: "input.requested", data: { requests: [{ requestId: "own_q", action: { callId: "own_q" } }] } },
  ];
  check("the main agent's own question is never a specialist's", specialistAskers(own).size === 0);
  check("a malformed data.subagent is ignored, not trusted", readAsker({ callId: 3, name: "" }, "event") === undefined);
}

console.log("\n3. The reply is persisted WITH the specialist and its run, and a reload reads it back");
{
  const question = ATTRIBUTED.find((e) => e.type === "input.requested");
  const rid = question.data.requests[0].requestId;
  const askers = specialistAskers(ATTRIBUTED);
  // The chat's own answer, as respondToInput records it, folded into the view as agent-chat does.
  const upToAnswer = ATTRIBUTED.slice(0, ATTRIBUTED.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2"));
  const answers = { [rid]: { requestId: rid, text: "Use FY25" } };
  const view = withResponses(project(upToAnswer), answers);
  const markers = respondedInputMarkers(view, answers, askers);
  check("one answered-input marker", markers.length === 1, markers);
  check("…of eve's own kind, so the question stays answered on reload", markers[0].type === "client.input.responded" && isPersistedMarker(markers[0]));
  check(
    "…carrying whom the reply went to: beta, its delegation's call id and its run",
    markers[0].data.subagent?.name === "beta" &&
      markers[0].data.subagent.callId === askers.get(rid).callId &&
      markers[0].data.subagent.childSessionId === askers.get(rid).childSessionId,
    markers[0].data,
  );
  check("…and the reply itself", markers[0].data.responses[0].text === "Use FY25");
  const stored = capMarkers(markers, MARKERS_MAX_BYTES_SERVER);
  check("the server's marker cap keeps the attribution", JSON.stringify(stored) === JSON.stringify(markers), stored);

  // Reload with ONLY the persisted marker to say who it was (a stream recorded before the patch, two live
  // delegations): the reply is still filed under beta.
  const bare = UNPATCHED.map((e) => e);
  const bareRid = bare.find((e) => e.type === "input.requested").data.requests[0].requestId;
  const marker = answerMarker({ requestId: bareRid, optionId: "fy26" }, { callId: "call_000000000000000000000101", name: "beta", childSessionId: "wrun_x", source: "inferred" });
  const reloaded = specialistAskers([...bare, marker]);
  check("on reload the marker alone attributes the reply", reloaded.get(bareRid)?.name === "beta" && reloaded.get(bareRid)?.source === "marker", reloaded.get(bareRid));
  const reprojected = project([...bare, marker]);
  const part = reprojected.flatMap((m) => m.parts).find((p) => p.toolMetadata?.eve?.inputRequest?.requestId === bareRid);
  check("…and eve's reducer still reads it as the answer", part?.toolMetadata?.eve?.inputResponse?.optionId === "fy26", part?.toolMetadata?.eve);
  const plain = answerMarker({ requestId: "r1", text: "x" }, undefined);
  check("an unattributed reply's marker is exactly what it was before (no subagent key)", !("subagent" in plain.data) && plain.data.responses[0].requestId === "r1");
}

console.log("\n4. After the reply: the specialist's progress, and whom the composer is answering");
{
  const beta = ATTRIBUTED.find((e) => e.type === "subagent.called" && e.data.name === "beta").data.callId;
  const rest = ATTRIBUTED.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2");
  const before = ATTRIBUTED.slice(0, rest);
  check("while beta works on the reply: 'reports later' (still live)", delegationProgress(before, beta) === "reports-later" && progressIsLive("reports-later"));
  check("once its result is in: finished", delegationProgress(ATTRIBUTED, beta) === "finished" && !progressIsLive("finished"));
  check("a Stop the chat recorded reads as stopped", delegationProgress(before, beta, new Map([[beta, "beta"]])) === "stopped");
  const failed = [{ type: "subagent.called", data: { callId: "c", name: "x" } }, { type: "action.result", data: { result: { callId: "c", kind: "subagent-result", isError: true, output: "boom" } } }];
  check("an error result reads as failed", delegationProgress(failed, "c") === "failed");
  const askers = specialistAskers(ATTRIBUTED);
  const rid = ATTRIBUTED.find((e) => e.type === "input.requested").data.requests[0].requestId;
  check("one open question of beta's: the composer is answering beta", answeringWhom([rid], askers)?.name === "beta");
  check("an open question nobody can attribute: no label (today's composer)", answeringWhom([rid, "unknown"], askers) === undefined);
  const two = new Map([
    ["q1", { callId: "a", name: "alpha", source: "event" }],
    ["q2", { callId: "b", name: "beta", source: "event" }],
  ]);
  check("two specialists asking at once: no single 'Answering'", answeringWhom(["q1", "q2"], two) === undefined);
}

console.log("\n5. Where the reply renders: on the specialist's card, never as a main-thread message");
{
  const askers = specialistAskers(ATTRIBUTED);
  const rid = ATTRIBUTED.find((e) => e.type === "input.requested").data.requests[0].requestId;
  const beta = askers.get(rid).callId;
  const answers = { [rid]: { requestId: rid, text: "Use FY25" } };
  const rest = ATTRIBUTED.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2");
  const live = ATTRIBUTED.slice(0, rest);
  const placedLive = placeSpecialistAnswers({ messages: withResponses(project(live), answers), askers, events: live });
  const a = placedLive.get(rid);
  check("while beta works on it: at the tail, under the question it answers", a?.where === "tail" && a.progress === "reports-later", a);
  check("…named, with the question, the reply and beta's delegation", a.name === "beta" && a.callId === beta && /fiscal year/.test(a.prompt) && a.reply === "Use FY25");
  const placedDone = placeSpecialistAnswers({ messages: withResponses(project(ATTRIBUTED), answers), askers, events: ATTRIBUTED });
  check("once beta has handed back: under beta's delegation card, finished", placedDone.get(rid)?.where === "card" && placedDone.get(rid)?.progress === "finished", placedDone.get(rid));
  const noCard = placeSpecialistAnswers({
    messages: withResponses(project(ATTRIBUTED), answers).map((m) => ({ ...m, parts: m.parts.filter((p) => !String(p.toolName ?? "").startsWith("eve:subagent:")) })),
    askers,
    events: ATTRIBUTED,
  });
  check("no delegation card on screen (a transcript that starts after it): in place", noCard.get(rid)?.where === "inplace");
  const option = placeSpecialistAnswers({ messages: withResponses(project(ATTRIBUTED), { [rid]: { requestId: rid, optionId: "fy26" } }), askers, events: ATTRIBUTED });
  check("a picked option reads as its label", option.get(rid)?.reply === "FY26");
  const unattributed = placeSpecialistAnswers({ messages: withResponses(project(UNPATCHED), answers), askers: specialistAskers(UNPATCHED), events: UNPATCHED });
  check("an unattributed reply is not placed: it renders as it did before", unattributed.size === 0);
  // mold_v1-296: the same request as an APPROVAL beta asked (allow a write) is relayed plumbing, not a reply: on beta's
  // card while beta works, never a row of the main thread; at the tail only when no card is on screen.
  const asApproval = (msgs) =>
    JSON.parse(JSON.stringify(msgs)).map((m) => ({
      ...m,
      parts: m.parts.map((p) =>
        p.toolMetadata?.eve?.inputRequest?.requestId === rid
          ? { ...p, toolName: "write_file", toolMetadata: { eve: { ...p.toolMetadata.eve, inputRequest: { ...p.toolMetadata.eve.inputRequest, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] }, inputResponse: { requestId: rid, optionId: "approve" } } } }
          : p,
      ),
    }));
  const approvedLive = placeSpecialistAnswers({ messages: asApproval(withResponses(project(live), answers)), askers, events: live });
  check("an approval beta asked, answered while beta works: on beta's card, marked an approval, with its part", approvedLive.get(rid)?.where === "card" && approvedLive.get(rid)?.approval === true && approvedLive.get(rid)?.part?.toolName === "write_file", approvedLive.get(rid));
  const approvedNoCard = placeSpecialistAnswers({
    messages: asApproval(withResponses(project(live), answers)).map((m) => ({ ...m, parts: m.parts.filter((p) => !String(p.toolName ?? "").startsWith("eve:subagent:")) })),
    askers,
    events: live,
  });
  check("…with no card on screen, at the tail while beta works", approvedNoCard.get(rid)?.where === "tail");
}

console.log("\n6. A placed answer is not also in its message (the message neither shows it nor counts it)");
{
  const askers = specialistAskers(ATTRIBUTED);
  const rid = ATTRIBUTED.find((e) => e.type === "input.requested").data.requests[0].requestId;
  const answers = { [rid]: { requestId: rid, text: "Use FY25" } };
  const rest = ATTRIBUTED.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2");
  const view = withResponses(project(ATTRIBUTED.slice(0, rest)), answers);
  const placed = placeSpecialistAnswers({ messages: view, askers, events: ATTRIBUTED.slice(0, rest) });
  const shown = withoutPlacedAnswers(view, placed);
  const has = (msgs) => msgs.some((m) => m.parts.some((p) => p.toolMetadata?.eve?.inputRequest?.requestId === rid));
  check("the answered question is in eve's message…", has(view));
  check("…and not in the message the chat renders (it is on beta's card)", !has(shown));
  check("messages it does not touch are the same objects", shown.filter((m, i) => m === view[i]).length === view.length - 1);
  check("nothing placed: the transcript is returned as it is", withoutPlacedAnswers(view, new Map()) === view);
  const inplace = new Map([[rid, { where: "inplace" }]]);
  check("an answer placed in place stays in its message", has(withoutPlacedAnswers(view, inplace)));
  // mold_v1-296: eve relays a specialist's approval on the DELEGATION part itself (approval-requested, then answered).
  // Placing that answer on the card must never take the card itself out of the thread.
  const card = {
    type: "dynamic-tool",
    toolName: "eve:subagent:research",
    toolCallId: "call_wait",
    state: "input-available",
    input: { message: "brief" },
    toolMetadata: { eve: { inputRequest: { requestId: "req_open", prompt: "Publish?", options: [{ id: "approve", label: "Approve" }] }, inputResponse: { requestId: "req_open", optionId: "approve" } } },
  };
  const withCard = [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "asked" }, card] }];
  const kept = withoutPlacedAnswers(withCard, new Map([["req_open", { where: "card" }]]));
  check("an answered approval carried on a delegation part: the delegation card stays in the thread", kept[0].parts.some((p) => p.toolCallId === "call_wait"), kept[0].parts);
}

console.log("\n7. Notes to a running specialist (mold_v1-235): where they show and how they read");
{
  const beta = ATTRIBUTED.find((e) => e.type === "subagent.called" && e.data.name === "beta").data.callId;
  const rest = ATTRIBUTED.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2");
  const notes = [
    { id: "n1", callId: beta, text: "focus on FY24 only", status: "delivered" },
    { id: "n2", callId: beta, text: "skip the annex", status: "pending" },
    { id: "n3", callId: "call_unknown", text: "for nobody", status: "pending" },
  ];
  const live = ATTRIBUTED.slice(0, rest);
  const whileWorking = placeSteeringNotes({ notes, events: live, cards: delegationCards(project(live)) });
  // mold_v1-296: a note is a relay to the specialist, not a row of the main thread: on its card while it works too.
  check("while beta works: its notes on its card, named, with their state; a note for no delegation on this stream is dropped", whileWorking.length === 2 && whileWorking.every((n) => n.where === "card" && n.name === "beta" && n.progress === "reports-later") && whileWorking[1].status === "pending", whileWorking);
  const after = placeSteeringNotes({ notes, events: ATTRIBUTED, cards: delegationCards(project(ATTRIBUTED)) });
  check("once beta has handed back: under its delegation card, finished", after.every((n) => n.where === "card" && n.progress === "finished"), after);
  check("no delegation card on screen: they stay at the tail", placeSteeringNotes({ notes, events: ATTRIBUTED, cards: new Set() }).every((n) => n.where === "tail"));
  check("no notes: nothing", placeSteeringNotes({ notes: [], events: ATTRIBUTED, cards: new Set() }).length === 0);
  check("the specialist reads a note as from its author, while it worked", noteForModel("pat@example.test", "skip the annex") === "Note from pat@example.test while you were working: skip the annex");
  check("…and as from the person when the author is unknown", noteForModel(null, "x").startsWith("Note from the person you are working for while you were working:"));
  check("a finished specialist's refusal says what to do instead", /has already finished/.test(notRunningMessage("Beta")) && /Ask the main agent/.test(notRunningMessage("Beta")));
  check("a note is non-empty text up to the limit", validNote("x") && !validNote("   ") && !validNote(42) && !validNote("y".repeat(STEER_NOTE_MAX_CHARS + 1)));
}

console.log(`\n${passed} checks passed`);
