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
import { continuationTurnId, projectAttached, turnFinished, withResumedSteps, withSessionEpochs } from "../lib/chat-turn-state.ts";

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
  const named = [];
  const differs = [];
  // A parked specialist's hand-back arrives with `turnId: ""` (section 6): its
  // reply is the same, in its own message named `turn_<sequence>`.
  const handsBack = (events) => events.some((e) => e.data?.turnId === "");
  for (const dir of ["subagent-delivery", "approval-park", "buffered-turns"]) {
    for (const file of readdirSync(`scripts/fixtures/${dir}`).filter((f) => f.endsWith(".ndjson"))) {
      const events = loadFile(`scripts/fixtures/${dir}/${file}`);
      const plain = fold(events, defaultMessageReducer());
      const ours = fold(events);
      const name = `${dir}/${file}`;
      if (handsBack(events)) {
        const same = show(assistantView(plain)) === show(assistantView(ours));
        const unnamed = ours.messages.some((m) => m.metadata?.turnId === "");
        (same && !unnamed ? named : differs).push(name);
      } else if (!restarts(events)) (show(plain.messages) === show(ours.messages) ? exact : differs).push(name);
      else (show(assistantView(plain)) === show(assistantView(ours)) ? reordered : differs).push(name);
    }
  }
  check(`${exact.length} recorded transcripts without a restarted step project byte-for-byte as before`, exact.length > 0 && differs.length === 0, show(differs));
  check(`${reordered.length} with one (a delegation that returned) read the same, card then reply`, reordered.length > 0 && differs.length === 0, show(differs));
  check(`${named.length} with a parked specialist's hand-back read the same, the hand-back under its own turn id`, named.length > 0 && differs.length === 0, show(differs));
  check("nothing is added to what is persisted (the state is not enumerable)", !Object.keys(fold(REASONING)).some((k) => k.startsWith("~")));
}

console.log("\n5. The Control Panel's rail folds a specialist's own stream the same way");
{
  // A specialist is an eve session like any other: when IT delegates (or is
  // resumed), eve restarts its step count exactly as it does the orchestrator's.
  // The rail (app/_components/cockpit.tsx, useChildFeeds) folds that stream
  // event by event into a feed; this is its fold, read from its source.
  const cockpit = readFileSync("app/_components/cockpit.tsx", "utf8");
  check(
    "the rail mounts the chat's reducer: withSessionEpochs(defaultMessageReducer())",
    /const childReducer = withSessionEpochs\(defaultMessageReducer\(\)\);/.test(cockpit),
  );
  check(
    "each event is folded onto the feed's own previous projection, never a rebuilt { messages }",
    /childReducer\.reduce\(\s*f\.transcript \?\? childReducer\.initial\(\)/.test(cockpit) &&
      !/childReducer\.reduce\(\s*\{\s*messages:/.test(cockpit),
  );
  check(
    "a re-opened feed continues from where its fold stopped (no replay onto a full transcript)",
    /let cursor = cursors\.current\[sid\] \?\? 0;/.test(cockpit) && /cursors\.current\[sid\] = cursor;/.test(cockpit),
  );
  // The rail's fold, as written there: the feed keeps `transcript`, messages are read from it.
  const railFold = (events, reducer) => {
    let feed = { messages: [], transcript: undefined };
    const frames = [];
    for (const event of events) {
      const transcript = reducer.reduce(feed.transcript ?? reducer.initial(), event);
      feed = { ...feed, transcript, messages: transcript.messages };
      frames.push(feed.messages);
    }
    return frames;
  };
  const bodyOf = (messages) => assistantView({ messages });
  for (const [name, events] of [["reasoning-around-subagent", REASONING], ["text-before-subagent", SAY]]) {
    const frames = railFold(events, withSessionEpochs(defaultMessageReducer()));
    check(
      `${name}: the rail's detail reads thinking, card, later thinking, answer`,
      show(bodyOf(frames.at(-1))) === show(assistantView(fold(events))),
      show(bodyOf(frames.at(-1))),
    );
    const bad = frames.findIndex((m) => {
      const [view] = bodyOf(m);
      if (!view) return false;
      const card = view.indexOf("subagent");
      const t2 = view.indexOf("reasoning:ORCH-THINK-2");
      return t2 >= 0 && !(card >= 0 && t2 > card);
    });
    check(`${name}: at no frame does the later thinking stream above the card in the rail`, bad === -1, `frame ${bad}`);
  }
  // What the rail did before: eve's reducer alone, folded onto a rebuilt { messages } each event.
  const before = (events, reducer) => {
    let messages = [];
    for (const e of events) messages = reducer.reduce({ messages }, e).messages;
    return assistantView({ messages });
  };
  check(
    "before: the rail showed the later thinking ABOVE the card (the #67 defect, in the Control Panel)",
    show(before(REASONING, defaultMessageReducer())) === show([["reasoning:ORCH-THINK-2", "subagent", "text:FINAL-ANSWER"]]),
    show(before(REASONING, defaultMessageReducer())),
  );
  check(
    "and wrapping alone is not enough: a rebuilt { messages } drops the wrapper's state every event",
    show(before(REASONING, withSessionEpochs(defaultMessageReducer()))) !== show(assistantView(fold(REASONING))),
  );
}

console.log("\n6. A parked specialist's hand-back (turnId \"\") is its own turn, in stream order");
{
  const TWO = load("two-parked-handbacks");
  const handBacks = TWO.filter((e) => e.type === "step.started" && e.data?.turnId === "");
  check(
    "the recording: two hand-backs, each with turnId \"\", at sequences 1 and 3 (turn_1 and turn_3 are never sent)",
    show(handBacks.map((e) => e.data.sequence)) === show([1, 3]) &&
      !TWO.some((e) => e.data?.turnId === "turn_1" || e.data?.turnId === "turn_3") &&
      TWO.some((e) => e.data?.turnId === "turn_2"),
  );
  const said = (data) =>
    data.messages.map((m) => {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text.split(" ")[0]).join("+");
      return `${m.role}:${text || m.parts.filter((p) => p.type === "dynamic-tool").length + "tools"}`;
    });
  const expected = ["user:MSG-1", "assistant:2tools", "assistant:ORCH-CONTINUE", "user:MSG-3", "assistant:2tools", "assistant:ORCH-CONTINUE"];
  const questionIn = (data) =>
    data.messages
      .filter((m) => m.parts.some((p) => p.type === "dynamic-tool" && p.toolName === "ask_question"))
      .map((m) => `${m.metadata?.turnId}:${m.parts.filter((p) => p.toolName === "ask_question").length}`);
  check(
    "each specialist's question card sits in the turn that delegated to it (the second is sent with the child's turn_0)",
    show(questionIn(fold(TWO))) === show(["turn_0:1", "turn_2:1"]) &&
      TWO.filter((e) => e.type === "input.requested").every((e) => e.data.turnId === "turn_0"),
    show(questionIn(fold(TWO))),
  );
  check("each hand-back reads under the message that asked for it", show(said(fold(TWO))) === show(expected), show(said(fold(TWO))));
  check(
    "named as eve numbers turns: turn_1 and turn_3",
    show(fold(TWO).messages.map((m) => m.metadata?.turnId)) === show(["turn_0", "turn_0", "turn_1", "turn_2", "turn_2", "turn_3"]),
    show(fold(TWO).messages.map((m) => m.metadata?.turnId)),
  );
  let resumedAgree = true;
  for (let cut = 1; cut < TWO.length; cut++) {
    const reducer = withSessionEpochs(defaultMessageReducer());
    if (show(projectAttached(reducer, fold(TWO.slice(0, cut), reducer), TWO.slice(cut)).messages) !== show(fold(TWO).messages)) resumedAgree = false;
  }
  check("a fold resumed at any event, and the compacted snapshot, agree", resumedAgree && show(fold(compactTranscript(TWO)).messages) === show(fold(TWO).messages));
  const before = fold(TWO, withResumedSteps(defaultMessageReducer()));
  check(
    "before: the second hand-back was written into the FIRST one's message, and its question card into MSG-1's reply, both above MSG-3",
    show(said(before)) === show(["user:MSG-1", "assistant:3tools", "assistant:ORCH-CONTINUE+ORCH-CONTINUE", "user:MSG-3", "assistant:1tools"]),
    show(said(before)),
  );
  check(
    "an empty turn id without a sequence is left alone",
    continuationTurnId("", undefined) === "" && continuationTurnId("turn_4", 9) === "turn_4" && continuationTurnId("", 5) === "turn_5",
  );
}

console.log(`\n${passed} checks passed`);
