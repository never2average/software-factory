/**
 * A scripted OpenAI-compatible chat-completions server, so the REAL agent (root
 * + declared subagents) can be driven end to end with no provider, no network
 * and no spend. `agent/lib/model.ts` builds its provider from CLOUDFLARE_BASE_URL,
 * so pointing that at this process swaps the model and nothing else: the eve
 * runtime, the subagent registry, the hooks and the HTTP channel are all real.
 *
 *   node scripts/fake-model-server.mjs --port 8788 --script <name>
 *
 * Scripts (chosen by --script, default "delegate-plain"):
 *   delegate-plain     root delegates to `research`; the child answers and ends.
 *   delegate-parks     root delegates to `research`; the child calls ask_question
 *                      first, then answers once the reply reaches it. With
 *                      `--child-work-ms N` that answer takes N ms — a specialist
 *                      WORKING after its question, while the parent's stream says
 *                      nothing (scripts/rig-subagent-handback.mjs times the hand-back).
 *   vision             answers a `read_image` call by REPORTING what arrived on the
 *                      wire: the model id, how many image parts and their media types.
 *                      That makes "the picture really reached the provider, as an image
 *                      part, on the VISION model" checkable without a provider — which
 *                      is the one thing a mocked tool could never show. It is the only
 *                      script that reads the request body rather than the messages,
 *                      which is why `decide` takes the payload.
 *   vision-empty       the same call, answered EMPTY — reusing `empty-always`'s shape
 *                      below rather than inventing a second one, so `read_image` is
 *                      shown surviving the MEASURED failure and not an approximation
 *                      of it. Kimi K2.6, this repo's vision model until 2026-09-25, is
 *                      the model that produced that failure.
 *   vision-refuses-reasoning
 *                      `vision`, except a request carrying `reasoning_effort` is answered
 *                      400 with a body naming the field — a provider that does not take
 *                      it. Shows `read_image` retrying once WITHOUT the field rather than
 *                      losing the capability.
 *   empty-always       EVERY completion comes back with no content at all —
 *                      `finish_reason: "length"`, `content: null`, and the whole
 *                      completion budget spent on reasoning. This is the live
 *                      failure of 2026-09-23 (`MODEL_CALL_FAILED "Empty model
 *                      response"` after the pdf had already been read) and the
 *                      one shape that was ever reproduced by hand: `max_tokens:
 *                      256` returns `length` + empty content + 256 completion
 *                      tokens, because the orchestrator is a reasoning model and
 *                      spends the budget thinking.
 *   empty-then-answer  the first `--empties N` (default 1) completions come back
 *                      empty the same way, then a plain text answer — so a
 *                      recovery can be shown to actually recover rather than
 *                      merely to stop crashing.
 *
 *   slow-reply         a plain text answer STREAMED slowly: `--chunks N` pieces
 *                      ("SLOW-REPLY part i."), `--chunk-delay-ms D` apart, ending
 *                      "SLOW-REPLY END." — a turn long enough to be severed mid-reply
 *                      (scripts/rig-chat-reattach.mjs).
 *   long-tool          the root makes ONE long tool call, then answers slowly as
 *                      slow-reply does ("TOOL-ANSWER part i." … "TOOL-ANSWER END.").
 *                      `--tool bash` (default) runs eve's own `bash` in the sandbox:
 *                      `sleep <--tool-seconds, default 20> && echo TOOL-DONE`;
 *                      `--tool delegate` hands the work to the specialist instead,
 *                      which works `--child-work-ms` before it answers. Either way a
 *                      tool is IN FLIGHT for that long with nothing streaming
 *                      (scripts/rig-end-of-answer.mjs).
 *
 * `GET /__log` serves every decision with the time it was made (`at`, epoch ms), so a
 * rig can tell when the orchestrator was asked to continue — the moment a specialist's
 * result reached it.
 *
 * Every request body is kept and served at `GET /__requests`, because the field
 * that settles the empty-response hypothesis is one nothing else can see: the
 * `max_tokens` the whole stack (eve, the AI SDK, this repo, a provider default)
 * actually put on the wire. A test asserts on what arrived here, not on what the
 * source says it sends.
 *
 * Who is calling is read off the prompt, not off a header: eve wraps every
 * delegated message with `You are the subagent "<name>".` (its
 * execution/subagent-invocation.js), which is the only reliable in-band marker.
 */
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "8788"));
const SCRIPT = arg("script", "delegate-plain");
const SUBAGENT = arg("subagent", "research");
const NO_USAGE = argv.includes("--no-usage");
const EMPTIES = Number(arg("empties", "1"));
/** delegate-parks: how long the child "works" after its question is answered. */
const CHILD_WORK_MS = Number(arg("child-work-ms", "0"));
/** slow-reply / long-tool: how the answer streams. */
const CHUNKS = Number(arg("chunks", "8"));
const CHUNK_DELAY_MS = Number(arg("chunk-delay-ms", "700"));
/** long-tool: which tool is long, and how long a bash one sleeps. */
const LONG_TOOL = arg("tool", "bash");
const TOOL_SECONDS = Number(arg("tool-seconds", "20"));
/** Completion tokens an empty reasoning answer burns — the measured 256. */
const EMPTY_COMPLETION_TOKENS = Number(arg("empty-completion-tokens", "256"));
const LOG = [];
/** Every request body, in order — see the header note on `GET /__requests`. */
const REQUESTS = [];

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
      : "";

/** The child's own prompt always carries eve's invocation wrapper. */
const isChild = (messages) =>
  messages.some((m) => textOf(m.content).includes(`You are the subagent "${SUBAGENT}"`));

/** Has the child already asked its question (and thus already been answered)? */
const childAlreadyAsked = (messages) =>
  messages.some((m) => m.role === "assistant" && (m.tool_calls ?? []).some((c) => c.function?.name === "ask_question"));

/** Has the parent already received the delegation's tool result? */
const parentHasResult = (messages) => messages.some((m) => m.role === "tool");

/** How many completions have been answered empty so far (empty-* scripts). */
let emptied = 0;

/**
 * The image parts of the last user message, as the OpenAI-compatible WIRE carries
 * them: `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`.
 *
 * The tool sends AI SDK `file` parts; the provider converts them to this on the
 * way out. Reading the wire rather than the SDK-level part is the point — it is
 * what the provider was actually sent, not what the tool believes it sent.
 */
function imagePartsIn(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last || !Array.isArray(last.content)) return [];
  return last.content
    .filter((part) => part?.type === "image_url" && typeof part.image_url?.url === "string")
    .map((part) => {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(part.image_url.url) ?? [];
      return { mediaType: match[1] ?? "unknown", base64Length: (match[3] ?? "").length };
    });
}

function decide(messages, payload = {}) {
  if (SCRIPT === "vision" || SCRIPT === "vision-empty" || SCRIPT === "vision-refuses-reasoning") {
    // `{ empty: true }` — the same shape `empty-always` returns, so `completion()`
    // and `sseChunks()` need no case of their own for this. The branch that used to
    // be here returned `{ text: "" }`, which the truthiness test below reads as "no
    // text", sending it to the tool-call branch with no tool name.
    if (SCRIPT === "vision-empty") return { empty: true };
    const images = imagePartsIn(messages);
    return {
      text: `VISION-READ model=${payload.model} images=${images.length} types=${
        images.map((i) => i.mediaType).join(",") || "none"
      } bytes=${images.map((i) => i.base64Length).join(",") || "0"}`,
    };
  }
  if (SCRIPT === "empty-always") return { empty: true };
  if (SCRIPT === "empty-then-answer") {
    if (emptied < EMPTIES) {
      emptied++;
      return { empty: true };
    }
    // Plain text, not the delegation script: what is being shown is that a
    // reissue after an empty answer reaches the person, and a tool call would
    // put an unrelated tool loop in the way of saying so.
    return { text: "RECOVERED: the answer that the empty response was hiding." };
  }
  const slow = (tag) => ({
    text: Array.from({ length: CHUNKS }, (_, i) => `${tag} part ${i + 1}. `).join("") + `${tag} END.`,
    chunked: true,
  });
  if (SCRIPT === "slow-reply") return slow("SLOW-REPLY");
  if (SCRIPT === "long-tool" && !isChild(messages)) {
    if (!parentHasResult(messages)) {
      return LONG_TOOL === "delegate"
        ? { tool: SUBAGENT, args: { message: "Do the long specialist work." } }
        : { tool: "bash", args: { command: `sleep ${TOOL_SECONDS} && echo TOOL-DONE` } };
    }
    return slow("TOOL-ANSWER");
  }
  if (isChild(messages)) {
    if (SCRIPT === "delegate-parks" && !childAlreadyAsked(messages)) {
      return {
        tool: "ask_question",
        args: { prompt: "Which fiscal year should I use?", options: [{ id: "fy26", label: "FY26" }], allowFreeform: true },
      };
    }
    return { text: "CHILD-RESULT: the specialist's finished output." };
  }
  if (parentHasResult(messages)) return { text: "PARENT-DONE: I received the specialist's output." };
  return { tool: SUBAGENT, args: { message: "Do the specialist work." } };
}

/**
 * Usage for an empty answer: the budget went on thinking.
 *
 * `completion_tokens_details.reasoning_tokens` is what the provider-level usage
 * breaks out as `outputTokens.reasoning`, and "reasoning ≈ completion on an
 * empty answer" is the whole reproduction in two numbers.
 */
const emptyUsage = () => ({
  prompt_tokens: 8213,
  completion_tokens: EMPTY_COMPLETION_TOKENS,
  total_tokens: 8213 + EMPTY_COMPLETION_TOKENS,
  completion_tokens_details: { reasoning_tokens: EMPTY_COMPLETION_TOKENS },
});

let seq = 0;
function completion(decision, model) {
  seq++;
  const id = `chatcmpl-${seq}`;
  if (decision.empty) {
    // content null AND no tool_calls: nothing for the caller to show and nothing
    // to run. `length` is the raw finish reason the live reproduction returns.
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "length" }],
      ...(NO_USAGE ? {} : { usage: emptyUsage() }),
    };
  }
  if (decision.text) {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: decision.text }, finish_reason: "stop" }],
      ...(NO_USAGE ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
    };
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${seq.toString(16).padStart(24, "0")}`,
              type: "function",
              function: { name: decision.tool, arguments: JSON.stringify(decision.args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    ...(NO_USAGE ? {} : { usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 } }),
  };
}

function sseChunks(decision, model) {
  seq++;
  const id = `chatcmpl-${seq}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const out = [];
  if (decision.empty) {
    // A role delta and then the end: a well-formed stream that says nothing.
    // Streaming was ruled out as the cause, so the empty must be reproducible on
    // the streamed path too or the test is not testing the live path.
    out.push({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    out.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      ...(NO_USAGE ? {} : { usage: emptyUsage() }),
    });
    return out;
  }
  if (decision.text) {
    out.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: decision.text }, finish_reason: null }] });
    out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(NO_USAGE ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) });
  } else {
    out.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${seq.toString(16).padStart(24, "0")}`,
                type: "function",
                function: { name: decision.tool, arguments: JSON.stringify(decision.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(NO_USAGE ? {} : { usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 } }) });
  }
  return out;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("__log")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(LOG));
      return;
    }
    if (req.url?.includes("__requests")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(REQUESTS));
      return;
    }
    if (!req.url?.includes("chat/completions")) {
      res.writeHead(404).end("{}");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("{}");
      return;
    }
    REQUESTS.push(payload);
    if (SCRIPT === "vision-refuses-reasoning" && payload.reasoning_effort !== undefined) {
      // The shape an OpenAI-compatible endpoint gives an unsupported parameter.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: "invalid_request_error" } }));
      console.error("[fake-model] ROOT   -> 400 (reasoning_effort refused)");
      return;
    }
    const messages = payload.messages ?? [];
    const decision = decide(messages, payload);
    LOG.push({ at: Date.now(), child: isChild(messages), decision });
    console.error(
      `[fake-model] ${isChild(messages) ? "CHILD " : "ROOT  "} -> ${decision.empty ? "EMPTY" : (decision.tool ?? "text")} (max_tokens=${payload.max_tokens ?? "unset"})`,
    );
    // The child's resumed work, when asked for: its answer comes CHILD_WORK_MS later.
    const work =
      (SCRIPT === "delegate-parks" && isChild(messages) && childAlreadyAsked(messages)) ||
      (SCRIPT === "long-tool" && isChild(messages))
        ? CHILD_WORK_MS
        : 0;
    if (work > 0) {
      setTimeout(() => respond(payload, decision, res), work);
      return;
    }
    respond(payload, decision, res);
  });
});

function respond(payload, decision, res) {
  if (payload.stream && decision.chunked) {
    // One piece per sentence, CHUNK_DELAY_MS apart: a reply that is still being
    // written for seconds, the way a real one is.
    seq++;
    const base = { id: `chatcmpl-${seq}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: payload.model };
    const pieces = decision.text.split(/(?<=\. )/);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    let i = 0;
    const next = () => {
      if (i < pieces.length) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: pieces[i++] }, finish_reason: null }] })}\n\n`);
        setTimeout(next, CHUNK_DELAY_MS);
        return;
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(NO_USAGE ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    };
    setTimeout(next, CHUNK_DELAY_MS);
    return;
  }
  if (payload.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const chunk of sseChunks(decision, payload.model)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(completion(decision, payload.model)));
}
server.listen(PORT, "127.0.0.1", () => console.error(`[fake-model] script=${SCRIPT} on :${PORT}`));
