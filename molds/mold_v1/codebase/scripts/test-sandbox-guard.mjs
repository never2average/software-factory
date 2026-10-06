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
 *   - (mold_v1-190) WITHOUT the watchdog a command sent to a guest that hung after booting never comes back; with it
 *     the command is answered plainly within the bound, the VM is stopped (killed by its labels if it will not stop)
 *     and the same step's next command gets a fresh VM with the step's files; a long command on a live VM is left
 *     alone; twelve specialists at once never run more VMs than SANDBOX_MAX_RUNNING, and without the cap they do;
 *     past SANDBOX_WAIT_S or SANDBOX_QUEUE_MAX a call is answered "Waiting for a free sandbox: ..." and nothing runs;
 *     an idle VM is stopped to free its place for one that waits and comes back with its files;
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
const { microsandboxSettings, sandboxGuardSettings, maxRunningFor } = await import(pathToFileURL(join(ROOT, "agent/lib/sandbox-settings.ts")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const { backend, lines } = guarded(raw, { maxRunning: 6 }); // the boot gate on its own: the running cap is tested below
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

  /* ---- mold_v1-190: the running cap, the bounded wait, the watchdog ------------------------------------------- */

  const FAST = { checkAfterMs: 100, stallMs: 400, stopWaitMs: 300, housekeepMs: 25, parkIdleMs: 60 };
  const hungAnswer = /^ERROR The sandbox stopped responding \(nothing came back from it for 0 s\), so this command was stopped and the sandbox is being restarted\. Run the command again\./;

  await check("WITHOUT the watchdog (eve's binding as it ships) a command sent to a guest that hung after booting never comes back (eve-sbx-ses-5256b07f)", async () => {
    const { appRoot, raw } = await world();
    const s = session();
    const h = await raw.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { sessionId: s.id }, templateKey: TEMPLATE });
    assert.equal((await h.session.run({ command: "echo booted" })).stdout.trim(), "booted");
    control.hangNext = 1;
    const outcome = await Promise.race([h.session.run({ command: "echo SBX-T0K0-1" }).then(() => "answered", () => "failed"), sleep(1_500).then(() => "still waiting")]);
    assert.equal(outcome, "still waiting");
    assert.equal(control.running().length, 1, "and the hung VM keeps running");
  });

  await check("the watchdog: a command whose VM answers nothing is answered plainly within the bound, the VM is stopped, and the SAME step's next command gets a fresh VM with the step's files", async () => {
    const { appRoot, raw } = await world();
    const { backend, lines } = guarded(raw, FAST);
    const s = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { sessionId: s.id }, templateKey: TEMPLATE });
    assert.equal((await h.session.run({ command: "echo before >> notes.txt" })).exitCode, 0);
    control.hangNext = 1;
    const started = Date.now();
    const answer = await h.session.run({ command: "echo SBX-T0K0-1" }).then((r) => r.stdout, (e) => `ERROR ${e.message}`);
    const took = Date.now() - started;
    assert.match(answer, hungAnswer);
    assert.ok(took < 4_000, `answered after ${took} ms (bound: 100 ms before the check + 400 ms of silence; without the watchdog: never)`);
    assert.equal(control.hung.length, 1);
    for (let i = 0; i < 120 && control.running().includes(control.hung[0]); i++) await sleep(25);
    assert.ok(!control.running().includes(control.hung[0]), "the hung VM was stopped");
    assert.deepEqual((await h.session.run({ command: "cat notes.txt" })).stdout.trim(), "before", "the same step goes on, on a fresh VM, with its files");
    s.state = await h.captureState();
    assert.deepEqual(await step(backend, appRoot, s, ["echo next-step", "cat notes.txt"]), ["next-step", "before"]);
    assert.ok(lines.some((l) => /^a sandbox stopped responding .*no answer for 0\.4 s during a command; stopping it/.test(l)), lines.join("\n"));
  });

  await check("the watchdog, through spawn(): the process's wait() is answered plainly too", async () => {
    const { appRoot, raw } = await world();
    const { backend } = guarded(raw, FAST);
    const s = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { sessionId: s.id }, templateKey: TEMPLATE });
    await h.session.run({ command: "echo up" });
    control.hangNext = 1;
    // The real package hands back the stream at once and the wait hangs; the stand-in's exec hangs before it: either
    // way the caller is answered plainly.
    await assert.rejects(
      h.session.spawn({ command: "echo spawned" }).then((proc) => proc.wait()),
      /The sandbox stopped responding/,
    );
  });

  await check("a hung VM whose runtime will not stop it politely is killed by the labels eve gave it", async () => {
    const { appRoot, raw } = await world();
    control.stopOfHungHangs = true;
    const { backend, lines } = guarded(raw, FAST);
    const s = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { agent: "lodr-filings", channel: "eve", sessionId: s.id }, templateKey: TEMPLATE });
    await h.session.run({ command: "echo up" });
    control.hangNext = 1;
    assert.match(await h.session.run({ command: "echo stuck" }).then(() => "", (e) => `ERROR ${e.message}`), hungAnswer);
    for (let i = 0; i < 120 && control.running().includes(control.hung[0]); i++) await sleep(50);
    assert.ok(!control.running().includes(control.hung[0]), "killed");
    assert.ok(lines.some((l) => /did not stop on request: 1 VM\(s\) killed/.test(l)), lines.join("\n"));
    assert.equal((await h.session.run({ command: "echo again" })).stdout.trim(), "again");
  });

  await check("a long command on a live VM is left alone: the VM answers the check, the command finishes", async () => {
    const { appRoot, raw } = await world();
    const pool = createSandboxPool();
    const { backend } = guarded(raw, { ...FAST, pool });
    assert.deepEqual(await step(backend, appRoot, session(), ["sleep 1.2", "echo done"]), ["", "done"]);
    assert.equal(pool.hung, 0);
  });

  await check("SANDBOX_STALL_S=0 turns the watchdog off (a hung command then waits, as before)", async () => {
    const { appRoot, raw } = await world();
    const { backend } = guarded(raw, { ...FAST, stallMs: 0 });
    const s = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { sessionId: s.id }, templateKey: TEMPLATE });
    await h.session.run({ command: "echo up" });
    control.hangNext = 1;
    const outcome = await Promise.race([h.session.run({ command: "echo x" }).then(() => "answered", () => "failed"), sleep(1_000).then(() => "still waiting")]);
    assert.equal(outcome, "still waiting");
  });

  await check("the running cap: twelve specialists at once never have more than SANDBOX_MAX_RUNNING VMs up; all twelve get a working sandbox; the rest wait and say so", async () => {
    const { appRoot, raw } = await world();
    control.bootMs = 20;
    const pool = createSandboxPool();
    const { backend, lines } = guarded(raw, { ...FAST, pool });
    const sessions = Array.from({ length: 12 }, () => session());
    const outs = await Promise.all(sessions.map((s, i) => step(backend, appRoot, s, ["sleep 0.15", `echo SBX-${i}-1`]).then(async (first) => [...first, ...(await step(backend, appRoot, s, [`echo SBX-${i}-2`]))])));
    assert.deepEqual(outs, sessions.map((_, i) => ["", `SBX-${i}-1`, `SBX-${i}-2`]));
    assert.ok(control.peakRunning <= 2, `peak running VMs ${control.peakRunning}`);
    assert.equal(pool.peakRunning, 2);
    assert.ok(lines.some((l) => /^waiting for a free sandbox \(.*\): 2 of 2 running on this host \(4 CPUs, 2 per sandbox\); \d+ waiting$/.test(l)), lines.join("\n"));
    assert.equal(pool.running, 0, "every place was handed back");
  });

  await check("WITHOUT the cap (SANDBOX_MAX_RUNNING as high as the sessions) the same twelve run more VMs at once than the host has CPUs for", async () => {
    const { appRoot, raw } = await world();
    control.bootMs = 20;
    const { backend } = guarded(raw, { ...FAST, maxRunning: 12 });
    await Promise.all(Array.from({ length: 12 }, () => step(backend, appRoot, session(), ["sleep 0.3"])));
    assert.ok(control.peakRunning > 2, `peak running VMs ${control.peakRunning}`);
  });

  await check("the bounded wait: when no sandbox comes free in SANDBOX_WAIT_S the call is answered 'Waiting for a free sandbox: ...' and nothing runs", async () => {
    const { appRoot, raw } = await world();
    const { backend, lines } = guarded(raw, { ...FAST, maxRunning: 1, runWaitMs: 1_000 });
    const busyStep = step(backend, appRoot, session(), ["sleep 2.5"]);
    await sleep(100);
    const s = session();
    const started = Date.now();
    await assert.rejects(
      step(backend, appRoot, s, ["echo never-ran"]),
      /^Error: Waiting for a free sandbox: all 1 sandboxes this server runs at once are in use, and none came free within 1 s\. Nothing was run\. Try again in a minute or two\.$/,
    );
    assert.ok(Date.now() - started < 4_000, `answered after ${Date.now() - started} ms (SANDBOX_WAIT_S here: 1 s)`);
    assert.ok(!control.ran.some((r) => r.command === "echo never-ran"));
    assert.ok(lines.some((l) => /no sandbox came free within 1 s/.test(l)), lines.join("\n"));
    await busyStep;
  });

  await check("the bounded queue: past SANDBOX_QUEUE_MAX waiting, one more is answered at once", async () => {
    const { appRoot, raw } = await world();
    const pool = createSandboxPool();
    const { backend } = guarded(raw, { ...FAST, pool, maxRunning: 1, maxWaiting: 1, runWaitMs: 5_000 });
    const first = step(backend, appRoot, session(), ["sleep 0.8"]);
    await sleep(80);
    const second = step(backend, appRoot, session(), ["echo second"]);
    await sleep(50);
    const started = Date.now();
    await assert.rejects(step(backend, appRoot, session(), ["echo third"]), /^Error: Waiting for a free sandbox: all 1 sandboxes this server runs at once are in use, and 1 more is already waiting\./);
    assert.ok(Date.now() - started < 1_000, `at once, not after the 5 s wait (${Date.now() - started} ms)`);
    assert.deepEqual(await second, ["second"], "the one in line still gets its turn");
    await first;
  });

  await check("a VM idle while others wait (a parent waiting on its specialists) is stopped to free its place, and its next command restores it with its files", async () => {
    const { appRoot, raw } = await world();
    const pool = createSandboxPool();
    const { backend, lines } = guarded(raw, { ...FAST, pool, maxRunning: 1, runWaitMs: 5_000 });
    const parent = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: parent.key, tags: { sessionId: parent.id }, templateKey: TEMPLATE });
    assert.equal((await h.session.run({ command: "echo parent >> notes.txt" })).exitCode, 0);
    // The parent's step is still open (it delegated and waits): its specialist needs the only place.
    assert.deepEqual(await step(backend, appRoot, session(), ["echo specialist"]), ["specialist"]);
    assert.ok(lines.some((l) => /^stopping an idle sandbox .* to free its place for one that is waiting/.test(l)), lines.join("\n"));
    assert.equal((await h.session.run({ command: "cat notes.txt" })).stdout.trim(), "parent", "the parent's VM came back with its files");
    parent.state = await h.captureState();
    assert.deepEqual(await step(backend, appRoot, parent, ["cat notes.txt"]), ["parent"]);
    assert.ok(pool.peakRunning <= 1);
  });

  await check("a VM no step has used for the idle time (a step that never committed) is stopped even when nothing waits", async () => {
    const { appRoot, raw } = await world();
    const pool = createSandboxPool();
    const { backend } = guarded(raw, { ...FAST, pool, idleStopMs: 150 });
    const s = session();
    const h = await backend.create({ runtimeContext: { appRoot }, sessionKey: s.key, tags: { sessionId: s.id }, templateKey: TEMPLATE });
    await h.session.run({ command: "echo kept >> notes.txt" });
    // the VM stops first; its snapshot is then taken and its place handed back
    for (let i = 0; i < 80 && (control.running().length > 0 || pool.running > 0); i++) await sleep(25);
    assert.equal(control.running().length, 0, "stopped while idle");
    assert.equal(pool.running, 0);
    assert.equal((await h.session.run({ command: "cat notes.txt" })).stdout.trim(), "kept");
  });

  await check("where a call's time went: a command that queued says how long it waited and how long it ran, with its session (what the load check reads)", async () => {
    const { appRoot, raw } = await world();
    const { backend, lines } = guarded(raw, { ...FAST, maxRunning: 1, runWaitMs: 5_000, timingFromMs: 300 });
    const first = step(backend, appRoot, session(), ["sleep 0.8"]);
    await sleep(80);
    const s = session();
    assert.deepEqual(await step(backend, appRoot, s, ["echo queued"]), ["queued"]);
    await first;
    const mine = lines.filter((l) => l.includes(`session ${s.id},`));
    const opened = mine.find((l) => /^timing: a sandbox \(session wrun_\d+, .*\) opened after ([\d.]+) s$/.test(l));
    assert.ok(opened && Number(/after ([\d.]+) s/.exec(opened)[1]) >= 0.5, `the open waited for the first step's place:\n${lines.join("\n")}`);
    assert.ok(lines.some((l) => /^timing: a command \(session wrun_\d+, .*\) waited [\d.]+ s for its sandbox and ran [\d.]+ s$/.test(l) && l.includes("ran 0.8 s")), lines.join("\n"));
  });

  await check("a boot that stalls is KILLED at the deadline, not left booting until microsandbox's own relay timeout (outside the cap, spinning a CPU)", async () => {
    const { appRoot, raw } = await world();
    control.stallNext = 1;
    control.relayTimeoutMs = 4_000;
    const { backend, lines } = guarded(raw, { ...FAST, bootDeadlineMs: 200 });
    const s = session();
    assert.deepEqual(await step(backend, appRoot, s, ["echo after-stall"]), ["after-stall"]);
    const stalled = control.vms.get(control.stalled[0]);
    assert.equal(stalled?.status, "stopped", `the stalled VM is ${stalled?.status} (microsandbox would only give up on it after ${control.relayTimeoutMs} ms)`);
    assert.ok(lines.some((l) => /the sandbox that did not start .* was stopped: 1 VM\(s\) killed/.test(l)), lines.join("\n"));
  });

  await check("the settings: SANDBOX_MAX_RUNNING, SANDBOX_WAIT_S, SANDBOX_QUEUE_MAX, SANDBOX_STALL_S; defaults; wrong values said plainly; the derived cap", async () => {
    assert.deepEqual(sandboxGuardSettings({}), { maxRunning: null, runWaitMs: 180_000, maxWaiting: 32, stallMs: 60_000 });
    assert.deepEqual(sandboxGuardSettings({ SANDBOX_MAX_RUNNING: "3", SANDBOX_WAIT_S: "60", SANDBOX_QUEUE_MAX: "0", SANDBOX_STALL_S: "0" }), { maxRunning: 3, runWaitMs: 60_000, maxWaiting: 0, stallMs: 0 });
    assert.equal(sandboxGuardSettings({ SANDBOX_MAX_RUNNING: "auto" }).maxRunning, null);
    assert.throws(() => sandboxGuardSettings({ SANDBOX_MAX_RUNNING: "0" }), /SANDBOX_MAX_RUNNING="0" is not valid\. Use a whole number from 1 to 256, or leave it unset/);
    assert.throws(() => sandboxGuardSettings({ SANDBOX_STALL_S: "5" }), /SANDBOX_STALL_S="5" is too short/);
    assert.throws(() => sandboxGuardSettings({ SANDBOX_WAIT_S: "soon" }), /SANDBOX_WAIT_S="soon" is not valid/);
    // the first server: 4 CPUs, 7941 MiB; 2 CPUs and 1024 MiB per sandbox
    assert.equal(maxRunningFor(4, 2, 7941, 1024), 2);
    assert.equal(maxRunningFor(4, 1, 7941, 1024), 4);
    assert.equal(maxRunningFor(8, 2, 16_000, 1024), 4);
    assert.equal(maxRunningFor(32, 2, 7941, 1024), 4, "memory bounds it too");
    assert.equal(maxRunningFor(2, 4, 2048, 1024), 1, "never below one");
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
