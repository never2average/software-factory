/**
 * A GUARD AROUND EVE'S MICROSANDBOX BACKEND, for a deployment that is not on Vercel (`SANDBOX_BACKEND=microsandbox`).
 * It is applied by the build's sandbox wrapper (scripts/lib/sandbox-overlay.mjs) and nowhere else, so with the setting
 * unset (every Vercel deployment) this module is never loaded. Handed any backend that is not microsandbox, it returns
 * that backend untouched.
 *
 * WHAT IT FIXES (mold_v1-183, measured on the first self-hosted server, 2026-10-05). Read in eve 0.25.1:
 *
 *   1. "no agent socket found". At the end of every model step eve commits the sandbox (context/providers/sandbox.js
 *      `commit` -> execution/sandbox/ensure.js `captureState`). Outside `eve dev`, the microsandbox binding's
 *      `captureState` STOPS the VM and snapshots it (bindings/microsandbox-runtime.js `MicrosandboxVm.captureState` ->
 *      `stopAndSnapshot`), but leaves the handle in its per-process cache (bindings/microsandbox-lifecycle.js
 *      `activeMicrosandboxSessionHandles`), which is emptied only by `shutdown()` at process exit. The next step of
 *      the same session is handed that cached handle, whose VM is stopped and whose agent socket is gone: every bash,
 *      glob or file call in it fails with `runtime error: no agent socket found for sandbox "eve-sbx-ses-…"`. Live, a
 *      specialist that ran bash in two model steps failed on the second every time (9 of 9 under load).
 *      THE GUARD: when the last user of a VM commits it, the guard lets eve snapshot and stop it as before, then evicts
 *      eve's cached handle (`shutdown()`, a no-op on a stopped VM), so the next step reattaches the way eve does after
 *      a restart: the stopped sandbox is restored from the snapshot it just took.
 *
 *   2. Concurrent users of ONE sandbox. Sessions that share a sandbox key (the built-in `agent` tool's children run in
 *      their parent's sandbox) all got the same VM, and the first to finish a step stopped it under the others. The
 *      guard counts who is using a VM: an intermediate commit returns without stopping it, the last one stops it.
 *      Opening the same key twice at once makes one VM, not one each (eve's cache is filled only after the boot).
 *
 *   3. A VM that never boots. When several 2-vCPU VMs boot at once on a 4-vCPU host the guest kernel can stall
 *      ("BUG: scheduling while atomic" in the sandbox's kernel.log) and never report ready; microsandbox waits 180 s
 *      for its agent relay, then the step is retried: one specialist started 3 minutes after it was called.
 *      THE GUARD: at most `floor(host CPUs / SANDBOX_CPUS)` VMs boot at the same time (2 on a 4-vCPU host with the
 *      default 2 per sandbox); the rest queue, each logging "waiting for a sandbox". A boot that is not ready within
 *      `bootDeadlineMs` (60 s) is abandoned (its VM is stopped when microsandbox gives up on it) and started once
 *      more, so a stall costs about a minute, not three. A VM is not booted while the host's available memory is
 *      below one sandbox plus a margin, for at most `memoryWaitMs`: a bounded wait, never a refusal, so a parent
 *      waiting on its specialists can never deadlock on it.
 *
 * WHAT IT ALSO FIXES (mold_v1-190, measured on the same server, 2026-10-05 and 2026-10-06):
 *
 *   4. A guest that hangs AFTER booting. With more busy vCPUs than the host has (a 4-vCPU droplet, nested KVM, four or
 *      more 2-vCPU sandboxes running), a guest's second vCPU can stop making progress: the VMM spins at ~80% of a host
 *      CPU on that one vCPU thread (`fc_vcpu 1`), the guest logs "BUG: scheduling while atomic" on CPU 1, and a bash
 *      request it has taken never runs (eve-sbx-ses-5256b07f held a turn for 14 minutes; at 3 turns x 3 specialists
 *      four guests did it at once). Every guest kernel warning on record is on CPU 1. Capping BOOTS alone does not
 *      prevent it: the guests hang after they are up.
 *      THE CAP: at most `maxRunning` VMs run at the same time (SANDBOX_MAX_RUNNING; by default no more vCPUs than the
 *      host has, and no more memory than it can spare: 2 on a 4-CPU, 8 GB server at 2 CPUs each). One more waits, in
 *      line, for at most `runWaitMs` (SANDBOX_WAIT_S), and at most `maxWaiting` wait (SANDBOX_QUEUE_MAX); past either
 *      bound the call is answered "Waiting for a free sandbox: ..." and nothing runs, which the chat shows as the
 *      step's result. While something waits, a VM that has had no command for `parkIdleMs` (a parent waiting on its
 *      specialists, a step that will never commit) is snapshotted and stopped to free its place, exactly as a commit
 *      would; its session's next command restores it. A VM idle for `idleStopMs` is stopped the same way even when
 *      nothing waits (two leaked VMs had held 1 GiB each for 10 hours).
 *
 *   5. A command that never comes back. THE WATCHDOG: a command that has run for `checkAfterMs` has its VM asked a
 *      trivial question (`true`); a VM that answers nothing for `stallMs` (SANDBOX_STALL_S) while the command runs is
 *      hung. The command is answered "The sandbox stopped responding ..." at once, and the VM is stopped (eve's own
 *      snapshot-and-stop, which force-kills after 10 s; if even that does not end it, microsandbox's kill by the labels
 *      eve gave the VM) and replaced for the session's next command. A long command on a live VM is left alone.
 *      To make a VM replaceable mid-step, the handle eve gets carries a session that always works on the key's
 *      CURRENT VM, reopening it (through the cap and the boot gate) when it was parked or replaced.
 *
 * Nothing about the VMs themselves changes: the same CPUs, memory, network policy, templates, snapshots and names.
 *
 * No eve import here, on purpose: the plain-node tests load this module with eve's real binding behind it.
 *   node --experimental-strip-types scripts/test-sandbox-guard.mjs
 */
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";
import { maxRunningFor, sandboxGuardSettings } from "./sandbox-settings.ts";

/* ---- the shapes this needs from eve (execution/sandbox: SandboxBackend, its create input, its handle) ---------- */

export interface GuardedState {
  readonly backendName: string;
  readonly metadata?: unknown;
  readonly sessionKey: string;
}

export interface GuardedHandle {
  readonly session: unknown;
  readonly useSessionFn: (...args: never[]) => Promise<unknown>;
  captureState(): Promise<GuardedState>;
  shutdown(): Promise<void>;
}

export interface GuardedCreateInput {
  readonly sessionKey: string;
  readonly existingMetadata?: unknown;
  /** eve's tags; `sessionId` is the session's OWN id (the sandbox key may be its parent's). */
  readonly tags?: Readonly<Record<string, unknown>>;
}

export interface GuardedBackend {
  readonly name: string;
  prewarm?(input: never): Promise<unknown>;
  create(input: never): Promise<unknown>;
}

type Log = (line: string) => void;

/** Stops every RUNNING VM carrying all of these labels, by force. Returns how many it stopped. */
export type ForceStop = (labels: Readonly<Record<string, string>>) => Promise<number>;

export interface SandboxGuardOptions {
  /** Virtual CPUs each sandbox is given (SANDBOX_CPUS). */
  readonly sandboxCpus: number;
  /** Memory each sandbox is given, in MiB (SANDBOX_MEMORY_MIB). */
  readonly sandboxMemoryMiB: number;
  /** CPUs of this host. Default: what node reports. */
  readonly hostCpus?: number;
  /** Memory of this host in MiB. Default: /proc/meminfo MemTotal, else what node reports. */
  readonly hostMemoryMiB?: number;
  /** VMs allowed to boot at the same time. Default: floor(hostCpus / sandboxCpus), at least 1. */
  readonly maxStarting?: number;
  /** How long one boot may take before it is abandoned and started again. Default 60 s. */
  readonly bootDeadlineMs?: number;
  /** Boots tried before the step is told no sandbox started. Default 2. */
  readonly bootAttempts?: number;
  /** Memory kept free on top of one sandbox before another boots, in MiB. Default 512. */
  readonly memoryHeadroomMiB?: number;
  /** Longest wait for that memory before booting anyway. Default 60 s. */
  readonly memoryWaitMs?: number;
  /** The host's available memory in MiB. Default: /proc/meminfo MemAvailable, else node's free memory. */
  readonly memAvailableMiB?: () => number;
  /**
   * VMs allowed to RUN at the same time (SANDBOX_MAX_RUNNING). Default: the setting, else {@link maxRunningFor} the
   * host. Applies only where eve stops VMs between steps (not under `eve dev`, where they all stay up).
   */
  readonly maxRunning?: number;
  /** Longest wait for a free sandbox before the call is answered plainly (SANDBOX_WAIT_S). Default 180 s. */
  readonly runWaitMs?: number;
  /** Most calls waiting for a free sandbox at once; one more is answered at once (SANDBOX_QUEUE_MAX). Default 32. */
  readonly maxWaiting?: number;
  /** While something waits, a VM with no command for this long may be stopped to free its place. Default 10 s. */
  readonly parkIdleMs?: number;
  /** A VM with no command for this long is stopped even when nothing waits. Default 10 min. */
  readonly idleStopMs?: number;
  /** How often waiting and idle VMs are looked at. Default 2 s. */
  readonly housekeepMs?: number;
  /** A VM that answers nothing for this long while a command runs is hung (SANDBOX_STALL_S). 0: off. Default 60 s. */
  readonly stallMs?: number;
  /** How long a command runs before the watchdog first asks its VM whether it is alive. Default 20 s. */
  readonly checkAfterMs?: number;
  /** How long a hung VM's snapshot-and-stop may take before it is killed by its labels. Default 30 s. */
  readonly stopWaitMs?: number;
  /** A call that took this long logs where its time went (waited / ran). Default 5 s. */
  readonly timingFromMs?: number;
  /** How a VM that would not stop is killed. Default: microsandbox's own, by the labels eve gave it. */
  readonly forceStop?: ForceStop;
  /**
   * Whether eve stops the VM when it captures a session's state. True outside `eve dev`, which is what eve's binding
   * itself checks (`EVE_DEV=1` keeps the VM running, so there is nothing stale to evict).
   */
  readonly stopsOnCapture?: () => boolean;
  /** Where the plain status lines go. Default: console.log with a "[sandbox]" prefix. */
  readonly log?: Log;
  /** The VMs and the boot queue this guard shares. Default: one per process (they are the host's). */
  readonly pool?: SandboxPool;
}

/* ---- the pool: one per process, shared by every node's backend ------------------------------------------------ */

interface Entry {
  key: string;
  /** The VM's handle while it is running; null once it is stopped (committed, parked or replaced). */
  handle: GuardedHandle | null;
  /**
   * Who is using `handle`: one token per session (a session runs one step at a time, so a new step from the same
   * session supersedes its previous one, which may have failed without committing).
   */
  holders: Map<string, symbol>;
  opening: Promise<GuardedHandle> | null;
  closing: Promise<unknown> | null;
  /** The state the last real capture returned: newer than what a sibling session holds. */
  latest: GuardedState | null;
  touched: number;
  /** Holds one of the host's running places, from the start of its boot until its VM is stopped. */
  slot: boolean;
  /** Commands in flight on `handle`. */
  inflight: number;
  /** When a command last started or finished on it (or it was opened). */
  lastActive: number;
  /** The labels eve gave the running VM (its opener's tags): how to find it if it will not stop. */
  labels: Readonly<Record<string, string>> | null;
  /** Stop its VM to free its place (set by the guard that opened it). */
  park: ((why: "waiting" | "idle") => void) | null;
}

interface Waiter {
  readonly label: string;
  granted: boolean;
  grant(): void;
}

export interface SandboxPool {
  readonly entries: Map<string, Entry>;
  /** Handles whose VM the guard knows is stopped. eve's cache must never hand one out again. */
  readonly retired: WeakSet<object>;
  starting: number;
  readonly queue: Array<() => void>;
  /** Most VMs ever booting at the same time (the tests read it). */
  peakStarting: number;
  /** VMs holding a running place now. */
  running: number;
  /** Most VMs ever holding a running place at the same time (the tests read it). */
  peakRunning: number;
  /** Calls waiting for a running place, first come first served. */
  readonly waiting: Waiter[];
  /** VMs being stopped to free a place. */
  parking: number;
  /** Commands answered "the sandbox stopped responding" (the tests read it). */
  hung: number;
  timer: ReturnType<typeof setInterval> | null;
  tuning: { parkIdleMs: number; idleStopMs: number; housekeepMs: number };
}

const MAX_IDLE_ENTRIES = 500;

export function createSandboxPool(): SandboxPool {
  return {
    entries: new Map(),
    retired: new WeakSet(),
    starting: 0,
    queue: [],
    peakStarting: 0,
    running: 0,
    peakRunning: 0,
    waiting: [],
    parking: 0,
    hung: 0,
    timer: null,
    tuning: { parkIdleMs: 10_000, idleStopMs: 600_000, housekeepMs: 2_000 },
  };
}

const POOL_KEY = Symbol.for("app.sandbox.guard.pool");
function processPool(): SandboxPool {
  const holder = globalThis as unknown as Record<symbol, SandboxPool | undefined>;
  return (holder[POOL_KEY] ??= createSandboxPool());
}

/** What the pool is doing, in numbers (for a status line or a test). */
export function sandboxPoolStatus(pool: SandboxPool = processPool()): { running: number; waiting: number; peakRunning: number; hung: number } {
  return { running: pool.running, waiting: pool.waiting.length, peakRunning: pool.peakRunning, hung: pool.hung };
}

/* ---- the host ------------------------------------------------------------------------------------------------- */

function meminfoMiB(field: "MemAvailable" | "MemTotal"): number | null {
  try {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Math.floor(Number(match[1]) / 1024);
  } catch {
    /* not Linux */
  }
  return null;
}

function memAvailableFromProc(): number {
  return meminfoMiB("MemAvailable") ?? Math.floor(freemem() / 1048576);
}

/** How many VMs may boot at once on a host with `hostCpus` CPUs when each is given `sandboxCpus`. */
export function maxStartingFor(hostCpus: number, sandboxCpus: number): number {
  return Math.max(1, Math.floor(hostCpus / Math.max(1, sandboxCpus)));
}

export { maxRunningFor };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A timer that can be cleared, so a race that is already won leaves nothing pending. */
function after<T>(ms: number, value: T): { promise: Promise<T>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/** `work`, or `fallback` when it has not settled within `ms` (or failed). */
async function within<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  const t = after(ms, fallback);
  try {
    return await Promise.race([work.catch(() => fallback), t.promise]);
  } finally {
    t.clear();
  }
}

/**
 * eve's handle `shutdown()` empties its cache entry first, synchronously, then stops the VM (already stopped here) and
 * detaches. The eviction is what matters, so a runtime slow to answer the redundant stop never holds up a commit.
 */
async function evict(handle: GuardedHandle): Promise<void> {
  await within(handle.shutdown(), 5_000, undefined);
}

/** eve labels a VM with `eve.backend` and its opener's tags (bindings/microsandbox-runtime.js createMicrosandbox). */
function labelsOf(tags: GuardedCreateInput["tags"]): Readonly<Record<string, string>> | null {
  const sessionId = tags?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const labels: Record<string, string> = { "eve.backend": "microsandbox" };
  for (const [k, v] of Object.entries(tags ?? {})) if (typeof v === "string") labels[k] = v;
  return labels;
}

interface StoppableSandbox {
  readonly status: string;
  stopWithTimeout(timeoutMs: number): Promise<void>;
  kill(): Promise<void>;
}

/** microsandbox's own kill, for a VM its runtime would not stop politely: the package eve's binding loads. */
const microsandboxForceStop: ForceStop = async (labels) => {
  const mod = (await import("microsandbox")) as unknown as { Sandbox: { listWith(filter: { labels: Record<string, string> }): Promise<StoppableSandbox[]> } };
  let stopped = 0;
  for (const vm of await mod.Sandbox.listWith({ labels: { ...labels } })) {
    if (vm.status === "stopped" || vm.status === "crashed") continue; // a guest stalled at boot is not "running" yet
    await vm.stopWithTimeout(0).catch(() => vm.kill());
    stopped += 1;
  }
  return stopped;
};

/* ---- the guard ------------------------------------------------------------------------------------------------ */

const TIMED_OUT = Symbol("timed out");

let anonymous = 0;

/** The methods of eve's SandboxSession (shared/sandbox-session) that talk to the VM. `spawn` is watched apart. */
const VM_METHODS = new Set(["run", "readFile", "readBinaryFile", "readTextFile", "writeFile", "writeBinaryFile", "writeTextFile", "removePath", "setNetworkPolicy"]);

type AnySession = Record<string, unknown>;
interface SpawnedProcess {
  wait(): Promise<unknown>;
  [k: string]: unknown;
}

/**
 * `backend` with the guard in front of its `create` (and `prewarm` passed through). Any backend that is not eve's
 * microsandbox is returned as it is, the same object.
 */
export function guardSandboxBackend<B extends GuardedBackend>(backend: B, options: SandboxGuardOptions): B {
  if (backend?.name !== "microsandbox") return backend;
  const settings = sandboxGuardSettings();
  const pool = options.pool ?? processPool();
  const hostCpus = options.hostCpus ?? availableParallelism();
  const hostMemoryMiB = options.hostMemoryMiB ?? meminfoMiB("MemTotal") ?? Math.floor(totalmem() / 1048576);
  const maxStarting = options.maxStarting ?? maxStartingFor(hostCpus, options.sandboxCpus);
  const maxRunning = Math.max(1, options.maxRunning ?? settings.maxRunning ?? maxRunningFor(hostCpus, options.sandboxCpus, hostMemoryMiB, options.sandboxMemoryMiB));
  const runWaitMs = options.runWaitMs ?? settings.runWaitMs;
  const maxWaiting = Math.max(0, options.maxWaiting ?? settings.maxWaiting);
  const stallMs = Math.max(0, options.stallMs ?? settings.stallMs);
  const checkAfterMs = options.checkAfterMs ?? 20_000;
  const stopWaitMs = options.stopWaitMs ?? 30_000;
  const forceStop = options.forceStop ?? microsandboxForceStop;
  const timingFromMs = options.timingFromMs ?? 5_000;
  const bootDeadlineMs = options.bootDeadlineMs ?? 60_000;
  const bootAttempts = Math.max(1, options.bootAttempts ?? 2);
  const headroomMiB = options.memoryHeadroomMiB ?? 512;
  const memoryWaitMs = options.memoryWaitMs ?? 60_000;
  const memAvailableMiB = options.memAvailableMiB ?? memAvailableFromProc;
  const stopsOnCapture = options.stopsOnCapture ?? (() => process.env.EVE_DEV !== "1");
  const log: Log = options.log ?? ((line) => console.log(`[sandbox] ${line}`));
  const inner = backend as unknown as { create(input: GuardedCreateInput): Promise<GuardedHandle> };
  pool.tuning = {
    parkIdleMs: options.parkIdleMs ?? pool.tuning.parkIdleMs,
    idleStopMs: options.idleStopMs ?? pool.tuning.idleStopMs,
    housekeepMs: options.housekeepMs ?? pool.tuning.housekeepMs,
  };
  const secs = (ms: number) => Math.round(ms / 100) / 10;

  /* -- the running cap: at most `maxRunning` VMs up, the rest in line for a bounded time -- */

  const busy = (why: string) =>
    new Error(
      `Waiting for a free sandbox: all ${maxRunning} sandboxes this server runs at once are in use, ${why}. Nothing was run. ` +
        "Try again in a minute or two.",
    );

  async function acquireRun(entry: Entry, label: string): Promise<void> {
    if (entry.slot || !stopsOnCapture()) return; // under eve dev every VM stays up between steps: nothing to share
    if (pool.running < maxRunning && pool.waiting.length === 0) {
      pool.running += 1;
      pool.peakRunning = Math.max(pool.peakRunning, pool.running);
      entry.slot = true;
      return;
    }
    if (pool.waiting.length >= maxWaiting) {
      log(`no free sandbox (${label}): ${pool.running} of ${maxRunning} running and ${pool.waiting.length} already waiting; answered at once`);
      throw busy(`and ${pool.waiting.length} more ${pool.waiting.length === 1 ? "is" : "are"} already waiting`);
    }
    const waiter: Waiter = { label, granted: false, grant: () => {} };
    const granted = new Promise<void>((resolve) => {
      waiter.grant = () => {
        waiter.granted = true;
        resolve();
      };
    });
    pool.waiting.push(waiter);
    log(`waiting for a free sandbox (${label}): ${pool.running} of ${maxRunning} running on this host (${hostCpus} CPUs, ${options.sandboxCpus} per sandbox); ${pool.waiting.length} waiting`);
    const from = Date.now();
    housekeep();
    const limit = after(runWaitMs, null);
    await Promise.race([granted, limit.promise]);
    limit.clear();
    if (!waiter.granted) {
      const i = pool.waiting.indexOf(waiter);
      if (i >= 0) pool.waiting.splice(i, 1);
      log(`no sandbox came free within ${secs(runWaitMs)} s (${label}); answered plainly`);
      throw busy(`and none came free within ${Math.round(runWaitMs / 1000)} s`);
    }
    entry.slot = true;
    pool.peakRunning = Math.max(pool.peakRunning, pool.running);
    log(`a sandbox came free (${label}) after ${secs(Date.now() - from)} s`);
  }

  /** The entry's VM is stopped (or never started): its place passes to the next in line. */
  function releaseRun(entry: Entry) {
    if (!entry.slot) return;
    entry.slot = false;
    const next = pool.waiting.shift();
    if (next) next.grant();
    else pool.running -= 1;
  }

  /** While something waits, stop the VMs idle longest; and stop any VM idle for `idleStopMs` regardless. */
  function housekeep() {
    const now = Date.now();
    const idle = [...pool.entries.values()]
      .filter((e) => e.handle && e.slot && e.park && e.inflight === 0 && !e.closing && !e.opening)
      .sort((a, b) => a.lastActive - b.lastActive);
    for (const e of idle) if (now - e.lastActive >= pool.tuning.idleStopMs) e.park?.("idle");
    let need = pool.waiting.length - pool.parking;
    for (const e of idle) {
      if (need <= 0) break;
      if (!e.handle || e.closing || now - e.lastActive < pool.tuning.parkIdleMs) continue;
      e.park?.("waiting");
      need -= 1;
    }
    if (pool.waiting.length === 0 && ![...pool.entries.values()].some((e) => e.slot)) {
      if (pool.timer) clearInterval(pool.timer);
      pool.timer = null;
    } else if (!pool.timer) {
      pool.timer = setInterval(housekeep, pool.tuning.housekeepMs);
      pool.timer.unref?.();
    }
  }

  /* -- the boot gate: at most `maxStarting` VMs booting, the rest in line, first come first served -- */

  async function acquireStart(label: string): Promise<() => void> {
    if (pool.starting >= maxStarting) {
      log(
        `waiting for a sandbox (${label}): ${pool.starting} already starting, at most ${maxStarting} at once on this host ` +
          `(${hostCpus} CPUs, ${options.sandboxCpus} per sandbox); ${pool.queue.length + 1} waiting`,
      );
      const waitedFrom = Date.now();
      await new Promise<void>((resolve) => pool.queue.push(resolve));
      log(`sandbox slot free (${label}) after ${secs(Date.now() - waitedFrom)} s`);
    } else pool.starting += 1;
    pool.peakStarting = Math.max(pool.peakStarting, pool.starting);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = pool.queue.shift();
      if (next) next(); // the slot passes straight to the next in line
      else pool.starting -= 1;
    };
  }

  async function waitForMemory(label: string): Promise<void> {
    const need = options.sandboxMemoryMiB + headroomMiB;
    if (memAvailableMiB() >= need) return;
    log(`waiting for memory (${label}): ${memAvailableMiB()} MiB available, a sandbox needs ${options.sandboxMemoryMiB} MiB plus ${headroomMiB} MiB spare`);
    const until = Date.now() + memoryWaitMs;
    while (Date.now() < until) {
      await sleep(1_000);
      if (memAvailableMiB() >= need) return;
    }
    log(`still short of memory after ${Math.round(memoryWaitMs / 1000)} s (${label}); starting the sandbox anyway`);
  }

  /** Boot one VM for `entry`: a running place, then the boot gate, with a deadline and one more try. */
  async function open(entry: Entry, input: GuardedCreateInput): Promise<GuardedHandle> {
    const label = shortKey(entry.key);
    await waitForMemory(label);
    await acquireRun(entry, label);
    let opened = false;
    try {
      const release = await acquireStart(label);
      try {
        let staleSeen = 0;
        for (let attempt = 1; ; ) {
          const pending = inner.create({ ...input, existingMetadata: entry.latest?.metadata ?? input.existingMetadata });
          const deadline = after(bootDeadlineMs, TIMED_OUT);
          const outcome = await Promise.race([pending, deadline.promise]).finally(() => deadline.clear());
          if (outcome === TIMED_OUT) {
            // If the abandoned boot does come up later, stop it: nothing will use it.
            pending.then(
              (late) => {
                pool.retired.add(late);
                late.shutdown().catch(() => {});
              },
              () => {},
            );
            // And do not leave it running meanwhile. A guest that stalled at boot ("BUG: scheduling while atomic" on CPU
            // 1, seen under the cap on 2026-10-06) is left by microsandbox until its own 180 s relay timeout, outside
            // the cap, spinning a CPU, while the next attempt boots beside it. Kill it by the labels eve gave it.
            const labels = labelsOf(input.tags);
            if (labels) {
              const killed = await within(forceStop(labels), 15_000, -1);
              if (killed > 0) log(`the sandbox that did not start (${label}) was stopped: ${killed} VM(s) killed`);
            }
            if (attempt >= bootAttempts) {
              throw new Error(
                `No sandbox started within ${Math.round(bootDeadlineMs / 1000)} s, ${bootAttempts} times in a row. The host may be ` +
                  `overloaded (${hostCpus} CPUs, ${options.sandboxCpus} per sandbox, ${maxStarting} starting at once). Try again in a minute.`,
              );
            }
            log(`a sandbox did not start within ${Math.round(bootDeadlineMs / 1000)} s (${label}, attempt ${attempt} of ${bootAttempts}); starting another`);
            attempt += 1;
            continue;
          }
          if (pool.retired.has(outcome)) {
            // eve's own cache handed back a VM this guard saw stopped: evict it (stopping a stopped VM is a no-op).
            await evict(outcome);
            if (++staleSeen > 2) throw new Error(`The sandbox for ${label} kept coming back stopped; it could not be reopened.`);
            continue;
          }
          opened = true;
          entry.labels = labelsOf(input.tags);
          entry.lastActive = Date.now();
          entry.park = (why) => park(entry, why);
          return outcome;
        }
      } finally {
        release();
      }
    } finally {
      if (!opened) releaseRun(entry);
      else housekeep(); // keeps the idle watch running while a VM is up
    }
  }

  /** The key's running VM, opened (or reopened after a park or a replacement) when there is none. */
  async function live(entry: Entry, input: GuardedCreateInput): Promise<GuardedHandle> {
    for (;;) {
      if (entry.closing) {
        await entry.closing.catch(() => {});
        continue;
      }
      if (entry.handle) return entry.handle;
      if (!entry.opening) {
        const target = entry;
        target.opening = open(target, input)
          .then((handle) => {
            target.handle = handle;
            return handle;
          })
          .finally(() => {
            target.opening = null;
          });
      }
      await entry.opening;
    }
  }

  /**
   * Stop `handle`'s VM and take its state, as eve's commit does: snapshot and stop. A commit's failure is the caller's;
   * a park's or a hung VM's is not, and a VM that would not stop is then killed by its labels. Either way the handle
   * is retired, evicted from eve's cache and its running place passed on.
   */
  function close(entry: Entry, handle: GuardedHandle, why: "commit" | "park" | "hung"): Promise<GuardedState | null> {
    pool.retired.add(handle);
    if (entry.handle === handle) entry.handle = null;
    const closing = (async () => {
      let state: GuardedState | null = null;
      try {
        if (why === "commit") state = await handle.captureState();
        else if (stopsOnCapture()) state = await within(handle.captureState(), stopWaitMs, null);
        if (state) entry.latest = state;
        return state;
      } finally {
        if (why !== "commit" && !state && entry.labels) {
          const stopped = await within(forceStop(entry.labels), 15_000, -1);
          log(
            stopped < 0
              ? `a sandbox (${shortKey(entry.key)}) could not be stopped; it is left to microsandbox`
              : `a sandbox (${shortKey(entry.key)}) did not stop on request: ${stopped} VM(s) killed`,
          );
        }
        await evict(handle);
        releaseRun(entry);
      }
    })();
    entry.closing = closing;
    closing.then(
      () => {
        if (entry.closing === closing) entry.closing = null;
      },
      () => {
        if (entry.closing === closing) entry.closing = null;
      },
    );
    return closing;
  }

  function park(entry: Entry, why: "waiting" | "idle") {
    const handle = entry.handle;
    if (!handle || entry.closing || entry.inflight > 0) return;
    pool.parking += 1;
    log(
      `stopping an idle sandbox (${shortKey(entry.key)}, no command for ${secs(Date.now() - entry.lastActive)} s) ` +
        (why === "waiting" ? "to free its place for one that is waiting; its next command restores it" : "; its next command restores it"),
    );
    close(entry, handle, "park")
      .catch((error) => log(`stopping an idle sandbox (${shortKey(entry.key)}) failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`))
      .finally(() => {
        pool.parking -= 1;
      });
  }

  /* -- the watchdog: a command whose VM answers nothing for `stallMs` is answered plainly, and the VM replaced -- */

  async function watch<T>(entry: Entry, handle: GuardedHandle, work: Promise<T>, what: string): Promise<T> {
    if (stallMs <= 0) return await work;
    type Settled = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    const settled: Promise<Settled> = work.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    const unwrap = (r: Settled): T => {
      if (r.ok) return r.value;
      throw r.error;
    };
    const stoppedResponding = () =>
      new Error(
        `The sandbox stopped responding (nothing came back from it for ${Math.round(stallMs / 1000)} s), so this command was stopped and the ` +
          "sandbox is being restarted. Run the command again. Files from earlier steps are kept.",
      );
    for (;;) {
      const wait = after(checkAfterMs, null);
      const first = await Promise.race([settled, wait.promise]);
      wait.clear();
      if (first) return unwrap(first);
      if (entry.handle !== handle) {
        // Its VM is being stopped under it (another call found it hung): its own error comes when the VM goes, and if
        // the VM will not go, this call is not left waiting on it.
        const gone = after(stopWaitMs + 20_000, null);
        const r = await Promise.race([settled, gone.promise]);
        gone.clear();
        if (r) return unwrap(r);
        throw stoppedResponding();
      }
      // Still running: is the VM itself alive? A guest that is merely busy answers a trivial command.
      const probe = (handle.session as AnySession).run as ((o: { command: string }) => Promise<unknown>) | undefined;
      const alive = probe
        ? probe.call(handle.session, { command: "true" }).then(
            () => "alive" as const,
            () => "silent" as const,
          )
        : Promise.resolve("alive" as const);
      const limit = after(stallMs, "silent" as const);
      const r = await Promise.race([settled, alive, limit.promise]);
      limit.clear();
      if (typeof r === "object") return unwrap(r);
      if (r === "alive") continue;
      // Hung. Answer now; stop and replace the VM behind the answer.
      pool.hung += 1;
      if (entry.handle === handle) {
        log(`a sandbox stopped responding (${shortKey(entry.key)}): no answer for ${secs(stallMs)} s during ${what}; stopping it, the next command gets a fresh one`);
        void close(entry, handle, "hung").catch(() => {});
      }
      throw stoppedResponding();
    }
  }

  /**
   * WHERE A CALL'S TIME WENT (mold_v1-190 follow-up). A call that took `timingFromMs` (5 s) or more says, for its session,
   * how long it waited for its sandbox (a free place, the boot gate and the boot itself, or a restore) and how long it
   * then ran. From outside, a call answered after 80 s looks the same whether it queued for 79 s or ran for 79 s; the
   * load check (scripts/rig-sandbox-load.mjs --judge) reads these lines to tell the two apart. One fixed shape:
   *   timing: a command (session <id>, <key>) waited 81.0 s for its sandbox and ran 0.3 s
   *   timing: a sandbox (session <id>, <key>) opened after 61.7 s
   */
  function timing(what: "command" | "open", entry: Entry, holder: string, waitedMs: number, ranMs = 0) {
    if (waitedMs + ranMs < timingFromMs) return;
    const who = `session ${holder}, ${shortKey(entry.key)}`;
    log(
      what === "open"
        ? `timing: a sandbox (${who}) opened after ${secs(waitedMs)} s`
        : `timing: a command (${who}) waited ${secs(waitedMs)} s for its sandbox and ran ${secs(ranMs)} s`,
    );
  }

  /** One call on the key's current VM, counted as in flight and watched. */
  async function onVm<T>(entry: Entry, input: GuardedCreateInput, holder: string, what: string, call: (handle: GuardedHandle) => Promise<T>): Promise<T> {
    const asked = Date.now();
    const handle = await live(entry, input);
    const ready = Date.now();
    entry.inflight += 1;
    entry.lastActive = ready;
    try {
      return await watch(entry, handle, Promise.resolve().then(() => call(handle)), what);
    } finally {
      entry.inflight -= 1;
      entry.lastActive = Date.now();
      if (what === "a command") timing("command", entry, holder, ready - asked, entry.lastActive - ready);
    }
  }

  /**
   * eve's session object, on whichever VM the key has NOW: every call that talks to the VM goes through `onVm`. Pure
   * helpers (`resolvePath`) and plain values (`id`) are the first VM's, which are the same for every VM of a key.
   */
  function sessionOn(entry: Entry, first: GuardedHandle, input: GuardedCreateInput, holder: string): AnySession {
    const base = first.session as AnySession;
    const out: AnySession = {};
    for (const name of Object.keys(base)) {
      const value = base[name];
      if (name === "spawn" && typeof value === "function") {
        out.spawn = async (...args: unknown[]) => {
          const asked = Date.now();
          const handle = await live(entry, input);
          const ready = Date.now();
          entry.inflight += 1;
          entry.lastActive = ready;
          let proc: SpawnedProcess;
          try {
            proc = await watch(entry, handle, Promise.resolve().then(() => ((handle.session as AnySession).spawn as (...a: unknown[]) => Promise<SpawnedProcess>)(...args)), "spawn");
          } catch (error) {
            entry.inflight -= 1;
            throw error;
          }
          const done = proc.wait();
          done.then(
            () => {},
            () => {},
          ).finally(() => {
            entry.inflight -= 1;
            entry.lastActive = Date.now();
            timing("command", entry, holder, ready - asked, entry.lastActive - ready);
          });
          return { ...proc, wait: () => watch(entry, handle, done, "a command") };
        };
      } else if (VM_METHODS.has(name) && typeof value === "function") {
        out[name] = (...args: unknown[]) =>
          onVm(entry, input, holder, name === "run" ? "a command" : name, (handle) => ((handle.session as AnySession)[name] as (...a: unknown[]) => Promise<unknown>)(...args));
      } else out[name] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(base) : value;
    }
    return out;
  }

  function lease(entry: Entry, first: GuardedHandle, input: GuardedCreateInput, holder: string, token: symbol): GuardedHandle {
    let own: GuardedState | null = null;
    /** True when this lease was still the session's current hold on the VM (and is not any more). */
    const finish = () => {
      entry.touched = Date.now();
      if (entry.holders.get(holder) !== token) return false;
      entry.holders.delete(holder);
      return true;
    };
    const quiet = (): GuardedState => ({ backendName: backend.name, sessionKey: input.sessionKey });
    const session = sessionOn(entry, first, input, holder);
    return {
      session,
      useSessionFn: async (...args: never[]) => {
        await onVm(entry, input, holder, "a network change", (handle) => handle.useSessionFn(...args));
        return session;
      },
      async captureState(): Promise<GuardedState> {
        if (!finish()) return own ?? quiet();
        if (!stopsOnCapture()) {
          // eve dev: eve leaves the VM running, so its cached handle stays good. Nothing to do but pass it through.
          own = await (entry.handle ?? first).captureState();
          entry.latest = own;
          return own;
        }
        while (entry.closing) await entry.closing.catch(() => {});
        if (entry.holders.size > 0) {
          // Another session is still working in this VM: committing must not stop it under them. No metadata: after
          // a restart eve then reads the key's own metadata file, which names this VM and whatever snapshot the last
          // one out takes of it.
          own = quiet();
          return own;
        }
        const handle = entry.handle;
        if (!handle) {
          // Already stopped (parked to free its place, or replaced after it hung): its snapshot is the state.
          own = entry.latest ?? quiet();
          return own;
        }
        // The last user: eve snapshots and stops the VM, as before; then its cached handle is evicted so the next
        // step reattaches (restores the stopped sandbox from the snapshot just taken) instead of reusing a dead one.
        try {
          own = (await close(entry, handle, "commit")) ?? quiet();
          return own;
        } finally {
          prune();
        }
      },
      async shutdown(): Promise<void> {
        // The process is exiting (eve's shutdown plugin): stop the VM whoever else is using it.
        finish();
        const handle = entry.handle;
        if (!handle) return;
        pool.retired.add(handle);
        entry.handle = null;
        try {
          await handle.shutdown();
        } finally {
          releaseRun(entry);
        }
      },
    };
  }

  function prune() {
    if (pool.entries.size <= MAX_IDLE_ENTRIES) return;
    const idle = [...pool.entries.values()].filter((e) => !e.handle && !e.opening && !e.closing && e.holders.size === 0).sort((a, b) => a.touched - b.touched);
    for (const e of idle.slice(0, pool.entries.size - MAX_IDLE_ENTRIES)) pool.entries.delete(e.key);
  }

  async function create(input: GuardedCreateInput): Promise<GuardedHandle> {
    const key = `${backend.name}\0${input.sessionKey}`;
    let entry = pool.entries.get(key);
    if (!entry) {
      entry = {
        key,
        handle: null,
        holders: new Map(),
        opening: null,
        closing: null,
        latest: null,
        touched: Date.now(),
        slot: false,
        inflight: 0,
        lastActive: Date.now(),
        labels: null,
        park: null,
      };
      pool.entries.set(key, entry);
    }
    const ownId = input.tags?.sessionId;
    const holder = typeof ownId === "string" && ownId ? ownId : `anonymous:${++anonymous}`;
    const token = Symbol(holder);
    entry.holders.set(holder, token); // supersedes this session's previous step, committed or not
    try {
      const asked = Date.now();
      const handle = await live(entry, input);
      entry.lastActive = Date.now();
      timing("open", entry, holder, entry.lastActive - asked);
      return lease(entry, handle, input, holder, token);
    } catch (error) {
      if (entry.holders.get(holder) === token) entry.holders.delete(holder);
      throw error;
    }
  }

  return { ...backend, create } as B;
}

function shortKey(key: string): string {
  const sessionKey = key.split("\0").pop() ?? key;
  return sessionKey.length > 48 ? `…${sessionKey.slice(-48)}` : sessionKey;
}
