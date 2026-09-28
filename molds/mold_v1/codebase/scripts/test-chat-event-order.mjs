/**
 * "The thinking stream continues above the subagent segment even though it
 * should be below the subagent section."
 *
 * THE DEFECT. After the orchestrator delegates to a specialist, eve resumes the
 * turn when the specialist's result arrives — and the resumed half numbers its
 * steps from 0 AGAIN (`step.started {turnId: "turn_0", stepIndex: 0}` for a step
 * that already completed; see the fixtures). eve's reducer keys a turn's
 * reasoning and text by step (`reasoning:<stepIndex>`, `text:<stepIndex>`) and
 * `upsertPart` replaces a part where it already is. So the thinking after the
 * delegation streamed INTO the thinking block above the specialist's card, and
 * a sentence written before delegating was overwritten by the final answer.
 *
 * THE FIXTURES ARE REAL: scripts/fixtures/event-order/*.ndjson were recorded
 * from this repo's agent under `eve dev` with a scripted model that streams
 * reasoning (README there).
 *
 * What is checked, on the chat's own reducer (`withSessionEpochs(
 * defaultMessageReducer())`, the one agent-chat.tsx mounts):
 *   1. a full fold (a reopened / replayed transcript) puts every part in event
 *      order: thinking, the card, the later thinking, the answer;
 *   2. every PREFIX of the stream (what a live turn shows frame by frame) keeps
 *      the earlier thinking where it was and opens the later one below the card;
 *   3. the same holds when the fold is resumed mid-stream from an earlier
 *      projection (the live tail folded onto the store's data), after the
 *      snapshot compaction, and across a second eve session;
 *   4. what must NOT change: a retried step still rewrites itself in place, and
 *      transcripts with no delegation project exactly as eve's reducer alone.
 *
 * Run:  npm run test:chat-event-order
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import { compactTranscript } from "../lib/chat-snapshot.ts";
import { projectAttached, turnFinished, withSessionEpochs } from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, detail ? `${label}\n      got: ${detail}` : label);
  passed++;
  console.log(`  ok   ${label}`);
};

const loadFile = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const load = (name) => loadFile(`scripts/fixtures/event-order/${name}.ndjson`);

const fold = (events, reducer = withSessionEpochs(defaultMessageReducer()), data = reducer.initial()) => {
  for (const e of events) data = reducer.reduce(data, e);
  return data;
};

/** What a person sees in each assistant message, top to bottom (the parts AgentMessage renders). */
function visible(message) {
  const out = [];
  for (const p of message.parts) {
    if (p.type === "reasoning" && p.text?.trim()) out.push(`reasoning:${p.text.trim().split(" ")[0]}`);
    else if (p.type === "text" && p.text?.trim()) out.push(`text:${p.text.trim().split(" ")[0]}`);
    else if (p.type === "dynamic-tool") out.push(p.toolName.startsWith("eve:subagent:") ? "subagent" : `tool:${p.toolName}`);
  }
  return out;
}
const assistantView = (data) => (data.messages ?? []).filter((m) => m.role === "assistant").map(visible);
const show = (x) => JSON.stringify(x);

const REASONING = load("reasoning-around-subagent");
const SAY = load("text-before-subagent");

console.log("\n0. The fixtures carry the eve behaviour this is about");
for (const [name, events] of [["reasoning-around-subagent", REASONING], ["text-before-subagent", SAY]]) {
  const result = events.findIndex((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result");
  const resumed = events.findIndex((e, i) => i > result && e.type === "step.started");
  check(
    `${name}: after the specialist's result the turn starts step ${events[resumed]?.data?.stepIndex} again, which already completed`,
    result > 0 &&
      events[resumed]?.data?.stepIndex === 0 &&
      events.some((e, i) => i < result && e.type === "step.completed" && e.data?.stepIndex === 0),
  );
}

console.log("\n1. A replayed transcript shows every part in the order it happened");
{
  const view = assistantView(fold(REASONING));
  check(
    "thinking -> specialist card -> later thinking -> answer",
    show(view) === show([["reasoning:ORCH-THINK-1", "subagent", "reasoning:ORCH-THINK-2", "text:FINAL-ANSWER"]]),
    show(view),
  );
  const said = assistantView(fold(SAY));
  check(
    "a sentence written before delegating survives, above the card; the answer is below it",
    show(said) ===
      show([["reasoning:ORCH-THINK-1", "text:PRE-DELEGATION", "subagent", "reasoning:ORCH-THINK-2", "text:FINAL-ANSWER"]]),
    show(said),
  );
  const parts = fold(REASONING).messages.find((m) => m.role === "assistant").parts;
  const reasoning = parts.filter((p) => p.type === "reasoning");
  check(
    "each thinking block holds its own text in full",
    reasoning.length === 2 &&
      reasoning[0].text === "ORCH-THINK-1 I should ask the configuration specialist. It knows the settings. " &&
      reasoning[1].text === "ORCH-THINK-2 The specialist answered. Now I summarise it. ",
    show(reasoning.map((p) => p.text)),
  );
  check("both thinking blocks end done (no spinner left behind)", reasoning.every((p) => p.state === "done"));
}

console.log("\n2. A live turn, frame by frame: the later thinking opens BELOW the card");
for (const [name, events] of [["reasoning-around-subagent", REASONING], ["text-before-subagent", SAY]]) {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  let firstThinking = null;
  let bad = null;
  for (let i = 0; i < events.length && !bad; i++) {
    data = reducer.reduce(data, events[i]);
    const [view] = assistantView(data);
    if (!view) continue;
    const card = view.indexOf("subagent");
    const t1 = view.indexOf("reasoning:ORCH-THINK-1");
    const t2 = view.indexOf("reasoning:ORCH-THINK-2");
    const reasoning = data.messages.find((m) => m.role === "assistant").parts.filter((p) => p.type === "reasoning");
    if (card >= 0 && firstThinking === null) firstThinking = reasoning[0]?.text;
    if (card >= 0 && t1 !== 0) bad = `event ${i}: the first thinking left the top: ${show(view)}`;
    else if (t2 >= 0 && !(card >= 0 && t2 > card)) bad = `event ${i}: later thinking not below the card: ${show(view)}`;
    else if (card >= 0 && reasoning[0]?.text !== firstThinking) bad = `event ${i}: the first thinking was rewritten`;
  }
  check(`${name}: at every one of ${events.length} events, nothing streams above the card`, bad === null, bad ?? "");
}

console.log("\n3. The same projection however it is reached");
{
  const whole = fold(REASONING);
  const expected = show(whole.messages);
  let splitsAgree = true;
  for (let cut = 1; cut < REASONING.length; cut++) {
    // The live tail is folded ONTO the store's projection (agent-chat `view`,
    // projectAttached); the renumbering state must ride along on that object.
    const reducer = withSessionEpochs(defaultMessageReducer());
    const base = fold(REASONING.slice(0, cut), reducer);
    const joined = projectAttached(reducer, base, REASONING.slice(cut));
    if (show(joined.messages) !== expected) {
      splitsAgree = false;
      console.log(`      differs when resumed at event ${cut}`);
    }
  }
  check("a fold resumed at any event equals the full fold", splitsAgree);
  check(
    "the snapshot's compacted prefix projects the same transcript",
    show(fold(compactTranscript(REASONING)).messages) === expected &&
      show(fold(compactTranscript(SAY)).messages) === show(fold(SAY).messages),
  );
  // A second eve session: the first ends for good, a new one starts at turn_0 again.
  const second = REASONING.map((e) => JSON.parse(JSON.stringify(e)));
  for (const e of second) if (e.data?.message === "DELEGATE: what are the settings?") e.data.message = "again";
  const twoSessions = [...REASONING, { type: "session.completed", data: {} }, ...second];
  const views = assistantView(fold(twoSessions));
  const one = ["reasoning:ORCH-THINK-1", "subagent", "reasoning:ORCH-THINK-2", "text:FINAL-ANSWER"];
  check("a second session's turn_0 gets its own, correctly ordered message", show(views) === show([one, one]), show(views));
  check(
    "#52: the turn still reads finished only at its terminal (end-of-answer row)",
    turnFinished({ storeBusy: false, events: REASONING, pendingInputs: 0 }) === true &&
      turnFinished({
        storeBusy: false,
        events: REASONING.slice(0, REASONING.findIndex((e) => e.type === "turn.completed")),
        pendingInputs: 0,
      }) === false,
  );
}

console.log("\n4. What must not change");
{
  // eve replays a whole turn after a step throws: session.started -> turn.started
  // -> message.received again, same ids. That replay must rewrite in place.
  const firstStep = REASONING.slice(0, REASONING.findIndex((e) => e.type === "actions.requested"));
  const prologue = REASONING.slice(0, 3);
  const retried = [...firstStep, ...prologue, ...firstStep.slice(3)];
  const view = assistantView(fold(retried));
  check("a turn replayed after a throw still writes over its own thinking", show(view) === show([["reasoning:ORCH-THINK-1"]]), show(view));
  // A step that never completed and starts again (no new turn) keeps its index.
  const again = [...firstStep, firstStep[3], ...firstStep.slice(4)];
  check("a step started twice without completing stays one block", show(assistantView(fold(again))) === show([["reasoning:ORCH-THINK-1"]]));

  // Every other recorded transcript in the repo. Those whose turn never
  // restarts a step project EXACTLY as eve's reducer alone does; those that do
  // (a specialist that completed or failed, then the parent's reply) show the
  // same parts in the same order — they had nothing above the card for the
  // resumed step to collide with — only under their own step number.
  const restarts = (events) => {
    const completed = new Set();
    for (const e of events) {
      const key = `${e.data?.turnId}:${e.data?.stepIndex}`;
      if (e.type === "step.completed") completed.add(key);
      if (e.type === "step.started" && completed.has(key)) return true;
    }
    return false;
  };
  const exact = [];
  const reordered = [];
  const differs = [];
  for (const dir of ["subagent-delivery", "approval-park", "buffered-turns"]) {
    for (const file of readdirSync(`scripts/fixtures/${dir}`).filter((f) => f.endsWith(".ndjson"))) {
      const events = loadFile(`scripts/fixtures/${dir}/${file}`);
      const plain = fold(events, defaultMessageReducer());
      const ours = fold(events);
      const name = `${dir}/${file}`;
      if (!restarts(events)) (show(plain.messages) === show(ours.messages) ? exact : differs).push(name);
      else (show(assistantView(plain)) === show(assistantView(ours)) ? reordered : differs).push(name);
    }
  }
  check(`${exact.length} recorded transcripts without a restarted step project byte-for-byte as before`, exact.length > 0 && differs.length === 0, show(differs));
  check(`${reordered.length} with one (a delegation that returned) read the same, card then reply`, reordered.length > 0 && differs.length === 0, show(differs));
  check("nothing is added to what is persisted (the state is not enumerable)", !Object.keys(fold(REASONING)).some((k) => k.startsWith("~")));
}

console.log(`\n${passed} checks passed`);
