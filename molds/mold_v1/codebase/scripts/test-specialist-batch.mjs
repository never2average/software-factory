/**
 * SPECIALISTS CALLED TOGETHER, AND "RESUME" ON A STOPPED ONE — on the REAL eve runtime (the installed eve, 0.25.1),
 * in this process's control, with a scripted model. No provider, no network, no microVM.
 *
 * The app it runs is the smallest one that has the shape: a root agent and two declared specialists (`alpha`, `beta`),
 * every node on eve's in-process `just-bash` sandbox, every model call answered by scripts/fake-model-server.mjs
 * (`--script handback`, directed by `[[hb <specialist>:<mode> …]]` in the person's message). It is written into a
 * temporary directory, served by `eve dev --no-ui` on a free port, and removed afterwards. Everything below is what
 * that runtime did, read off its own streams.
 *
 * WHAT IT SETTLES (mold_v1-184; docs/SPECIALIST_HANDBACK.md "Called together" and "Resume"):
 *
 *   1. eve gives the main agent a step's specialists TOGETHER, and nothing the app can send reaches the main agent
 *      while it waits: a message posted to the main thread during the wait is accepted (200), emits nothing, and runs
 *      as a turn of its own only AFTER eve has delivered the batch. So an "early" hand-back of a finished result would
 *      arrive after eve's own delivery of the same result: a duplicate, and no sooner. The app therefore sends none.
 *      This app runs eve's own batch ("all"); the root agent runs `subagents: { batch: "detach" }` (the eve patch,
 *      mold_v1-184), under which a finished result no longer waits behind a question — scripts/test-specialist-detach.mjs.
 *      A batch in which nobody asks holds nothing either way.
 *   2. The Control Panel's "Resume" on a stopped specialist posted a message to the specialist's own session with its
 *      token. eve answered 200 and started a NEW, unrelated session; the specialist and the main thread got nothing.
 *      Shown here first, then the fix: the panel no longer offers it (lib/specialist-run-actions.ts) and the agent
 *      refuses such a message (agent/lib/session-guard.ts; behavioural against Postgres in test:session-guard).
 *
 * Run:  npm run test:specialist-batch      (about 30 s; EVE_BATCH_KEEP=1 keeps the temporary app for a look)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnFakeModel } from "./lib/own-listener.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the app ------------------------------------------------------------------------------------------------- */

const APP = mkdtempSync(join(tmpdir(), "eve-specialist-batch-"));
const files = {
  "package.json": JSON.stringify({ name: "eve-specialist-batch", private: true, type: "module" }),
  "agent/model.ts": [
    'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
    'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
    'export const scripted = provider.chatModel("scripted-model");',
  ].join("\n"),
  "agent/agent.ts": 'import { defineAgent } from "eve";\nimport { scripted } from "./model.ts";\nexport default defineAgent({ model: scripted, modelContextWindowTokens: 200000 });\n',
  "agent/instructions.md": "The main agent of a test app.\n",
  // eve's in-process sandbox, on every node: nothing here may start a VM or a container.
  "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
};
for (const name of ["alpha", "beta"]) {
  files[`agent/subagents/${name}/agent.ts`] = `import { defineAgent } from "eve";\nimport { scripted } from "../../model.ts";\nexport default defineAgent({ description: "Test specialist ${name}.", model: scripted, modelContextWindowTokens: 200000 });\n`;
  files[`agent/subagents/${name}/sandbox.ts`] = files["agent/sandbox.ts"];
}
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(join(APP, rel, ".."), { recursive: true });
  writeFileSync(join(APP, rel), text);
}
symlinkSync(join(ROOT, "node_modules"), join(APP, "node_modules"), "dir");

const model = await spawnFakeModel(["--script", "handback"], { cwd: ROOT });
const port = await freePort();
const eve = spawn(join(ROOT, "node_modules/.bin/eve"), ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: APP,
  env: { ...process.env, SCRIPTED_MODEL_URL: `${model.base}/v1`, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let eveLog = "";
eve.stdout.on("data", (d) => (eveLog += d));
eve.stderr.on("data", (d) => (eveLog += d));
const cleanup = () => {
  try {
    process.kill(-eve.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  model.stop();
  // Only the directory this run created, by the path mkdtemp returned.
  if (!process.env.EVE_BATCH_KEEP && APP.startsWith(join(tmpdir(), "eve-specialist-batch-"))) rmSync(APP, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const B = `http://127.0.0.1:${port}`;
{
  // Ours, not a squatter: eve's own announcement of this port, then its health route.
  const mine = new RegExp(`listening at https?://[^\\s]+:${port}\\b`);
  for (let i = 0; ; i++) {
    if (eve.exitCode !== null) throw new Error(`eve dev exited before listening:\n${eveLog.slice(-3000)}`);
    if (mine.test(eveLog)) {
      const ok = await fetch(`${B}/eve/v1/health`).then((r) => r.ok, () => false);
      if (ok) break;
    }
    if (i > 600) throw new Error(`eve dev did not come up on :${port}:\n${eveLog.slice(-3000)}`);
    await sleep(250);
  }
}

/* ---- talking to it ------------------------------------------------------------------------------------------- */

const post = async (path, body) => {
  const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** A session's history as of now: its stream from the start, read until it has been quiet for a moment. */
async function history(id) {
  const ctrl = new AbortController();
  const out = [];
  let quiet;
  const arm = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => ctrl.abort(), 700);
  };
  try {
    const res = await fetch(`${B}/eve/v1/session/${id}/stream?startIndex=0`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i).trim().replace(/^data: /, "");
        buf = buf.slice(i + 1);
        if (line) {
          try {
            out.push(JSON.parse(line));
          } catch {
            /* a keep-alive */
          }
        }
      }
    }
  } catch {
    /* the quiet timer aborted the read */
  }
  clearTimeout(quiet);
  return out.filter((e) => e && typeof e.type === "string" && !e.type.endsWith(".appended") && !e.type.endsWith(".delta"));
}
async function until(id, test, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const h = await history(id);
    if (test(h)) return h;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} on ${id}: ${h.map((e) => e.type).join(" ")}`);
    await sleep(300);
  }
}
const types = (h) => h.map((e) => e.type);
const at = (e) => Date.parse(e?.meta?.at ?? "");
const tokenOf = (h) => [...h].reverse().find((e) => e.type === "session.waiting")?.data?.continuationToken;

try {
  /* ---- 1. called together ---------------------------------------------------------------------------------- */

  console.log("two specialists called in one step, one asks the person (the shape that held a result):");
  const started = await post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" });
  check("the main thread starts (202)", started.status === 202 && typeof started.body?.sessionId === "string", started);
  const P = started.body.sessionId;
  const P_TOKEN = started.body.continuationToken;
  let parent = await until(P, (h) => types(h).includes("input.requested"), "beta's question on the main thread");
  const calls = Object.fromEntries(parent.filter((e) => e.type === "subagent.called").map((e) => [e.data.name, e.data]));
  check("both specialists were called in the same step", Boolean(calls.alpha && calls.beta) && parent.filter((e) => e.type === "step.completed").length === 1, types(parent));
  const alpha = await until(calls.alpha.childSessionId, (h) => types(h).includes("session.completed"), "alpha to finish");
  check("alpha finished on its own session", /CHILD-RESULT alpha/.test(alpha.find((e) => e.type === "message.completed")?.data?.message ?? ""));
  await sleep(2_000);
  parent = await history(P);
  check("…and its result is HELD: the main thread has no result while beta waits for the person (eve's batch rule)", !types(parent).includes("action.result") && types(parent).at(-1) === "session.waiting", types(parent));

  console.log("\nwhat a message sent to the main thread during that wait does (why the app sends no early hand-back):");
  const before = parent.length;
  const note = await post(`/eve/v1/session/${P}`, { message: "EARLY-NOTE: alpha has finished", continuationToken: P_TOKEN });
  check("eve accepts it (200, the main thread's own id)", note.status === 200 && note.body?.sessionId === P, note);
  await sleep(3_000);
  check("…and NOTHING happens on the main thread: no turn starts, the model is not asked", (await history(P)).length === before);
  const request = parent.find((e) => e.type === "input.requested").data.requests[0].requestId;
  const answered = await post(`/eve/v1/session/${P}`, { inputResponses: [{ requestId: request, optionId: "fy26" }], continuationToken: P_TOKEN });
  check("the person answers beta's question (200)", answered.status === 200, answered);
  parent = await until(P, (h) => h.some((e) => e.type === "message.completed" && /PARENT-PLAIN/.test(e.data?.message ?? "")), "the held note's own turn");
  const results = parent.filter((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result");
  const done = parent.findIndex((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? ""));
  const noteAt = parent.findIndex((e) => e.type === "message.received" && /EARLY-NOTE/.test(e.data?.message ?? ""));
  check("eve then hands back BOTH results together, once each", results.length === 2 && new Set(results.map((e) => e.data.result.callId)).size === 2 && Math.abs(at(results[0]) - at(results[1])) < 1_000, results.map((e) => e.data.result.callId));
  check("…the main agent replies on both", done > 0 && /CHILD-RESULT alpha/.test(parent[done].data.message) && /CHILD-RESULT beta/.test(parent[done].data.message), parent[done]?.data?.message);
  check("…and only AFTER that does the early message reach the main agent, as a turn of its own: an early hand-back would be a duplicate, not a head start", noteAt > done && noteAt > parent.indexOf(results[1]), { done, noteAt });

  console.log("\na specialist called with others that RETURNS its question instead of asking holds nothing:");
  const shaped = await post("/eve/v1/session", { message: "[[hb alpha:fast beta:returns]]" });
  const Q = shaped.body.sessionId;
  const q = await until(Q, (h) => h.some((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? "")), "the main agent's reply");
  const qCalls = q.filter((e) => e.type === "subagent.called").map((e) => e.data);
  const qAlpha = await history(qCalls.find((c) => c.name === "alpha").childSessionId);
  const qResults = q.filter((e) => e.type === "action.result" && e.data?.result?.kind === "subagent-result");
  check("nobody is asked anything mid-step: no question on the main thread", !types(q).includes("input.requested"), types(q));
  const qIds = qResults.map((e) => e.data.result.callId);
  check("both results reach the main agent", qCalls.every((c) => qIds.includes(c.callId)), { results: qIds, types: types(q) });
  // OBSERVED, NOT ASSERTED (mold_v1-184): when both specialists finish within milliseconds of each other, eve
  // 0.25.1 on `eve dev` has written each `action.result`, and the main agent's reply and `turn.completed` after them,
  // TWICE, tens of milliseconds apart (distinct `meta.at`), in about one run in five. That is eve's own batch
  // delivery, not anything this app sends; it is reported for investigation rather than failed here, because this
  // scenario is about nothing being HELD. The first scenario's results arrive seconds apart and are held to "once".
  if (qResults.length !== qCalls.length) console.log(`  NOTE eve wrote ${qResults.length} results for ${qCalls.length} delegations here (${types(q).filter((t) => t === "turn.completed").length} turn.completed): its own duplicate delivery when results land together`);
  const heldMs = at(qResults.find((e) => e.data.result.callId === qCalls.find((c) => c.name === "alpha").callId)) - at(qAlpha.find((e) => e.type === "session.completed"));
  check(`…the finished one within seconds of finishing (held ${heldMs} ms), not until a person answers`, heldMs >= 0 && heldMs < 10_000, heldMs);
  const reply = q.find((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? "")).data.message;
  check("…and the question is in the main agent's hands, to ask the person itself", /CHILD-QUESTION beta: Which fiscal year/.test(reply), reply);

  const { renderRootInstructions } = await import("../agent/lib/root-instructions.ts");
  const prompt = renderRootInstructions();
  // The root runs with `subagents: { batch: "detach" }` (mold_v1-184), but a chat started before that deploy (on Vercel)
  // and every session a program opens keep eve's batch: the rule must be true under both.
  check(
    "the root agent is told the rule, true under either batch: may return together (ask first, in a step of its own, or run it alone); one 'reports later' sends its result by itself",
    /Fan out \*\*independent\*\* work in parallel/.test(prompt) && /Specialists called in one step may return\s+together, so if one will need the person's answer or an approval, ask for\s+that first, in a step of its own, or run that specialist alone\. One marked\s+"reports later" sends its result to\s+you by itself: answer with what you\s+have and do not call it again\./.test(prompt),
    prompt.slice(prompt.indexOf("## How to delegate"), prompt.indexOf("## How to delegate") + 1200),
  );
  const words = prompt.trim().split(/\s+/).length;
  check(`…and the stable prompt keeps headroom under its 1,400-word budget (${words} words, at most 1,350)`, words <= 1_350, words);
  for (const file of ["agent/prompt-neutral.md", "agent/prompt-persona.md"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const section = text.slice(text.indexOf("<!-- section: delegate-rules -->"), text.indexOf("<!-- section: memory-save -->"));
    check(`…in both prompt variants (${file})`, /may return\s+together/.test(section) && /in a step of its own, or run that specialist alone/.test(section) && /marked\s+"reports later"/.test(section) && /pull context for three/.test(section));
  }

  /* ---- 2. "Resume" on a stopped specialist ----------------------------------------------------------------- */

  console.log('\n"Resume" on a stopped specialist — the defect, on the real runtime:');
  const r = await post("/eve/v1/session", { message: "[[hb alpha:slow=20000]]" });
  const R = r.body.sessionId;
  const rCall = (await until(R, (h) => types(h).includes("subagent.called"), "the delegation")).find((e) => e.type === "subagent.called").data;
  const C = rCall.childSessionId;
  await until(C, (h) => types(h).includes("step.started"), "the specialist to start work");
  const stop = await post(`/eve/v1/session/${C}/cancel`);
  check("the specialist is stopped on its own (eve accepts)", stop.body?.status === "accepted", stop);
  const child = await until(C, (h) => types(h).slice(-2).join(" ") === "turn.cancelled session.waiting", "the stop to settle");
  const childToken = tokenOf(child);
  check("its session parks on the token eve minted for the delegation: <main thread>:<call id>", childToken === `${R}:${rCall.callId}`, { childToken, expected: `${R}:${rCall.callId}` });
  const parentBefore = (await history(R)).length;
  const resumed = await post(`/eve/v1/session/${C}`, { message: "Resume — continue the task from where you left off.", continuationToken: childToken });
  check("the old Resume (a message on the specialist's own token) is answered 200…", resumed.status === 200, resumed);
  check("…with ANOTHER session's id", typeof resumed.body?.sessionId === "string" && resumed.body.sessionId !== C && resumed.body.sessionId !== R, resumed.body);
  await sleep(3_000);
  const stray = await history(resumed.body.sessionId);
  check("…a brand-new conversation that starts from the Resume text with no context (the root agent, not the specialist)", types(stray)[0] === "session.started" && stray.some((e) => e.type === "message.received" && /^Resume/.test(e.data?.message ?? "")) && !stray.some((e) => /You are the subagent/.test(e.data?.message ?? "")), types(stray));
  check("…while the specialist receives nothing", (await history(C)).length === child.length);
  check("…and the main thread receives nothing", (await history(R)).length === parentBefore);

  console.log("\nthe fix — what a person is offered, and what the agent answers:");
  const { runControl, canMessageSession, delegationFromHeader, refusalText, SESSION_DELEGATION_HEADER, STOPPED_SPECIALIST_NOTE, SPECIALIST_MESSAGE_REFUSAL } = await import("../lib/specialist-run-actions.ts");
  // Right after the Stop the feed still counts the turn active, so Stop stays: pressing it again retries a hand-back
  // that could not be delivered (#114). Once eve says nothing is running, there is no button at all.
  const justStopped = runControl({ delegated: true, running: true, turnActive: true, continuationToken: childToken, stopped: true });
  const idle = runControl({ delegated: true, running: true, turnActive: false, continuationToken: childToken, stopped: true });
  check("a stopped specialist: never Resume; a note saying to ask the main agent to run it again", justStopped.button !== "resume" && idle.button === null && justStopped.note === STOPPED_SPECIALIST_NOTE && idle.note === STOPPED_SPECIALIST_NOTE && /ask the main agent in the chat to run it again/.test(STOPPED_SPECIALIST_NOTE), { justStopped, idle });
  check("…Stop stays while the feed counts its turn active (the retry of an undelivered hand-back)", justStopped.button === "stop");
  check("a specialist that finished or waits on a question: nothing to press here either", JSON.stringify(runControl({ delegated: true, running: false, turnActive: false, continuationToken: childToken })) === JSON.stringify({ button: null, note: null }));
  check("a specialist at work: Stop, as before, and no note", runControl({ delegated: true, running: true, turnActive: true }).button === "stop" && runControl({ delegated: true, running: true, turnActive: true }).note === null);
  // A workflow step's session was started over HTTP: a message on its own token continues it. Shown on this runtime.
  const step = await post("/eve/v1/session", { message: "a step on its own" });
  const stepH = await until(step.body.sessionId, (h) => types(h).includes("session.waiting"), "the step to park");
  const cont = await post(`/eve/v1/session/${step.body.sessionId}`, { message: "continue", continuationToken: tokenOf(stepH) ?? step.body.continuationToken });
  check("a workflow step's own session IS continued by a message on its token (same session): Resume stays for steps", cont.status === 200 && cont.body?.sessionId === step.body.sessionId, cont.body);
  check("…and the panel offers Resume there, once the agent has said it is not a delegation", runControl({ delegated: false, running: false, turnActive: false, continuationToken: step.body.continuationToken }).button === "resume");
  // A workflow step's row usually opens the SPECIALIST the step called (`childSessionId ?? sessionId`): on this
  // runtime that is a session whose token is `<step>:<call id>`, which no message reaches (shown above).
  check("a step's row that opens the specialist it called: no Resume (the agent says it is a delegation)", runControl({ delegated: delegationFromHeader("1"), running: false, turnActive: false, continuationToken: childToken }).button === null);
  check("…nor while the agent has not said which kind of session it is", runControl({ delegated: delegationFromHeader(null), running: false, turnActive: false, continuationToken: "eve:any" }).button === null);
  check("a message (steer, Resume) is offered only to a session the agent says is not a delegation", canMessageSession(false) && !canMessageSession(true) && !canMessageSession(undefined));
  check(
    "a refusal shows the agent's own text, never a bare status code",
    (await refusalText(Response.json({ error: SPECIALIST_MESSAGE_REFUSAL, ok: false }, { status: 409 }), "Resume failed (409)")) === SPECIALIST_MESSAGE_REFUSAL &&
      (await refusalText(new Response("", { status: 502 }), "Resume failed (502)")) === "Resume failed (502)",
  );

  const guard = readFileSync(join(ROOT, "agent/lib/session-guard.ts"), "utf8");
  const cockpit = readFileSync(join(ROOT, "app/_components/cockpit.tsx"), "utf8");
  const timeline = readFileSync(join(ROOT, "app/_components/ops/run-timeline.tsx"), "utf8");
  const proxy = readFileSync(join(ROOT, "app/eve/v1/session/[...segments]/route.ts"), "utf8");
  check("the agent refuses a message to a delegated specialist's session before eve can start another (409)", /if \(decision\.ownership\?\.source === "lineage"\) \{\s*return Response\.json\(\s*\{ error: SPECIALIST_MESSAGE_REFUSAL/.test(guard) && guard.indexOf('decision.ownership?.source === "lineage"') < guard.indexOf("consumeSessionPost(post"));
  check("…in words that say what to do instead", /answer it in the chat/.test(SPECIALIST_MESSAGE_REFUSAL) && /ask the main agent in the chat to run it again/.test(SPECIALIST_MESSAGE_REFUSAL));
  check("the agent states the fact on every stream it serves, and the web proxy passes it through", /headers\.set\(SESSION_DELEGATION_HEADER, ownership\.source === "lineage" \? "1" : "0"\)/.test(guard) && /\["content-type", "x-eve-session-id", SESSION_DELEGATION_HEADER\]/.test(proxy) && SESSION_DELEGATION_HEADER === "x-eve-session-delegation");
  check("the Control Panel decides with runControl, and Resume is drawn only when it says so", /railControl = runControl\(\{[^}]*delegated: railRun !== null && railRun === selectedRun \? true : railFeed\?\.delegated/s.test(cockpit) && /railControl\.button === "resume" \? \(/.test(cockpit) && /railControl\.button !== "resume"\) return;/.test(cockpit) && /\{railControl\.note\}/.test(cockpit));
  check("…a cancelled turn marks the run stopped (leaving Stop for a retry), a new turn clears it", /event\.type === "turn\.cancelled"\) \{[^}]*?patch\(sid, \(f\) => \(\{ \.\.\.f, stopped: true \}\)\)/s.test(cockpit) && /turnActive: true, stopped: false/.test(cockpit));
  check("…each feed records what the agent said", /delegationFromHeader\(res\.headers\.get\(SESSION_DELEGATION_HEADER\)\)/.test(cockpit));
  check("the Control Panel's steer composer is offered only to a session a message can reach", /run\.childSessionId && live && canMessageSession\(feed\?\.delegated\) \? \(/.test(cockpit) && !/\{run\.childSessionId && live \? \(/.test(cockpit));
  check("the run timeline's step steer likewise (its row often opens the step's specialist)", /setDelegated\(delegationFromHeader\(res\.headers\.get\(SESSION_DELEGATION_HEADER\)\)\)/.test(timeline) && /if \(!canMessageSession\(delegated\)\) return null;/.test(timeline));
  check("…and every refused Resume or steer shows the agent's text, never a bare status", /await refusalText\(res, `Resume failed/.test(cockpit) && /await refusalText\(res, `Steer failed/.test(cockpit) && /await refusalText\(res, `Steer failed/.test(timeline) && !/: `Resume failed \(\$\{res\.status\}\)`\)/.test(cockpit) && !/: `Steer failed \(\$\{res\.status\}\)\.`\)/.test(timeline));
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
