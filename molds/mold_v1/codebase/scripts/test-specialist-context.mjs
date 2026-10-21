/**
 * A LONG SPECIALIST RUN SENDS AT MOST ABOUT ITS THRESHOLD ON ANY STEP, AND LOSES NOTHING — on the REAL eve runtime (the
 * installed, patched eve) with the fake model server. No provider, no network, no spend (mold_v1-220).
 *
 * Every step of an eve session resends its whole history, and eve compacted only at 90% of the window (~1.18M tokens
 * on GLM 5.3), which a specialist never reached: a run that read a few hundred thousand tokens of documents paid for
 * all of it again on each of its 20-40 steps. Now a specialist declares `compaction` from the deployment profile
 * (agent/lib/compaction-threshold.ts, 160,000 tokens by default), data-room reads come back a page at a time
 * (agent/lib/dataroom-paging.ts), and eve's compaction keeps what was read (the eve patch,
 * scripts/eve-patch/files/harness/compaction-fidelity.js).
 *
 * The app (a temporary directory, `eve dev --no-ui`): a main agent and two specialists on GLM 5.3's window
 * (1,310,720), each with a `read_doc` tool that pages an 800,000-character document (20 pages, 48 facts placed through
 * it, some at the very end of a page; ~200,000 tokens) with the same function `dataroom_read` uses:
 *
 *   reader               `compaction` from the profile, exactly as every specialist in agent/subagents/ declares it
 *   reader-eve-default   no `compaction`: eve's own threshold, what every specialist had before this change
 *
 * The fake model (`--script long-read`) reads page after page until the last, answers with every fact it can still
 * see, and answers a compaction request as a summariser would, from what the transcript shows it. It reports each
 * call's input as eve estimates it (JSON length / 4).
 *
 * Asserted, for `reader`: every call it made (compaction calls included) sent at most the profile's threshold; it
 * compacted; it read to the end; the main agent's answer carries all 48 facts, each with its value. For
 * `reader-eve-default`: the same answer, and a peak above the threshold (so this test tells the two apart). Both runs'
 * totals are printed: the measured before/after.
 *
 * Fails before mold_v1-220: agent/lib/compaction-threshold.ts and agent/lib/dataroom-paging.ts do not exist. And with
 * the threshold but eve's stock compaction (the patch's two compaction files put back, 2026-10-10), the summary is
 * written from 280-character digests: the first checkpoint kept 2 of the facts read and no offset, and the specialist
 * went back to page 1 after every compaction (21 times, 26.2M input tokens, never finishing) — the "never went back
 * to the start" check fails at the first restart.
 *
 * Run:  npm run test:specialist-context      (a few minutes; EVE_CONTEXT_KEEP=1 keeps the temporary app,
 *                                            EVE_CONTEXT_LOG=1 shows eve's log, EVE_CONTEXT_WAIT_MIN=N allows N minutes a run)
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

const { DEPLOYMENT_PROFILE } = await import(join(ROOT, "agent/lib/deployment-profile.generated.ts"));
const THRESHOLD = DEPLOYMENT_PROFILE.agent.compaction.specialist_tokens;
const WINDOW = 1_310_720; // GLM 5.3 on Workers AI (agent/lib/model.ts CLOUDFLARE_CONTEXT_WINDOWS)

/* ---- the document: 20 pages of 40,000 characters (~200,000 tokens), 48 facts ---------------------------------- */
const PAGE = 40_000;
const PAGES = 20;
// mulberry32: deterministic, and every bit of a value is random (the facts must not look alike).
let seed = 220;
const rand32 = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};
const hex8 = () => rand32().toString(16).padStart(8, "0");
const FACTS = new Map();
const lines = [];
{
  let size = 0;
  let n = 0;
  const total = PAGE * PAGES;
  // Facts at fixed fractions of the document, some placed just before a page boundary.
  const at = new Set(Array.from({ length: 41 }, (_, i) => Math.floor(((i + 0.5) / 41) * (total / 81))));
  for (let p = 1; p < PAGES; p += 3) at.add(Math.floor((p * PAGE) / 81) - 2);
  while (size < total) {
    let line;
    if (at.has(n) && FACTS.size < 48) {
      const k = FACTS.size + 1;
      const v = hex8();
      FACTS.set(k, v);
      line = `Line ${String(n).padStart(6, "0")}: FACT-${k}=${v} (the figure the report must carry).`;
    } else {
      line = `Line ${String(n).padStart(6, "0")}: filler text of the filing, ${hex8()} ${hex8()} ${hex8()} ${hex8()}.`;
    }
    line = line.padEnd(80, ".");
    lines.push(line);
    size += line.length + 1;
    n++;
  }
}
const DOC = lines.join("\n");

/* ---- the app ------------------------------------------------------------------------------------------------- */
const APP = mkdtempSync(join(tmpdir(), "eve-specialist-context-"));
// Its own empty `.git`, as a real app in its repository has: `eve dev` searches upward for one to find the root it
// watches, and a stray one in the temporary directory (left by anything else on the machine) made it watch all of
// it, re-reading thousands of entries whenever anything there changed (mold_v1-286, mold_v1-292).
mkdirSync(join(APP, ".git"));
writeFileSync(join(APP, "doc.txt"), DOC);
const PAGING = JSON.stringify(join(ROOT, "agent/lib/dataroom-paging.ts"));
const COMPACTION = JSON.stringify(join(ROOT, "agent/lib/compaction-threshold.ts"));
const readDoc = [
  'import { readFileSync } from "node:fs";',
  'import { defineTool } from "eve/tools";',
  'import { z } from "zod";',
  `import { pageText } from ${PAGING};`,
  `const DOC = readFileSync(${JSON.stringify(join(APP, "doc.txt"))}, "utf8");`,
  "export default defineTool({",
  '  description: "Read the filing, one page at a time: call again with offset: nextOffset until a result has none.",',
  "  inputSchema: z.object({ offset: z.number().int().min(0).optional() }),",
  "  async execute({ offset }) {",
  // The composition dataroom_read uses (agent/lib/dataroom-tools.ts): the page, and its paging fields when it has them.
  "    const page = pageText(DOC, offset);",
  '    return page.paging ? { path: "Reports/filing.md", content: page.content, ...page.paging } : { path: "Reports/filing.md", content: page.content };',
  "  },",
  "});",
].join("\n");
const specialist = (name, compaction) =>
  [
    'import { defineAgent } from "eve";',
    'import { scripted } from "../../model.ts";',
    ...(compaction ? [`import { agentCompaction } from ${COMPACTION};`] : []),
    "export default defineAgent({",
    `  description: "Test specialist ${name}: reads the filing.",`,
    "  model: scripted,",
    `  modelContextWindowTokens: ${WINDOW},`,
    // What every base specialist declares through compactionFor(<key>, <role>) in agent/lib/model.ts; the environment
    // is left out so the profile's own value is what is tested.
    ...(compaction ? [`  compaction: agentCompaction("specialist", ${JSON.stringify(name)}, ${WINDOW}, {}),`] : []),
    "});",
  ].join("\n") + "\n";
const files = {
  "package.json": JSON.stringify({ name: "eve-specialist-context", private: true, type: "module" }),
  "agent/model.ts": [
    'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
    'const provider = createOpenAICompatible({ name: "scripted", baseURL: process.env.SCRIPTED_MODEL_URL ?? "http://127.0.0.1:9/v1", apiKey: "none" });',
    'export const scripted = provider.chatModel("scripted-model");',
  ].join("\n"),
  "agent/agent.ts": `import { defineAgent } from "eve";\nimport { scripted } from "./model.ts";\nexport default defineAgent({ model: scripted, modelContextWindowTokens: ${WINDOW} });\n`,
  "agent/instructions.md": "The main agent of a test app.\n",
  "agent/sandbox.ts": 'import { defineSandbox } from "eve/sandbox";\nimport { justbash } from "eve/sandbox/just-bash";\nexport default defineSandbox({ backend: justbash() });\n',
};
for (const [name, compaction] of [["reader", true], ["reader-eve-default", false]]) {
  files[`agent/subagents/${name}/agent.ts`] = specialist(name, compaction);
  files[`agent/subagents/${name}/instructions.md`] = `SPECIALIST-ID: ${name}\nRead the filing with read_doc and report every fact.\n`;
  files[`agent/subagents/${name}/tools/read_doc.ts`] = readDoc;
  files[`agent/subagents/${name}/sandbox.ts`] = files["agent/sandbox.ts"];
}
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(join(APP, rel, ".."), { recursive: true });
  writeFileSync(join(APP, rel), text);
}
symlinkSync(join(ROOT, "node_modules"), join(APP, "node_modules"), "dir");

const model = await spawnFakeModel(["--script", "long-read"], { cwd: ROOT });
const port = await freePort();
const eve = spawn(join(ROOT, "node_modules/.bin/eve"), ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: APP,
  env: { ...process.env, SCRIPTED_MODEL_URL: `${model.base}/v1`, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let eveLog = "";
const echo = process.env.EVE_CONTEXT_LOG ? (d) => process.stderr.write(d) : () => {};
eve.stdout.on("data", (d) => ((eveLog += d), echo(d)));
eve.stderr.on("data", (d) => ((eveLog += d), echo(d)));
const cleanup = () => {
  try {
    process.kill(-eve.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  model.stop();
  if (!process.env.EVE_CONTEXT_KEEP && APP.startsWith(join(tmpdir(), "eve-specialist-context-"))) rmSync(APP, { recursive: true, force: true });
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

const getJson = (path) => fetch(`${model.base}${path}`).then((r) => r.json());
const factsIn = (text) => new Map([...String(text).matchAll(/FACT-(\d+)=([0-9a-f]{8})/g)].map((m) => [Number(m[1]), m[2]]));
const missing = (got) => [...FACTS.entries()].filter(([k, v]) => got.get(k) !== v).map(([k]) => k);

/** Run one delegation to `name`; resolve with its calls and the main agent's final answer. */
async function run(name) {
  const before = (await getJson("/__log")).length;
  const r = await fetch(`${B}/eve/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: `[[read ${name}]]` }) });
  const started = await r.json().catch(() => null);
  check(`${name}: the main thread starts (202)`, r.status === 202 && typeof started?.sessionId === "string", started);
  let done = null;
  // Each step takes about a second on an idle runner; a loaded machine can take a minute. EVE_CONTEXT_WAIT_MIN
  // (default 15) is how long one run may take.
  const deadline = Date.now() + Number(process.env.EVE_CONTEXT_WAIT_MIN || 15) * 60_000;
  let restarts = 0;
  while (!done && Date.now() < deadline) {
    const log = (await getJson("/__log")).slice(before);
    done = log.find((l) => typeof l.decision?.text === "string" && l.decision.text.startsWith("ROOT-DONE"));
    // A read from the start after the first is a specialist that lost its place in a compaction: it would read the
    // document again and again (eve's stock compaction did, 21 times in 26M tokens, never finishing). Stop there.
    restarts = log.filter((l) => l.decision?.tool === "read_doc" && !l.decision.args?.offset).length - 1;
    if (restarts > 0) break;
    if (!done) await sleep(1000);
  }
  const calls = (await getJson("/__calls")).filter((c) => c.child === name);
  check(`${name}: it never went back to the start (no read of page 1 after the first)`, restarts <= 0, { restarts });
  return { answer: done?.decision.text ?? null, calls };
}

const summary = (calls) => {
  const steps = calls.filter((c) => !c.compaction);
  const compactions = calls.filter((c) => c.compaction);
  return {
    calls: calls.length,
    steps: steps.length,
    compactions: compactions.length,
    peak: Math.max(0, ...calls.map((c) => c.inputTokens)),
    total: calls.reduce((a, c) => a + c.inputTokens, 0),
  };
};

try {
  await main();
} catch (error) {
  check("the runs completed without an error", false, error?.stack ?? String(error));
} finally {
  console.log(`\ntest-specialist-context: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(eveLog.slice(-2000));
    process.exitCode = 1;
  }
  process.exit();
}

async function main() {
  console.log(`a specialist reads a ${DOC.length.toLocaleString("en-US")}-character document (${PAGES} pages, ${FACTS.size} facts) and reports every fact:`);
  check(`the profile's specialist threshold is set (${THRESHOLD})`, Number.isInteger(THRESHOLD) && THRESHOLD > 0 && THRESHOLD < WINDOW * 0.9, THRESHOLD);

  const after = await run("reader");
  const a = summary(after.calls);
  check("reader: the main agent finished with the specialist's result", after.answer?.startsWith("ROOT-DONE") && after.answer.includes("READER-RESULT"), after.answer?.slice(0, 300));
  const gotA = factsIn(after.answer ?? "");
  check(`reader: nothing lost — all ${FACTS.size} facts reached the main agent, each with its value`, missing(gotA).length === 0, { missing: missing(gotA) });
  check("reader: it compacted at least once", a.compactions >= 1, a);
  check(`reader: no call sent more than the threshold (peak ${a.peak.toLocaleString("en-US")} <= ${THRESHOLD.toLocaleString("en-US")}), compaction calls included`, a.peak <= THRESHOLD, a);
  check("reader: it read every page (one step per page, and the answer)", a.steps >= PAGES + 1, a);

  const before = await run("reader-eve-default");
  const b = summary(before.calls);
  const gotB = factsIn(before.answer ?? "");
  check("reader-eve-default: the same answer, all facts", missing(gotB).length === 0, { missing: missing(gotB) });
  check(`reader-eve-default (eve's own threshold, as before): its peak passes the threshold (${b.peak.toLocaleString("en-US")} > ${THRESHOLD.toLocaleString("en-US")}), so this test tells the two apart`, b.peak > THRESHOLD && b.compactions === 0, b);

  const fmt = (s) => `${s.steps} steps, ${s.compactions} compaction call(s), peak ${s.peak.toLocaleString("en-US")}, total ${s.total.toLocaleString("en-US")} input tokens`;
  console.log(`\n  measured (input tokens as eve estimates them):\n    before (eve's own threshold): ${fmt(b)}\n    after  (profile, ${THRESHOLD}):  ${fmt(a)}\n    total input: ${(100 * (1 - a.total / b.total)).toFixed(1)}% less`);
}
