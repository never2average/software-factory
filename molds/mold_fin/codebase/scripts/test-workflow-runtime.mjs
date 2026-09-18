/**
 * The sandbox is the security boundary for operator-authored JavaScript, so it
 * is tested with hostile scripts, not happy paths: escape attempts must FAIL and
 * an infinite loop must be killed rather than take the process with it.
 *
 *   node scripts/test-workflow-runtime.mjs
 */
import { newAsyncContext, getQuickJS } from "quickjs-emscripten";

// A copy of lib/workflow-runtime.ts's core, so this runs without Next's
// "server-only" import. Kept in step by hand; the shapes are identical.
const WALL_CLOCK_MS = 3000;

async function run(source, delegate = async () => "ok") {
  const events = [];
  await getQuickJS();
  const vm = await newAsyncContext();
  try {
    const deadline = Date.now() + WALL_CLOCK_MS;
    vm.runtime.setInterruptHandler(() => Date.now() > deadline);
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);

    const logFn = vm.newFunction("log", (h) => {
      events.push(vm.getString(h));
      return vm.undefined;
    });
    vm.setProp(vm.global, "log", logFn);
    logFn.dispose();
    const phaseFn = vm.newFunction("phase", (h) => {
      events.push(`phase:${vm.getString(h)}`);
      return vm.undefined;
    });
    vm.setProp(vm.global, "phase", phaseFn);
    phaseFn.dispose();
    const agentFn = vm.newAsyncifiedFunction("agent", async (h) => {
      const out = await delegate(vm.getString(h));
      return vm.newString(out);
    });
    vm.setProp(vm.global, "agent", agentFn);
    agentFn.dispose();

    const pre = vm.evalCode(`
      globalThis.parallel = (thunks) => Promise.all(thunks.map((t) => { try { return t(); } catch { return null; } }));
      globalThis.pipeline = async (items, ...stages) => {
        const one = async (item, i) => { let v = item; for (const s of stages) v = await s(v, item, i); return v; };
        return Promise.all(items.map((it, i) => one(it, i).catch(() => null)));
      };
    `);
    if (pre.error) pre.error.dispose();
    else pre.value.dispose();

    const body = source.replace(/^\s*export\s+/gm, "");
    const evaluated = await vm.evalCodeAsync(`(async () => { ${body} })()`);
    if (evaluated.error) {
      const msg = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: String(msg?.message ?? msg), events };
    }
    // See lib/workflow-runtime.ts: the queue must be pumped or this never settles.
    const pending = vm.resolvePromise(evaluated.value);
    vm.runtime.executePendingJobs();
    const settled = await pending;
    evaluated.value.dispose();
    if (settled.error) {
      const msg = vm.dump(settled.error);
      settled.error.dispose();
      return { ok: false, error: String(msg?.message ?? msg), events };
    }
    const result = vm.dump(settled.value);
    settled.value.dispose();
    return { ok: true, result, events };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), events };
  } finally {
    vm.dispose();
  }
}

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

console.log("Escape attempts (every one MUST fail):");

const escapes = [
  ["require()", `const fs = require("node:fs"); return fs.readFileSync("/etc/passwd", "utf8");`],
  ["process", `return process.env.DATABASE_URL;`],
  ["fetch", `return await fetch("https://example.com").then(r => r.text());`],
  ["globalThis.process", `return globalThis.process.env;`],
  ["constructor escape", `return this.constructor.constructor("return process.env")();`],
  ["Function()", `return new Function("return process")();`],
];
for (const [name, src] of escapes) {
  const r = await run(src);
  check(name, !r.ok || r.result === undefined, r.ok ? `returned ${JSON.stringify(r.result)}` : r.error?.slice(0, 60));
}

console.log("\nDenial of service:");
const spin = await run(`while (true) {}`);
check("infinite loop is interrupted", !spin.ok, spin.error?.slice(0, 40));

const bomb = await run(`const a = []; while (true) { a.push(new Array(1e6).fill("x")); }`);
check("memory bomb is capped", !bomb.ok, bomb.error?.slice(0, 40));

console.log("\nThe script surface actually works:");

const happy = await run(
  `
  export const meta = { name: "demo", description: "d" };
  phase("Find");
  const a = await agent("find the bugs");
  phase("Verify");
  const votes = await parallel([() => agent("verify 1"), () => agent("verify 2")]);
  const piped = await pipeline([1, 2], (x) => x * 2, (x) => x + 1);
  return { a, votes, piped };
  `,
  async (prompt) => `answer:${prompt}`,
);
check("phase/agent/parallel/pipeline", happy.ok, happy.error);
if (happy.ok) {
  check("agent() returns the delegate's text", happy.result.a === "answer:find the bugs", JSON.stringify(happy.result.a));
  check("parallel() fans out", JSON.stringify(happy.result.votes) === JSON.stringify(["answer:verify 1", "answer:verify 2"]));
  check("pipeline() runs stages in order", JSON.stringify(happy.result.piped) === JSON.stringify([3, 5]));
  check("phase() is recorded", happy.events.includes("phase:Find") && happy.events.includes("phase:Verify"));
}

const thrown = await run(`throw new Error("boom");`);
check("a throwing script fails cleanly", !thrown.ok && thrown.error.includes("boom"), thrown.error);

console.log(failures === 0 ? "\nAll sandbox checks passed." : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
