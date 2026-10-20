/**
 * PER-RESULT DELEGATION ("detach") ON THE REAL EVE RUNTIME (mold_v1-184) — the installed eve 0.25.1 WITH
 * patches/eve+0.25.1.patch, in this process's control, with a scripted model. No provider, no network, no microVM.
 *
 * The app is the smallest one with the shape (as scripts/test-specialist-batch.mjs): a root agent and two declared
 * specialists (`alpha`, `beta`), eve's in-process `just-bash` sandbox on every node, every model call answered by
 * scripts/fake-model-server.mjs `--script handback` (directed by `[[hb <specialist>:<mode> …]]` in the person's
 * message). The root sets `subagents: { batch: "detach", detachAfterMs: 3000 }`, as agent/agent.ts does (with the
 * default 10 s bound there). It is written to a temporary directory, served by `eve dev --no-ui`, and removed after.
 * Everything below is read off the runtime's own streams.
 *
 * WHAT IT SETTLES (docs/SPECIALIST_HANDBACK.md "Per-result delegation"):
 *
 *   asks      one finishes while another waits on the person's question: the finished result reaches the main agent
 *             at once, the other as "reports later"; the question stays on the main thread and answerable between
 *             turns; when it is answered the specialist finishes and its result arrives as a turn of its own, as
 *             that delegation's TOOL result (never a user message), once.
 *   slow      one finishes while another is merely slow: handed over after detachAfterMs.
 *   together  all finish together: one hand-over, no "reports later", once each (eve's own batch).
 *   stopped   a detached specialist is stopped: the main agent is told once, as its tool result (SUBAGENT_STOPPED),
 *             and a second stop tells it nothing more.
 *   main      the main thread is stopped: its detached specialists stop too; nothing is delivered afterwards.
 *   midturn   a detached result lands while the main thread is mid-turn: delivered when that turn ends, not lost.
 *   twice     a second copy of a late result arrives through the durable queue at the same moment as the real one
 *             (what a second instance or a retried step sends): the main agent gets it once.
 *   ownq      a late result lands while the main agent waits on ITS OWN question: held for the answer, then delivered
 *             in the answer's turn, once.
 *   ownqthen  …and that turn then calls a specialist: the late result is delivered once and the new batch resolves
 *             (a first version deferred the late result again there; the batch lost its results and was dispatched
 *             twice).
 *   stopasking       a "reports later" specialist WAITING ON ITS QUESTION is stopped: accepted (it has no turn), reported
 *                    once, its question retired; a second Stop finds nothing.
 *   stopaskingbatch  the same inside a batch that still waits: the batch takes the stop as that result and goes on.
 *   mainasking       stopping the main thread stops a "reports later" specialist that waits on its question.
 *   forgery   eve's unauthenticated callback routes (`runtime-action-result`, `deliver` payloads) reach a parked
 *             specialist's stop hook and the bound's timer hook by token, and do nothing: only eve's own
 *             `{ kind: "stop-parked" }` / `{ kind: "detach-timer" }` act, and the hooks stay alive.
 *             The app itself closes both routes (agent/lib/callback-guard.ts, #123); this scratch app keeps eve's
 *             open on purpose, so the payload filters are tested as the second line of defence.
 *   lone      a lone delegation (no session copy) is stopped, working and waiting on its question: reported once.
 *   unattended  a session a PROGRAM opens (creator auth `eve_subagent_batch: "all"`, lib/subagent-batch.ts) keeps eve's
 *             batch: nothing "reports later", and its last reply — a step's value — is the full answer.
 *   samestep  the main agent calls a specialist AND asks the person its own question in ONE step (seen live
 *             2026-10-06). eve 0.25.1 dropped the question and left its call with no result, so the next model call
 *             failed (AI_MissingToolResultsError). Now the question is answered "not asked, ask again on its own",
 *             and the turn goes on: alone, with a "reports later" sibling, and (in `all`) under eve's own batch.
 *   sweeptiming  the specialist sweep's whole-history read (agent/lib/specialist-sweep-world.ts, mold_v1-199): a long
 *             stream is read from the start once (about 2 ms an event here; a pass that runs out of time keeps what it
 *             got and the next goes on from there), the next pass's read takes only the tail. Counted, not timed.
 *   all       an app WITHOUT the setting behaves as eve always has: the finished result is held while the other asks,
 *             both arrive together once the question is answered, and nothing is "reports later".
 *
 * Run:  npm run test:specialist-detach     (about 6 minutes; EVE_DETACH_KEEP=1 keeps the temporary apps)
 *       EVE_DETACH_PACE_FACTOR=<n>         an upper time bound is at least n no-op turns of this machine (default 4)
 *       EVE_DETACH_WAIT_FACTOR=<n>         how many times longer a wait for an event runs before it fails (default 3)
 *       EVE_DETACH_AFTER_MS=<ms>           the bound the scratch app is set to and no hand-over may beat (default 3000)
 *       EVE_DETACH_SHARD=<k>/<n>           only the k-th of n slices of SCENARIOS (every n-th, from the k-th); the n
 *                                          slices are disjoint and together every scenario. CI runs two side by side.
 * Without the patch (`npx patch-package --reverse`, then `EVE_DETACH_TEST_CONFIG=omit`, because unpatched eve refuses
 * the `subagents` key) the detach scenarios fail: the finished result is held behind the question.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnFakeModel } from "./lib/own-listener.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ONLY = (process.env.EVE_DETACH_ONLY ?? "").split(",").filter(Boolean);
const OMIT_CONFIG = process.env.EVE_DETACH_TEST_CONFIG === "omit";
/**
 * TIME ON A BUSY MACHINE (mold_v1-286). The runtime here is the real one, on the machine the test runs on: on a loaded
 * 8 GB box every step of it (eve's local queue, its workflow replays, one file per event) is several times slower than
 * on a quiet one, and a check that held a hand-over to fixed milliseconds failed there on unchanged code. So the time
 * checks are split by what they claim:
 *
 *   - THE PRODUCT'S PROMISE is the bound itself: a batch is handed over no EARLIER than `detachAfterMs` (or the idle
 *     bound). That is a lower bound, fixed, read from EVE_DETACH_AFTER_MS (default 3000, what the scratch app is set
 *     to); a slow machine only makes a hand-over later, so it never needs loosening there.
 *   - "PROMPTLY AFTER" is not a number the product promises: a hand-over or a late result can be no faster than the
 *     runtime moves anything. Those upper bounds are today's milliseconds as a floor, raised to PACE_FACTOR times a
 *     no-op specialist turn measured in the same scenario, on the same app, at the same moment (`turnMs`,
 *     `paceProbe`): on a quiet machine they are exactly what they were, on a loaded one they grow with the machine and
 *     not with a guess.
 *   - What the timing used to stand in for is asserted as order: a hand-over happens BEFORE the slow sibling finishes
 *     (it is not "when all are back"), a late result arrives with no message from the person in between.
 *   - A specialist that must still be working at some moment is HELD until the test releases it (`hold=<key>`), not
 *     given a guessed duration that a slow hand-over could outlast (the scenario would then test something else).
 *   - The sweep's tail read (`sweeptiming`) is asserted by counting what each read takes from the runtime's stream,
 *     not by how long it took.
 */
const DETACH_AFTER_MS = Number(process.env.EVE_DETACH_AFTER_MS ?? 3_000);
const PACE_FACTOR = Number(process.env.EVE_DETACH_PACE_FACTOR ?? 4);
const WAIT_FACTOR = Number(process.env.EVE_DETACH_WAIT_FACTOR ?? 3);
if (!(DETACH_AFTER_MS > 0) || !(PACE_FACTOR > 0) || !(WAIT_FACTOR > 0)) {
  console.error("EVE_DETACH_AFTER_MS, EVE_DETACH_PACE_FACTOR and EVE_DETACH_WAIT_FACTOR must be positive numbers");
  process.exit(2);
}
/** An upper bound for "promptly": `floorMs` (today's value), or PACE_FACTOR no-op turns on this machine now if more. */
const promptly = (floorMs, paceMs) => Math.max(floorMs, Number.isFinite(paceMs) ? Math.round(PACE_FACTOR * paceMs) : 0);
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
process.on("exit", () => {
  for (const c of cleanups.reverse()) c();
});
process.on("SIGINT", () => process.exit(130));

/* ---- eve's own duplicate writes (mold_v1-191) ------------------------------------------------------------------ */

/**
 * eve 0.25.1's local world sometimes ran one turn step's body twice when two results reached a turn together (one
 * invocation ran it inline, a second queued it again; docs/SPECIALIST_HANDBACK.md "Two results written twice"). The
 * patch now refuses that second start; this stays as a safety net, and its note would show the fix failing:
 * every event of that step is written again, IDENTICAL, tens of milliseconds later, in the SAME turn. That is not a
 * delivery: the step's result is recorded once. A second DELIVERY of a result would be a turn of its own (another
 * turn id and sequence), so dropping exact repeats never hides one. Only the events a delivery consists of are
 * collapsed (`action.result`, `subagent.completed`, `message.completed`, each carrying its turn, step and sequence, so
 * an identical repeat is eve's duplicate run); others repeat legitimately (`session.waiting` at every rest, eve's
 * `step.started` again with the same index when a batch resolves) and are kept. Each repeat dropped is a note.
 */
const notes191 = new Set();
const COLLAPSED = new Set(["action.result", "subagent.completed", "message.completed"]);
function collapse191(events, sessionId) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const e of events) {
    if (!COLLAPSED.has(e.type)) {
      out.push(e);
      continue;
    }
    const key = `${e.type}\n${JSON.stringify(e.data ?? null)}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  if (dropped > 0 && !notes191.has(sessionId)) {
    notes191.add(sessionId);
    console.log(`  NOTE eve wrote ${dropped} event(s) of a turn step twice on ${sessionId} (mold_v1-191, its own duplicate step run; counted once here)`);
  }
  return out;
}

/* ---- an app on eve dev ---------------------------------------------------------------------------------------- */

async function startApp({ detach, idleMs }) {
  const APP = mkdtempSync(join(tmpdir(), "eve-specialist-detach-"));
  const idle = idleMs === undefined ? "" : `, detachIdleAfterMs: ${idleMs}`;
  const subagents = detach && !OMIT_CONFIG ? `, subagents: { batch: "detach", detachAfterMs: ${DETACH_AFTER_MS}${idle} }` : "";
  const files = {
    "package.json": JSON.stringify({ name: "eve-specialist-detach", private: true, type: "module" }),
    "agent/model.ts": [
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
      'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
      'export const scripted = provider.chatModel("scripted-model");',
    ].join("\n"),
    "agent/agent.ts": `import { defineAgent } from "eve";\nimport "./steer-inbox.ts";\nimport { scripted } from "./model.ts";\nexport default defineAgent({ model: scripted, modelContextWindowTokens: 200000${subagents} });\n`,
    // TEST ONLY (mold_v1-235): the inbox of notes to running specialists, in memory, read through the reader the eve
    // patch calls at each step of a delegated session (harness/steering-notes.js). Same contract as the app's
    // agent/lib/steering.ts: due = pending, or already given to this very step; the model reads the app's own wording.
    "agent/steer-inbox.ts": [
      `import { noteForModel } from ${JSON.stringify(join(ROOT, "lib/steering-client.ts"))};`,
      "const notes = (globalThis.__steerNotes ??= []);",
      "globalThis[Symbol.for('eve.app.steeringNotes')] = async ({ sessionId, parent, turnId, stepIndex }) => {",
      "  const step = `${sessionId}:${turnId}:${stepIndex}`;",
      "  const due = notes.filter((n) => n.parentSessionId === parent?.sessionId && n.callId === parent?.callId && (n.status === 'pending' || n.step === step));",
      "  for (const n of due) { n.status = 'delivered'; n.step = step; n.childSessionId = sessionId; n.reads = (n.reads ?? 0) + 1; }",
      "  return due.map((n) => ({ id: n.id, text: noteForModel(n.author, n.text) }));",
      "};",
      "",
    ].join("\n"),
    "agent/instructions.md": "The main agent of a test app.\n",
    // The part of a request that needs no specialist (the `+work` directive, mold_v1-197).
    "agent/tools/independent_part.ts": 'import { defineTool } from "eve/tools";\nimport { z } from "zod";\nexport default defineTool({ description: "Test: the part of the request that needs no specialist.", inputSchema: z.object({}), async execute() { return "INDEPENDENT-PART"; } });\n',
    "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
    // TEST ONLY, in this throwaway app: resume the main thread's session hook with a copy of a delegation's result,
    // through eve's own runtime and durable queue — what a second instance, or a retried step, sends.
    "agent/channels/redeliver.ts": [
      'import { defineChannel, POST } from "eve/channels";',
      `import { resumeHook } from ${JSON.stringify(join(ROOT, "node_modules/eve/dist/src/internal/workflow/runtime.js"))};`,
      `import { getHookByToken } from ${JSON.stringify(join(ROOT, "node_modules/eve/dist/src/internal/workflow/runtime.js"))};`,
      "export default defineChannel({ routes: [POST('/test/redeliver', async (request) => {",
      "  const { sessionId, continuationToken, result } = await request.json();",
      "  // The session's delivery hook: its continuation token as the HTTP channel namespaces it.",
      "  for (const token of [continuationToken, `eve:${continuationToken}`]) {",
      "    const hook = await getHookByToken(token).catch(() => null);",
      "    if (hook?.runId !== sessionId) continue;",
      "    await resumeHook(token, { kind: 'deliver', payloads: [{ delegationResults: [result] }] });",
      "    return Response.json({ ok: true, token });",
      "  }",
      "  return Response.json({ ok: false, error: 'no delivery hook for that session' }, { status: 404 });",
      "}),",
      // TEST ONLY: a session opened the way a PROGRAM opens one (lib/subagent-batch.ts): its creator's auth carries
      // `eve_subagent_batch: "all"`, which the patched eve reads to keep its own batch for that session.
      "POST('/test/start-unattended', async (request, { send }) => {",
      "  const { message } = await request.json();",
      "  const session = await send(message, { auth: { attributes: { eve_subagent_batch: 'all' }, authenticator: 'test', principalId: 'program', principalType: 'service' }, continuationToken: `eve:${crypto.randomUUID()}`, mode: 'conversation' });",
      "  return Response.json({ sessionId: session.id });",
      "}),",
      // TEST ONLY: the specialist sweep's operations (mold_v1-196), exactly as the app imports them: `delegationSweep`
      // from eve/channels (the patch's execution/delegation-sweep.js).
      "POST('/test/sweep', async (request) => {",
      "  const { delegationSweep } = await import('eve/channels');",
      "  const b = await request.json();",
      "  if (b.op === 'handOver') return Response.json({ ok: await delegationSweep.handOver(b.sessionId, b.callIds) });",
      "  if (b.op === 'deliver') return Response.json({ ok: await delegationSweep.deliverLateResult({ sessionId: b.sessionId, continuationTokens: [b.token, `eve:${b.token}`], result: b.result }) });",
      "  if (b.op === 'cancel') return Response.json(await delegationSweep.cancel(b.sessionId));",
      "  if (b.op === 'terminate') return Response.json({ ok: await delegationSweep.terminate(b.sessionId, 'test') });",
      "  if (b.op === 'events') { const r = (await delegationSweep.events(b.sessionId, 0)).getReader(); const out = []; const t = setTimeout(() => r.cancel(), 800); for (;;) { const x = await r.read().catch(() => ({ done: true })); if (x.done) break; out.push(x.value); } clearTimeout(t); return Response.json({ events: out }); }",
      "  return Response.json({ ok: false }, { status: 400 });",
      "}),",
      // TEST ONLY (mold_v1-235): write a note into the in-memory inbox, or read the inbox.
      "POST('/test/steer', async (request) => {",
      "  const b = await request.json();",
      "  const notes = (globalThis.__steerNotes ??= []);",
      "  if (b.op === 'add') { const n = { id: crypto.randomUUID(), parentSessionId: b.parentSessionId, callId: b.callId, author: b.author, text: b.text, status: 'pending' }; notes.push(n); return Response.json({ ok: true, note: n }); }",
      "  return Response.json({ notes });",
      "}),",
      // TEST ONLY: one pass of the sweep's whole-history read of one session on this runtime (mold_v1-199), and what it
      // took from the runtime (mold_v1-286): every stream it opened, the index it opened it at, and how many events it
      // pulled from it. The runtime is ONE object for every request, as `delegationSweep` is in production, so the
      // reader's per-runtime cache lives across passes exactly as it does there. Each stream hands out an event only
      // when the reader asks for one (highWaterMark 0), so a count is what the reader read, not what was buffered.
      "POST('/test/sweep-history', async (request) => {",
      "  const { delegationSweep } = await import('eve/channels');",
      `  const { wholeHistory } = await import(${JSON.stringify(join(ROOT, "agent/lib/specialist-sweep-world.ts"))});`,
      "  const b = await request.json();",
      "  const reads = (globalThis.__sweepReads = []);",
      "  globalThis.__countedSweep ??= { async events(id, startIndex) {",
      "    const read = { startIndex, events: 0 };",
      "    globalThis.__sweepReads.push(read);",
      "    const source = (await delegationSweep.events(id, startIndex)).getReader();",
      "    return new ReadableStream({ async pull(c) { const x = await source.read(); if (x.done) c.close(); else { read.events++; c.enqueue(x.value); } }, cancel(reason) { return source.cancel(reason); } }, { highWaterMark: 0 });",
      "  } };",
      "  const t0 = Date.now();",
      "  const events = await wholeHistory(globalThis.__countedSweep)(b.sessionId);",
      "  return Response.json({ ms: Date.now() - t0, n: events ? events.length : null, last: events?.at(-1)?.type ?? null, reads });",
      "}),",
      // TEST ONLY: the app's own sweep (agent/lib/specialist-sweep.ts over agent/lib/specialist-sweep-world.ts, the
      // world it runs in production) on this runtime, with an in-memory ledger and the bounds the request names.
      "POST('/test/sweep-run', async (request) => {",
      "  const { delegationSweep } = await import('eve/channels');",
      `  const { sweepMainThread } = await import(${JSON.stringify(join(ROOT, "agent/lib/specialist-sweep.ts"))});`,
      `  const { runtimeWorld } = await import(${JSON.stringify(join(ROOT, "agent/lib/specialist-sweep-world.ts"))});`,
      "  const b = await request.json();",
      "  const rows = (globalThis.__sweepRows ??= new Map());",
      "  const ledger = {",
      "    async claim(r) { const k = `${r.parentSessionId}/${r.callId}`; if (rows.has(k) && rows.get(k).status !== 'surfaced') return 'held'; rows.set(k, { ...r, status: 'claimed' }); return 'won'; },",
      "    async settle(p, c, status) { const r = rows.get(`${p}/${c}`); if (r) r.status = status; },",
      "    async surfaceWaiting(r) { const k = `${r.parentSessionId}/${r.callId}`; if (!rows.has(k)) rows.set(k, { ...r, status: 'surfaced' }); },",
      "    async clearWaiting() {},",
      "    async frozenToEnd() { return []; },",
      "    async ended() {},",
      "  };",
      "  const outcomes = await sweepMainThread(runtimeWorld(delegationSweep, ledger, { frozenMs: b.frozenMs, graceMs: b.graceMs, waitingMs: b.waitingMs ?? 3600000 }), b.sessionId);",
      "  return Response.json({ outcomes });",
      "})] });",
      "",
    ].join("\n"),
  };
  for (const name of ["alpha", "beta"]) {
    files[`agent/subagents/${name}/agent.ts`] = `import { defineAgent } from "eve";\nimport { scripted } from "../../model.ts";\nexport default defineAgent({ description: "Test specialist ${name}.", model: scripted, modelContextWindowTokens: 200000 });\n`;
    files[`agent/subagents/${name}/sandbox.ts`] = files["agent/sandbox.ts"];
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(APP, rel, ".."), { recursive: true });
    writeFileSync(join(APP, rel), text);
  }
  // The app is its own source root, as a real app in its repository is (mold_v1-286). `eve dev` looks upward from the
  // app for `.git` / `pnpm-workspace.yaml` to find the root it watches; with none in the app, a stray marker above it
  // (a `.git` left in the temporary directory by anything else on the machine) made it watch the WHOLE temporary
  // directory: every file created or removed there by any process re-read its thousands of entries, and the runtime
  // under test ran at a fraction of its speed (seen on a shared 8 GB box: eve dev at 100% CPU in chokidar's crawl of
  // /tmp; hand-overs 10 s late, a 90 s wait for a first step). An empty `.git` here stops that search at the app.
  mkdirSync(join(APP, ".git"));
  symlinkSync(join(ROOT, "node_modules"), join(APP, "node_modules"), "dir");
  const model = await spawnFakeModel(["--script", "handback"], { cwd: ROOT });
  const port = await freePort();
  const eve = spawn(join(ROOT, "node_modules/.bin/eve"), ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: APP,
    env: { ...process.env, SCRIPTED_MODEL_URL: `${model.base}/v1`, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  eve.stdout.on("data", (d) => (log += d));
  eve.stderr.on("data", (d) => (log += d));
  cleanups.push(() => {
    try {
      process.kill(-eve.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    model.stop();
    // Only the directory this run created, by the path mkdtemp returned.
    if (!process.env.EVE_DETACH_KEEP && APP.startsWith(join(tmpdir(), "eve-specialist-detach-"))) rmSync(APP, { recursive: true, force: true });
  });
  const B = `http://127.0.0.1:${port}`;
  const mine = new RegExp(`listening at https?://[^\\s]+:${port}\\b`);
  for (let i = 0; ; i++) {
    if (eve.exitCode !== null) throw new Error(`eve dev exited before listening:\n${log.slice(-3000)}`);
    if (mine.test(log) && (await fetch(`${B}/eve/v1/health`).then((r) => r.ok, () => false))) break;
    if (i > 600) throw new Error(`eve dev did not come up on :${port}:\n${log.slice(-3000)}`);
    await sleep(250);
  }
  const post = async (path, body) => {
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  /**
   * A session's history as of now: its stream from the start, read until it has been quiet for a moment. The first
   * event may take longer than that moment on a loaded machine (the runtime opens the stream and reads its first file
   * first), and a read cut there would be an empty history, so the wait for it is longer (mold_v1-286).
   */
  async function history(id, quietMs = 700, firstMs = 5_000) {
    const ctrl = new AbortController();
    const out = [];
    let quiet;
    let first = true;
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ctrl.abort(), first ? Math.max(quietMs, firstMs) : quietMs);
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
        first = false;
        arm();
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          const line = buf.slice(0, i).trim().replace(/^data: /, "");
          buf = buf.slice(i + 1);
          if (line) {
            try {
              out.push(JSON.parse(line));
            } catch {
              /* keep-alive */
            }
          }
        }
      }
    } catch {
      /* the quiet timer aborted the read */
    }
    clearTimeout(quiet);
    return collapse191(out.filter((e) => e && typeof e.type === "string" && !e.type.endsWith(".appended") && !e.type.endsWith(".delta")), id);
  }
  /** Waits for something that must happen. Its time is no claim (a check reads the times off the stream), so on a busy
   * machine it waits WAIT_FACTOR times as long before calling it missing (mold_v1-286). */
  async function until(id, test, what, ms = 30_000) {
    const deadline = Date.now() + ms * WAIT_FACTOR;
    for (;;) {
      const h = await history(id);
      if (test(h)) return h;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} on ${id}: ${h.map((e) => e.type).join(" ")}`);
      await sleep(300);
    }
  }
  return { B, post, history, until, model, log: () => log };
}

/* ---- reading a main thread ------------------------------------------------------------------------------------ */

const types = (h) => h.map((e) => e.type);
const at = (e) => Date.parse(e?.meta?.at ?? "");
const tokenOf = (h) => [...h].reverse().find((e) => e.type === "session.waiting")?.data?.continuationToken;
const isPlaceholder = (e) => e?.data?.result?.kind === "subagent-result" && e.data.result.output?.status === "running" && typeof e.data.result.output?.childSessionId === "string";
const resultsFor = (h, callId) => h.filter((e) => e.type === "action.result" && e.data?.result?.callId === callId);
const realResultsFor = (h, callId) => resultsFor(h, callId).filter((e) => !isPlaceholder(e));
const replies = (h, re) => h.filter((e) => e.type === "message.completed" && re.test(e.data?.message ?? ""));
const callsOf = (h) => Object.fromEntries(h.filter((e) => e.type === "subagent.called").map((e) => [e.data.name, e.data]));
const userMessagesAfterFirst = (h) => h.filter((e) => e.type === "message.received").slice(1);
const completedAt = (run) => at(run.find((e) => e.type === "session.completed"));
/**
 * The machine's pace now: how long one turn of a specialist that answers at once takes, from its session.started to its
 * session.completed (the scripted model has no delay, so this is the runtime's own cost: its queue, its steps, its
 * writes). NaN when the run is not complete.
 */
const turnMs = (run) => completedAt(run) - at(run.find((e) => e.type === "session.started"));
/**
 * A pace probe beside a scenario that has no fast specialist of its own: a lone `[[hb <who>:fast]]` main thread on
 * the same app, started now, and the no-op turn of its specialist. Start it with the scenario and await it after.
 */
async function paceProbe(appX, who = "beta") {
  const P = (await appX.post("/eve/v1/session", { message: `[[hb ${who}:fast]]` })).body.sessionId;
  const h = await appX.until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the pace probe's reply", 30_000);
  return turnMs(await appX.until(callsOf(h)[who].childSessionId, (x) => types(x).includes("session.completed"), "the pace probe's specialist", 30_000));
}
/**
 * A specialist that must still be working when something happens is HELD (`<name>:hold=<key>`, the scripted model
 * answers it only once released) rather than given a guessed duration (`slow=<ms>`): on a loaded machine a 6 s
 * specialist could finish before a 3 s bound's hand-over did, and the scenario then tested something else (mold_v1-286).
 */
let holds = 0;
const holdKey = () => String(++holds);
const release = (appX, key) => fetch(`${appX.model.base}/__release/${key}`, { method: "POST" }).then((r) => r.json());

/**
 * A main thread's events, without what differs between runs (ids, times, the scripted model's call ids): the shape a
 * client sees. Used to hold the "all" mode to unpatched eve, event for event.
 */
function normalize(h) {
  const names = Object.fromEntries(h.filter((e) => e.type === "subagent.called").map((e) => [e.data.callId, e.data.name]));
  return h.map((e) => {
    const d = e.data ?? {};
    if (e.type === "action.result") return `${e.type} ${names[d.result?.callId] ?? "?"} ${d.status} ${JSON.stringify(d.result?.output)}`;
    if (e.type === "subagent.called" || e.type === "subagent.completed") return `${e.type} ${names[d.callId] ?? d.name ?? "?"}`;
    if (e.type === "message.completed" || e.type === "message.received") return `${e.type} ${String(d.message ?? "").replace(/call_[0-9a-f]+/g, "call")}`;
    if (e.type === "input.requested") return `${e.type} ${d.requests?.map((r) => r.prompt).join(",")}`;
    return `${e.type}${d.turnId ? ` ${d.turnId}` : ""}`;
  });
}
/**
 * Every scenario below, in the order it runs. EVE_DETACH_SHARD slices this list, so a scenario missing from it would
 * run in no shard: scenario() fails on a name not listed here, and the end of the run fails on a listed name that no
 * scenario() reached.
 */
const SCENARIOS = ["asks", "slow", "together", "stopped", "main", "midturn", "twice", "ownq", "ownqthen", "stopasking", "stopaskingbatch", "mainasking", "forgery", "lone", "unattended", "samestep", "parallel", "sweephandover", "sweeprace", "sweepstale", "sweeprun", "sweeptiming", "idle", "steer", "all"];
const SHARD = (() => {
  const raw = process.env.EVE_DETACH_SHARD;
  if (!raw) return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  const k = Number(m?.[1]);
  const n = Number(m?.[2]);
  if (!m || n < 1 || k < 1 || k > n) {
    console.error(`EVE_DETACH_SHARD=${raw}: expected <k>/<n> with 1 <= k <= n`);
    process.exit(2);
  }
  return { k, n };
})();
const inShard = (name) => !SHARD || SCENARIOS.indexOf(name) % SHARD.n === SHARD.k - 1;
if (SHARD) console.log(`shard ${SHARD.k}/${SHARD.n}: ${SCENARIOS.filter(inShard).join(", ")}`);
const shouldRun = (name) => (ONLY.length === 0 || ONLY.includes(name)) && inShard(name);
const reached = new Set();
/** One scenario: run if selected; a scenario that throws fails by name and the others still run. */
async function scenario(name, body) {
  reached.add(name);
  if (!SCENARIOS.includes(name)) {
    failures.push(`${name}: not in SCENARIOS, so a sharded run (EVE_DETACH_SHARD) would never run it; add it there`);
    return;
  }
  if (!shouldRun(name)) return;
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error).slice(0, 400)}`);
    console.log(`  FAIL ${name}: ${String(error?.message ?? error).slice(0, 600)}`);
  }
}
/**
 * EVE_DETACH_RECORD_STREAMS=1 writes a scenario's main thread (as `history` reads it: no deltas) to
 * scripts/fixtures/specialist-detach/<name>.ndjson, the streams scripts/test-detached-delegation.mjs reads.
 */
const record = (name, h) => {
  if (!process.env.EVE_DETACH_RECORD_STREAMS) return;
  writeFileSync(join(ROOT, "scripts/fixtures/specialist-detach", `${name}.ndjson`), `${h.map((e) => JSON.stringify(e)).join("\n")}\n`);
};
/** EVE_DETACH_DUMP=1 prints a main thread's events as they ended (to read the shape a client sees). */
const dump = (label, h) => {
  if (!process.env.EVE_DETACH_DUMP) return;
  console.log(`  --- ${label}`);
  for (const e of h) {
    const d = e.data ?? {};
    const r = d.result;
    const extra = r ? ` ${r.callId} ${r.isError ? "error " : ""}${JSON.stringify(r.output).slice(0, 70)}` : d.message ? ` ${String(d.message).slice(0, 60)}` : d.callId ? ` ${d.callId}${d.detachable ? " detachable" : ""}` : "";
    console.log(`      ${e.type} turn=${d.turnId ?? ""}${extra}`);
  }
};

try {
  // The app with the setting, unless only the "all" scenario runs (unpatched eve refuses the setting).
  const app = ["asks", "slow", "together", "stopped", "main", "midturn", "twice", "ownq", "ownqthen", "stopasking", "stopaskingbatch", "mainasking", "forgery", "lone", "unattended", "samestep", "parallel", "sweephandover", "sweeprace", "sweepstale", "sweeprun", "sweeptiming", "steer"].some(shouldRun) ? await startApp({ detach: true }) : null;
  const { post, history, until } = app ?? {};

  await scenario("asks", async () => {
    console.log("one finishes while the other waits on the person's question:");
    const started = await post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's first reply", 30_000);
    const calls = callsOf(h);
    check("both specialists were called in one step, each marked detachable", Boolean(calls.alpha && calls.beta) && calls.alpha.detachable === true && calls.beta.detachable === true, calls);
    const alphaRun = await until(calls.alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha's own run");
    const alphaDone = alphaRun.find((e) => e.type === "session.completed");
    const alphaResult = realResultsFor(h, calls.alpha.callId)[0];
    const heldMs = at(alphaResult) - at(alphaDone);
    // alpha answers at once: its own turn is this machine's no-op turn, measured in this very scenario.
    const pace = turnMs(alphaRun);
    const heldMax = promptly(8_000, pace);
    check(`alpha's result reached the main agent within seconds of alpha finishing (${heldMs} ms; at most ${heldMax}, a no-op turn here took ${pace} ms), not held behind beta's question (it came before the question was answered)`, Boolean(alphaResult) && heldMs >= 0 && heldMs < heldMax, { heldMs, heldMax, pace, types: types(h) });
    const placeholder = resultsFor(h, calls.beta.callId);
    check("beta is handed over as 'reports later': one action.result { status: running, childSessionId, name }", placeholder.length === 1 && isPlaceholder(placeholder[0]) && placeholder[0].data.result.output.childSessionId === calls.beta.childSessionId && placeholder[0].data.result.output.name === "beta", placeholder.map((e) => e.data.result));
    check("…which is not 'subagent.completed'", !h.some((e) => e.type === "subagent.completed" && e.data?.callId === calls.beta.callId));
    const reply = replies(h, /PARENT-DONE/)[0].data.message;
    check("the main agent replied with alpha's result and beta's 'running'", /CHILD-RESULT alpha/.test(reply) && /running/.test(reply), reply);
    const question = h.find((e) => e.type === "input.requested");
    check("beta's question is on the main thread", Boolean(question), types(h));
    // mold_v1-234: the forwarded question names the delegation that asked it (eve dropped the hook payload's callId,
    // subagentName and childSessionId), so the chat can say who is asking and file the reply under that specialist.
    check("…and says which delegation asked it: data.subagent { callId, name: beta, childSessionId } (mold_v1-234)", question?.data?.subagent?.callId === calls.beta.callId && question?.data?.subagent?.name === "beta" && question?.data?.subagent?.childSessionId === calls.beta.childSessionId, question?.data?.subagent ?? question?.data);
    h = await until(P, (x) => types(x).at(-1) === "session.waiting", "the main thread at rest");
    check("the main thread is at rest (its turn ended) while beta waits", types(h).at(-1) === "session.waiting", types(h).slice(-4));
    await sleep(1_500);
    const answered = await post(`/eve/v1/session/${P}`, { inputResponses: [{ requestId: question.data.requests[0].requestId, optionId: "fy26" }], continuationToken: tokenOf(h) ?? started.body.continuationToken });
    check("the person answers beta's question on the main thread, between turns (200)", answered.status === 200, answered);
    const betaRun = await until(calls.beta.childSessionId, (x) => types(x).includes("session.completed"), "beta to finish after its answer", 30_000);
    check("the answer reached beta and beta finished", /CHILD-RESULT beta/.test(betaRun.filter((e) => e.type === "message.completed").at(-1)?.data?.message ?? ""));
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "beta's late result on the main thread", 30_000);
    const late = realResultsFor(h, calls.beta.callId);
    const lateMs = at(late[0]) - completedAt(betaRun);
    const lateMax = promptly(8_000, pace);
    check(`beta's result reached the main agent as a turn of its own (${lateMs} ms after it finished; at most ${lateMax})`, late.length === 1 && lateMs >= 0 && lateMs < lateMax, { lateMs, lateMax, pace, n: late.length });
    check("…read as that delegation's TOOL result: PARENT-LATE carries beta's result", /PARENT-LATE: CHILD-RESULT beta/.test(replies(h, /PARENT-LATE/)[0].data.message), replies(h, /PARENT-LATE/)[0]?.data?.message);
    check("…no user message was sent to the main thread for it", userMessagesAfterFirst(h).length === 0, userMessagesAfterFirst(h).map((e) => e.data?.message));
    const requests = (await (await fetch(`${app.model.base}/__requests`)).json()).map((r) => r.body ?? r);
    const lateRequest = requests.filter((r) => Array.isArray(r.messages) && r.messages.at(-1)?.role === "tool" && /_result$/.test(r.messages.at(-1)?.tool_call_id ?? "")).at(-1);
    check("…and on the wire the model got it as a tool message answering a tool call of beta's (role tool, never user)", Boolean(lateRequest) && lateRequest.messages.at(-2)?.role === "assistant" && lateRequest.messages.at(-2)?.tool_calls?.[0]?.function?.name === "beta" && !lateRequest.messages.slice(-2).some((m) => m.role === "user"), lateRequest?.messages?.slice(-3));
    await sleep(3_000);
    h = await history(P);
    dump("asks: the main thread", h);
    record("asks-main-thread", h);
    check("once: beta has one real result and one 'running', alpha one result, one PARENT-LATE", realResultsFor(h, calls.beta.callId).length === 1 && resultsFor(h, calls.beta.callId).length === 2 && resultsFor(h, calls.alpha.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, { beta: resultsFor(h, calls.beta.callId).length, alpha: resultsFor(h, calls.alpha.callId).length, late: replies(h, /PARENT-LATE/).length });
  });

  await scenario("slow", async () => {
    console.log("\none finishes while the other is merely slow:");
    // beta is held until the hand-over is seen: it is "merely slow" for as long as the hand-over takes.
    const betaHold = holdKey();
    const P = (await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's first reply", 30_000);
    const calls = callsOf(h);
    const alphaRun = await until(calls.alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha's own run");
    const handedAt = at(realResultsFor(h, calls.alpha.callId)[0]);
    const handedMs = handedAt - completedAt(alphaRun);
    const pace = turnMs(alphaRun);
    const handedMax = DETACH_AFTER_MS + promptly(6_000, pace);
    check(`alpha's result was handed over after the ${DETACH_AFTER_MS} ms bound (${handedMs} ms after alpha finished; not before ${DETACH_AFTER_MS - 500}, at most ${handedMax}, a no-op turn here took ${pace} ms), with beta 'running'`, handedMs >= DETACH_AFTER_MS - 500 && handedMs < handedMax && isPlaceholder(resultsFor(h, calls.beta.callId)[0]), { handedMs, handedMax, pace, beta: resultsFor(h, calls.beta.callId).map((e) => e.data.result.output) });
    await release(app, betaHold);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "beta's late result", 40_000);
    const betaRun = await until(calls.beta.childSessionId, (x) => types(x).includes("session.completed"), "beta's own run");
    check("…the hand-over happened while beta was still working (before beta finished), not when all were back", handedAt < completedAt(betaRun), { handedAt: new Date(handedAt).toISOString(), betaDone: new Date(completedAt(betaRun)).toISOString() });
    const lateMs = at(realResultsFor(h, calls.beta.callId)[0]) - completedAt(betaRun);
    const lateMax = promptly(8_000, pace);
    check(`beta's result arrived as its own turn ${lateMs} ms after beta finished (at most ${lateMax}), once, with no message from the person`, lateMs >= 0 && lateMs < lateMax && realResultsFor(h, calls.beta.callId).length === 1 && userMessagesAfterFirst(h).length === 0, { lateMs, lateMax, pace });
    dump("slow: the main thread", h);
    record("slow-main-thread", h);
  });

  await scenario("together", async () => {
    console.log("\nall finish together:");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:fast beta:fast]]" })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's reply", 30_000);
    await sleep(DETACH_AFTER_MS + 2_000);
    h = await history(P);
    const calls = callsOf(h);
    check("one hand-over: both results, no 'running', no late turn, one reply", realResultsFor(h, calls.alpha.callId).length === 1 && realResultsFor(h, calls.beta.callId).length === 1 && !h.some(isPlaceholder) && replies(h, /PARENT-LATE/).length === 0 && replies(h, /PARENT-DONE/).length === 1, types(h));
  });

  await scenario("stopped", async () => {
    console.log("\na detached specialist is stopped:");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:fast beta:slow=60000]]" })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the hand-over", 30_000);
    const calls = callsOf(h);
    check("beta was detached ('running')", isPlaceholder(resultsFor(h, calls.beta.callId)[0]));
    const stop = await post(`/eve/v1/session/${calls.beta.childSessionId}/cancel`);
    check("beta is stopped on its own (eve accepts)", stop.body?.status === "accepted", stop);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "the main agent to be told", 30_000);
    const told = realResultsFor(h, calls.beta.callId);
    check("the main agent is told, as beta's tool result: stopped, no result (SUBAGENT_STOPPED)", told.length === 1 && told[0].data.result.isError === true && told[0].data.result.output?.code === "SUBAGENT_STOPPED" && /SUBAGENT_STOPPED/.test(replies(h, /PARENT-LATE/)[0].data.message), told.map((e) => e.data.result));
    check("…by the runtime, not by a message (no user message on the main thread)", userMessagesAfterFirst(h).length === 0);
    const again = await post(`/eve/v1/session/${calls.beta.childSessionId}/cancel`);
    await sleep(4_000);
    h = await history(P);
    check(`a second stop finds nothing to stop (${again.body?.status}) and tells the main agent nothing more`, again.body?.status === "no_active_turn" && realResultsFor(h, calls.beta.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, { again: again.body, results: realResultsFor(h, calls.beta.callId).length });
    dump("stopped: the main thread", h);
    record("stopped-main-thread", h);
  });

  await scenario("main", async () => {
    console.log("\nthe main thread is stopped while a specialist it detached still works:");
    const started = await post("/eve/v1/session", { message: "[[hb alpha:fast beta:slow=60000]]" });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    // A new turn that waits on a specialist of its own, so there is a turn to stop.
    await post(`/eve/v1/session/${P}`, { message: "[[hb alpha:slow=30000]]", continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => x.filter((e) => e.type === "subagent.called").length === 3, "the second turn's delegation", 30_000);
    const second = h.filter((e) => e.type === "subagent.called").at(-1).data;
    await until(second.childSessionId, (x) => types(x).includes("step.started"), "the second turn's specialist at work");
    const turnId = [...h].reverse().find((e) => e.type === "turn.started")?.data?.turnId;
    const stop = await post(`/eve/v1/session/${P}/cancel`, { turnId });
    check("the main thread's turn is stopped (eve accepts)", stop.body?.status === "accepted", stop);
    const betaRun = await until(beta.childSessionId, (x) => types(x).includes("turn.cancelled"), "the detached specialist to stop", 20_000);
    check("the detached specialist is stopped with it", types(betaRun).includes("turn.cancelled") && !types(betaRun).includes("session.completed"));
    const secondRun = await until(second.childSessionId, (x) => types(x).includes("turn.cancelled"), "the second turn's specialist to stop", 20_000);
    check("…and so is the specialist of the turn that was stopped (eve's own rule)", types(secondRun).includes("turn.cancelled"));
    await sleep(5_000);
    h = await history(P);
    const closed = realResultsFor(h, beta.callId);
    check("the detached specialist is closed on the main thread (its action.result: stopped), once", closed.length === 1 && closed[0].data.result.output?.code === "SUBAGENT_STOPPED", closed.map((e) => e.data.result));
    const lastCancel = h.map((e) => e.type).lastIndexOf("turn.cancelled");
    check("…and nothing is delivered afterwards: no turn starts after the stop", lastCancel >= 0 && !h.slice(lastCancel).some((e) => e.type === "turn.started"), types(h).slice(lastCancel));
    dump("main: the main thread", h);
    record("main-stopped-main-thread", h);
  });

  await scenario("midturn", async () => {
    console.log("\na detached result lands while the main thread is mid-turn:");
    // Order, not durations: beta is released once the second turn waits on its own specialist, and that specialist is
    // released once beta has finished (mold_v1-286; a guessed 8 s beta raced a slow hand-over and finished first).
    const betaHold = holdKey();
    const secondHold = holdKey();
    const started = await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    await post(`/eve/v1/session/${P}`, { message: `[[hb alpha:hold=${secondHold}]]`, continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => x.filter((e) => e.type === "subagent.called").length === 3, "the second turn's delegation", 30_000);
    await release(app, betaHold);
    const betaRun = await until(beta.childSessionId, (x) => types(x).includes("session.completed"), "beta to finish", 30_000);
    await sleep(2_000);
    h = await history(P);
    const busy = h.filter((e) => e.type === "turn.started").length === 2 && types(h).at(-1) !== "session.waiting";
    check("beta finished while the main thread was in another turn (waiting on a specialist)", busy && realResultsFor(h, beta.callId).length === 0, types(h).slice(-5));
    await release(app, secondHold);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "beta's late result after that turn", 40_000);
    const late = realResultsFor(h, beta.callId);
    const secondTurnEnd = h.findIndex((e, i) => e.type === "turn.completed" && i > h.findIndex((x) => x.type === "message.received" && x.data?.message === `[[hb alpha:hold=${secondHold}]]`) && h.slice(0, i).some((x) => x.type === "message.completed" && /PARENT-DONE: CHILD-RESULT alpha$/.test(x.data?.message ?? "")));
    check("…its result was delivered when that turn ended, as a turn of its own, once (not lost)", late.length === 1 && h.indexOf(late[0]) > secondTurnEnd && secondTurnEnd > 0, { late: late.length, at: h.indexOf(late[0]), secondTurnEnd, types: types(h) });
    check("…after beta finished", at(late[0]) >= at(betaRun.find((e) => e.type === "session.completed")));
    dump("midturn: the main thread", h);
    record("midturn-main-thread", h);
  });

  await scenario("twice", async () => {
    console.log("\na second copy of a late result arrives through the durable queue with the real one:");
    const betaHold = holdKey();
    const started = await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` });
    const P = started.body.sessionId;
    const T = started.body.continuationToken;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the hand-over", 30_000);
    const calls = callsOf(h);
    // A copy of alpha's result (delivered in the batch, never detached) must start nothing.
    const stray = await post("/test/redeliver", { sessionId: P, continuationToken: T, result: { callId: calls.alpha.callId, kind: "subagent-result", output: "CHILD-RESULT alpha (copy)", subagentName: "alpha" } });
    check("a copy of a result that was not detached is accepted by the queue…", stray.status === 200, stray.status === 200 ? stray : `${JSON.stringify(stray)}\n${app.log().split("\n").filter((l) => /redeliver|Error|error/.test(l)).slice(-12).join("\n")}`);
    // When beta finishes, three more copies of its result, at the same moment as its own.
    await release(app, betaHold);
    await until(calls.beta.childSessionId, (x) => types(x).includes("session.completed"), "beta to finish", 30_000);
    const copies = await Promise.all([1, 2, 3].map((n) => post("/test/redeliver", { sessionId: P, continuationToken: T, result: { callId: calls.beta.callId, kind: "subagent-result", output: `CHILD-RESULT beta (copy ${n})`, subagentName: "beta" } })));
    check("three copies of beta's result are accepted by the queue at the moment beta's own is sent", copies.every((c) => c.status === 200), copies);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "beta's late result", 30_000);
    await sleep(5_000);
    const late = await post("/test/redeliver", { sessionId: P, continuationToken: T, result: { callId: calls.beta.callId, kind: "subagent-result", output: "CHILD-RESULT beta (late copy)", subagentName: "beta" } });
    await sleep(4_000);
    h = await history(P);
    check("…and one more after it was delivered (200)", late.status === 200);
    const betaResults = realResultsFor(h, calls.beta.callId);
    check(`the main agent got beta's result exactly once (of 5 copies sent: ${betaResults[0]?.data?.result?.output})`, betaResults.length === 1 && replies(h, /PARENT-LATE/).length === 1, { results: betaResults.map((e) => e.data.result.output), late: replies(h, /PARENT-LATE/).length });
    check("…and alpha's copy started nothing (alpha: one result; no turn for it)", resultsFor(h, calls.alpha.callId).length === 1 && h.filter((e) => e.type === "turn.started").length === 2, { alpha: resultsFor(h, calls.alpha.callId).length, turns: h.filter((e) => e.type === "turn.started").length });
    dump("twice: the main thread", h);
  });

  await scenario("ownq", async () => {
    console.log("\na late result lands while the main agent waits on ITS OWN question; then the answer:");
    const betaHold = holdKey();
    const started = await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    await post(`/eve/v1/session/${P}`, { message: "[[hbq]]", continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => x.filter((e) => e.type === "input.requested").length === 1 && types(x).at(-1) === "session.waiting", "the main agent's own question", 30_000);
    const own = h.find((e) => e.type === "input.requested").data.requests[0].requestId;
    await release(app, betaHold);
    await until(beta.childSessionId, (x) => types(x).includes("session.completed"), "beta to finish", 30_000);
    await sleep(4_000);
    h = await history(P);
    check("beta finished while the main agent waited on its own question: its result is held for the answer (no turn ran the model)", realResultsFor(h, beta.callId).length === 0 && replies(h, /PARENT-/).length === 1, types(h).slice(-6));
    await post(`/eve/v1/session/${P}`, { inputResponses: [{ requestId: own, optionId: "emea" }], continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => replies(x, /PARENT-AFTER-Q/).length > 0, "the answer's reply", 30_000);
    await sleep(3_000);
    h = await history(P);
    const reply = replies(h, /PARENT-AFTER-Q/);
    check("the answer's turn delivers beta's result, once, and the main agent replies with it", realResultsFor(h, beta.callId).length === 1 && reply.length === 1 && /CHILD-RESULT beta/.test(reply[0].data.message), { results: realResultsFor(h, beta.callId).length, reply: reply.map((e) => e.data.message) });
    dump("ownq: the main thread", h);
  });

  await scenario("ownqthen", async () => {
    console.log("\n…and the answer's turn then delegates (the path that used to lose a batch's results):");
    const betaHold = holdKey();
    const started = await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    await post(`/eve/v1/session/${P}`, { message: "[[hbq then=alpha:fast]]", continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => x.filter((e) => e.type === "input.requested").length === 1 && types(x).at(-1) === "session.waiting", "the main agent's own question", 30_000);
    const own = h.find((e) => e.type === "input.requested").data.requests[0].requestId;
    await release(app, betaHold);
    await until(beta.childSessionId, (x) => types(x).includes("session.completed"), "beta to finish", 30_000);
    await sleep(4_000);
    h = await history(P);
    await post(`/eve/v1/session/${P}`, { inputResponses: [{ requestId: own, optionId: "emea" }], continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => replies(x, /PARENT-AFTER-Q/).length > 0, "the reply after the new delegation", 40_000);
    await sleep(3_000);
    h = await history(P);
    const second = h.filter((e) => e.type === "subagent.called").at(-1).data;
    const reply = replies(h, /PARENT-AFTER-Q/);
    check("the answer's turn delivers beta's late result once, delegates to alpha, and alpha's result resolves that batch (the main thread is not stuck)", h.filter((e) => e.type === "subagent.called").length === 3 && second.name === "alpha" && realResultsFor(h, second.callId).length === 1, h.filter((e) => e.type === "subagent.called").map((e) => e.data.name));
    check("…the reply carries both: beta's late result and the new alpha result, each once", reply.length === 1 && /CHILD-RESULT beta/.test(reply[0].data.message) && /CHILD-RESULT alpha/.test(reply[0].data.message) && realResultsFor(h, beta.callId).length === 1 && realResultsFor(h, second.callId).length === 1, { reply: reply.map((e) => e.data.message), beta: realResultsFor(h, beta.callId).length, alpha2: realResultsFor(h, second.callId).length });
    dump("ownqthen: the main thread", h);
  });

  await scenario("stopasking", async () => {
    console.log("\na detached specialist WAITING ON ITS QUESTION is stopped:");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    const question = h.find((e) => e.type === "input.requested").data.requests[0].requestId;
    check("beta is 'reports later' and waits on the person (no turn of its own running)", isPlaceholder(resultsFor(h, beta.callId)[0]) && types(await history(beta.childSessionId)).includes("input.requested"));
    const stop = await post(`/eve/v1/session/${beta.childSessionId}/cancel`);
    check("its Stop is accepted (it has no turn, yet it is stopped)", stop.body?.status === "accepted", stop);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "the main agent to be told", 30_000);
    const told = realResultsFor(h, beta.callId);
    check("the main agent is told once, as beta's tool result: SUBAGENT_STOPPED", told.length === 1 && told[0].data.result.output?.code === "SUBAGENT_STOPPED", told.map((e) => e.data.result));
    const { deadInputRequestIds } = await import("../lib/chat-turn-state.ts");
    check("…its question is retired on the main thread (the card settles, the composer is free)", deadInputRequestIds(h).has(question));
    const betaRun = await history(beta.childSessionId);
    check("…and beta's own stream says it was stopped", types(betaRun).includes("turn.cancelled"), types(betaRun).slice(-4));
    const again = await post(`/eve/v1/session/${beta.childSessionId}/cancel`);
    await sleep(3_000);
    h = await history(P);
    check(`a second Stop finds nothing (${again.body?.status}) and tells nothing more`, again.body?.status === "no_active_turn" && realResultsFor(h, beta.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, { again: again.body });
  });

  await scenario("stopaskingbatch", async () => {
    console.log("\na specialist waiting on its question INSIDE a batch that still waits is stopped:");
    const P = (await post("/eve/v1/session", { message: `[[hb alpha:hold=${holdKey()} beta:ask]]` })).body.sessionId;
    let h = await until(P, (x) => types(x).includes("input.requested"), "beta's question", 30_000);
    const calls = callsOf(h);
    const stop = await post(`/eve/v1/session/${calls.beta.childSessionId}/cancel`);
    check("its Stop is accepted", stop.body?.status === "accepted", stop);
    h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the batch to go on", 30_000);
    const told = realResultsFor(h, calls.beta.callId);
    check("the waiting batch takes its SUBAGENT_STOPPED as beta's result, once, and goes on (alpha 'reports later')", told.length === 1 && told[0].data.result.output?.code === "SUBAGENT_STOPPED" && isPlaceholder(resultsFor(h, calls.alpha.callId)[0]), { beta: told.map((e) => e.data.result), alpha: resultsFor(h, calls.alpha.callId).map((e) => e.data.result.output) });
    await post(`/eve/v1/session/${calls.alpha.childSessionId}/cancel`);
  });

  await scenario("mainasking", async () => {
    console.log("\nthe main thread is stopped while a 'reports later' specialist waits on its question:");
    const started = await post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    await post(`/eve/v1/session/${P}`, { message: "[[hb alpha:slow=30000]]", continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await until(P, (x) => x.filter((e) => e.type === "subagent.called").length === 3, "the second turn's delegation", 30_000);
    const turnId = [...h].reverse().find((e) => e.type === "turn.started")?.data?.turnId;
    const stop = await post(`/eve/v1/session/${P}/cancel`, { turnId });
    check("the main thread's turn is stopped", stop.body?.status === "accepted", stop);
    const betaRun = await until(beta.childSessionId, (x) => types(x).includes("turn.cancelled"), "beta to stop", 20_000);
    check("the asking specialist is stopped with it", types(betaRun).includes("turn.cancelled"));
    await sleep(5_000);
    h = await history(P);
    const closed = realResultsFor(h, beta.callId);
    const lastCancel = h.map((e) => e.type).lastIndexOf("turn.cancelled");
    check("…closed on the main thread once (stopped), and nothing delivered after", closed.length === 1 && closed[0].data.result.output?.code === "SUBAGENT_STOPPED" && !h.slice(lastCancel).some((e) => e.type === "turn.started"), { closed: closed.map((e) => e.data.result), tail: types(h).slice(lastCancel) });
  });

  await scenario("forgery", async () => {
    console.log("\neve's unauthenticated callback routes cannot stop a parked specialist or fire the bound:");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    const stopToken = encodeURIComponent(`${beta.childSessionId}:stop-parked`);
    // POST /eve/v1/callback/:token resumes a hook with { kind: "runtime-action-result", results: [...] }.
    const viaSession = await fetch(`${app.B}/eve/v1/callback/${stopToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "session.completed", callId: "forged", subagentName: "beta", output: "forged" }) });
    // GET|POST /eve/v1/connections/:name/callback/:token resumes a hook with { kind: "deliver", payloads: [...] }.
    const viaConnection = await fetch(`${app.B}/eve/v1/connections/anything/callback/${stopToken}?code=forged&state=x`);
    const viaConnectionPost = await fetch(`${app.B}/eve/v1/connections/anything/callback/${stopToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=forged" });
    check(`both callback routes reached the parked-stop hook (${viaSession.status}, ${viaConnection.status}, ${viaConnectionPost.status}: the hook exists, the routes resume it)`, viaSession.status === 202 && viaConnection.status === 200 && viaConnectionPost.status === 200);
    await sleep(4_000);
    h = await history(P);
    check("…and beta was NOT stopped: its stream has no cancellation, the main agent was told nothing", !types(await history(beta.childSessionId)).includes("turn.cancelled") && realResultsFor(h, beta.callId).length === 0, types(await history(beta.childSessionId)).slice(-3));
    const stop = await post(`/eve/v1/session/${beta.childSessionId}/cancel`);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "the real stop's report", 30_000);
    check(`the hook stayed alive: eve's own Stop still stops it (${stop.body?.status}), reported once`, stop.body?.status === "accepted" && realResultsFor(h, beta.callId).length === 1 && realResultsFor(h, beta.callId)[0].data.result.output?.code === "SUBAGENT_STOPPED");

    // The bound's own timer hook takes only { kind: "detach-timer" }: a forged resume does not hand the batch over early.
    const forgeryHold = holdKey();
    const Q = (await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${forgeryHold}]]` })).body.sessionId;
    h = await until(Q, (x) => x.filter((e) => e.type === "subagent.called").length === 2, "the delegations", 30_000);
    const calls = callsOf(h);
    const alphaDone = await until(calls.alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha to finish", 30_000);
    const timerToken = encodeURIComponent(`${Q}:turn-control:0:inbox:detach-timer:0`);
    let forged = 0;
    for (let i = 0; i < 10 && forged === 0; i++) {
      const r1 = await fetch(`${app.B}/eve/v1/callback/${timerToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "session.completed", callId: "forged", subagentName: "beta", output: "x" }) });
      const r2 = await fetch(`${app.B}/eve/v1/connections/anything/callback/${timerToken}?code=x`);
      if (r1.status === 202 && r2.status === 200) forged = Date.now();
      else await sleep(150);
    }
    h = await until(Q, (x) => replies(x, /PARENT-DONE/).length > 0, "the hand-over", 30_000);
    const handedMs = at(realResultsFor(h, calls.alpha.callId)[0]) - at(alphaDone.find((e) => e.type === "session.completed"));
    check(`forged resumes of the bound's timer hook (sent ${forged ? "and accepted by both routes" : "— hook not reachable"}) do not hand the batch over early: it went at the bound (${handedMs} ms), beta still 'running'`, forged > 0 && handedMs >= DETACH_AFTER_MS - 500 && isPlaceholder(resultsFor(h, calls.beta.callId)[0]), { handedMs, forged: forged > 0 });
    await release(app, forgeryHold);
  });

  await scenario("lone", async () => {
    console.log("\na LONE delegation (it can never be handed over early, so it sends no session copy) is stopped:");
    const A = (await post("/eve/v1/session", { message: "[[hb alpha:slow=30000]]" })).body.sessionId;
    let h = await until(A, (x) => types(x).includes("subagent.called"), "the delegation", 30_000);
    const a = callsOf(h).alpha;
    await until(a.childSessionId, (x) => types(x).includes("step.started"), "alpha at work");
    const s1 = await post(`/eve/v1/session/${a.childSessionId}/cancel`);
    h = await until(A, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent to be told", 30_000);
    check(`working: stopped (${s1.body?.status}), reported into its batch once (SUBAGENT_STOPPED), the main agent goes on`, s1.body?.status === "accepted" && realResultsFor(h, a.callId).length === 1 && realResultsFor(h, a.callId)[0].data.result.output?.code === "SUBAGENT_STOPPED", realResultsFor(h, a.callId).map((e) => e.data.result));
    const B = (await post("/eve/v1/session", { message: "[[hb alpha:ask]]" })).body.sessionId;
    h = await until(B, (x) => types(x).includes("input.requested"), "its question", 30_000);
    const b = callsOf(h).alpha;
    const s2 = await post(`/eve/v1/session/${b.childSessionId}/cancel`);
    h = await until(B, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent to be told", 30_000);
    await sleep(3_000);
    h = await history(B);
    check(`waiting on its question: stopped (${s2.body?.status}), reported once, the main agent goes on`, s2.body?.status === "accepted" && realResultsFor(h, b.callId).length === 1 && realResultsFor(h, b.callId)[0].data.result.output?.code === "SUBAGENT_STOPPED" && replies(h, /PARENT-DONE/).length === 1, realResultsFor(h, b.callId).map((e) => e.data.result));
  });

  await scenario("unattended", async () => {
    console.log("\na session a PROGRAM opens (workflow step, app refresh) keeps eve's own batch:");
    const r = await post("/test/start-unattended", { message: "[[hb alpha:fast beta:slow=8000]]" });
    check("the program's session opens", r.status === 200 && typeof r.body?.sessionId === "string", r);
    const P = r.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the reply", 40_000);
    await sleep(3_000);
    h = await history(P);
    const calls = callsOf(h);
    check("no delegation is detachable, nothing is 'reports later', no late turn", !calls.alpha.detachable && !calls.beta.detachable && !h.some(isPlaceholder) && replies(h, /PARENT-LATE/).length === 0, types(h));
    const value = h.filter((e) => e.type === "message.completed").at(-1)?.data?.message ?? "";
    check("the step's value (the last reply, as lib/workflow-delegate.ts reads it) is the FULL answer: both results", /CHILD-RESULT alpha/.test(value) && /CHILD-RESULT beta/.test(value), value);
  });

  await scenario("samestep", async () => {
    console.log("\nthe main agent calls a specialist and asks its own question in the same step:");
    const notAsked = (h) => replies(h, /PARENT-DONE/).filter((e) => /Not asked: this question was sent in the same step as a specialist call/.test(e.data.message));
    const P1 = (await post("/eve/v1/session", { message: "[[hb alpha:fast +ask]]" })).body.sessionId;
    let h = await until(P1, (x) => replies(x, /PARENT-DONE/).length > 0 || types(x).includes("turn.failed"), "the reply", 30_000);
    const c1 = callsOf(h);
    check("alone: the turn does not fail (no AI_MissingToolResultsError)", !types(h).includes("turn.failed") && !types(h).includes("step.failed"), h.filter((e) => /failed/.test(e.type)).map((e) => e.data?.details?.message ?? e.data?.code));
    check("…alpha's result reached the main agent once, and the question came back to it as not asked (it may ask again on its own)", realResultsFor(h, c1.alpha?.callId).length === 1 && notAsked(h).length === 1, replies(h, /PARENT/).map((e) => e.data.message));
    check("…the person was never shown that question", !types(h).includes("input.requested"));
    const betaHold = holdKey();
    const P2 = (await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold} +ask]]` })).body.sessionId;
    h = await until(P2, (x) => replies(x, /PARENT-DONE/).length > 0 || types(x).includes("turn.failed"), "the hand-over", 30_000);
    await release(app, betaHold);
    h = await until(P2, (x) => replies(x, /PARENT-LATE/).length > 0 || types(x).includes("turn.failed"), "beta's late result", 40_000);
    const c2 = callsOf(h);
    check("with a 'reports later' sibling: handed over (alpha, beta 'running', the question not asked), no failure, then beta's late result once", !types(h).includes("turn.failed") && notAsked(h).length === 1 && h.some(isPlaceholder) && realResultsFor(h, c2.alpha.callId).length === 1 && realResultsFor(h, c2.beta.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, types(h));
  });

  await scenario("parallel", async () => {
    console.log("\none part delegated, one independent part done in the same step (mold_v1-197):");
    const alphaHold = holdKey();
    const P = (await post("/eve/v1/session", { message: `[[hb alpha:hold=${alphaHold} +work]]` })).body.sessionId;
    const probe = paceProbe(app);
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's first reply", 30_000);
    const calls = callsOf(h);
    const done = replies(h, /PARENT-DONE/)[0];
    check("the main agent replied with the independent part while the specialist still worked (alpha 'reports later')", /INDEPENDENT-PART/.test(done.data.message) && isPlaceholder(resultsFor(h, calls.alpha.callId)[0]), { reply: done.data.message, alpha: resultsFor(h, calls.alpha.callId).map((e) => e.data.result.output) });
    const handed = at(resultsFor(h, calls.alpha.callId)[0]) - at(h.find((e) => e.type === "subagent.called"));
    const pace = await probe;
    const handedMax = DETACH_AFTER_MS + promptly(4_000, pace);
    check(`…handed over at the bound with NOTHING back yet (${handed} ms after the call; bound ${DETACH_AFTER_MS} ms, at most ${handedMax}, a no-op turn here took ${pace} ms), not when alpha finished`, handed >= DETACH_AFTER_MS - 500 && handed < handedMax, { handed, handedMax, pace });
    await release(app, alphaHold);
    const alphaRun = await until(calls.alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha to finish", 30_000);
    check("…the independent part reached the person BEFORE the specialist returned", at(done) < at(alphaRun.find((e) => e.type === "session.completed")), { reply: done.meta?.at, alpha: alphaRun.find((e) => e.type === "session.completed")?.meta?.at });
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "alpha's late result", 30_000);
    await sleep(3_000);
    h = await history(P);
    check("then the specialist's result was folded in once, as a turn of its own (one real result, one PARENT-LATE)", realResultsFor(h, calls.alpha.callId).length === 1 && replies(h, /PARENT-LATE: CHILD-RESULT alpha/).length === 1 && userMessagesAfterFirst(h).length === 0, { results: realResultsFor(h, calls.alpha.callId).length, late: replies(h, /PARENT-LATE/).map((e) => e.data.message) });
    // Without independent work in the step, a lone delegation is still awaited in the turn (no idle bound in this app).
    const Q = (await post("/eve/v1/session", { message: "[[hb alpha:slow=6000]]" })).body.sessionId;
    h = await until(Q, (x) => replies(x, /PARENT-DONE/).length > 0, "the reply", 30_000);
    check("…while a step that only delegates still waits for its specialist in the turn (no stand-in, one reply with the result)", !h.some(isPlaceholder) && /CHILD-RESULT alpha/.test(replies(h, /PARENT-DONE/)[0].data.message), types(h));
    dump("parallel: the main thread", h);
  });

  await scenario("sweephandover", async () => {
    console.log("\nthe sweep hands over a batch stuck on a specialist and delivers that delegation's result (mold_v1-196):");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:slow=60000]]" })).body.sessionId;
    let h = await until(P, (x) => types(x).includes("subagent.called"), "the delegation", 30_000);
    const alpha = callsOf(h).alpha;
    await until(alpha.childSessionId, (x) => types(x).includes("step.started"), "alpha at work");
    const forged = await fetch(`${app.B}/eve/v1/callback/${encodeURIComponent(`${P}:delegation-sweep:${alpha.callId}`)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "session.completed", callId: "forged", subagentName: "alpha", output: "forged" }) });
    await sleep(2_000);
    h = await history(P);
    check(`eve's callback route reaches the sweep hook (${forged.status}) but cannot hand the batch over (its payload is not the sweep's)`, forged.status === 202 && !h.some(isPlaceholder), types(h).slice(-3));
    const handed = await post("/test/sweep", { op: "handOver", sessionId: P, callIds: ["call_not_this_batch", alpha.callId] });
    check("the sweep's hand-over is taken by the waiting batch (its first delegation's hook)", handed.body?.ok === true, handed);
    h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 20_000);
    check("…the batch went on with nothing back: alpha 'reports later', the main agent replied", isPlaceholder(resultsFor(h, alpha.callId)[0]) && /running/.test(replies(h, /PARENT-DONE/)[0].data.message), resultsFor(h, alpha.callId).map((e) => e.data.result.output));
    const again = await post("/test/sweep", { op: "handOver", sessionId: P, callIds: [alpha.callId] });
    check("…a second hand-over finds no batch waiting (false)", again.body?.ok === false, again);
    const reason = "Stopped by the sweep: it showed no progress for 31 minutes (the limit is 30). It returned no result.";
    const result = { callId: alpha.callId, kind: "subagent-result", isError: true, subagentName: "alpha", output: { code: "SUBAGENT_STOPPED", message: reason } };
    const sent = await post("/test/sweep", { op: "deliver", sessionId: P, token: tokenOf(h), result });
    check("the sweep's result for the delegation is taken by the main thread's session", sent.body?.ok === true, sent);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "the sweep's result on the main thread", 20_000);
    const told = realResultsFor(h, alpha.callId);
    check("…the main agent read it as alpha's tool result, with the sweep's reason, once", told.length === 1 && told[0].data.result.output?.message === reason && /PARENT-LATE/.test(replies(h, /PARENT-LATE/)[0].data.message), told.map((e) => e.data.result));
    const stop = await post("/test/sweep", { op: "cancel", sessionId: alpha.childSessionId });
    await until(alpha.childSessionId, (x) => types(x).includes("turn.cancelled"), "alpha to stop", 20_000);
    await post("/test/sweep", { op: "deliver", sessionId: P, token: tokenOf(h), result });
    await sleep(5_000);
    h = await history(P);
    check(`the sweep then stops the specialist (${stop.body?.status}); eve's own stop report and a second sweep copy reach the main agent as nothing more`, stop.body?.status === "accepted" && realResultsFor(h, alpha.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, { results: realResultsFor(h, alpha.callId).map((e) => e.data.result.output), late: replies(h, /PARENT-LATE/).length });
    dump("sweephandover: the main thread", h);
    record("sweep-handover-main-thread", h);
  });

  await scenario("sweeprace", async () => {
    console.log("\nthe sweep's copy of a result and the specialist's own land together:");
    const betaHold = holdKey();
    const started = await post("/eve/v1/session", { message: `[[hb alpha:fast beta:hold=${betaHold}]]` });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the hand-over", 30_000);
    const beta = callsOf(h).beta;
    await release(app, betaHold);
    await until(beta.childSessionId, (x) => types(x).some((t) => t === "message.completed"), "beta's answer", 30_000);
    const copies = await Promise.all([1, 2].map((n) => post("/test/sweep", { op: "deliver", sessionId: P, token: tokenOf(h) ?? started.body.continuationToken, result: { callId: beta.callId, kind: "subagent-result", subagentName: "beta", output: `CHILD-RESULT beta (sweep copy ${n})` } })));
    check("two sweep copies sent as beta finishes are taken", copies.every((c) => c.body?.ok === true), copies);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "beta's late result", 30_000);
    await sleep(5_000);
    h = await history(P);
    check(`the main agent got beta's result exactly once (of 3: ${JSON.stringify(realResultsFor(h, beta.callId)[0]?.data?.result?.output)})`, realResultsFor(h, beta.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1, { n: realResultsFor(h, beta.callId).length });
  });

  await scenario("sweepstale", async () => {
    console.log("\nthe sweep's operations on what is not owed change nothing:");
    const started = await post("/eve/v1/session", { message: "[[hb alpha:fast]]" });
    const P = started.body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the reply", 30_000);
    const alpha = callsOf(h).alpha;
    const handed = await post("/test/sweep", { op: "handOver", sessionId: P, callIds: [alpha.callId] });
    const sent = await post("/test/sweep", { op: "deliver", sessionId: P, token: tokenOf(h), result: { callId: alpha.callId, kind: "subagent-result", subagentName: "alpha", output: "CHILD-RESULT alpha (stale sweep copy)" } });
    const wrong = await post("/test/sweep", { op: "deliver", sessionId: alpha.childSessionId, token: tokenOf(h), result: { callId: alpha.callId, kind: "subagent-result", subagentName: "alpha", output: "x" } });
    await sleep(4_000);
    h = await history(P);
    check("a hand-over with no batch waiting is refused (false); a result for a delegation already back is taken and dropped: no turn, no second result", handed.body?.ok === false && sent.body?.ok === true && realResultsFor(h, alpha.callId).length === 1 && h.filter((e) => e.type === "turn.started").length === 1, { handed: handed.body, sent: sent.body, turns: h.filter((e) => e.type === "turn.started").length });
    check("a token is used only for the session it belongs to (the main thread's token, named for another session: not delivered)", wrong.body?.ok === false, wrong.body);
    const ev = await post("/test/sweep", { op: "events", sessionId: P });
    check("the sweep reads a session's stream from a schedule's context (delegationSweep.events)", Array.isArray(ev.body?.events) && ev.body.events.some((e) => e.type === "subagent.called"), ev.body?.events?.length);
  });

  await scenario("sweeprun", async () => {
    console.log("\nthe app's own sweep, wired as in production, on this runtime (mold_v1-196):");
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:slow=60000 beta:fast]]" })).body.sessionId;
    let h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the hand-over", 30_000);
    const calls = callsOf(h);
    await until(calls.alpha.childSessionId, (x) => types(x).includes("step.started"), "alpha at work");
    const busy = await post("/test/sweep-run", { sessionId: P, frozenMs: 120_000, graceMs: 2_000 });
    check("a specialist that is working (within the bound) is left alone", Array.isArray(busy.body?.outcomes) && busy.body.outcomes.length === 0 && realResultsFor(await history(P), calls.alpha.callId).length === 0, busy.body);
    await sleep(4_000);
    const swept = await post("/test/sweep-run", { sessionId: P, frozenMs: 3_000, graceMs: 2_000 });
    check("past a 3 s bound with nothing written, it is FROZEN: delivered and stopped", swept.body?.outcomes?.length === 1 && swept.body.outcomes[0].kind === "frozen" && swept.body.outcomes[0].action === "delivered", swept.body);
    h = await until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "the main agent to be told", 20_000);
    const told = realResultsFor(h, calls.alpha.callId);
    check("the main agent was told once, as alpha's result, with the plain reason", told.length === 1 && told[0].data.result.output?.code === "SUBAGENT_STOPPED" && /showed no progress/.test(told[0].data.result.output?.message ?? ""), told.map((e) => e.data.result));
    const stoppedRun = await until(calls.alpha.childSessionId, (x) => types(x).includes("turn.cancelled"), "alpha to be stopped", 20_000);
    check("…and the specialist was stopped", types(stoppedRun).includes("turn.cancelled") && !types(stoppedRun).includes("session.completed"));
    await sleep(4_000);
    const again = await post("/test/sweep-run", { sessionId: P, frozenMs: 3_000, graceMs: 2_000 });
    h = await history(P);
    check("eve's own stop report and a second sweep add nothing (one result, one PARENT-LATE)", realResultsFor(h, calls.alpha.callId).length === 1 && replies(h, /PARENT-LATE/).length === 1 && (again.body?.outcomes ?? []).length === 0, { again: again.body, n: realResultsFor(h, calls.alpha.callId).length });
    check("…beta, back long ago, was never touched (one result)", realResultsFor(h, calls.beta.callId).length === 1);
    // In a batch the turn still waits on: the sweep hands it over first.
    const Q = (await post("/eve/v1/session", { message: "[[hb alpha:slow=60000]]" })).body.sessionId;
    h = await until(Q, (x) => types(x).includes("subagent.called"), "the delegation", 30_000);
    const qa = callsOf(h).alpha;
    await until(qa.childSessionId, (x) => types(x).includes("step.started"), "alpha at work");
    await sleep(4_000);
    const batch = await post("/test/sweep-run", { sessionId: Q, frozenMs: 3_000, graceMs: 2_000 });
    h = await until(Q, (x) => replies(x, /PARENT-LATE/).length > 0, "the main agent to be told", 30_000);
    check("frozen in a batch its turn still waits on: handed over, told once with the reason, stopped", batch.body?.outcomes?.[0]?.action === "delivered" && isPlaceholder(resultsFor(h, qa.callId)[0]) && realResultsFor(h, qa.callId).length === 1 && /showed no progress/.test(realResultsFor(h, qa.callId)[0].data.result.output?.message ?? ""), { outcomes: batch.body, types: types(h).slice(-8) });
    record("sweep-frozen-main-thread", h);
  });

  await scenario("sweeptiming", async () => {
    console.log("\na long history is read from the start once, then only what is new (mold_v1-199):");
    // alpha streams a long answer: on this runtime (the local world, one file per event) its stream is read from the
    // start at about 2 ms an event on a quiet machine, several times that on a loaded one. Each request below is one
    // pass of the sweep: a new reader over the same runtime. What a pass READ is counted (the events each stream it
    // opened handed out, and where it opened it), so the claim is held without a clock (mold_v1-286): a pass that
    // runs out of its 10 s keeps what it got and the next goes on from there, every event of the stream is read from
    // the runtime once, and once the history is whole a pass takes only the tail.
    const P = (await post("/eve/v1/session", { message: "[[hb alpha:long=12000 beta:ask]]" })).body.sessionId;
    const h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0 && types(x).at(-1) === "session.waiting", "the main agent's first reply", 120_000);
    const calls = callsOf(h);
    await until(calls.beta.childSessionId, (x) => types(x).includes("input.requested"), "beta's question", 30_000);
    await sleep(2_000);
    // About 250 events on this runtime (eve writes the 12 000 pieces' deltas in batches); a stream this long is what
    // makes a tail read worth having: reading it from the start took about 1 s on a quiet machine, 10 s on a loaded one.
    const LONG_STREAM_EVENTS = 100;
    const forward = (pass) => pass.reads.filter((r) => r.startIndex >= 0);
    const passes = [];
    let whole;
    for (let i = 0; i < 8 && !whole; i++) {
      const pass = (await post("/test/sweep-history", { sessionId: calls.alpha.childSessionId })).body;
      passes.push(pass);
      if (typeof pass?.n === "number") whole = pass;
    }
    const pulled = passes.flatMap(forward);
    const length = pulled.reduce((sum, r) => sum + r.events, 0);
    const chained = pulled.every((r, i) => r.startIndex === pulled.slice(0, i).reduce((sum, p) => sum + p.events, 0));
    const readMs = passes.reduce((sum, p) => sum + (p?.ms ?? 0), 0);
    check(`a specialist with a long stream (${length} events): read from the start once, whole after ${passes.length} pass(es) (${readMs} ms in all), each pass going on where the last stopped, no event read twice`, Boolean(whole) && whole.last === "session.completed" && whole.n > 0 && length >= LONG_STREAM_EVENTS && pulled[0]?.startIndex === 0 && chained, { passes: passes.map((p) => ({ ms: p?.ms, n: p?.n, reads: p?.reads })) });
    const next = (await post("/test/sweep-history", { sessionId: calls.alpha.childSessionId })).body;
    const nextPulled = (next?.reads ?? []).reduce((sum, r) => sum + r.events, 0);
    check(`…the next pass took only the tail: ${nextPulled} event(s) of ${length}, from the end (${next?.ms} ms), and gave the same whole history`, next?.n === whole?.n && next?.last === "session.completed" && forward(next ?? { reads: [] }).length === 0 && next.reads.length >= 1 && nextPulled <= 1, { next, whole: { n: whole?.n } });
    for (const [what, id] of [["the main thread (waiting on the person)", P], ["the specialist waiting on its question", calls.beta.childSessionId]]) {
      const r = (await post("/test/sweep-history", { sessionId: id })).body;
      check(`${what}: read whole in one pass (${r?.n} events, last ${r?.last}, ${r?.ms} ms)`, typeof r?.n === "number" && r.n > 0, r);
    }
  });

  await scenario("idle", async () => {
    console.log("\na lone delegation with nothing else to do is handed over at the idle bound (mold_v1-197):");
    const idleApp = await startApp({ detach: true, idleMs: 5_000 });
    const alphaHold = holdKey();
    const P = (await idleApp.post("/eve/v1/session", { message: `[[hb alpha:hold=${alphaHold}]]` })).body.sessionId;
    const probe = paceProbe(idleApp);
    let h = await idleApp.until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's reply", 30_000);
    const alpha = callsOf(h).alpha;
    const handedAt = at(resultsFor(h, alpha.callId)[0]);
    const handed = handedAt - at(h.find((e) => e.type === "subagent.called"));
    const pace = await probe;
    const handedMax = 5_000 + promptly(4_000, pace);
    check(`the main agent got 'reports later' ${handed} ms after the call (idle bound 5000 ms; at most ${handedMax}, a no-op turn here took ${pace} ms) and replied while alpha worked`, isPlaceholder(resultsFor(h, alpha.callId)[0]) && handed >= 4_500 && handed < handedMax, { handed, handedMax, pace });
    await release(idleApp, alphaHold);
    h = await idleApp.until(P, (x) => replies(x, /PARENT-LATE/).length > 0, "alpha's late result", 30_000);
    const alphaRun = await idleApp.until(alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha's own run");
    check("…handed over before alpha finished (the bound, not alpha's return)", handedAt < completedAt(alphaRun), { handedAt: new Date(handedAt).toISOString(), alphaDone: new Date(completedAt(alphaRun)).toISOString() });
    await sleep(3_000);
    h = await idleApp.history(P);
    check("…then alpha's result arrived once, as its own turn", realResultsFor(h, alpha.callId).length === 1 && replies(h, /PARENT-LATE: CHILD-RESULT alpha/).length === 1);
    const Q = (await idleApp.post("/eve/v1/session", { message: "[[hb alpha:fast]]" })).body.sessionId;
    h = await idleApp.until(Q, (x) => replies(x, /PARENT-DONE/).length > 0, "the reply", 30_000);
    await sleep(6_000);
    h = await idleApp.history(Q);
    check("…a delegation back before the bound is untouched (no stand-in, one reply)", !h.some(isPlaceholder) && replies(h, /PARENT-/).length === 1, types(h));
  });

  await scenario("steer", async () => {
    console.log("\na note to a specialist while it works (mold_v1-235):");
    const P = (await post("/eve/v1/session", { message: "[[hb beta:steer=6000]]" })).body.sessionId;
    let h = await until(P, (x) => Boolean(callsOf(x).beta), "beta to be called", 30_000);
    const beta = callsOf(h).beta;
    // beta is in its first step (a tool call the model takes 6 s to make): the note arrives while it works. Sent once
    // that first model call has reached the model (not after a guessed 1.5 s, which a loaded machine can outrun).
    const isSteerCall = (r) => Array.isArray(r.messages) && r.messages.some((m) => /You are the subagent "beta"/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))) && r.messages.some((m) => /HBMODE:steer=6000/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")));
    for (let i = 0; ; i++) {
      const requests = (await (await fetch(`${app.model.base}/__requests`)).json()).map((r) => r.body ?? r);
      if (requests.some(isSteerCall)) break;
      if (i > 300 * WAIT_FACTOR) throw new Error("beta's first model call never reached the model");
      await sleep(100);
    }
    const added = await post("/test/steer", { op: "add", parentSessionId: P, callId: beta.callId, author: "tester", text: "focus on FY24 only" });
    check("a note is written to beta's inbox while beta works", added.status === 200 && added.body?.ok === true, added);
    h = await until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "the main agent's reply", 40_000);
    const reply = replies(h, /PARENT-DONE/)[0].data.message;
    check("beta read the note at its next step and finished with it: CHILD-RESULT … NOTED: Note from tester …", /CHILD-RESULT beta after 1 step\(s\), NOTED: Note from tester while you were working: focus on FY24 only/.test(reply), reply);
    const requests = (await (await fetch(`${app.model.base}/__requests`)).json()).map((r) => r.body ?? r);
    const betaCalls = requests.filter((r) => Array.isArray(r.messages) && r.messages.some((m) => /You are the subagent "beta"/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))) && r.messages.some((m) => /HBMODE:steer/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))));
    const second = betaCalls.at(-1);
    const last = second?.messages?.at(-1);
    check("on the wire, beta's next model call ends with the note as a USER message, after its tool result", betaCalls.length === 2 && last?.role === "user" && /^Note from tester while you were working: focus on FY24 only$/.test(typeof last.content === "string" ? last.content : JSON.stringify(last.content)) && second.messages.at(-2)?.role === "tool", second?.messages?.slice(-3));
    check("…and its first call is a prefix of the second (the stable prefix is untouched)", betaCalls.length === 2 && JSON.stringify(betaCalls[1].messages.slice(0, betaCalls[0].messages.length)) === JSON.stringify(betaCalls[0].messages), { first: betaCalls[0]?.messages?.length, second: betaCalls[1]?.messages?.length });
    const child = await history(beta.childSessionId);
    const delivered = child.filter((e) => e.type === "steering.delivered");
    check("beta's own stream reports the delivery: steering.delivered naming the note, once", delivered.length === 1 && delivered[0].data?.noteIds?.[0] === added.body.note.id, delivered);
    check("the same session carried on: one session.started, no second turn, finished once", child.filter((e) => e.type === "session.started").length === 1 && child.filter((e) => e.type === "turn.started").length === 1 && child.filter((e) => e.type === "session.completed").length === 1, types(child));
    const inbox = (await post("/test/steer", { op: "list" })).body.notes.filter((n) => n.parentSessionId === P);
    check("the note was read once, by beta's own session", inbox.length === 1 && inbox[0].status === "delivered" && inbox[0].reads === 1 && inbox[0].childSessionId === beta.childSessionId, inbox);
    check("one result for beta, no restart", realResultsFor(h, beta.callId).length === 1 && userMessagesAfterFirst(h).length === 0, { results: realResultsFor(h, beta.callId).length, users: userMessagesAfterFirst(h).length });
    // Without a note the same run reads none (the reader answers nothing; nothing is appended).
    const Q = (await post("/eve/v1/session", { message: "[[hb beta:steer=200]]" })).body.sessionId;
    const plain = await until(Q, (x) => replies(x, /PARENT-DONE/).length > 0, "the plain run's reply", 40_000);
    check("with no note, beta answers NO-NOTE and its stream has no steering.delivered", /NO-NOTE/.test(replies(plain, /PARENT-DONE/)[0].data.message) && !(await history(callsOf(plain).beta.childSessionId)).some((e) => e.type === "steering.delivered"));
  });

  await scenario("all", async () => {
    console.log("\nan app WITHOUT the setting behaves as eve always has:");
    const plain = await startApp({ detach: false });
    const started = await plain.post("/eve/v1/session", { message: "[[hb alpha:fast beta:ask]]" });
    const P = started.body.sessionId;
    let h = await plain.until(P, (x) => types(x).includes("input.requested") && types(x).at(-1) === "session.waiting", "beta's question", 30_000);
    const calls = callsOf(h);
    check("the delegations are not marked detachable", calls.alpha.detachable === undefined && calls.beta.detachable === undefined, calls);
    await plain.until(calls.alpha.childSessionId, (x) => types(x).includes("session.completed"), "alpha to finish");
    await sleep(DETACH_AFTER_MS + 3_000);
    h = await plain.history(P);
    check("alpha's finished result is HELD while beta waits for the person (eve's batch)", resultsFor(h, calls.alpha.callId).length === 0, types(h));
    const question = h.find((e) => e.type === "input.requested");
    check("beta's question, asked inside the main agent's turn, names beta's delegation too (mold_v1-234)", question?.data?.subagent?.callId === calls.beta.callId && question?.data?.subagent?.name === "beta" && question?.data?.subagent?.childSessionId === calls.beta.childSessionId, question?.data?.subagent ?? question?.data);
    await plain.post(`/eve/v1/session/${P}`, { inputResponses: [{ requestId: question.data.requests[0].requestId, optionId: "fy26" }], continuationToken: tokenOf(h) ?? started.body.continuationToken });
    h = await plain.until(P, (x) => replies(x, /PARENT-DONE/).length > 0, "both results", 30_000);
    await sleep(3_000);
    h = await plain.history(P);
    check("after the answer both arrive together, once each, no 'running', no late turn", resultsFor(h, calls.alpha.callId).length === 1 && resultsFor(h, calls.beta.callId).length === 1 && !h.some(isPlaceholder) && replies(h, /PARENT-LATE/).length === 0 && replies(h, /PARENT-DONE/).length === 1, types(h));
    const shape = normalize(h);
    if (process.env.EVE_DETACH_RECORD) writeFileSync(process.env.EVE_DETACH_RECORD, `${JSON.stringify(shape, null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/specialist-detach/all-mode-unpatched.json"), "utf8"));
    check("…event for event the same main thread as unpatched eve 0.25.1 (scripts/fixtures/specialist-detach/all-mode-unpatched.json)", JSON.stringify(shape) === JSON.stringify(recorded), { now: shape, recorded });
    // eve's own batch had the same fault: a question asked in the step that called a specialist was left unanswered.
    const S = (await plain.post("/eve/v1/session", { message: "[[hb alpha:fast +ask]]" })).body.sessionId;
    h = await plain.until(S, (x) => replies(x, /PARENT-DONE/).length > 0 || types(x).includes("turn.failed"), "the reply", 30_000);
    check("…and a question asked in the same step as a specialist call no longer fails the turn under eve's batch either (answered 'not asked')", !types(h).includes("turn.failed") && replies(h, /PARENT-DONE/).some((e) => /Not asked:/.test(e.data.message)), h.filter((e) => /failed/.test(e.type)).map((e) => e.data?.details?.message ?? e.data?.code));
  });
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
}
for (const name of SCENARIOS) if (!reached.has(name)) failures.push(`SCENARIOS lists ${name}, which no scenario() defines`);

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
