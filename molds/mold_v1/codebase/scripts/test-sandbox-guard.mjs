/**
 * THE MICROSANDBOX GUARD (agent/lib/sandbox-guard.ts, mold_v1-183), against eve 0.25.1's REAL microsandbox binding.
 *
 * eve's binding is loaded as it ships (`eve/sandbox/microsandbox`); only the `microsandbox` npm package under it is
 * replaced, by scripts/fixtures/microsandbox-standin.mjs, because there is no KVM here. Each "step" below does what
 * eve does for one model step (execution/sandbox/ensure.js + context/providers/sandbox.js): `backend.create` with the
 * session's last captured metadata, commands through the handle's session, then `captureState` (the commit).
 *
 * What it holds:
 *   - WITHOUT the guard the stand-in reproduces the server: a session's second step fails with
 *     `no agent socket found` (so the cases after it are a real test of the guard, not of the stand-in);
 *   - with it, every step of a session gets a working sandbox, and files written in one step are there in the next;
 *     also after a restart (eve's cache emptied);
 *   - sessions sharing one sandbox key (the built-in `agent` tool's children) get ONE VM, nobody's commit stops it
 *     under the others, and the last one's snapshot holds everyone's work;
 *   - a step that failed without committing does not keep the VM running for ever; a runtime that never answers the
 *     redundant stop of a stopped VM does not hold up a commit;
 *   - at most floor(host CPUs / sandbox CPUs) VMs boot at once; the others wait, saying so; with a stand-in guest that
 *     stalls when booted beside two others, nothing stalls with the guard and something does without it;
 *   - a boot that hangs is abandoned at the deadline and started again (seconds, not microsandbox's 180 s);
 *   - a bounded wait for memory, never a refusal;
 *   - under `eve dev` (EVE_DEV=1, eve keeps VMs running) the guard evicts nothing;
 *   - SANDBOX_BACKEND=vercel: eve's vercel() backend (and any non-microsandbox one) is returned untouched, the same
 *     object.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-sandbox-guard.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STANDIN = pathToFileURL(join(ROOT, "scripts/fixtures/microsandbox-standin.mjs")).href;

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(s, c, n) {
        if (s === "microsandbox") return { url: ${JSON.stringify(STANDIN)}, shortCircuit: true };
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

// eve's platform check wants /dev/kvm or MSB_PATH; nothing is executed from this path.
process.env.MSB_PATH = "/nonexistent/msb-for-tests";
delete process.env.EVE_DEV;

const { microsandbox } = await import("eve/sandbox/microsandbox");
const { vercel } = await import("eve/sandbox/vercel");
const lifecycle = await import(pathToFileURL(join(ROOT, "node_modules/eve/dist/src/execution/sandbox/bindings/microsandbox-lifecycle.js")).href);
const { control } = await import(STANDIN);
const { guardSandboxBackend, createSandboxPool, maxStartingFor } = await import(pathToFileURL(join(ROOT, "agent/lib/sandbox-guard.ts")).href);
const { microsandboxSettings } = await import(pathToFileURL(join(ROOT, "agent/lib/sandbox-settings.ts")).href);

const SETTINGS = microsandboxSettings({ SANDBOX_BACKEND: "microsandbox" });
const TEMPLATE = "eve-sbx-tpl-test-root";
const scratch = mkdtempSync(join(tmpdir(), "sandbox-guard-test-"));
let passed = 0;
const failures = [];

async function check(what, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("did not finish within 30 s")), 30_000)))]);
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (error) {
    failures.push(what);
    console.log(`  FAIL ${what}\n       ${String(error?.stack ?? error).split("\n").slice(0, 4).join("\n       ")}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A fresh world: an empty stand-in, eve's handle cache emptied (a new process), the template built by eve's prewarm. */
async function world() {
  control.reset();
  lifecycle.clearActiveMicrosandboxSessionHandlesForTest();
  const appRoot = mkdtempSync(join(scratch, "app-"));
  const raw = microsandbox(SETTINGS);
  await raw.prewarm({ runtimeContext: { appRoot }, templateKey: TEMPLATE, seedFiles: [] });
  return { appRoot, raw };
}

function guarded(raw, extra = {}) {
  const lines = [];
  const backend = guardSandboxBackend(raw, {
    sandboxCpus: SETTINGS.cpus,
    sandboxMemoryMiB: SETTINGS.memoryMiB,
    hostCpus: 4,
    memAvailableMiB: () => 8_000,
    pool: createSandboxPool(),
    log: (line) => lines.push(line),
    ...extra,
  });
  return { backend, lines };
}

let ids = 0;
const session = (key = `eve-sbx-ses-microsandbox-test-${++ids}`, id = `wrun_${ids}`) => ({ key, id, state: null });

/** One model step, as eve runs it. Returns each command's output, or "ERROR <message>". */
async function step(backend, appRoot, s, commands, { commit = true } = {}) {
  const handle = await backend.create({
    existingMetadata: s.state?.backendName === "microsandbox" && s.state.sessionKey === s.key ? s.state.metadata : undefined,
    runtimeContext: { appRoot },
    sessionKey: s.key,
    tags: { agent: "test", channel: "test", sessionId: s.id },
    templateKey: TEMPLATE,
  });
  const out = [];
  for (const command of commands) {
    try {
      const r = await handle.session.run({ command });
      out.push(r.exitCode === 0 ? r.stdout.trim() : `exit ${r.exitCode}`);
    } catch (error) {
      out.push(`ERROR ${error.message}`);
    }
  }
  if (commit) s.state = await handle.captureState();
  return out;
}

const sessionVms = () => [...control.vms.keys()].filter((n) => n.startsWith("eve-sbx-ses-"));

try {
  console.log("eve 0.25.1's microsandbox binding, the microsandbox package replaced by a stand-in (no KVM here):");

  await check("WITHOUT the guard: a session's second step fails with 'no agent socket found' (what the server did)", async () => {
    const { appRoot, raw } = await world();
    const s = session();
    assert.deepEqual(await step(raw, appRoot, s, ["echo FIRST"]), ["FIRST"]);
    const second = await step(raw, appRoot, s, ["echo SECOND"]);
    assert.match(second[0], /^ERROR .*no agent socket found for sandbox "eve-sbx-ses-/);
  });

  await check("with the guard: three steps in a row each get a working sandbox, and a file written in step 1 is read in step 3", async () => {
    const { appRoot, raw } = await world();
    const { backend } = guarded(raw);
    const s = session();
    assert.deepEqual(await step(backend, appRoot, s, ["echo FIRST", "echo one >> notes.txt"]), ["FIRST", ""]);
    assert.deepEqual(await step(backend, appRoot, s, ["echo SECOND", "echo two >> notes.txt"]), ["SECOND", ""]);
    assert.deepEqual(await step(backend, appRoot, s, ["cat notes.txt"]), ["one\ntwo"]);
    assert.equal(control.running().length, 0, "the VM is stopped between steps, as eve stops it");
    assert.equal(sessionVms().length, 1, "each reattach replaces the session's VM; none is left behind");
  });

  await check("with the guard: after a restart (eve's handle cache empty, a new pool) the session reattaches with its files", async () => {
    const { appRoot, raw } = await world();
    const s = session();
    await step(guarded(raw).backend, appRoot, s, ["echo kept >> notes.txt"]);
    lifecycle.clearActiveMicrosandboxSessionHandlesForTest();
    assert.deepEqual(await step(guarded(raw).backend, appRoot, s, ["cat notes.txt"]), ["kept"]);
  });

  await check("sessions sharing a sandbox key: ONE VM; two commits leave it running for the third; the last snapshot holds all three", async () => {
    const { appRoot, raw } = await world();
    const { backend } = guarded(raw);
    const key = "eve-sbx-ses-microsandbox-shared-parent-root";
    const kids = [session(key, "wrun_child_a"), session(key, "wrun_child_b"), session(key, "wrun_child_c")];
    const handles = await Promise.all(
      kids.map((k) => backend.create({ runtimeContext: { appRoot }, sessionKey: key, tags: { sessionId: k.id }, templateKey: TEMPLATE })),
    );
    assert.equal(sessionVms().length, 1, `opened at once, the key got ${sessionVms().length} VMs`);
    for (const [i, h] of handles.entries()) assert.equal((await h.session.run({ command: `echo kid${i} >> shared.txt` })).exitCode, 0);
    kids[0].state = await handles[0].captureState();
    kids[1].state = await handles[1].captureState();
    assert.equal(control.running().length, 1, "two of three committed: the VM must still run for the third");
    assert.equal((await handles[2].session.run({ command: "echo still-here" })).stdout.trim(), "still-here");
    kids[2].state = await handles[2].captureState();
    assert.equal(control.running().length, 0, "the last one out stops it");
    assert.deepEqual(await step(backend, appRoot, kids[0], ["cat shared.txt"]), ["kid0\nkid1\nkid2"]);
  });

  await check("WITHOUT the guard the same three boot three VMs for one key, and after they commit a sibling's next step gets a stopped one", async () => {
    const { appRoot, raw } = await world();
    const key = "eve-sbx-ses-microsandbox-shared-parent-root";
    const handles = await Promise.all(["a", "b", "c"].map((id) => raw.create({ runtimeContext: { appRoot }, sessionKey: key, tags: { sessionId: id }, templateKey: TEMPLATE })));
    assert.equal(sessionVms().length, 3, "eve's cache is filled only after a boot, so each concurrent open boots its own VM");
    for (const h of handles) await h.captureState();
    const next = await step(raw, appRoot, session(key, "a"), ["echo next"]);
    assert.match(next[0], /^ERROR .*no agent socket found/);
  });

  await check("a runtime that never answers the redundant stop of a stopped VM does not hold up the commit", async () => {
    const { appRoot, raw } = await world();
    control.stopOfStoppedHangs = true;
    const { backend } = guarded(raw);
    const s = session();
    const started = Date.now();
    assert.deepEqual(await step(backend, appRoot, s, ["echo one"]), ["one"]);
    assert.ok(Date.now() - started < 8_000, `the commit took ${Date.now() - started} ms`);
    assert.deepEqual(await step(backend, appRoot, s, ["echo two"]), ["two"]);
  });

  await check("a step that failed without committing does not keep its VM running: the session's next step supersedes it", async () => {
    const { appRoot, raw } = await world();
    const { backend } = guarded(raw);
    const s = session();
    await step(backend, appRoot, s, ["echo crashed-step"], { commit: false });
    assert.deepEqual(await step(backend, appRoot, s, ["echo retried"]), ["retried"]);
    assert.equal(control.running().length, 0, "the retried step's commit stopped the VM");
    assert.deepEqual(await step(backend, appRoot, s, ["echo next"]), ["next"]);
  });

  await check(`at most floor(CPUs / SANDBOX_CPUS) boot at once (${maxStartingFor(4, SETTINGS.cpus)} on 4 CPUs at ${SETTINGS.cpus} each); the rest wait and say so; nothing stalls`, async () => {
    const { appRoot, raw } = await world();
    control.stallAbove = 2; // a guest started beside two booting ones never comes up
    control.relayTimeoutMs = 1_500;
    control.bootMs = 40;
    const { backend, lines } = guarded(raw);
    const sessions = Array.from({ length: 6 }, () => session());
    const outs = await Promise.all(sessions.map((s, i) => step(backend, appRoot, s, [`echo ok${i}`])));
    assert.deepEqual(outs, sessions.map((_, i) => [`ok${i}`]));
    assert.equal(control.stalled.length, 0, `stalled: ${control.stalled.join(", ")}`);
    assert.ok(control.peakBooting <= 2, `peak booting ${control.peakBooting}`);
    assert.ok(lines.some((l) => /^waiting for a sandbox .*at most 2 at once on this host \(4 CPUs, 2 per sandbox\)/.test(l)), lines.join("\n"));
  });

  await check("WITHOUT the gate the same six sessions start six guests at once, and the stand-in guest stalls", async () => {
    const { appRoot, raw } = await world();
    control.stallAbove = 2;
    control.relayTimeoutMs = 300;
    control.bootMs = 40;
    const outs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => step(raw, appRoot, session(), [`echo ok${i}`])));
    assert.ok(control.stalled.length > 0 && outs.some((o) => o.status === "rejected"), `stalled ${control.stalled.length}`);
  });

  await check("a boot that hangs is abandoned at the deadline and started again: the step works in well under microsandbox's own timeout", async () => {
    const { appRoot, raw } = await world();
    control.stallNext = 1;
    control.relayTimeoutMs = 3_000;
    const { backend, lines } = guarded(raw, { bootDeadlineMs: 200 });
    const started = Date.now();
    assert.deepEqual(await step(backend, appRoot, session(), ["echo after-stall"]), ["after-stall"]);
    const took = Date.now() - started;
    assert.ok(took < 2_000, `took ${took} ms`);
    assert.ok(lines.some((l) => /did not start within 0 s .*attempt 1 of 2\); starting another/.test(l)), lines.join("\n"));
    assert.equal(control.stalled.length, 1);
  });

  await check("two hung boots in a row: the step is told plainly, in about two deadlines", async () => {
    const { appRoot, raw } = await world();
    control.stallNext = 2;
    control.relayTimeoutMs = 3_000;
    const { backend } = guarded(raw, { bootDeadlineMs: 150 });
    await assert.rejects(step(backend, appRoot, session(), ["echo never"]), /No sandbox started within 0 s, 2 times in a row\. The host may be overloaded/);
  });

  await check("short of memory: it waits (bounded), says so, then starts the sandbox anyway", async () => {
    const { appRoot, raw } = await world();
    const { backend, lines } = guarded(raw, { memAvailableMiB: () => 100, memoryWaitMs: 1_200 });
    assert.deepEqual(await step(backend, appRoot, session(), ["echo late"]), ["late"]);
    assert.ok(lines.some((l) => /^waiting for memory .*100 MiB available, a sandbox needs 1024 MiB plus 512 MiB spare/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /starting the sandbox anyway/.test(l)), lines.join("\n"));
  });

  await check("under eve dev (EVE_DEV=1: eve keeps the VM running between steps) the guard evicts and stops nothing", async () => {
    const { appRoot, raw } = await world();
    process.env.EVE_DEV = "1";
    try {
      const { backend } = guarded(raw);
      const s = session();
      await step(backend, appRoot, s, ["echo dev >> notes.txt"]);
      assert.equal(control.running().length, 1, "eve dev leaves the VM running; the guard must too");
      assert.deepEqual(await step(backend, appRoot, s, ["cat notes.txt"]), ["dev"]);
      assert.equal(sessionVms().length, 1, "and reuses it");
    } finally {
      delete process.env.EVE_DEV;
    }
  });

  await check("SANDBOX_BACKEND=vercel: eve's vercel() backend, and any backend that is not microsandbox, is returned as it is", async () => {
    const v = vercel();
    assert.equal(guardSandboxBackend(v, { sandboxCpus: 2, sandboxMemoryMiB: 1024 }), v);
    const other = { name: "docker", create: async () => null };
    assert.equal(guardSandboxBackend(other, { sandboxCpus: 2, sandboxMemoryMiB: 1024 }), other);
    assert.equal(microsandboxSettings({}), null, "with the setting unset there are no settings, so the build's wrapper never calls the guard");
  });

  await check("the guarded backend keeps eve's name and prewarm (what `npm run sandbox:prewarm` and eve's graph read)", async () => {
    const raw = microsandbox(SETTINGS);
    const g = guardSandboxBackend(raw, { sandboxCpus: 2, sandboxMemoryMiB: 1024 });
    assert.notEqual(g, raw);
    assert.equal(g.name, "microsandbox");
    assert.equal(g.prewarm, raw.prewarm);
    assert.deepEqual([maxStartingFor(4, 2), maxStartingFor(2, 2), maxStartingFor(1, 2), maxStartingFor(16, 2)], [2, 1, 1, 8]);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures.length ? `\ntest-sandbox-guard: ${failures.length} FAILED: ${failures.join("; ")}` : `\ntest-sandbox-guard: ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);
