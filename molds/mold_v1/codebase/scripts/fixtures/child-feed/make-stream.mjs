/**
 * A specialist's session stream in eve's own shape, generated, content-free and deterministic: the shape the
 * Control Panel's harvest measured on the live app (onfinance_hfc, 2026-10-13), where 98.6% of a specialist's bytes
 * were `reasoning.appended` deltas, each carrying the WHOLE reasoning text so far. Field order is eve's
 * (`{"data":{…},"type":"…","meta":{"at":"…"}}`, data keys sorted), as in scripts/fixtures/event-order/.
 *
 * Used by scripts/test-child-feed.mjs (the fold and the store) and tests/control-panel.spec.ts (the panel in a
 * browser). No recorded text: every word is from a fixed list, picked by a seeded generator.
 */

const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau".split(" ");

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const at = (i) => new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + i * 50).toISOString();
const line = (i, type, data) => JSON.stringify({ data, type, meta: { at: at(i) } });

/**
 * @param {object} o
 * @param {number} [o.seed]
 * @param {number} [o.steps]         model steps, each: reasoning deltas, a tool call and its result
 * @param {number} [o.reasoningChars] how long each step's reasoning grows (the cumulative field reaches this)
 * @param {number} [o.deltaWords]    words per delta
 * @param {"waiting"|"completed"|"input"|"reasoning"|"failed"|"running"} [o.end] how the stream ends:
 *   waiting   - the turn finishes and the session parks with a resume token (a finished specialist)
 *   completed - session.completed (genuinely done)
 *   input     - the specialist asked a question: `input.requested`, nothing after (no boundary at all)
 *   reasoning - cut off mid-reasoning (no boundary at all)
 *   failed    - step.failed → turn.failed → session.failed
 *   running   - the turn is still going (no end)
 * @param {string} [o.nested]        a child session this specialist delegates to
 * @param {string} [o.token]         the resume token on session.waiting
 * @param {boolean} [o.answer]       write a short final answer (message deltas then message.completed)
 * @returns {string[]} NDJSON lines, without newlines
 */
export function specialistStream(o = {}) {
  const { seed = 1, steps = 3, reasoningChars = 4000, deltaWords = 6, end = "waiting", nested, token = "eve:token-1", answer = true } = o;
  const r = rng(seed);
  const out = [];
  let i = 0;
  const push = (type, data) => out.push(line(i++, type, data));
  push("session.started", { runtime: { agentId: "agent-workspace", eveVersion: "0.25.1" } });
  push("turn.started", { sequence: 0, turnId: "turn_0" });
  push("message.received", { message: "BRIEF", parts: [{ text: "BRIEF", type: "text" }], sequence: 0, turnId: "turn_0" });
  for (let s = 0; s < steps; s++) {
    push("step.started", { sequence: 0, stepIndex: s, turnId: "turn_0" });
    let soFar = "";
    while (soFar.length < reasoningChars) {
      let delta = "";
      for (let k = 0; k < deltaWords; k++) delta += `${WORDS[Math.floor(r() * WORDS.length)]} `;
      soFar += delta;
      push("reasoning.appended", { reasoningDelta: delta, reasoningSoFar: soFar, sequence: 0, stepIndex: s, turnId: "turn_0" });
    }
    if (end === "reasoning" && s === steps - 1) return out;
    push("reasoning.completed", { reasoning: soFar, sequence: 0, stepIndex: s, turnId: "turn_0" });
    const callId = `call_${seed}_${s}`;
    if (nested && s === 0) {
      push("actions.requested", {
        actions: [{ callId, input: { message: "NESTED BRIEF" }, kind: "subagent-call", subagentName: "research" }],
        sequence: 0,
        stepIndex: s,
        turnId: "turn_0",
      });
      push("subagent.called", { callId, childSessionId: nested, name: "research", sequence: 0, turnId: "turn_0" });
      push("subagent.completed", { callId, output: "NESTED RESULT", subagentName: "research" });
      push("action.result", {
        result: { callId, kind: "subagent-result", output: "NESTED RESULT", subagentName: "research" },
        sequence: 0,
        stepIndex: s,
        status: "completed",
        turnId: "turn_0",
      });
    } else {
      push("actions.requested", {
        actions: [{ callId, input: { path: `/folder/file-${s}.md` }, kind: "tool-call", toolName: "dataroom_read" }],
        sequence: 0,
        stepIndex: s,
        turnId: "turn_0",
      });
      if (end === "input" && s === steps - 1) {
        push("input.requested", {
          requests: [{ action: { callId: `ask_${seed}`, input: { question: "WHICH?" }, kind: "tool-call", toolName: "ask_question" }, options: [{ id: "a", label: "A" }], prompt: "WHICH?", requestId: `req_${seed}` }],
          sequence: 0,
          stepIndex: s,
          turnId: "turn_0",
        });
        return out;
      }
      push("action.result", {
        result: { callId, kind: "tool-result", output: { ok: true }, toolName: "dataroom_read" },
        sequence: 0,
        stepIndex: s,
        status: "completed",
        turnId: "turn_0",
      });
    }
    push("step.completed", { finishReason: "tool-calls", sequence: 0, stepIndex: s, turnId: "turn_0" });
  }
  if (end === "running") return out;
  if (end === "failed") {
    const failure = { code: "MODEL_ERROR", message: "upstream refused" };
    push("step.failed", { ...failure, sequence: 0, stepIndex: steps, turnId: "turn_0" });
    push("turn.failed", { ...failure, sequence: 0, turnId: "turn_0" });
    push("session.failed", failure);
    return out;
  }
  const s = steps;
  push("step.started", { sequence: 0, stepIndex: s, turnId: "turn_0" });
  if (answer) {
    let soFar = "";
    for (let k = 0; k < 5; k++) {
      const delta = `ANSWER-${k}. `;
      soFar += delta;
      push("message.appended", { messageDelta: delta, messageSoFar: soFar, sequence: 0, stepIndex: s, turnId: "turn_0" });
    }
    push("message.completed", { finishReason: "stop", message: soFar, sequence: 0, stepIndex: s, turnId: "turn_0" });
  }
  push("step.completed", { finishReason: "stop", sequence: 0, stepIndex: s, turnId: "turn_0" });
  push("turn.completed", { sequence: 0, turnId: "turn_0" });
  if (end === "completed") push("session.completed", {});
  else push("session.waiting", { continuationToken: token, wait: "next-user-message" });
  return out;
}
