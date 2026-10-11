// agent-workspace patch to eve 0.25.1 (mold_v1-220): a compaction that keeps what the session READ.
// Not part of eve. Added by patches/eve+0.25.1.patch; the readable source of every change is scripts/eve-patch/.
//
// eve compacts a session when its prompt passes `compaction.threshold` (harness/compaction.js): the older messages
// are summarised by the model, the last few are kept, and the session goes on from there. As shipped it was written
// for chat-like sessions, and three of its choices lose a specialist's work when compaction fires mid-run:
//
//   1. The summariser is shown each part cut to 280 characters, and a tool result collapsed to three keys, two levels
//      deep (`Tool dataroom_read returned object(type=json, value=object(3 keys))`). Whatever a document said is gone
//      before the summary is written, so the summary cannot keep it.
//   2. The messages kept after the summary lose every tool call and tool result (only an assistant's own text stays),
//      and those messages were not summarised either: the last few pages a specialist read vanish outright.
//   3. The kept window is chosen to fill the threshold less a reserve of at most 2,048 tokens, so the session comes
//      out of a compaction nearly as large as it went in and compacts again a step or two later.
//
// Each is replaced here, for every session (a session compacts only past its threshold, so one that never reaches it
// is unchanged):
//
//   1. `compactionTranscriptMessages`: the summariser reads every part in full — tool inputs and results as JSON.
//      The transcript is held to a budget (`compactionTranscriptBudgetChars`: never less than the summarised messages'
//      own size, which the session already sent); over it, the LARGEST parts are shortened first (water-filling),
//      each to the same length, never below eve's own 280, with a note of how much is not shown. A short part is
//      never cut to make room for a long one.
//   2. `keepRecentMessages`: a kept message keeps its tool calls and their results, as complete pairs (a call with no
//      result in the window, or a result whose call is not kept, is dropped as eve did). `splitKeepingToolPairs`
//      starts the kept window after any tool results that answer a call in the summarised part, so they are
//      summarised rather than orphaned.
//   3. `compactionRecentReserve`: the kept window is at most a quarter of the threshold, so a compaction leaves room
//      for three quarters of a threshold of new work before the next one.
//
// Pure functions only, no I/O.

/** eve's own floor for a part shown to the summariser (harness/compaction-prompt.js `summarizeText`). */
const MIN_PART_CHARS = 280;
/** Characters per token in eve's own estimate (harness/compaction.js `estimateTokens`: JSON length / 4). */
const CHARS_PER_TOKEN = 4;

/**
 * The transcript budget, in characters: the larger of the threshold and the summarised messages' own size, both as
 * eve measures a prompt. The summarised messages were already sent to the model as part of the session (all but the
 * latest step's results), so a transcript of them in full fits wherever the session did; the budget binds only on a
 * transcript that came out larger than the messages it renders.
 */
export function compactionTranscriptBudgetChars(config, olderMessages = []) {
  const threshold = Number(config?.threshold);
  let own = 0;
  try {
    own = JSON.stringify(olderMessages).length;
  } catch {
    own = 0;
  }
  return Math.max(4096, Math.floor((Number.isFinite(threshold) && threshold > 0 ? threshold : 100_000) * CHARS_PER_TOKEN), own);
}

/** The reserve `selectRecentWindowSize` keeps free of kept messages: three quarters of the threshold. */
export function compactionRecentReserve(config) {
  return Math.max(64, Math.floor((config.threshold * 3) / 4));
}

const json = (value) => {
  if (value === undefined) return ``;
  if (typeof value === `string`) return value;
  try {
    return JSON.stringify(value) ?? ``;
  } catch {
    return String(value);
  }
};

/** A tool result's output as the summariser should read it (AI SDK `ToolResultOutput`). */
function renderToolOutput(output) {
  if (output === undefined || output === null) return ``;
  if (typeof output !== `object`) return String(output);
  switch (output.type) {
    case `text`:
    case `error-text`:
      return typeof output.value === `string` ? output.value : json(output.value);
    case `json`:
    case `error-json`:
      return json(output.value);
    case `content`:
      return Array.isArray(output.value)
        ? output.value.map((p) => (p?.type === `text` ? p.text : p?.type ? `[${p.type}${p.mediaType ? ` ${p.mediaType}` : ``}]` : json(p))).join(`\n`)
        : json(output.value);
    default:
      return json(output);
  }
}

/** One message's parts, each as the full text the summariser should read (empty parts dropped). */
function partsOf(message) {
  if (typeof message.content === `string`) return message.content.trim() ? [message.content.trim()] : [];
  if (!Array.isArray(message.content)) return [];
  const out = [];
  for (const part of message.content) {
    switch (part?.type) {
      case `text`:
        if (part.text?.trim()) out.push(part.text.trim());
        break;
      case `file`:
        out.push(part.filename ? `Attached file ${part.filename} (${part.mediaType})` : `Attached file attachment (${part.mediaType})`);
        break;
      case `tool-call`: {
        const input = json(part.input);
        out.push(input ? `Called ${part.toolName} with ${input}` : `Called ${part.toolName}`);
        break;
      }
      case `tool-result`: {
        const output = renderToolOutput(part.output);
        const verb = part.isError || part.output?.type === `error-text` || part.output?.type === `error-json` ? `errored` : `returned`;
        out.push(output ? `Tool ${part.toolName} ${verb} ${output}` : `Tool ${part.toolName} ${verb}`);
        break;
      }
      default:
        // reasoning, approvals and anything newer: not part of what the next model needs to continue (as eve).
        break;
    }
  }
  return out;
}

/**
 * The largest length every part may keep so that all of them together fit `budget` characters, or Infinity when they
 * already do. Water-filling: parts shorter than the level keep everything; the rest are cut to the level.
 */
export function waterFillCap(lengths, budget) {
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= budget) return Infinity;
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = budget;
  let count = sorted.length;
  for (const len of sorted) {
    const level = remaining / count;
    if (len > level) return Math.max(MIN_PART_CHARS, Math.floor(level));
    remaining -= len;
    count -= 1;
  }
  return Infinity;
}

const clip = (text, cap) => (text.length <= cap ? text : `${text.slice(0, cap)}… [${text.length - cap} more characters not shown]`);

/**
 * The transcript messages (`{ role, content }`, content a string) the summariser reads for `messages`, every part in
 * full unless the whole is over `budgetChars`, in which case the largest parts are shortened first.
 */
export function compactionTranscriptMessages(messages, budgetChars) {
  const rendered = messages.map((m) => ({ role: m.role, parts: partsOf(m) }));
  const cap = waterFillCap(rendered.flatMap((m) => m.parts.map((p) => p.length)), budgetChars);
  return rendered.map((m) => ({ role: m.role, content: m.parts.map((p) => clip(p, cap)).join(`\n`).trim() }));
}

/**
 * Split for compaction: the last `count` messages are kept, except that tool results at the start of the kept window
 * (whose calls are in the summarised part) are moved to the summarised part with their calls.
 */
export function splitKeepingToolPairs(messages, count) {
  if (count <= 0) return { older: [...messages], recent: [] };
  let at = Math.max(0, messages.length - count);
  while (at < messages.length && messages[at]?.role === `tool`) at += 1;
  return { older: messages.slice(0, at), recent: messages.slice(at) };
}

const assistantText = (m) =>
  typeof m.content === `string`
    ? m.content.trim()
    : m.content
        .filter((p) => p.type === `text`)
        .map((p) => p.text)
        .join(``)
        .trim();

/**
 * The kept window after a compaction: user and system messages as they are; an assistant message with its text and
 * every tool call whose result is also in the window; a tool message with the results of the calls kept. Reasoning
 * and approval parts are dropped, as eve did.
 */
export function keepRecentMessages(messages) {
  const answered = new Set();
  for (const m of messages) {
    if (m.role !== `tool` || !Array.isArray(m.content)) continue;
    for (const p of m.content) if (p?.type === `tool-result`) answered.add(p.toolCallId);
  }
  const keptCalls = new Set();
  const out = [];
  for (const m of messages) {
    if (m.role === `assistant`) {
      if (typeof m.content === `string`) {
        if (m.content.trim()) out.push({ role: `assistant`, content: m.content.trim() });
        continue;
      }
      const calls = m.content.filter((p) => p?.type === `tool-call` && answered.has(p.toolCallId));
      if (calls.length === 0) {
        const text = assistantText(m);
        if (text) out.push({ role: `assistant`, content: text });
        continue;
      }
      for (const c of calls) keptCalls.add(c.toolCallId);
      const text = assistantText(m);
      out.push({ role: `assistant`, content: [...(text ? [{ type: `text`, text }] : []), ...calls] });
      continue;
    }
    if (m.role === `tool`) {
      if (!Array.isArray(m.content)) continue;
      const results = m.content.filter((p) => p?.type === `tool-result` && keptCalls.has(p.toolCallId));
      if (results.length) out.push({ ...m, content: results });
      continue;
    }
    out.push(m);
  }
  return out;
}
