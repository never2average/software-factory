/**
 * ONE SESSION, ONE MODEL INSTANCE — `x-session-affinity` on every Workers AI call (agent/lib/session-affinity.ts).
 *
 * Workers AI caches a prompt's prefix on the instance that computed it, and a hit needs the next call of the same
 * session to land there. Cloudflare routes on the `x-session-affinity` request header
 * (https://developers.cloudflare.com/workers-ai/features/prompt-caching/). Nothing sent it, and one workspace's
 * specialist runs recorded 39.6% of their input as cache reads (mold_v1-220).
 *
 * Read off the WIRE, at scripts/fake-model-server.mjs (`GET /__calls`), never off the source:
 *
 *   1. THE PROVIDER PATH, in this process: `agentModel` for every role — the orchestrator, the specialist, the
 *      vision model, and the empty-response fallback — sends the session's value; two sessions send two values; a
 *      call with no eve context sends none (there is no session to name).
 *   2. THE REAL eve RUNTIME (the installed eve 0.25.1 under `eve dev`, a throwaway app whose main agent and specialist
 *      run on THIS repo's `agentModel`): every call carries the header; one value for all the steps of the main
 *      agent's session, across turns; one value for all the steps of a specialist's own session, different from its
 *      parent's; a second conversation gets values of its own; and no value carries a person's address, a workspace
 *      name, or eve's own session id.
 *
 * Run:  npm run test:session-affinity      (about 30 s; EVE_AFFINITY_KEEP=1 keeps the temporary app)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const HEADER = "x-session-affinity";
const ORCHESTRATOR = "@cf/moonshotai/kimi-k2.6";
const SPECIALIST = "@cf/zai-org/glm-5.3";
const VISION = "@cf/zai-org/glm-5.3-flash";
/** What a value must never carry. The address and name are written into the conversation so they are there to leak. */
const PERSON = "analyst@example-bank.test";
const WORKSPACE = "Example Housing Finance";
const OPAQUE = /^ses_[0-9a-f]{24}$/;
const affinityOf = (call) => call.headers?.[HEADER] ?? null;
const leaks = (value, extra = []) =>
  [PERSON, WORKSPACE, PERSON.split("@")[0], "example", ...extra].some((s) => s && String(value).toLowerCase().includes(String(s).toLowerCase()));

const env = {
  MODEL_PROVIDER: "cloudflare",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_MODEL_ORCHESTRATOR: ORCHESTRATOR,
  CLOUDFLARE_MODEL_SPECIALIST: SPECIALIST,
  CLOUDFLARE_MODEL_VISION: VISION,
};

/* ---- 1. the provider path ------------------------------------------------------------------------------------ */

console.log("1. Every role's call on the Workers AI provider carries the session's value");
{
  const affinity = await import("../agent/lib/session-affinity.ts").catch((e) => ({ missing: String(e) }));
  check("there is a session-affinity module (agent/lib/session-affinity.ts)", !affinity.missing, affinity.missing);
  // Two empties, then an answer: the configured model and its same-model retry come back empty, the fallback answers.
  const fake = await spawnFakeModel(["--script", "empty-then-answer", "--empties", "2"], { cwd: ROOT });
  try {
    Object.assign(process.env, env, { CLOUDFLARE_BASE_URL: `${fake.base}/v1` });
    const { generateText, streamText } = await import("ai");
    const { agentModel } = await import("../agent/lib/model.ts");
    const calls = async () => (await fetch(`${fake.base}/__calls`)).json();
    let seen = 0;
    const fresh = async () => {
      const all = await calls();
      const out = all.slice(seen);
      seen = all.length;
      return out;
    };

    if (!affinity.missing) {
      const { __useSessionAffinitySlot, newSessionAffinityValue } = affinity;
      const A = newSessionAffinityValue();
      const B = newSessionAffinityValue();
      check(`a value is opaque: ses_ and 24 hex characters (${A})`, OPAQUE.test(A) && OPAQUE.test(B) && A !== B);
      // Session A: the slot eve scopes to a session, replaced by a plain one.
      const restore = __useSessionAffinitySlot({ get: () => A });
      try {
        const run = streamText({ model: agentModel("orchestrator"), prompt: "Summarise the filing." });
        await run.consumeStream();
        const recovered = await fresh();
        check(
          `the orchestrator's call, its retry and the FALLBACK model's answer all carry it (wire: ${recovered.map((c) => c.model).join(", ")})`,
          recovered.length === 3 && recovered[2].model === SPECIALIST && recovered.every((c) => affinityOf(c) === A),
          recovered.map((c) => [c.model, affinityOf(c)]),
        );
        await generateText({ model: agentModel("orchestrator"), prompt: "Next step." });
        await generateText({ model: agentModel("specialist"), prompt: "Work." });
        await generateText({ model: agentModel("vision"), prompt: "Describe the page." });
        const roles = await fresh();
        check(
          "the orchestrator, the specialist and the vision model each carry it",
          roles.length === 3 && roles.map((c) => c.model).join() === [ORCHESTRATOR, SPECIALIST, VISION].join() && roles.every((c) => affinityOf(c) === A),
          roles.map((c) => [c.model, affinityOf(c)]),
        );
        __useSessionAffinitySlot({ get: () => B });
        await generateText({ model: agentModel("specialist"), prompt: "Another conversation." });
        const other = await fresh();
        check("another session's call carries ITS value", other.length === 1 && affinityOf(other[0]) === B, other.map(affinityOf));
        __useSessionAffinitySlot({ get: () => `${PERSON}` });
        await generateText({ model: agentModel("specialist"), prompt: "A slot holding something else." });
        const odd = await fresh();
        check("a slot holding anything but an opaque value sends nothing (never an address)", odd.length === 1 && affinityOf(odd[0]) === null, odd.map(affinityOf));
      } finally {
        __useSessionAffinitySlot(restore);
      }
    }

    // No eve context (the real slot): no session, so no header rather than one value shared by unrelated callers.
    await generateText({ model: agentModel("specialist"), prompt: "Outside any session." }).catch(() => null);
    const outside = await fresh();
    check("a call with no eve context reaches the provider…", outside.length >= 1, outside.length);
    check("…and carries no affinity value (there is no session to name)", outside.every((c) => affinityOf(c) === null), outside.map(affinityOf));
  } finally {
    fake.stop();
  }
}

/* ---- 2. the real eve runtime --------------------------------------------------------------------------------- */

console.log("\n2. On the real eve runtime: one value per session, stable across its steps");
const APP = mkdtempSync(join(tmpdir(), "eve-session-affinity-"));
const MODEL_TS = join(ROOT, "agent/lib/model.ts");
const files = {
  "package.json": JSON.stringify({ name: "eve-session-affinity", private: true, type: "module" }),
  // THIS repo's model selector, unchanged: what is on the wire is what the deployed agent sends.
  "agent/model.ts": `export { agentModel } from ${JSON.stringify(MODEL_TS)};\n`,
  "agent/agent.ts": 'import { defineAgent } from "eve";\nimport { agentModel } from "./model.ts";\nexport default defineAgent({ model: agentModel("orchestrator"), modelContextWindowTokens: 200000 });\n',
  "agent/instructions.md": "The main agent of a test app.\n",
  "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
  "agent/subagents/alpha/agent.ts":
    'import { defineAgent } from "eve";\nimport { agentModel } from "../../model.ts";\nexport default defineAgent({ description: "Test specialist alpha.", model: agentModel("specialist"), modelContextWindowTokens: 200000 });\n',
  "agent/subagents/alpha/sandbox.ts":
    'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(join(APP, rel, ".."), { recursive: true });
  writeFileSync(join(APP, rel), text);
}
symlinkSync(join(ROOT, "node_modules"), join(APP, "node_modules"), "dir");

const model = await spawnFakeModel(["--script", "handback", "--subagent", "alpha"], { cwd: ROOT });
const port = await freePort();
const eve = spawn(join(ROOT, "node_modules/.bin/eve"), ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: APP,
  env: { ...process.env, ...env, CLOUDFLARE_BASE_URL: `${model.base}/v1`, NO_COLOR: "1" },
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
  if (!process.env.EVE_AFFINITY_KEEP && APP.startsWith(join(tmpdir(), "eve-session-affinity-"))) rmSync(APP, { recursive: true, force: true });
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
async function until(id, test, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const h = await history(id);
    if (test(h)) return h;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} on ${id}: ${h.map((e) => e.type).join(" ")}\n${eveLog.slice(-2000)}`);
    await sleep(300);
  }
}
const repliedWith = (pattern, count = 1) => (h) => h.filter((e) => e.type === "message.completed" && pattern.test(e.data?.message ?? "")).length >= count;
const calls = async () => (await fetch(`${model.base}/__calls`)).json();
const STEPS = 3;

try {
  // A conversation that names a person and a workspace, so there is something for a value to leak.
  const intro = `For ${PERSON} at ${WORKSPACE}: [[hb alpha:steps=${STEPS}]]`;
  const one = await post("/eve/v1/session", { message: intro });
  check("the first conversation starts (202)", one.status === 202 && typeof one.body?.sessionId === "string", one);
  const S1 = one.body.sessionId;
  let h1 = await until(S1, repliedWith(/PARENT-DONE/), "the first answer");
  const child1 = h1.find((e) => e.type === "subagent.called")?.data?.childSessionId;
  check(`the specialist worked in ${STEPS} tool steps and answered`, /after 3 steps/.test(h1.find((e) => e.type === "message.completed")?.data?.message ?? ""), h1.find((e) => e.type === "message.completed")?.data?.message);
  // A second turn on the same conversation: the main agent's value must outlive the turn.
  const token = [...h1].reverse().find((e) => e.type === "session.waiting")?.data?.continuationToken;
  const again = await post(`/eve/v1/session/${S1}`, { message: "And once more, plainly.", continuationToken: token });
  check("the same conversation takes a second turn (200)", again.status === 200, again);
  h1 = await until(S1, repliedWith(/PARENT-PLAIN/), "the second turn's answer");
  const afterFirst = await calls();

  const two = await post("/eve/v1/session", { message: `[[hb alpha:steps=${STEPS}]]` });
  const S2 = two.body?.sessionId;
  const h2 = await until(S2, repliedWith(/PARENT-DONE/), "the second conversation's answer");
  const child2 = h2.find((e) => e.type === "subagent.called")?.data?.childSessionId;
  const all = await calls();
  const firstRoot = afterFirst.filter((c) => c.child === null);
  const firstChild = afterFirst.filter((c) => c.child === "alpha");
  const later = all.slice(afterFirst.length);
  const secondRoot = later.filter((c) => c.child === null);
  const secondChild = later.filter((c) => c.child === "alpha");
  const values = (list) => [...new Set(list.map(affinityOf))];

  check(`every model call carries ${HEADER} (${all.length} calls)`, all.length > 0 && all.every((c) => typeof affinityOf(c) === "string" && affinityOf(c).length > 0), all.map((c) => [c.child, affinityOf(c)]));
  check(
    `the main agent's ${firstRoot.length} calls, over both turns, share ONE value`,
    firstRoot.length >= 3 && values(firstRoot).length === 1 && values(firstRoot)[0] !== null,
    values(firstRoot),
  );
  check(
    `the specialist's ${firstChild.length} calls (${STEPS} tool steps and its answer) share ONE value`,
    firstChild.length === STEPS + 1 && values(firstChild).length === 1 && values(firstChild)[0] !== null,
    values(firstChild),
  );
  check("…its own, not its parent's: a specialist's prompts share no prefix with the main agent's", values(firstChild)[0] !== values(firstRoot)[0]);
  check(
    "a second conversation gets values of its own, for its main agent and for its specialist",
    values(secondRoot).length === 1 &&
      values(secondChild).length === 1 &&
      ![values(firstRoot)[0], values(firstChild)[0]].includes(values(secondRoot)[0]) &&
      ![values(firstRoot)[0], values(firstChild)[0]].includes(values(secondChild)[0]) &&
      values(secondRoot)[0] !== values(secondChild)[0],
    { firstRoot: values(firstRoot), firstChild: values(firstChild), secondRoot: values(secondRoot), secondChild: values(secondChild) },
  );
  const every = values(all);
  check(`every value is opaque (ses_ and 24 hex characters)`, every.every((v) => OPAQUE.test(v ?? "")), every);
  check(
    "no value carries the person's address, the workspace's name, or eve's own session ids",
    every.every((v) => !leaks(v, [S1, S2, child1, child2])),
    every,
  );
} catch (e) {
  failures.push(String(e?.message ?? e).slice(0, 400));
  console.log(`  FAIL ${String(e?.message ?? e).slice(0, 1500)}`);
}

console.log(`\ntest-session-affinity: ${passed} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
