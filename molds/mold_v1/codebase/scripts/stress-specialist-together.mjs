/**
 * TWO SPECIALISTS FINISHING TOGETHER, MANY TIMES: IS ANYTHING WRITTEN, OR ANY MODEL CALLED, TWICE? (mold_v1-191)
 *
 * On the REAL eve runtime (the installed eve 0.25.1 with patches/eve+0.25.1.patch), with a scripted model
 * (scripts/fake-model-server.mjs `--script handback`), served by `eve dev --no-ui` from a throwaway app (as
 * scripts/test-specialist-detach.mjs builds one). Each run is a new main thread whose message is
 * `[[hb alpha:fast beta:fast]] run=<n>`: the main agent calls both specialists in one step and both answer at once, so
 * their two results reach the main thread's turn together — the shape that, on the eve dev world during agent-workspace
 * #121, wrote a result, the main agent's next reply and turn.completed twice.
 *
 * Counted per run, from what the runtime itself wrote (nothing is collapsed here, unlike test:specialist-detach):
 *   - the main thread's stream: `action.result` per call id, `message.completed` with PARENT-DONE, `turn.completed`
 *     per turn id — each must appear exactly once;
 *   - the model's side (the fake model's own request log): the main agent's call that sees both results (the one
 *     that answers PARENT-DONE) — exactly once. Two would be a double charge and a double reply, not only a
 *     double write.
 * And, over the whole batch, from the runtime's debug log (`DEBUG=workflow:*`), how the two invocations that replay a
 * turn together (one per result) came apart: both tried to create the next step and the world let one through
 * (`lazyCreateLost`); the second saw the first one's start and armed the core's delayed backstop (`ownerSeenBackstop`);
 * the second saw the step created but not started, queued it, and the patched world refused that start
 * (`secondStartRefused`); or the step body ran twice (`stepCompletedTwice`: "Tried completing step, but step has
 * already finished"). docs/SPECIALIST_HANDBACK.md "Re-measured on the current patch".
 *
 *   npm run stress:specialist-together -- --mode all --runs 200 --concurrency 4     (about 25 minutes)
 *   node --experimental-strip-types scripts/stress-specialist-together.mjs [--runs 60] [--mode detach|all|both]
 *        [--concurrency 1] [--json out.json] [--log prefix] [--no-barrier] [--jitter-ms N [--jitter-writes]]
 *
 * The specialists' answers are released by the scripted model in the same tick (`--child-barrier 2`), so they finish
 * together; `--no-barrier` lets each answer as soon as it is asked (they then finish about 100 ms apart, and in 320 runs
 * no step ran twice even with the fix off). `--jitter-ms N` delays each read the local
 * world makes of its data by a random 0..N ms (scripts/lib/world-io-jitter.mjs), so replays overlap more often;
 * `--jitter-writes` delays its writes too.
 *
 * Exit 0 when every run finished with nothing written twice and one model call for the reply; 1 otherwise.
 * (EVE_STRESS_KEEP=1 keeps the temporary apps.)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, spawnFakeModel } from "./lib/own-listener.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RUNS = Number(arg("runs", "60"));
const MODE = arg("mode", "both");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "1")));
const JSON_OUT = arg("json", "");
const BARRIER = !argv.includes("--no-barrier");
const JITTER_MS = Number(arg("jitter-ms", "0"));
const JITTER_WRITES = argv.includes("--jitter-writes");
const LOG_OUT = arg("log", ""); // writes each mode's eve dev log (with DEBUG=workflow:*) to <log>.<mode>.log
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
process.on("exit", () => {
  for (const c of cleanups.reverse()) c();
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

async function startApp({ detach }) {
  const APP = mkdtempSync(join(tmpdir(), "eve-stress-191-"));
  const subagents = detach ? `, subagents: { batch: "detach", detachAfterMs: 10000 }` : "";
  const files = {
    "package.json": JSON.stringify({ name: "eve-stress-191", private: true, type: "module" }),
    "agent/model.ts": [
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
      'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
      'export const scripted = provider.chatModel("scripted-model");',
    ].join("\n"),
    "agent/agent.ts": `import { defineAgent } from "eve";\nimport { scripted } from "./model.ts";\nexport default defineAgent({ model: scripted, modelContextWindowTokens: 200000${subagents} });\n`,
    "agent/instructions.md": "The main agent of a test app.\n",
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
  // Both specialists' answers leave the model in the same tick, so the two finish together (not ~100 ms apart).
  const model = await spawnFakeModel(["--script", "handback", ...(BARRIER ? ["--child-barrier", "2"] : [])], { cwd: ROOT });
  const port = await freePort();
  const eve = spawn(join(ROOT, "node_modules/.bin/eve"), ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: APP,
    env: {
      ...process.env,
      SCRIPTED_MODEL_URL: `${model.base}/v1`,
      NO_COLOR: "1",
      DEBUG: process.env.DEBUG ?? "workflow:*",
      ...(JITTER_MS > 0 ? { EVE_STRESS_JITTER_MS: String(JITTER_MS), EVE_STRESS_JITTER_WRITES: JITTER_WRITES ? "1" : "0", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${join(ROOT, "scripts/lib/world-io-jitter.mjs")}`.trim() } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  eve.stdout.on("data", (d) => (log += d));
  eve.stderr.on("data", (d) => (log += d));
  const stop = () => {
    try {
      process.kill(-eve.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    model.stop();
    if (!process.env.EVE_STRESS_KEEP && APP.startsWith(join(tmpdir(), "eve-stress-191-"))) rmSync(APP, { recursive: true, force: true });
  };
  cleanups.push(stop);
  const B = `http://127.0.0.1:${port}`;
  const mine = new RegExp(`listening at https?://[^\\s]+:${port}\\b`);
  for (let i = 0; ; i++) {
    if (eve.exitCode !== null) throw new Error(`eve dev exited before listening:\n${log.slice(-3000)}`);
    if (mine.test(log) && (await fetch(`${B}/eve/v1/health`).then((r) => r.ok, () => false))) break;
    if (i > 600) throw new Error(`eve dev did not come up on :${port}:\n${log.slice(-3000)}`);
    await sleep(250);
  }
  return { B, model, log: () => log, stop };
}

/** A session's raw events (no deltas), read until the stream has been quiet for `quietMs`. */
async function history(B, id, quietMs = 700) {
  const ctrl = new AbortController();
  const out = [];
  let quiet;
  const arm = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => ctrl.abort(), quietMs);
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
            /* keep-alive */
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

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n") : "");
const countBy = (xs, key) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map());

/**
 * The duplicates in one main thread's stream. Exported shape (also used by scripts/rig-specialist-handback.mjs's
 * detector): every `action.result` per call id, `turn.completed` per turn id, and `message.completed` per
 * (turn, text) must be unique.
 */
export function duplicatesIn(events) {
  const dups = [];
  for (const [k, n] of countBy(events.filter((e) => e.type === "action.result"), (e) => `${e.data?.result?.callId}|${e.data?.result?.output?.status === "running" ? "placeholder" : "result"}`)) if (n > 1) dups.push(`action.result ${k} x${n}`);
  for (const [k, n] of countBy(events.filter((e) => e.type === "turn.completed"), (e) => e.data?.turnId)) if (n > 1) dups.push(`turn.completed ${k} x${n}`);
  for (const [k, n] of countBy(events.filter((e) => e.type === "message.completed"), (e) => `${e.data?.turnId}|${String(e.data?.message ?? "").slice(0, 80)}`)) if (n > 1) dups.push(`message.completed ${k} x${n}`);
  return dups;
}

async function oneRun(app, n) {
  const tag = `run=${n}-${Math.random().toString(36).slice(2, 8)}`;
  // Opening a session can fail on a loaded machine (eve dev answers an error): try again, a few times.
  let sessionId;
  for (let attempt = 0; attempt < 3 && !sessionId; attempt++) {
    if (attempt > 0) await sleep(2_000);
    const r = await fetch(`${app.B}/eve/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: `[[hb alpha:fast beta:fast]] ${tag}` }) }).catch(() => null);
    sessionId = (await r?.json().catch(() => null))?.sessionId;
  }
  if (!sessionId) return { n, sessionId: null, done: false, duplicates: [], finalModelCalls: 0, parentDoneMessages: 0, placeholders: 0, resultsSpreadMs: null, notOpened: true };
  // Generous: on a loaded machine a turn can stall for a minute; a run is "not done" only after three.
  const deadline = Date.now() + 180_000;
  let h = [];
  for (;;) {
    h = await history(app.B, sessionId);
    if (h.some((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? "")) && h.at(-1)?.type === "session.waiting") break;
    if (Date.now() > deadline) break;
    await sleep(300);
  }
  await sleep(1_500); // a duplicate lands tens of ms later; give it ample time
  // A long quiet window for the read that counts: on a loaded machine (or with --jitter-ms) eve can pause for more than
  // a second while it reads a stream back, and a short window would end the read early and miss the end of the turn.
  h = await history(app.B, sessionId, 3_000);
  const requests = await (await fetch(`${app.model.base}/__requests`)).json();
  // The main agent's model calls for this run that saw both results (the PARENT-DONE call).
  const finalCalls = requests.filter((p) => {
    const msgs = p.messages ?? [];
    const users = msgs.filter((m) => m.role === "user");
    const last = users.at(-1);
    if (!last || !textOf(last.content).includes(tag) || textOf(msgs[0]?.content).includes("You are the subagent")) return false;
    if (msgs.some((m) => textOf(m.content).includes("You are the subagent"))) return false;
    return msgs.slice(msgs.lastIndexOf(last) + 1).filter((m) => m.role === "tool").length >= 2;
  }).length;
  const results = h.filter((e) => e.type === "action.result");
  const resultTimes = results.map((e) => Date.parse(e.meta?.at ?? ""));
  return {
    n,
    sessionId,
    done: h.some((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? "")),
    duplicates: duplicatesIn(h),
    finalModelCalls: finalCalls,
    parentDoneMessages: h.filter((e) => e.type === "message.completed" && /PARENT-DONE/.test(e.data?.message ?? "")).length,
    placeholders: results.filter((e) => e.data?.result?.output?.status === "running").length,
    resultsSpreadMs: resultTimes.length > 1 ? Math.max(...resultTimes) - Math.min(...resultTimes) : null,
  };
}

async function batch(mode) {
  const app = await startApp({ detach: mode === "detach" });
  console.log(`\n${mode}: ${RUNS} runs, concurrency ${CONCURRENCY}${BARRIER ? ", specialists released together" : ""}${JITTER_MS ? `, world ${JITTER_WRITES ? "reads and writes" : "reads"} jittered 0..${JITTER_MS} ms` : ""}`);
  const runs = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const n = next++;
        if (n >= RUNS) return;
        const r = await oneRun(app, n);
        runs.push(r);
        const bad = !r.notOpened && (r.duplicates.length > 0 || r.finalModelCalls !== 1 || !r.done);
        if (r.notOpened) console.log(`  run ${n}: eve did not open a session (3 tries); not counted`);
        else if (bad) console.log(`  run ${n} ${r.sessionId}: ${!r.done ? "NOT DONE " : ""}model calls for the reply ${r.finalModelCalls}; ${r.duplicates.join("; ") || "no duplicate in the stream"}`);
        else if ((n + 1) % 10 === 0) console.log(`  ${n + 1} runs`);
      }
    }),
  );
  const log = app.log();
  // One debug record per line group (`[workflow:…] message { …fields }`), colours removed.
  const records = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\n(?=\[workflow:)/);
  const records_ = (...res) => records.filter((r) => res.every((re) => re.test(r))).length;
  const summary = {
    mode,
    runs: runs.filter((r) => !r.notOpened).length,
    notOpened: runs.filter((r) => r.notOpened).length,
    notDone: runs.filter((r) => !r.done && !r.notOpened).length,
    runsWithStreamDuplicates: runs.filter((r) => r.duplicates.length > 0).length,
    runsWithDoubleModelCall: runs.filter((r) => r.finalModelCalls > 1).length,
    // How the two invocations that replay a turn together came apart (the debug log; see the header):
    lazyCreateLost: records_(/Step in terminal state, skipping/, /already created/), // both tried to create it; one went
    ownerSeenBackstop: records_(/inline-owned by a live invocation/), // the second saw the first's start: delayed backstop
    secondStartRefused: records_(/Step in terminal state, skipping/, /already running inline in another invocation/), // queued; refused
    stepCompletedTwice: records_(/Tried completing step, but step has already finished/), // a step body ran twice
    resultsSpreadMsMedian: (() => {
      const xs = runs.map((r) => r.resultsSpreadMs).filter((x) => x !== null).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)] : null;
    })(),
  };
  console.log(`  ${JSON.stringify(summary)}`);
  if (LOG_OUT) writeFileSync(`${LOG_OUT}.${mode}.log`, log);
  app.stop();
  return { summary, runs };
}

const modes = MODE === "both" ? ["detach", "all"] : [MODE];
const out = [];
for (const m of modes) out.push(await batch(m));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
const bad = out.some((b) => b.summary.runsWithStreamDuplicates > 0 || b.summary.runsWithDoubleModelCall > 0 || b.summary.notDone > 0);
console.log(bad ? "\nDUPLICATES FOUND" : "\nno duplicate in any run");
process.exit(bad ? 1 : 0);
