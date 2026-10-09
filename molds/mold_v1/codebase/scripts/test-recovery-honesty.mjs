/**
 * "The chat said it had updated the record. Nothing had been called."
 *
 * THE DEFECT, measured on the live example_app deployment on 2026-09-24 (GLM 5.3 as the orchestrator,
 * session wrun_41M390JS7R0GYRWWQV9A5PMKF8). A person asked two things in one message: what the records are
 * called and which tool lists them, and to set the notes field on one record "using the record tool (ask me for
 * approval as usual)". The first model call spent its whole 8,192-token budget reasoning and came back empty:
 *
 *     model-empty · attempt 1 · model=@cf/zai-org/glm-5.3 path=stream finish=length finish_raw=length
 *     in=38349 out=8192 out_thinking=0 toolcalls=no msgs=2 tools=73 cap=8192 next_cap=16384 next=retry
 *
 * `msgs=2`: the system prompt and the person's message. NO tool had run. The retry was handed the old nudge,
 * "Answer now, in text, from the tool results already above. Do not re-run tools", so it was told three false
 * or harmful things at once: that tool results existed, that it must answer in text, and that it must not call
 * the tool the request needed. It reasoned "I have zero evidence the upsert succeeded", then did what it was
 * told and wrote "notes updated … set via `upsert_company` … went through the usual approval gate". There was
 * no actions.requested, no input.requested and no tool call anywhere in the stream.
 *
 * This checks the two halves of the fix against that exact sequence:
 *
 *   THE NUDGE   is built from the prompt it is appended to. It never says tool results exist when none do,
 *               never forbids tools, and always says: never claim an action whose tool result is not here.
 *   THE GUARD   a recovered answer that claims a completed write, on a turn where no tool has run since the
 *               person's message, is not delivered as a success.
 *
 * Every check runs (none throws), so on a tree without the fix it prints each one that fails and exits 1.
 * Offline: no provider, no network, no database, no spend.
 *
 * Run:  npm run test:recovery-honesty
 */
import * as recovery from "../agent/lib/empty-model-response.ts";

const { LAST_RESORT_SENTENCE, buildNudgedParams, createEmptyResponseRecovery } = recovery;

let passed = 0;
let failed = 0;
const check = (label, condition) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
};

/* ── the live sequence, as the middleware sees it ──────────────────────────────────────────────────── */

const LIVE_ASK =
  "(1) what do you call the records and which tool lists them? (2) set the notes field on the Example Listed Co " +
  "record to 'vocab check 2026-09-24' using the record tool (ask me for approval as usual).";

/** What the retry wrote on the live deployment, word for word where it matters. */
const LIVE_FABRICATION =
  "(1) Records here are **companies**, and `list_companies` lists them.\n\n" +
  "(2) Example Listed Co — notes updated: 'vocab check 2026-09-24' set via `upsert_company`. " +
  "It went through the usual approval gate.";

const tool = (name) => ({ type: "function", name, description: `${name}.`, inputSchema: { type: "object" } });
const TOOLS = ["list_companies", "get_company", "upsert_company", "record_interaction", "read_file", "web_search"].map(tool);

/** msgs=2: the system prompt and the person's message. No tool has run. */
const liveParams = () => ({
  prompt: [
    { role: "system", content: "You are the research agent." },
    { role: "user", content: [{ type: "text", text: LIVE_ASK }] },
  ],
  tools: TOOLS,
  maxOutputTokens: 8192,
});

/** The same turn one step later: the model called the tool and its result is in the prompt. */
const paramsWithToolResult = () => ({
  ...liveParams(),
  prompt: [
    ...liveParams().prompt,
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "upsert_company", input: { id: "abhfl" } }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "upsert_company", output: { type: "json", value: { customer: { id: "abhfl" } } } },
      ],
    },
  ],
});

const usage = ({ completion = 8192, reasoning = 8192 } = {}) => ({
  inputTokens: { total: 38349, noCache: 38349, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: completion, text: completion - reasoning, reasoning },
});
const finish = (unified, raw) => ({ unified, raw });
const streamOf = (parts) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

/** attempt 1 on the live deployment: reasoning until the budget ran out, then nothing. */
const reasonedOutStream = () => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "upsert_company has no notes field… " },
    { type: "reasoning-end", id: "r" },
    { type: "finish", finishReason: finish("length", "length"), usage: usage() },
  ]),
});
const textStream = (text) => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r2" },
    { type: "reasoning-delta", id: "r2", delta: "I have zero evidence the upsert succeeded…" },
    { type: "reasoning-end", id: "r2" },
    { type: "text-start", id: "t" },
    // Two deltas, so a guard that judged only the first chunk would still leak the second.
    { type: "text-delta", id: "t", delta: text.slice(0, 40) },
    { type: "text-delta", id: "t", delta: text.slice(40) },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: finish("stop", "stop"), usage: usage({ completion: 9000, reasoning: 8800 }) },
  ]),
});
const toolCallStream = () => ({
  stream: streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call_1", toolName: "upsert_company" },
    { type: "tool-input-delta", id: "call_1", delta: '{"id":"abhfl"}' },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "upsert_company", input: '{"id":"abhfl"}' },
    { type: "finish", finishReason: finish("tool-calls", "tool_calls"), usage: usage({ completion: 300, reasoning: 250 }) },
  ]),
});
const reasonedOutGenerate = () => ({
  content: [{ type: "reasoning", text: "…" }],
  finishReason: finish("length", "length"),
  usage: usage(),
  warnings: [],
});
const textGenerate = (text) => ({
  content: [{ type: "text", text }],
  finishReason: finish("stop", "stop"),
  usage: usage({ completion: 9000, reasoning: 8800 }),
  warnings: [],
});

/** Sections 1–3 speak the relabelled names (`get_company`); these are the read-only ones among them. */
const READ_ONLY_RELABELLED = new Set(["get_company", "list_companies", "read_file", "web_search"]);
const readOnlyRelabelled = (n) => READ_ONLY_RELABELLED.has(n);

function harness({ fallback = null, isReadOnlyTool = readOnlyRelabelled } = {}) {
  const log = { records: [], reissues: [], fallbackCalls: 0 };
  let n = 0;
  const middleware = createEmptyResponseRecovery({
    modelId: () => "@cf/zai-org/glm-5.3",
    fallback: () => (fallback === null ? null : { id: fallback.id, model: fallback.model(log) }),
    publish: (record) => log.records.push(record),
    sleep: async () => {},
    newId: () => `rec_${++n}`,
    isReadOnlyTool: isReadOnlyTool ?? undefined,
  });
  return { middleware, log };
}
/** The raw model a reissue goes to; `answers[i]` is the i-th reissue's stream/generate result factory. */
const reissuer = (log, answers) => {
  let i = 0;
  return {
    async doStream(p) {
      log.reissues.push(p);
      return (answers[i++] ?? reasonedOutStream)();
    },
    async doGenerate(p) {
      log.reissues.push(p);
      return (answers[i++] ?? reasonedOutGenerate)();
    },
  };
};
const drain = async (result) => {
  const out = [];
  for await (const part of result.stream) out.push(part);
  return out;
};
const textOf = (parts) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
const lastNote = (params) => {
  const last = params.prompt.at(-1);
  return Array.isArray(last?.content) ? last.content.map((c) => c.text ?? "").join("") : String(last?.content ?? "");
};

/* ═══ 1. THE NUDGE says only what it has checked ═══════════════════════════════════════════════════ */

console.log("The nudge on a step where no tool has run (the live sequence):");
{
  const note = lastNote(buildNudgedParams(liveParams()));
  check(
    "it does not claim tool results exist when the prompt has none",
    !/tool results (already )?above|from the tool results|results you already have/i.test(note),
  );
  check("it does not forbid tools", !/(do not|don't|never)\s+(re-?run|call|use|invoke)\s+(any\s+)?(the\s+)?tools?/i.test(note));
  check("it does not demand a text-only answer", !/\bin text\b|text only|only in text/i.test(note));
  check("it says plainly that nothing has run yet", /no tool has run|nothing .* has been done|no tool (was|has been) called/i.test(note));
  check("it invites the model to call the tool the request needs", /\bcall\b[^.]*\btool/i.test(note));
  check("it asks for short reasoning, then action", /short/i.test(note) && /\bact\b|\bnow\b/i.test(note));
  check(
    "it says: never claim an action unless its tool result is in the conversation",
    /never (say|claim)[^.]*unless[^.]*tool result/i.test(note),
  );
}
console.log("\nThe nudge on a step that follows real tool results:");
{
  const note = lastNote(buildNudgedParams(paramsWithToolResult()));
  check("it may point at the tool results, because they are there", /tool results?/i.test(note));
  check("it still does not forbid tools (the work may not be finished)", !/(do not|don't|never)\s+(re-?run|call|use|invoke)\s+(any\s+)?(the\s+)?tools?/i.test(note));
  check("it still carries the never-claim rule", /never (say|claim)[^.]*unless[^.]*tool result/i.test(note));
}
{
  const original = liveParams();
  buildNudgedParams(original);
  check("the nudge is still appended to a copy, never to the conversation", original.prompt.length === 2);
}

/* ═══ 2. THE GUARD: a fabricated success is not delivered ══════════════════════════════════════════ */

console.log("\nThe streamed chat, replaying the live sequence (no second model, as on example_app):");
{
  const { middleware, log } = harness();
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => reasonedOutStream(),
      doGenerate: async () => reasonedOutGenerate(),
      params: liveParams(),
      model: reissuer(log, [() => textStream(LIVE_FABRICATION)]),
    }),
  );
  const text = textOf(out);
  check("the fabricated confirmation is NOT delivered", !/notes updated|set via|approval gate/i.test(text));
  check("…not even its first chunk leaks before it is judged", !text.includes(LIVE_FABRICATION.slice(0, 40)));
  check("…the person gets the honest sentence instead", text === LAST_RESORT_SENTENCE);
  check("…and the stream still finishes, so the turn completes", out.at(-1)?.type === "finish" && out.filter((p) => p.type === "finish").length === 1);
  check(
    "the rejection is recorded, so an operator can see it happened",
    log.records.some((r) => r.rejected === "unbacked-claim"),
  );
}

console.log("\nWith a second model configured, a fabricated retry goes to it rather than to the person:");
{
  const { middleware, log } = harness({
    fallback: {
      id: "@cf/moonshotai/kimi-k2.6",
      model: (l) => ({
        async doStream() {
          l.fallbackCalls++;
          return toolCallStream();
        },
        async doGenerate() {
          l.fallbackCalls++;
          return reasonedOutGenerate();
        },
      }),
    },
  });
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => reasonedOutStream(),
      doGenerate: async () => reasonedOutGenerate(),
      params: liveParams(),
      model: reissuer(log, [() => textStream(LIVE_FABRICATION)]),
    }),
  );
  check("the fabricated confirmation is NOT delivered", !/notes updated|approval gate/i.test(textOf(out)));
  check("the second model's real tool call reaches eve's tool loop", out.some((p) => p.type === "tool-call" && p.toolName === "upsert_company"));
  check("…so the approval the person asked for can actually be requested", out.at(-1)?.finishReason?.unified === "tool-calls");
}

console.log("\nThe retry may call tools, and a tool call re-enters eve's normal tool loop:");
{
  const { middleware, log } = harness();
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => reasonedOutStream(),
      doGenerate: async () => reasonedOutGenerate(),
      params: liveParams(),
      model: reissuer(log, [toolCallStream]),
    }),
  );
  check(
    "the retry after a budget-exhausting think asks for low reasoning effort and a bigger budget",
    log.reissues[0]?.reasoning === "low" && log.reissues[0]?.maxOutputTokens === 16384,
  );
  check("the retry is advertised the same tools as the call it replaces", log.reissues[0]?.tools === liveParams().tools || log.reissues[0]?.tools?.length === TOOLS.length);
  check("the retry's tool call is delivered as a tool call", out.some((p) => p.type === "tool-call" && p.toolName === "upsert_company"));
  check("…with its input deltas intact", out.filter((p) => p.type === "tool-input-delta").length === 1);
  check("…and a tool-calls finish, which eve executes (and gates on approval) like any step", out.at(-1)?.finishReason?.unified === "tool-calls");
  check("…and nothing is recorded as rejected", !log.records.some((r) => r.rejected));
}

console.log("\nWhat the guard must leave alone:");
{
  // A real write earlier in THIS turn: the claim is backed by a tool result in the prompt.
  const { middleware, log } = harness();
  const backed = "Done — the notes on Example Listed Co are updated.";
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => reasonedOutStream(),
      doGenerate: async () => reasonedOutGenerate(),
      params: paramsWithToolResult(),
      model: reissuer(log, [() => textStream(backed)]),
    }),
  );
  check("a claim backed by a tool result since the person's message is delivered", textOf(out) === backed);
}
{
  // A read-only recovered answer: nothing claimed, nothing to reject.
  const { middleware, log } = harness();
  const answer = "Records here are companies; `list_companies` lists them. I have not changed anything yet: shall I set the notes with `upsert_company`?";
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => reasonedOutStream(),
      doGenerate: async () => reasonedOutGenerate(),
      params: liveParams(),
      model: reissuer(log, [() => textStream(answer)]),
    }),
  );
  check("an honest recovered answer that claims nothing is delivered whole", textOf(out) === answer);
}
{
  // The first answer is not a recovery: the guard never touches a model that answered first time.
  const { middleware, log } = harness();
  const out = await drain(
    await middleware.wrapStream({
      doStream: async () => textStream("Revenue grew 18%."),
      doGenerate: async () => reasonedOutGenerate(),
      params: liveParams(),
      model: reissuer(log, []),
    }),
  );
  check("a first-time answer passes straight through", textOf(out) === "Revenue grew 18%." && log.records.length === 0);
}

console.log("\nThe non-streamed path behaves the same:");
{
  const { middleware, log } = harness();
  const result = await middleware.wrapGenerate({
    doGenerate: async () => reasonedOutGenerate(),
    doStream: async () => reasonedOutStream(),
    params: liveParams(),
    model: reissuer(log, [() => textGenerate(LIVE_FABRICATION)]),
  });
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  check("the fabricated confirmation is NOT returned", !/notes updated|approval gate/i.test(text));
  check("…the honest sentence is", text === LAST_RESORT_SENTENCE);
}

/* ═══ 3. REVIEW OF #56: the evidence is structural, the match is narrow ═══════════════════════════════ */
//
// The guard is a best-effort BACKSTOP; the honest nudge is the fix. Withholding a TRUE answer after an empty first
// attempt is a failure too, so the evidence must be precise and the text match narrow. Cases below are the
// reviewer's probes (/root/.claude/jobs/9129ce07/tmp/probe/guard.mjs, guard2.mjs), each failing on 4d97d6d.

const sys = { role: "system", content: "sys" };
const said = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const called = (n, id = "c1") => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: n, input: {} }] });
const result = (n, output = { type: "json", value: { ok: true } }, id = "c1") => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: n, output }] });
const P = (prompt) => ({ prompt, tools: TOOLS });
const ASK = "set Acme notes to X";
const FAKE = "Notes updated: Acme's notes now read X (set via upsert_company).";
const verdict = (params, text) => {
  try {
    return recovery.rejectRecoveredAnswer(params, text, false, readOnlyRelabelled);
  } catch (e) {
    return `threw: ${e.message}`;
  }
};
const nudgeOf = (params) => lastNote(buildNudgedParams(params));

console.log("\nB1 only a SUCCESSFUL WRITE result is evidence of a write:");
{
  const readOnly = P([sys, said(ASK), called("get_company"), result("get_company")]);
  check("a READ result this turn does not back \"notes updated … via upsert_company\"", verdict(readOnly, FAKE) === "unbacked-claim");
  const denied = P([sys, said(ASK), called("upsert_company"), {
    role: "tool",
    content: [
      { type: "tool-approval-response", approvalId: "a", approved: false },
      { type: "tool-result", toolCallId: "c1", toolName: "upsert_company", output: { type: "execution-denied", reason: "Tool execution was denied." } },
    ],
  }]);
  check("an approval-DENIED write does not back \"I've updated Acme's notes\"", verdict(denied, "I've updated Acme's notes to X.") === "unbacked-claim");
  const errored = P([sys, said(ASK), called("upsert_company"), result("upsert_company", { type: "error-text", value: "invalid input" })]);
  check("a write that ERRORED does not back it either", verdict(errored, "I've updated Acme's notes to X.") === "unbacked-claim");
  const asked = P([sys, said(ASK), called("ask_question"), result("ask_question", { type: "json", value: { status: "answered", text: "yes" } })]);
  check("an answered ask-the-person result does not back it", verdict(asked, "I've updated Acme's notes to X.") === "unbacked-claim");
  const wrote = P([sys, said(ASK), called("upsert_company"), result("upsert_company")]);
  check("a successful write result DOES back it: delivered", verdict(wrote, "I've updated Acme's notes to X.") === null);
  // End to end on the stream: a read ran, the write never did.
  const { middleware, log } = harness();
  const out = await drain(await middleware.wrapStream({
    doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(),
    params: { ...readOnly, maxOutputTokens: 8192 }, model: reissuer(log, [() => textStream(FAKE)]),
  }));
  check("…and on the stream, the read-only turn's fabrication is withheld", textOf(out) === LAST_RESORT_SENTENCE);
}

console.log("\nB2 compaction and eve's own user messages are not the person, and not evidence of nothing:");
{
  const compacted = P([sys, { role: "user", content: "Summary of our conversation so far:" },
    { role: "assistant", content: "Called upsert_company for Acme; notes set to X. Approved and saved." },
    said("please set Acme notes to X"), { role: "assistant", content: "Saving now." }, { role: "user", content: "Continue." }]);
  const n = nudgeOf(compacted);
  check("after compaction the nudge does NOT say no tool has run", !/no tool has run|nothing .* has been done/i.test(n));
  check("…it says to check before acting and not to repeat an action that already ran", /check/i.test(n) && /(do not|don't) repeat/i.test(n));
  check("…it is the neutral note", recovery.NUDGE_NEUTRAL !== undefined && n === recovery.NUDGE_NEUTRAL);
  check("…and still carries the never-claim rule", /never (say|claim)[^.]*unless[^.]*tool result/i.test(n));
  check("after compaction the guard stands down (the evidence was compacted away)", verdict(compacted, "I've updated Acme's notes to X.") === null);
  const previous = P([sys, said(ASK), called("upsert_company"), result("upsert_company"), { role: "assistant", content: [{ type: "text", text: "Done." }] }, said("what did you change?")]);
  check("an earlier turn's write: the nudge does not say nothing has been done", !/no tool has run|nothing .* has been done/i.test(nudgeOf(previous)));
  check("…and reporting that write back is delivered", verdict(previous, "I updated Acme's notes to X in the last turn.") === null);
  // The reviewer's probe A: a checkpoint eve might word differently, then the synthetic "Continue." it appends.
  const unrecognised = P([sys, { role: "user", content: "<eve-compaction-checkpoint>" },
    { role: "assistant", content: "Called upsert_company for Acme; notes set to X. Approved and saved." },
    said("please set Acme notes to X"), { role: "assistant", content: "Saving now." }, { role: "user", content: "Continue." }]);
  check("eve's synthetic \"Continue.\" alone marks a compaction: neutral note", nudgeOf(unrecognised) === recovery.NUDGE_NEUTRAL);
  check("…and the guard stands down", verdict(unrecognised, "I've updated Acme's notes to X.") === null);
}

console.log("\nB3 the text match is tied to what THIS turn asked to write; quotes and read-only prose are left alone:");
{
  const fresh = P([sys, said("summarise HomeFirst's Q2 deck")]);
  for (const text of [
    "Management says: \"We have added 40 branches and we have recorded 18% AUM growth.\"",
    "I've added the key figures in the table below.",
    "Below I set out the three main risks.",
    "The RBI master direction has been updated to cap LTV at 80%.",
    "The board has been changed after the AGM; the auditor was removed in March.",
    "Example Listed Co has recorded AUM growth of 18% in Q2 FY26.",
    "The company updated its guidance in the Q2 presentation (slide 7).",
  ]) check(`read-only prose is delivered: ${JSON.stringify(text.slice(0, 60))}`, verdict(fresh, text) === null);
  const ask = P([sys, said(ASK)]);
  for (const text of [
    "I've updated Acme's notes to X.",
    "Just to confirm, I've updated Acme's notes to X.",
    "I went ahead and updated Acme's notes to X.",
    "I set the notes to X.",
    "We have saved the notes.",
    "Acme's notes have been changed to X.",
    "The notes field was updated to X.",
    "Updated Acme's notes to X.",
    "Notes updated for Acme.",
    "Acme notes set to X via upsert_company.",
    "The interaction was logged with record_interaction.",
    LIVE_FABRICATION,
  ]) check(`a claim about the asked-for write is withheld: ${JSON.stringify(text.slice(0, 60))}`, verdict(ask, text) === "unbacked-claim");
  for (const text of [
    "I have not updated the notes yet — shall I call upsert_company?",
    "Once you approve, I will set the notes with upsert_company.",
    "`upsert_company` has no notes field, so nothing was updated.",
    "Records are companies; `list_companies` lists them.",
    "He said \"I've updated the notes\" but nothing ran.",
  ]) check(`an honest or quoted answer about it is delivered: ${JSON.stringify(text.slice(0, 60))}`, verdict(ask, text) === null);
  const live = P([sys, said(LIVE_ASK)]);
  check("the live sentence, against the live ask", verdict(live, LIVE_FABRICATION) === "unbacked-claim");
  check(
    "writeTargets reads what the person asked to write (live ask -> notes)",
    typeof recovery.writeTargets === "function" && recovery.writeTargets(LIVE_ASK).includes("notes"),
  );
}

console.log("\nP1 lower reasoning only on measured models, and survive a provider that refuses the field:");
{
  const unlisted = harness();
  unlisted.middleware; // same harness, different model below
  const { middleware, log } = (() => {
    const log = { records: [], reissues: [], fallbackCalls: 0 };
    let n = 0;
    const middleware = createEmptyResponseRecovery({
      modelId: () => "@cf/zai-org/glm-5.2", fallback: () => null,
      publish: (r) => log.records.push(r), sleep: async () => {}, newId: () => `rec_${++n}`,
    });
    return { middleware, log };
  })();
  await drain(await middleware.wrapStream({
    doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(),
    params: liveParams(), model: reissuer(log, [() => textStream("Records are companies.")]),
  }));
  check("a model not measured to accept reasoning_effort (glm-5.2) is not sent it", log.reissues[0] && log.reissues[0].reasoning === undefined);
}
{
  const { middleware, log } = harness();
  let calls = 0;
  const model = {
    async doStream(p) {
      log.reissues.push(p);
      calls++;
      if (p.reasoning !== undefined) {
        const e = new Error("Bad Request: unsupported parameter reasoning_effort");
        e.statusCode = 400;
        e.responseBody = '{"errors":[{"message":"reasoning_effort is not supported"}]}';
        throw e;
      }
      return textStream("Records are companies.");
    },
    async doGenerate() { return reasonedOutGenerate(); },
  };
  const out = await drain(await middleware.wrapStream({
    doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(), params: liveParams(), model,
  }));
  check("a 4xx naming reasoning_effort is retried once without it, and the answer arrives", textOf(out) === "Records are companies." && calls === 2 && log.reissues[1]?.reasoning === undefined);
}

console.log("\nP2/P3 a held recovery is judged even beside an error part, and a withheld attempt's reasoning never shows:");
{
  const { middleware, log } = harness();
  const withError = () => ({
    stream: streamOf([
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r3" },
      { type: "reasoning-delta", id: "r3", delta: "I'll just say notes updated" },
      { type: "reasoning-end", id: "r3" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: LIVE_FABRICATION },
      { type: "text-end", id: "t" },
      { type: "error", error: new Error("stream hiccup") },
      { type: "finish", finishReason: finish("stop", "stop"), usage: usage({ completion: 900, reasoning: 800 }) },
    ]),
  });
  const out = await drain(await middleware.wrapStream({
    doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(), params: liveParams(), model: reissuer(log, [withError]),
  }));
  check("P2 an error part does not let a held fabrication through unjudged", !/notes updated/i.test(textOf(out)));
  check("P3 the withheld attempt's reasoning is not streamed to the person", !out.some((p) => p.type === "reasoning-delta" && /notes updated/.test(p.delta)));
}
{
  const { middleware, log } = harness();
  const out = await drain(await middleware.wrapStream({
    doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(), params: liveParams(),
    model: reissuer(log, [() => textStream("Records are companies; I have not changed anything yet.")]),
  }));
  check("P3 a delivered recovery still carries its reasoning", out.some((p) => p.type === "reasoning-delta" && /zero evidence/.test(p.delta)));
}

/* ═══ 4. SECOND REVIEW OF #56 (reviewer probe r2.mjs, cases E–L) ═════════════════════════════════════ */
//
// Tool names here are the BASE names (the default profile this test runs under), so the guard's own read-only
// allow-list decides, with nothing injected.

const BASE_TOOLS = ["upsert_customer", "get_customer", "list_customers", "record_interaction", "remember", "bash", "customer-context", "mcp_call", "dataroom_read", "web_search"].map(tool);
const PB = (prompt) => ({ prompt, tools: BASE_TOOLS });
const ASK2 = "Please set Acme's notes to X";
const judge = (params, text) => {
  try {
    return recovery.rejectRecoveredAnswer(params, text, false);
  } catch (e) {
    return `threw: ${e.message}`;
  }
};

console.log("\nR2-1 any successful result from a tool not known to be read-only may be the write: stand down:");
{
  check("E a subagent did the write: \"Acme's notes have been updated to X.\" is delivered",
    judge(PB([sys, said(ASK2), called("customer-context"), result("customer-context", { type: "text", value: "Done: upsert_customer set notes=X" })]), "Acme's notes have been updated to X.") === null);
  check("F remember succeeded: \"I've saved the note…\" is delivered",
    judge(PB([sys, said("Save a note that Acme's CFO is Priya"), called("remember"), result("remember")]), "I've saved the note that Acme's CFO is Priya.") === null);
  check("G bash wrote the file: \"I've saved the table…\" is delivered",
    judge(PB([sys, said("Save the table to a file"), called("bash"), result("bash", { type: "text", value: "ok" })]), "I've saved the table to /work/table.csv.") === null);
  check("an unknown tool (a pack's own) counts as possible write evidence too",
    judge(PB([sys, said(ASK2), called("hfc_kpi_extraction"), result("hfc_kpi_extraction")]), "I've updated Acme's notes to X.") === null);
  check("…but when EVERY result is from a known read-only tool, the fabrication is still withheld",
    judge(PB([sys, said(ASK2), called("get_customer"), result("get_customer"), called("dataroom_read", "c2"), result("dataroom_read", { type: "json", value: { content: "x" } }, "c2"), called("web_search", "c3"), result("web_search", undefined, "c3")]), "I've updated Acme's notes to X.") === "unbacked-claim");
}

console.log("\nR2-2 a conditional first person is not a claim:");
check("\"I'd set the notes, but I need approval first.\" is delivered", judge(PB([sys, said(ASK2)]), "I'd set the notes, but I need approval first.") === null);

console.log("\nR2-3 failure shapes are not success, so they are not write evidence:");
{
  for (const [label, value] of [
    ["J mcp_call {isError:true}", { isError: true, content: [{ type: "text", text: "fail" }] }],
    ["J' mcp_call {connector, tool, result:{isError:true}}", { connector: "crm", tool: "update", result: { isError: true } }],
    ["K {status:\"failed\"}", { status: "failed", message: "not found" }],
    ["K' {status:\"error\"}", { status: "error" }],
    ["K'' {result:{status:\"failed\"}}", { result: { status: "failed" } }],
  ]) {
    const name = label.startsWith("J") ? "mcp_call" : "upsert_customer";
    check(`${label} does not back "I've updated Acme's notes to X."`,
      judge(PB([sys, said(ASK2), called(name), result(name, { type: "json", value })]), "I've updated Acme's notes to X.") === "unbacked-claim");
  }
}

console.log("\nR2-4 two more read-only sentences:");
{
  const ask = PB([sys, said("Set the notes field on Acme to 'watch NPA'")]);
  check("\"I set out below what the notes would say.\" is delivered", judge(ask, "I set out below what the notes would say.") === null);
  check("\"The notes in HomeFirst's deck say the board has been changed.\" is delivered", judge(ask, "The notes in HomeFirst's deck say the board has been changed.") === null);
  check("…while \"Acme's notes have been changed.\" is still withheld", judge(ask, "Acme's notes have been changed.") === "unbacked-claim");
  check("L (documented miss) an image-only message after the ask anchors the turn: no targets, no guard",
    judge(PB([sys, said(ASK2), { role: "user", content: [{ type: "file", mediaType: "image/png", data: "x" }] }]), "I've updated Acme's notes to X.") === null);
}

console.log("\nR2-5 hold only when the guard could fire; otherwise the retry streams live:");
{
  let release;
  const gate = new Promise((r) => (release = r));
  const slowAnswer = () => ({
    stream: new ReadableStream({
      async start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "reasoning-start", id: "r" });
        c.enqueue({ type: "reasoning-delta", id: "r", delta: "reading the deck" });
        c.enqueue({ type: "reasoning-end", id: "r" });
        c.enqueue({ type: "text-start", id: "t" });
        c.enqueue({ type: "text-delta", id: "t", delta: "NPA fell to 1.2%." });
        await gate;
        c.enqueue({ type: "text-end", id: "t" });
        c.enqueue({ type: "finish", finishReason: finish("stop", "stop"), usage: usage({ completion: 50, reasoning: 20 }) });
        c.close();
      },
    }),
  });
  const run = async (prompt) => {
    const { middleware, log } = harness({ isReadOnlyTool: null });
    const res = await middleware.wrapStream({
      doStream: async () => reasonedOutStream(), doGenerate: async () => reasonedOutGenerate(),
      params: { prompt, tools: BASE_TOOLS, maxOutputTokens: 8192 }, model: reissuer(log, [slowAnswer]),
    });
    const reader = res.stream.getReader();
    const seen = [];
    const readUntil = async (pred, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok(null), deadline - Date.now()))]);
        if (!r || r.done) return false;
        seen.push(r.value);
        if (pred(r.value)) return true;
      }
      return false;
    };
    const live = await readUntil((p) => p.type === "text-delta", 300);
    return { live, reader, seen };
  };
  const readOnly = await run([sys, said("What does HomeFirst's Q2 deck say about NPA?")]);
  check("a read-only question's recovery streams its text before the attempt finishes", readOnly.live === true);
  const writeAsk = await run([sys, said(ASK2)]);
  check("a write request's recovery is held until the attempt finishes", writeAsk.live === false);
  release();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
