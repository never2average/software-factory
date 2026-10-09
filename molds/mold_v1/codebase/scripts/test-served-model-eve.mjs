/**
 * THE SERVED-MODEL NOTE REACHES A SPECIALIST'S OWN HOOK — on the REAL eve runtime (the installed eve), with a
 * scripted model. No provider, no network, no microVM.
 *
 * A specialist's run is priced at the model that served each step (agent/lib/workflow-usage.ts). eve's
 * `step.completed` does not carry a model id, so the model boundary notes it (`servedModelNote`, agent/lib/served-model.ts)
 * in a `defineState` slot and the hook takes it (`takeServedModel`). That rests on one runtime fact a unit test cannot
 * show: the model middleware and a subagent's hooks run inside the SAME eve context, and the root's do not share it.
 * So this runs it: a root agent and one declared specialist (`alpha`), each on the scripted model wrapped in its own
 * note, and a hook on each that writes what it takes on every `step.completed`. The app is written into a temporary
 * directory, served by `eve dev --no-ui`, and removed afterwards — the shape of scripts/test-specialist-batch.mjs.
 *
 * Run:  npm run test:served-model-eve      (about 20 s; EVE_SERVED_KEEP=1 keeps the temporary app)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const APP = mkdtempSync(join(tmpdir(), "eve-served-model-"));
const LOG = join(APP, "served.ndjson");
const ROOT_MODEL = "probe/root-model";
const ALPHA_MODEL = "probe/specialist-model";
const SERVED = JSON.stringify(join(ROOT, "agent/lib/served-model.ts"));

const hook = (who) =>
  [
    'import { appendFileSync } from "node:fs";',
    'import { defineHook } from "eve/hooks";',
    `import { takeServedModel } from ${SERVED};`,
    "export default defineHook({",
    "  events: {",
    '    "step.completed"(event, ctx) {',
    `      appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ who: ${JSON.stringify(who)}, session: ctx.session.id, step: event.data.stepIndex, model: takeServedModel() }) + "\\n");`,
    "    },",
    "  },",
    "});",
  ].join("\n");

const files = {
  "package.json": JSON.stringify({ name: "eve-served-model", private: true, type: "module" }),
  "agent/model.ts": [
    'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
    'import { wrapLanguageModel } from "ai";',
    `import { servedModelNote } from ${SERVED};`,
    'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
    `export const rootModel = wrapLanguageModel({ model: provider.chatModel("scripted-model"), middleware: servedModelNote(${JSON.stringify(ROOT_MODEL)}) });`,
    `export const alphaModel = wrapLanguageModel({ model: provider.chatModel("scripted-model"), middleware: servedModelNote(${JSON.stringify(ALPHA_MODEL)}) });`,
  ].join("\n"),
  "agent/agent.ts": 'import { defineAgent } from "eve";\nimport { rootModel } from "./model.ts";\nexport default defineAgent({ model: rootModel, modelContextWindowTokens: 200000 });\n',
  "agent/instructions.md": "The main agent of a test app.\n",
  "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
  "agent/hooks/served.ts": hook("root"),
  "agent/subagents/alpha/agent.ts": 'import { defineAgent } from "eve";\nimport { alphaModel } from "../../model.ts";\nexport default defineAgent({ description: "Test specialist alpha.", model: alphaModel, modelContextWindowTokens: 200000 });\n',
  "agent/subagents/alpha/hooks/served.ts": hook("alpha"),
};
files["agent/subagents/alpha/sandbox.ts"] = files["agent/sandbox.ts"];
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
  if (!process.env.EVE_SERVED_KEEP && APP.startsWith(join(tmpdir(), "eve-served-model-"))) rmSync(APP, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const B = `http://127.0.0.1:${port}`;
{
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

const lines = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  console.log("a main agent delegates to a specialist; each notes its own model; each one's hook takes what it served:");
  const r = await fetch(`${B}/eve/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "[[hb alpha:fast]]" }) });
  const started = await r.json().catch(() => null);
  check("the main thread starts (202)", r.status === 202 && typeof started?.sessionId === "string", started);
  for (let i = 0; i < 240; i++) {
    const got = lines();
    if (got.some((l) => l.who === "alpha") && got.filter((l) => l.who === "root").length >= 2) break;
    await sleep(250);
  }
  const got = lines();
  const alpha = got.filter((l) => l.who === "alpha");
  const root = got.filter((l) => l.who === "root");
  check("the specialist's hook fired on its step", alpha.length >= 1, got);
  check(`…and took the model that served it (${ALPHA_MODEL}), across eve's own boundary from the model call to the hook`, alpha.length >= 1 && alpha.every((l) => l.model === ALPHA_MODEL), alpha);
  check("…on the specialist's own session, not the main thread's", alpha.length >= 1 && alpha.every((l) => l.session !== started?.sessionId), { alpha, main: started?.sessionId });
  check(`the main agent's hook took ITS model (${ROOT_MODEL}) on every step — the two contexts never mix`, root.length >= 2 && root.every((l) => l.model === ROOT_MODEL), root);
} finally {
  console.log(`\ntest-served-model-eve: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(eveLog.slice(-2000));
    process.exitCode = 1;
  }
  process.exit();
}
