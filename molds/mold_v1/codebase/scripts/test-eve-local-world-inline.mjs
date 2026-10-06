/**
 * THE LOCAL WORLD DOES NOT START A STEP TWICE (mold_v1-191), and never refuses the start it must accept — against the
 * installed, patched eve's own local world (node_modules/eve/dist/src/compiled/@workflow/world-local), on a scratch
 * data directory, with a controlled clock. No eve server, no model.
 *
 * The patch (scripts/eve-patch/changes.mjs, "a step another invocation is running inline is not started again") notes
 * a step started INLINE (the lazy `step_started` that creates it) and refuses a NON-inline `step_started` of it by
 * another owner while the runtime's inline-ownership lease runs. The core's backstop re-delivers such a step at
 * `lastStartedAt + lease`, where lastStartedAt is the inline start EVENT's createdAt (core runtime `yr`): so the note is
 * counted from that same createdAt, and a backstop exactly at the boundary must be accepted.
 *
 *   node scripts/test-eve-local-world-inline.mjs     (npm run test:eve-local-world-inline)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)}`}`);
};

// A controlled clock that MOVES: every reading is 1 ms later than the one before, as time passes while the world
// writes its files. The world stamps an event with `new Date()` when it starts handling it; anything read after its
// writes is later. (A first version of the fix noted `Date.now()` after the write, and a backstop exactly at the
// boundary was refused: this clock is what shows it.)
const RealDate = Date;
let now = RealDate.UTC(2026, 9, 6, 12, 0, 0);
const tick = () => now++;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(tick());
    else super(...a);
  }
  static now() {
    return tick();
  }
};

const DIR = mkdtempSync(join(tmpdir(), "eve-local-world-inline-"));
process.on("exit", () => {
  if (DIR.startsWith(join(tmpdir(), "eve-local-world-inline-"))) rmSync(DIR, { recursive: true, force: true });
});
const { createLocalWorld } = await import(join(ROOT, "node_modules/eve/dist/src/compiled/@workflow/world-local/index.js"));
const world = createLocalWorld({ dataDir: DIR });

let seq = 0;
const ulid = () => `01J${String(++seq).padStart(23, "0")}`;
async function newRun() {
  const runId = `wrun_${ulid()}`;
  await world.events.create(runId, { eventType: "run_started", specVersion: 5, eventData: { deploymentId: "dpl_test", workflowName: "w", input: [] } });
  return runId;
}
const inlineStart = (runId, stepId, owner) =>
  world.events.create(runId, { eventType: "step_started", specVersion: 5, correlationId: stepId, eventData: { stepName: "s", workflowName: "w", input: [], ownerMessageId: owner } });
const queuedStart = (runId, stepId, owner) => world.events.create(runId, { eventType: "step_started", specVersion: 5, correlationId: stepId, eventData: { stepName: "s", ...(owner ? { ownerMessageId: owner } : {}) } });
const outcome = (p) => p.then((r) => ({ ok: true, attempt: r.step?.attempt, createdAt: r.event?.createdAt ? +new RealDate(r.event.createdAt) : undefined }), (e) => ({ ok: false, name: e?.name, message: e?.message }));

async function scenario(lease, label) {
  if (lease === undefined) delete process.env.WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS;
  else process.env.WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS = lease;
  console.log(`\nlease ${label}:`);
}

try {
  await scenario("1", "1 s");
  {
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    const first = await outcome(inlineStart(runId, step, "msg_A"));
    check("an inline start creates and starts the step", first.ok && first.attempt === 1, first);
    now = t0 + 900;
    const early = await outcome(queuedStart(runId, step, "msg_B"));
    check("a queued start by another invocation 100 ms before the lease ends is refused as a conflict (the duplicate run of mold_v1-191)", !early.ok && /already running inline/.test(early.message ?? ""), early);
    // The core's backstop is due at lastStartedAt + lease, lastStartedAt being the inline start EVENT's createdAt.
    // (the world reads the clock that many times before stamping an event: measured on the inline start itself)
    now = first.createdAt + 1000 - (first.createdAt - t0);
    const boundary = await outcome(queuedStart(runId, step, "msg_B"));
    check(`…a backstop EXACTLY at the lease boundary (stamped ${boundary.createdAt - first.createdAt} ms after the inline start's createdAt, as the core schedules it) is accepted`, boundary.ok && boundary.attempt === 2 && boundary.createdAt - first.createdAt === 1000, boundary);
  }
  {
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    await inlineStart(runId, step, "msg_A");
    now = t0 + 10;
    const same = await outcome(queuedStart(runId, step, "msg_A"));
    check("the same owner's redelivery (the runtime recovering its own inline step) is accepted", same.ok, same);
  }
  {
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    await inlineStart(runId, step, "msg_A");
    now = t0 + 20;
    await world.events.create(runId, { eventType: "step_retrying", specVersion: 5, correlationId: step, eventData: { error: { message: "transient" }, retryAfter: new Date(now) } });
    now = t0 + 30;
    const retry = await outcome(queuedStart(runId, step, "msg_C"));
    check("a step set to retry is started by its retry at once (the note is gone)", retry.ok, retry);
  }
  {
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    await inlineStart(runId, step, "msg_A");
    now = t0 + 40;
    await world.events.create(runId, { eventType: "step_completed", specVersion: 5, correlationId: step, eventData: { result: [] } });
    now = t0 + 50;
    const after = await outcome(queuedStart(runId, step, "msg_D"));
    check("a completed step is refused for being completed, not for being inline", !after.ok && !/already running inline/.test(after.message ?? ""), after);
  }
  {
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    const q = await outcome(queuedStart(runId, `step_${ulid()}`, "msg_X"));
    void q;
    await world.events.create(runId, { eventType: "step_created", specVersion: 5, correlationId: step, eventData: { stepName: "s", input: [] } });
    now = t0 + 5;
    const a = await outcome(queuedStart(runId, step, "msg_E"));
    const b = await outcome(queuedStart(runId, step, "msg_F"));
    check("a step that was never started inline is started from the queue as before (no note, no refusal)", a.ok && b.ok && b.attempt === 2, { a, b });
  }

  for (const [value, expectRefusedAt, label] of [
    ["0", 900, "0 → clamped to 1 s, as the core clamps it"],
    ["5000", 899_000, "5000 → clamped to 900 s"],
    ["abc", 859_000, "not an integer → the default, 860 s"],
    [undefined, 859_000, "unset → the default, 860 s"],
  ]) {
    await scenario(value, label);
    const runId = await newRun();
    const step = `step_${ulid()}`;
    const t0 = now;
    await inlineStart(runId, step, "msg_A");
    now = t0 + expectRefusedAt;
    const inside = await outcome(queuedStart(runId, step, "msg_B"));
    now = t0 + expectRefusedAt + (value === "0" ? 100 : 1000);
    const atBoundary = await outcome(queuedStart(runId, step, "msg_B"));
    check(`refused shortly before the lease ends, accepted at it`, !inside.ok && atBoundary.ok, { inside, atBoundary });
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
