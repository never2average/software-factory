#!/usr/bin/env node
/**
 * DOES THE MAIN AGENT GET A SPECIALIST'S RESULT AND CONTINUE BY ITSELF? — one delegated turn against a running app,
 * with nobody watching the main thread, timed on the server's own clock.
 *
 *   RIG_BASE=https://app.example.com RIG_TOKEN=<a signed-in session token> [RIG_ORG=<workspace id>] \
 *     node scripts/rig-specialist-handback.mjs [--shapes single,question,two,stopped] [--max-ms 15000]
 *
 * Exit 0 `handback: pass` when, in every shape asked for, the main agent received the specialist's result (or its
 * plain failure) and finished a reply of its own within --max-ms of the specialist coming to rest — with NO message
 * from this script to nudge it — exactly once. Exit 1 `handback: fail` with the shape and the reason. Exit 3
 * `handback: skipped` when RIG_BASE or RIG_TOKEN is missing. The token is read from the environment and never
 * printed; `MOLD_V1_SESSION_TOKEN` is accepted for it, the name the factory's lanes already use.
 *
 * WHY "NOBODY WATCHING". The defect this guards (2026-10-05) was never on screen: the main thread's turn was left
 * waiting on the server. So each shape CLOSES its read of the main thread as soon as the specialist is called — a
 * closed tab — follows the SPECIALIST's own session to the moment it comes to rest, and only then reads the main
 * thread's history. Every time is `meta.at`, the timestamp eve stamps on the event as it writes it, so the number is
 * the server-side hand-back and owes nothing to when this script happened to look.
 *
 * SHAPES (default: single,question,two,stopped,answered,apart,resume)
 *   single    one specialist, awaited. It answers; the main agent must continue.
 *   question  one specialist that asks the person a question; this script answers it; then as `single`.
 *   two       two specialists called in ONE step, one of which asks a question. While that one waits, the other's
 *             result is HELD — eve hands a step's delegations back together — which is reported, not failed. Once
 *             the question is answered both must reach the main agent together, once each.
 *   stopped   one specialist, stopped on its own (`POST /eve/v1/session/<child>/cancel`, what the Control Panel's
 *             Stop does) while it works. The main agent must be TOLD and continue. On a build without the fix the
 *             specialist stops and the main thread waits for ever: this shape is the one that fails there.
 *   answered  one specialist asks the person a question, the person answers, and the specialist is stopped while it
 *             works on. The main thread is in a different state here — eve parked it on the question, and its stream
 *             already says `turn.completed` — and it must be told and continue all the same.
 *   sibling   two specialists; one is stopped while the other still works. The stop must be REFUSED (409) with the
 *             reason, and the working one left alone. (Then the main thread is stopped, to leave nothing running.)
 *   failed    one specialist whose model call fails every time (scripted model only): the main agent must receive
 *             the failure as that delegation's result and continue.
 *   apart     (mold_v1-184) two independent pieces of work, one of which needs the PERSON's choice. eve hands a step's
 *             specialists back together, so a specialist that asks the person mid-step holds every finished result
 *             of that step until the person answers; the root's delegation rule (agent/prompt-*.md) is to still fan out
 *             independent work, but get the person's answer or approval first, or run that specialist on its own.
 *             This script plays a person who takes a while: a specialist's question is answered only after
 *             --max-ms + 5 s (the main agent's own question at once). Pass when every specialist's result reached
 *             the main agent within --max-ms of that specialist finishing, and the main agent finished a reply.
 *             Scripted: the second specialist returns its question as its result instead of asking (`returns`).
 *   resume    (mold_v1-184) as `stopped`, then the Control Panel's old "Resume": a message posted to the stopped
 *             specialist's own session on its own token. eve would start an unrelated conversation with it; the
 *             agent must refuse it (409, code specialist-session-not-addressable), start nothing, and send the main
 *             thread nothing.
 *
 * TWO KINDS OF MODEL
 *   real      (default) a deployed app. The shapes are asked for in words; pass the specialists to use with
 *             --specialists a,b (default: the built-in `agent` tool, which every deployment has).
 *   scripted  --scripted: `eve dev` answered by `node scripts/fake-model-server.mjs --script handback`, which follows
 *             the `[[hb …]]` directive this script puts in the message. Deterministic, no provider, no spend.
 *             RIG_HOST sets the Host header (eve dev admits `Host: localhost` as an anonymous developer; a real
 *             token and a non-loopback Host exercise the session guard as production does).
 *
 * It starts test chats, so run it where test chats are welcome (an empty workspace, or the operator's say-so).
 */
import http from "node:http";
import https from "node:https";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const BASE = (process.env.RIG_BASE ?? "").replace(/\/$/, "");
const TOKEN = (process.env.RIG_TOKEN ?? process.env.MOLD_V1_SESSION_TOKEN ?? "").trim();
if (!BASE || !TOKEN) {
  console.log("handback: skipped — set RIG_BASE (the app's address) and RIG_TOKEN (a signed-in session token). See the header.");
  process.exit(3);
}
const ORG = process.env.RIG_ORG ?? "";
const HOST = process.env.RIG_HOST ?? "";
const SCRIPTED = argv.includes("--scripted");
const SHAPES = opt("shapes", SCRIPTED ? "single,question,two,stopped,answered,sibling,failed,apart,resume" : "single,question,two,stopped,answered,apart,resume").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_MS = Number(opt("max-ms", "15000"));
const WORK_S = Number(opt("work-s", "240")); // how long a real specialist may take over its own work
const SPECIALISTS = opt("specialists", SCRIPTED ? "research,customer-context" : "agent,agent").split(",").map((s) => s.trim());
const [S1, S2 = S1] = SPECIALISTS;
const HEADING = "[Automatic hand-back";

/* ---- http ------------------------------------------------------------------------------------------------------ */

const target = new URL(BASE);
const lib = target.protocol === "https:" ? https : http;
const headers = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": "rig-specialist-handback",
  ...(ORG ? { "x-ops-org": ORG } : {}),
  ...(HOST ? { host: HOST } : {}),
  ...extra,
});
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method, path: `${target.pathname.replace(/\/$/, "")}${path}`, headers: headers() },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("request timed out")));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Read a session's stream from `startIndex`, handing each event to `until`; resolves with the events read when
 * `until` returns true, when the stream has been quiet for `quietMs` (0 = never), or at `timeoutMs`.
 */
function read(sessionId, { startIndex = 0, until = () => false, quietMs = 0, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const events = [];
    let done = false;
    let quiet;
    let req;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(limit);
      req?.destroy();
      resolve({ events, why });
    };
    const limit = setTimeout(() => finish("timeout"), timeoutMs);
    const touch = () => {
      if (!quietMs) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => finish("quiet"), quietMs);
    };
    const open = (from) => {
      if (done) return;
      req = lib.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: "GET", path: `${target.pathname.replace(/\/$/, "")}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${from}`, headers: headers() },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            if (res.statusCode === 404 || res.statusCode === 401 || res.statusCode === 403) return finish(`http ${res.statusCode}`);
            return void setTimeout(() => open(startIndex + events.length), 1_000);
          }
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim() || done) continue;
              let event;
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }
              events.push(event);
              touch();
              if (until(event, events)) return finish("until");
            }
          });
          // A segment that ends is reopened at the cursor: the stream is durable, the connection is not.
          res.on("end", () => setTimeout(() => open(startIndex + events.length), 500));
          res.on("error", () => setTimeout(() => open(startIndex + events.length), 500));
        },
      );
      req.on("error", () => setTimeout(() => open(startIndex + events.length), 1_000));
      req.end();
    };
    touch();
    open(startIndex);
  });
}

/* ---- helpers --------------------------------------------------------------------------------------------------- */

const at = (event) => (event?.meta?.at ? Date.parse(event.meta.at) : NaN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
class Failed extends Error {}
const fail = (why) => {
  throw new Failed(why);
};

async function start(message) {
  const res = await request("POST", "/eve/v1/session", { message });
  if (!res.json?.sessionId) fail(`the app opened no session (${res.status}): ${res.text.slice(0, 160)}`);
  return { sessionId: res.json.sessionId, token: res.json.continuationToken };
}

/** Read the main thread only until its specialists are called, then stop reading: the tab is closed. */
async function untilCalled(sessionId, count) {
  const { events, why } = await read(sessionId, {
    timeoutMs: 180_000,
    until: (_e, all) => all.filter((e) => e.type === "subagent.called").length >= count || all.some((e) => e.type === "turn.failed" || (e.type === "turn.completed" && !all.some((x) => x.type === "subagent.called"))),
  });
  const called = events.filter((e) => e.type === "subagent.called").map((e) => ({ callId: e.data.callId, name: e.data.name, child: e.data.childSessionId }));
  if (called.length < count) {
    const said = events.filter((e) => e.type === "message.completed").map((e) => String(e.data?.message ?? "")).pop() ?? "";
    fail(`the main agent delegated to ${called.length} specialist(s), not ${count} (${why}); it said: ${JSON.stringify(said.slice(0, 200))}`);
  }
  return called;
}

/** Follow a specialist's own session until it comes to rest. Returns when (server time) and how. */
async function childRest(child, { timeoutMs = WORK_S * 1000, alsoOn = () => false } = {}) {
  const { events, why } = await read(child, {
    timeoutMs,
    until: (e) => e.type === "session.completed" || e.type === "session.failed" || e.type === "input.requested" || (e.type === "session.waiting") || alsoOn(e),
  });
  const last = events[events.length - 1];
  return { events, why, last, at: at(last), type: last?.type };
}

/** The main thread's history as it stands, read after the fact. */
const history = async (sessionId, quietMs = 2_500) => (await read(sessionId, { quietMs, timeoutMs: 60_000 })).events;

/** Wait (reading history, never sending) until the main thread satisfies `ok`, at most `ms`. */
async function settle(sessionId, ok, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const events = await history(sessionId, 1_500);
    const verdict = ok(events);
    if (verdict) return { events, verdict };
    if (Date.now() >= deadline) return { events, verdict: null };
    await sleep(1_000);
  }
}

const subagentResults = (events) => events.filter((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result");
/** A reply of the main agent's own that finished after index `from`. */
function replyAfter(events, from) {
  let text = null;
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.type === "message.completed" && e.data?.finishReason !== "tool-calls" && String(e.data?.message ?? "").trim()) text = { text: String(e.data.message), at: at(e) };
    if (e.type === "turn.completed" && text) return { ...text, endedAt: at(e) };
  }
  return null;
}

function assertOnce(events, called, shape) {
  for (const c of called) {
    const n = subagentResults(events).filter((e) => e.data.result.callId === c.callId).length;
    if (n !== 1) fail(`${shape}: the "${c.name}" delegation reached the main agent ${n} times, not once`);
  }
}

/* ---- the words a real model is asked with ---------------------------------------------------------------------- */

const tool = (name) => (name === "agent" ? "the built-in `agent` tool" : `the tool named \`${name}\` (a declared specialist)`);
const PREAMBLE = "This is an automated check of delegation. Do exactly what is asked and nothing else. Do not ask me anything.";
const words = {
  single: `${PREAMBLE} Call ${tool(S1)} once with this message: 'Use no tools. Reply with exactly: CHILD-OK'. When it hands back, reply to me with exactly: PARENT-GOT followed by its reply.`,
  question: `${PREAMBLE} Call ${tool(S1)} once with this message: 'Before anything else, ask the person exactly one question with your ask_question tool: "Which fiscal year?" with the options FY25 and FY26. After the answer, use no other tools and reply with exactly: CHILD-YEAR followed by the answer.' When it hands back, reply to me with exactly: PARENT-GOT followed by its reply.`,
  two: `${PREAMBLE} In ONE step, make two delegations at the same time. First: ${tool(S1)} with the message 'Use no tools. Reply with exactly: CHILD-FAST'. Second: ${tool(S2)} with the message 'Before anything else, ask the person exactly one question with your ask_question tool: "Which fiscal year?" with the options FY25 and FY26. After the answer, use no other tools and reply with exactly: CHILD-YEAR followed by the answer.' When both have handed back, reply to me with exactly: PARENT-GOT followed by both replies.`,
  stopped: `${PREAMBLE} Call ${tool(S1)} once with this message: 'Use no tools. Write a 3000-word essay on the history of canal building, then end with the line CHILD-ESSAY-DONE.' When it hands back, reply to me with one short sentence saying what you received.`,
  answered: `${PREAMBLE} Call ${tool(S1)} once with this message: 'Before anything else, ask the person exactly one question with your ask_question tool: "Which fiscal year?" with the options FY25 and FY26. After the answer, use no other tools and write a 3000-word essay on the history of canal building.' When it hands back, reply to me with one short sentence saying what you received.`,
  // Not the preamble: here the main agent is ALLOWED to ask, and how it arranges the work around the question is the test.
  apart: `This is an automated check of delegation. I need two independent things. First, have ${tool(S1)} do this: 'Use no tools. Reply with exactly: CHILD-FAST'. Second, have ${tool(S2)} write a one-line greeting for our newsletter. Its tone, formal or casual, is my choice and must not be guessed: I will say which when asked. When you have both, reply to me with one short sentence containing both results.`,
  sibling: `${PREAMBLE} In ONE step, make two delegations at the same time. First: ${tool(S1)} with the message 'Use no tools. Write a 3000-word essay on the history of canal building.' Second: ${tool(S2)} with the message 'Use no tools. Write a 3000-word essay on the history of lighthouse building.' When both have handed back, reply to me with one short sentence.`,
};
const directed = {
  single: `[[hb ${S1}:fast]]`,
  question: `[[hb ${S1}:ask]]`,
  two: `[[hb ${S1}:fast ${S2}:ask]]`,
  stopped: `[[hb ${S1}:slow=120000]]`,
  answered: `[[hb ${S1}:askslow=120000]]`,
  sibling: `[[hb ${S1}:slow=120000 ${S2}:slow=120000]]`,
  failed: `[[hb ${S1}:fail]]`,
  apart: `[[hb ${S1}:fast ${S2}:returns]]`,
  resume: `[[hb ${S1}:slow=120000]]`,
};
words.resume = words.stopped;
const ask = (shape) => (SCRIPTED ? `rig ${shape} ${directed[shape]}` : words[shape]);

/* ---- the shapes ------------------------------------------------------------------------------------------------ */

/** After the specialists are at rest at `restAt`: the main agent has their results and a reply of its own. */
async function expectContinuation(shape, parent, called, restAt, extra = "") {
  const { events, verdict } = await settle(
    parent.sessionId,
    (all) => {
      const got = subagentResults(all);
      if (got.length < called.length) return null;
      const lastResult = all.lastIndexOf(got[got.length - 1]);
      return replyAfter(all, lastResult);
    },
    MAX_MS + 20_000,
  );
  const got = subagentResults(events);
  if (got.length < called.length) {
    const tail = events.slice(-3).map((e) => e.type).join(" → ");
    fail(`${shape}: ${MAX_MS + 20_000} ms after the specialist came to rest the main agent has ${got.length} of ${called.length} result(s) and was not resumed; its stream ends ${tail}`);
  }
  if (!verdict) fail(`${shape}: the main agent received the result but did not finish a reply of its own`);
  assertOnce(events, called, shape);
  const lag = Math.max(...got.map(at)) - restAt;
  if (Number.isFinite(lag) && lag > MAX_MS) fail(`${shape}: the result reached the main agent ${lag} ms after the specialist came to rest (limit ${MAX_MS} ms)`);
  // Nothing typed by anyone: every message the main thread received after the first is the system's own.
  const typed = events.filter((e) => e.type === "message.received").slice(1).filter((e) => !String(e.data?.message ?? "").startsWith(HEADING));
  if (typed.length) fail(`${shape}: the main thread received ${typed.length} message(s) nobody should have sent`);
  return `result ${Number.isFinite(lag) ? `${lag} ms` : "?"} after the specialist came to rest; the main agent replied ${JSON.stringify(verdict.text.slice(0, 70))}${extra}`;
}

const toldMessages = (events) => events.filter((e) => e.type === "message.received" && String(e.data?.message ?? "").startsWith(HEADING));

/** Stop one specialist on its own; the main agent must be told once, by the system, and finish a reply of its own. */
async function stopAndExpectTold(shape, parent, child) {
  const stopAt = Date.now();
  const stop = await request("POST", `/eve/v1/session/${child.child}/cancel`, {});
  if (stop.json?.status !== "accepted") fail(`${shape}: the specialist was not stopped (${stop.status} ${JSON.stringify(stop.json).slice(0, 160)})`);
  const { events, verdict } = await settle(
    parent.sessionId,
    (all) => {
      const told = all.findIndex((e) => e.type === "message.received" && String(e.data?.message ?? "").startsWith(HEADING));
      return told >= 0 ? replyAfter(all, told) : null;
    },
    MAX_MS + 20_000,
  );
  const told = toldMessages(events);
  if (told.length === 0) {
    const tail = events.slice(-3).map((e) => e.type).join(" → ");
    fail(`${shape}: the specialist stopped and the main agent was told NOTHING — ${MAX_MS + 20_000} ms later its stream still ends ${tail} (the stop answered handback=${JSON.stringify(stop.json?.handback ?? null)})`);
  }
  if (stop.json?.handback !== "main-thread-told") fail(`${shape}: the main agent was told, but the stop reported handback=${JSON.stringify(stop.json?.handback ?? null)} — the outcome must be reported as it happened`);
  if (!verdict) fail(`${shape}: the main agent was told the specialist stopped but did not finish a reply of its own`);
  // The specialist's words are quoted as data, under a delimiter minted for this one message.
  const text = String(told[0].data.message);
  if (!/^Hand-back reference: [0-9a-f-]{8,}$/m.test(text) || !/It returned NO result/.test(text)) fail(`${shape}: the hand-back is not in the system's format: ${JSON.stringify(text.slice(0, 200))}`);
  // Once: wait, count again; stop again, count again.
  await sleep(4_000);
  const count = toldMessages(await history(parent.sessionId)).length;
  if (count !== 1) fail(`${shape}: the main agent was told ${count} times, not once`);
  const second = await request("POST", `/eve/v1/session/${child.child}/cancel`, {});
  await sleep(3_000);
  const after = toldMessages(await history(parent.sessionId)).length;
  if (after !== 1) fail(`${shape}: a second Stop told the main agent again (${after} hand-backs)`);
  const lag = at(told[0]) - stopAt;
  if (lag > MAX_MS) fail(`${shape}: the main agent was told ${lag} ms after the stop (limit ${MAX_MS} ms)`);
  return `told ${lag} ms after the stop, once (a second Stop answered ${second.json?.status}); the main agent replied ${JSON.stringify(verdict.text.slice(0, 70))}`;
}

const shapes = {
  async single() {
    const parent = await start(ask("single"));
    const called = await untilCalled(parent.sessionId, 1);
    const rest = await childRest(called[0].child);
    if (rest.type !== "session.completed") fail(`single: the specialist did not finish (${rest.type ?? rest.why})`);
    return expectContinuation("single", parent, called, rest.at);
  },

  async question() {
    const parent = await start(ask("question"));
    const called = await untilCalled(parent.sessionId, 1);
    const asked = await childRest(called[0].child);
    if (asked.type !== "input.requested") fail(`question: the specialist did not ask its question (${asked.type ?? asked.why})`);
    const requests = asked.last.data?.requests ?? [];
    // The answer goes to the MAIN thread, as the chat sends it; eve routes it to the specialist by request id.
    const parked = await settle(parent.sessionId, (all) => all.some((e) => e.type === "input.requested") && all.filter((e) => e.type === "session.waiting").pop(), 20_000);
    if (!parked.verdict) fail("question: the specialist's question never reached the main thread");
    const token = parked.verdict.data?.continuationToken ?? parent.token;
    const answered = await request("POST", `/eve/v1/session/${parent.sessionId}`, {
      continuationToken: token,
      inputResponses: requests.map((r) => ({ requestId: r.requestId, text: "FY26", ...(r.options?.length ? { optionId: r.options[r.options.length - 1].id } : {}) })),
    });
    if (answered.status !== 200) fail(`question: the answer was refused (${answered.status})`);
    const rest = await read(called[0].child, { timeoutMs: WORK_S * 1000, until: (e) => e.type === "session.completed" || e.type === "session.failed" });
    const done = rest.events[rest.events.length - 1];
    if (done?.type !== "session.completed") fail(`question: the specialist did not finish after its answer (${done?.type ?? rest.why})`);
    return expectContinuation("question", parent, called, at(done));
  },

  async two() {
    const parent = await start(ask("two"));
    const called = await untilCalled(parent.sessionId, 2);
    const rests = await Promise.all(called.map((c) => childRest(c.child)));
    const asker = rests.findIndex((r) => r.type === "input.requested");
    const fast = rests.findIndex((r) => r.type === "session.completed");
    if (asker < 0 || fast < 0) fail(`two: expected one specialist to finish and one to ask; got ${rests.map((r) => r.type ?? r.why).join(", ")}`);
    // HELD, by eve's design: the finished one's result is not on the main thread while its sibling waits.
    await sleep(3_000);
    const before = await history(parent.sessionId);
    const held = subagentResults(before).length === 0;
    const parked = before.filter((e) => e.type === "session.waiting").pop();
    const requests = rests[asker].last.data?.requests ?? [];
    const answered = await request("POST", `/eve/v1/session/${parent.sessionId}`, {
      continuationToken: parked?.data?.continuationToken ?? parent.token,
      inputResponses: requests.map((r) => ({ requestId: r.requestId, text: "FY26", ...(r.options?.length ? { optionId: r.options[r.options.length - 1].id } : {}) })),
    });
    if (answered.status !== 200) fail(`two: the answer was refused (${answered.status})`);
    const rest = await read(called[asker].child, { timeoutMs: WORK_S * 1000, until: (e) => e.type === "session.completed" || e.type === "session.failed" });
    const done = rest.events[rest.events.length - 1];
    if (done?.type !== "session.completed") fail(`two: the asking specialist did not finish after its answer (${done?.type ?? rest.why})`);
    return expectContinuation("two", parent, called, at(done), held ? "; while one waited on its question the other's result was held, as eve hands a step's delegations back together" : "");
  },

  async stopped() {
    const parent = await start(ask("stopped"));
    const called = await untilCalled(parent.sessionId, 1);
    // Let it get to work, then stop the SPECIALIST alone — what the Control Panel's Stop on a specialist does.
    await read(called[0].child, { timeoutMs: 120_000, until: (e) => e.type === "step.started" || e.type === "reasoning.appended" || e.type === "message.appended" });
    await sleep(1_500);
    return stopAndExpectTold("stopped", parent, called[0]);
  },

  async answered() {
    const parent = await start(ask("answered"));
    const called = await untilCalled(parent.sessionId, 1);
    const asked = await childRest(called[0].child);
    if (asked.type !== "input.requested") fail(`answered: the specialist did not ask its question (${asked.type ?? asked.why})`);
    const parked = await settle(parent.sessionId, (all) => all.some((e) => e.type === "input.requested") && all.filter((e) => e.type === "session.waiting").pop(), 20_000);
    if (!parked.verdict) fail("answered: the specialist's question never reached the main thread");
    const before = asked.events.length;
    const answered = await request("POST", `/eve/v1/session/${parent.sessionId}`, {
      continuationToken: parked.verdict.data?.continuationToken ?? parent.token,
      inputResponses: (asked.last.data?.requests ?? []).map((r) => ({ requestId: r.requestId, text: "FY26", ...(r.options?.length ? { optionId: r.options[r.options.length - 1].id } : {}) })),
    });
    if (answered.status !== 200) fail(`answered: the answer was refused (${answered.status})`);
    // The specialist is working again: its stream moves past the question.
    const resumed = await read(called[0].child, { startIndex: before, timeoutMs: 120_000, until: (e) => e.type === "step.started" || e.type === "reasoning.appended" || e.type === "message.appended" || e.type === "session.completed" });
    if (resumed.events.some((e) => e.type === "session.completed")) fail("answered: the specialist finished before it could be stopped (make its work longer)");
    if (resumed.why !== "until") fail(`answered: the specialist did not resume after its answer (${resumed.why})`);
    await sleep(1_500);
    return stopAndExpectTold("answered", parent, called[0]);
  },

  async sibling() {
    const parent = await start(ask("sibling"));
    const called = await untilCalled(parent.sessionId, 2);
    await Promise.all(called.map((c) => read(c.child, { timeoutMs: 120_000, until: (e) => e.type === "turn.started" })));
    await sleep(1_500);
    const stop = await request("POST", `/eve/v1/session/${called[0].child}/cancel`, {});
    try {
      if (stop.status !== 409) fail(`sibling: stopping one specialist while the other works answered ${stop.status} ${JSON.stringify(stop.json).slice(0, 120)}, not a refusal — the main thread would now wait for ever`);
      if (!/still working/.test(String(stop.json?.error ?? ""))) fail(`sibling: the refusal does not say why: ${JSON.stringify(stop.json)}`);
      const child = (await read(called[0].child, { quietMs: 1_500, timeoutMs: 20_000 })).events;
      if (child.some((e) => e.type === "turn.cancelled")) fail("sibling: the refused specialist was cancelled anyway");
      return `refused with the reason (${String(stop.json.error).slice(0, 80)}…); nothing was cancelled`;
    } finally {
      await request("POST", `/eve/v1/session/${parent.sessionId}/cancel`, {}); // leave nothing running
    }
  },

  async apart() {
    const parent = await start(ask("apart"));
    const answered = new Set();
    const firstSeen = new Map(); // a specialist's request id → when this script first saw it
    const deadline = Date.now() + WORK_S * 1000 + 60_000;
    let events = [];
    let reply = null;
    for (;;) {
      events = await history(parent.sessionId, 1_500);
      const results = subagentResults(events);
      const calls = events.filter((e) => e.type === "subagent.called");
      // Done: every delegation is back and the main agent finished a reply after the last one.
      if (calls.length > 0 && results.length >= calls.length) {
        reply = replyAfter(events, events.lastIndexOf(results[results.length - 1]));
        if (reply) break;
      }
      // Answer what is asked. The main agent's own question at once; a specialist's only after --max-ms + 5 s. eve
      // copies a specialist's question onto the main thread unmarked; it is the specialist's when its request id is
      // on that specialist's own stream.
      const parked = events.filter((e) => e.type === "session.waiting").pop();
      const childAsks = new Set();
      for (const c of calls) {
        for (const e of await history(c.data.childSessionId, 800)) {
          if (e.type === "input.requested") for (const r of e.data?.requests ?? []) childAsks.add(r.requestId);
        }
      }
      for (const e of events.filter((x) => x.type === "input.requested")) {
        for (const r of e.data?.requests ?? []) {
          if (answered.has(r.requestId)) continue;
          if (!firstSeen.has(r.requestId)) firstSeen.set(r.requestId, Date.now());
          if (childAsks.has(r.requestId) && Date.now() - firstSeen.get(r.requestId) < MAX_MS + 5_000) continue;
          const res = await request("POST", `/eve/v1/session/${parent.sessionId}`, {
            continuationToken: parked?.data?.continuationToken ?? parent.token,
            inputResponses: [{ requestId: r.requestId, text: "casual", ...(r.options?.length ? { optionId: (r.options.find((o) => /casual/i.test(`${o.id} ${o.label}`)) ?? r.options[r.options.length - 1]).id } : {}) }],
          });
          if (res.status !== 200) fail(`apart: an answer was refused (${res.status} ${res.text.slice(0, 120)})`);
          answered.add(r.requestId);
        }
      }
      // A plain-text question from the main agent (no ask_question): answer it as a person would, once.
      const last = events[events.length - 1];
      if (last?.type === "session.waiting" && calls.length === 0 && !answered.has("text") && replyAfter(events, 0)) {
        const res = await request("POST", `/eve/v1/session/${parent.sessionId}`, { continuationToken: last.data?.continuationToken ?? parent.token, message: "Casual." });
        if (res.status !== 200) fail(`apart: the answer was refused (${res.status})`);
        answered.add("text");
      }
      if (Date.now() >= deadline) fail(`apart: the main agent did not finish within ${WORK_S + 60} s; its stream ends ${events.slice(-3).map((e) => e.type).join(" → ")}`);
      await sleep(1_000);
    }
    // Every result: how long after its specialist finished did it reach the main agent?
    const calls = events.filter((e) => e.type === "subagent.called").map((e) => ({ callId: e.data.callId, name: e.data.name, child: e.data.childSessionId }));
    assertOnce(events, calls, "apart");
    const held = [];
    for (const c of calls) {
      const own = await history(c.child, 1_500);
      const finished = own.find((e) => e.type === "session.completed" || e.type === "session.failed");
      const got = subagentResults(events).find((e) => e.data.result.callId === c.callId);
      held.push({ name: c.name, ms: at(got) - at(finished), asked: own.some((e) => e.type === "input.requested") });
    }
    const worst = held.reduce((a, b) => (b.ms > a.ms ? b : a));
    if (worst.ms > MAX_MS) fail(`apart: the "${worst.name}" specialist's result waited ${worst.ms} ms after it finished before reaching the main agent (limit ${MAX_MS} ms) — held behind a question to the person (${held.map((h) => `${h.name}${h.asked ? " asked" : ""}`).join(", ")})`);
    const steps = new Set(events.map((e, i) => (e.type === "subagent.called" ? events.slice(0, i).filter((x) => x.type === "step.started").length : null)).filter((n) => n !== null)).size;
    return `${calls.length} delegation(s) in ${steps} step(s); no result held (worst ${worst.ms} ms, "${worst.name}"); ${held.some((h) => h.asked) ? "a specialist asked the person" : "no specialist asked the person mid-step"}; the main agent replied ${JSON.stringify(reply.text.slice(0, 70))}`;
  },

  async resume() {
    const parent = await start(ask("resume"));
    const called = await untilCalled(parent.sessionId, 1);
    await read(called[0].child, { timeoutMs: 120_000, until: (e) => e.type === "step.started" || e.type === "reasoning.appended" || e.type === "message.appended" });
    await sleep(1_500);
    const told = await stopAndExpectTold("resume", parent, called[0]);
    // What the old Resume sent: a message on the token the stopped specialist's session parks on.
    const own = await history(called[0].child, 1_500);
    const token = own.filter((e) => e.type === "session.waiting").pop()?.data?.continuationToken;
    if (!token) fail("resume: the stopped specialist's stream carries no token to try (is this caller a viewer?)");
    const before = (await history(parent.sessionId)).length;
    const res = await request("POST", `/eve/v1/session/${called[0].child}`, { message: "Resume — continue the task from where you left off.", continuationToken: token });
    if (res.status !== 409 || res.json?.code !== "specialist-session-not-addressable") {
      fail(`resume: a message to the stopped specialist's own session answered ${res.status} ${JSON.stringify(res.json).slice(0, 160)}${res.json?.sessionId && res.json.sessionId !== called[0].child ? ` — eve started an unrelated session (${res.json.sessionId})` : ""}`);
    }
    await sleep(3_000);
    if ((await history(parent.sessionId)).length !== before) fail("resume: the refused message still reached the main thread");
    if ((await history(called[0].child, 1_500)).length !== own.length) fail("resume: the refused message still reached the specialist");
    return `${told}; a message to the stopped specialist's own session was refused (409: ${String(res.json.error).slice(0, 70)}…), nothing started`;
  },

  async failed() {
    if (!SCRIPTED) return "not run: a specialist cannot be made to fail on demand with a real model (use --scripted)";
    const parent = await start(ask("failed"));
    const called = await untilCalled(parent.sessionId, 1);
    const rest = await read(called[0].child, { timeoutMs: WORK_S * 1000, until: (e) => e.type === "session.failed" || e.type === "session.completed" || e.type === "turn.failed" });
    const restAt = at(rest.events[rest.events.length - 1]);
    const summary = await expectContinuation("failed", parent, called, restAt);
    const result = subagentResults(await history(parent.sessionId))[0];
    if (result.data.result.isError !== true) fail("failed: the specialist's failure reached the main agent as a success");
    return `${summary}; the delegation's result is an error the main agent can act on (${JSON.stringify(result.data.result.output).slice(0, 90)})`;
  },
};

/* ---- run ------------------------------------------------------------------------------------------------------- */

let failed = 0;
for (const shape of SHAPES) {
  if (!shapes[shape]) {
    console.log(`| ${shape} | fail | no such shape (${Object.keys(shapes).join(", ")}) |`);
    failed++;
    continue;
  }
  const t0 = Date.now();
  try {
    const detail = await shapes[shape]();
    results.push({ shape, ok: true, detail });
    console.log(`| ${shape} | ${detail.startsWith("not run") ? "skip" : "pass"} | ${detail} (${Math.round((Date.now() - t0) / 1000)} s) |`);
  } catch (error) {
    failed++;
    const why = error instanceof Failed ? error.message : `the rig itself failed: ${error?.stack ?? error}`;
    console.log(`| ${shape} | FAIL | ${why} (${Math.round((Date.now() - t0) / 1000)} s) |`);
  }
}
if (failed) {
  console.log(`handback: fail — ${failed} of ${SHAPES.length} shape(s): the main agent did not get a specialist's result and continue by itself`);
  process.exit(1);
}
console.log(`handback: pass — in ${SHAPES.length} shape(s) the main agent received its specialists' results and continued by itself, once, within ${MAX_MS} ms`);
process.exit(0);
