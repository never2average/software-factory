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
 *                      first, then answers once the reply reaches it.
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
const LOG = [];

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

function decide(messages) {
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

let seq = 0;
function completion(decision, model) {
  seq++;
  const id = `chatcmpl-${seq}`;
  if (decision.text) {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: decision.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
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
    usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 },
  };
}

function sseChunks(decision, model) {
  seq++;
  const id = `chatcmpl-${seq}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const out = [];
  if (decision.text) {
    out.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: decision.text }, finish_reason: null }] });
    out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
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
    out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 } });
  }
  return out;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
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
    const messages = payload.messages ?? [];
    const decision = decide(messages);
    LOG.push({ child: isChild(messages), decision });
    console.error(`[fake-model] ${isChild(messages) ? "CHILD " : "ROOT  "} -> ${decision.tool ?? "text"}`);
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const chunk of sseChunks(decision, payload.model)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion(decision, payload.model)));
  });
});
server.listen(PORT, "127.0.0.1", () => console.error(`[fake-model] script=${SCRIPT} on :${PORT}`));
