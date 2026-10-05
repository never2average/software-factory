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
 * Nothing about the VMs themselves changes: the same CPUs, memory, network policy, templates, snapshots and names.
 *
 * No eve import here, on purpose: the plain-node tests load this module with eve's real binding behind it.
 *   node --experimental-strip-types scripts/test-sandbox-guard.mjs
 */
import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";

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

export interface SandboxGuardOptions {
  /** Virtual CPUs each sandbox is given (SANDBOX_CPUS). */
  readonly sandboxCpus: number;
  /** Memory each sandbox is given, in MiB (SANDBOX_MEMORY_MIB). */
  readonly sandboxMemoryMiB: number;
  /** CPUs of this host. Default: what node reports. */
  readonly hostCpus?: number;
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
  /** The VM's handle while it is running; null once the last user has committed it. */
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
}

export interface SandboxPool {
  readonly entries: Map<string, Entry>;
  /** Handles whose VM the guard knows is stopped. eve's cache must never hand one out again. */
  readonly retired: WeakSet<object>;
  starting: number;
  readonly queue: Array<() => void>;
  /** Most VMs ever booting at the same time (the tests read it). */
  peakStarting: number;
}

const MAX_IDLE_ENTRIES = 500;

export function createSandboxPool(): SandboxPool {
  return { entries: new Map(), retired: new WeakSet(), starting: 0, queue: [], peakStarting: 0 };
}

const POOL_KEY = Symbol.for("app.sandbox.guard.pool");
function processPool(): SandboxPool {
  const holder = globalThis as unknown as Record<symbol, SandboxPool | undefined>;
  return (holder[POOL_KEY] ??= createSandboxPool());
}

/* ---- the host ------------------------------------------------------------------------------------------------- */

function memAvailableFromProc(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Math.floor(Number(match[1]) / 1024);
  } catch {
    /* not Linux */
  }
  return Math.floor(freemem() / 1048576);
}

/** How many VMs may boot at once on a host with `hostCpus` CPUs when each is given `sandboxCpus`. */
export function maxStartingFor(hostCpus: number, sandboxCpus: number): number {
  return Math.max(1, Math.floor(hostCpus / Math.max(1, sandboxCpus)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * eve's handle `shutdown()` empties its cache entry first, synchronously, then stops the VM (already stopped here) and
 * detaches. The eviction is what matters, so a runtime slow to answer the redundant stop never holds up a commit.
 */
async function evict(handle: GuardedHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    handle.shutdown().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
    }),
  ]);
  clearTimeout(timer);
}

/* ---- the guard ------------------------------------------------------------------------------------------------ */

const TIMED_OUT = Symbol("timed out");
let anonymous = 0;

/**
 * `backend` with the guard in front of its `create` (and `prewarm` passed through). Any backend that is not eve's
 * microsandbox is returned as it is, the same object.
 */
export function guardSandboxBackend<B extends GuardedBackend>(backend: B, options: SandboxGuardOptions): B {
  if (backend?.name !== "microsandbox") return backend;
  const pool = options.pool ?? processPool();
  const hostCpus = options.hostCpus ?? availableParallelism();
  const maxStarting = options.maxStarting ?? maxStartingFor(hostCpus, options.sandboxCpus);
  const bootDeadlineMs = options.bootDeadlineMs ?? 60_000;
  const bootAttempts = Math.max(1, options.bootAttempts ?? 2);
  const headroomMiB = options.memoryHeadroomMiB ?? 512;
  const memoryWaitMs = options.memoryWaitMs ?? 60_000;
  const memAvailableMiB = options.memAvailableMiB ?? memAvailableFromProc;
  const stopsOnCapture = options.stopsOnCapture ?? (() => process.env.EVE_DEV !== "1");
  const log: Log = options.log ?? ((line) => console.log(`[sandbox] ${line}`));
  const inner = backend as unknown as { create(input: GuardedCreateInput): Promise<GuardedHandle> };

  /* -- the boot gate: at most `maxStarting` VMs booting, the rest in line, first come first served -- */

  async function acquireStart(label: string): Promise<() => void> {
    if (pool.starting >= maxStarting) {
      log(
        `waiting for a sandbox (${label}): ${pool.starting} already starting, at most ${maxStarting} at once on this host ` +
          `(${hostCpus} CPUs, ${options.sandboxCpus} per sandbox); ${pool.queue.length + 1} waiting`,
      );
      const waitedFrom = Date.now();
      await new Promise<void>((resolve) => pool.queue.push(resolve));
      log(`sandbox slot free (${label}) after ${Math.round((Date.now() - waitedFrom) / 100) / 10} s`);
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

  /** Boot one VM for `entry`, through the gate, with a deadline and one more try. */
  async function open(entry: Entry, input: GuardedCreateInput): Promise<GuardedHandle> {
    const label = shortKey(entry.key);
    await waitForMemory(label);
    const release = await acquireStart(label);
    try {
      let staleSeen = 0;
      for (let attempt = 1; ; ) {
        const pending = inner.create({ ...input, existingMetadata: entry.latest?.metadata ?? input.existingMetadata });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          pending,
          new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), bootDeadlineMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (outcome === TIMED_OUT) {
          // If the abandoned boot does come up later, stop it: nothing will use it.
          pending.then(
            (late) => {
              pool.retired.add(late);
              late.shutdown().catch(() => {});
            },
            () => {},
          );
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
        return outcome;
      }
    } finally {
      release();
    }
  }

  function lease(entry: Entry, handle: GuardedHandle, input: GuardedCreateInput, holder: string, token: symbol): GuardedHandle {
    let own: GuardedState | null = null;
    /** True when this lease was still the session's current hold on the VM (and is not any more). */
    const finish = () => {
      entry.touched = Date.now();
      if (entry.holders.get(holder) !== token) return false;
      entry.holders.delete(holder);
      return true;
    };
    const quiet = (): GuardedState => ({ backendName: backend.name, sessionKey: input.sessionKey });
    return {
      session: handle.session,
      useSessionFn: handle.useSessionFn,
      async captureState(): Promise<GuardedState> {
        if (!finish()) return own ?? quiet();
        if (!stopsOnCapture()) {
          // eve dev: eve leaves the VM running, so its cached handle stays good. Nothing to do but pass it through.
          own = await handle.captureState();
          entry.latest = own;
          return own;
        }
        if (entry.holders.size > 0 && entry.handle === handle) {
          // Another session is still working in this VM: committing must not stop it under them. No metadata: after
          // a restart eve then reads the key's own metadata file, which names this VM and whatever snapshot the last
          // one out takes of it.
          own = quiet();
          return own;
        }
        // The last user: eve snapshots and stops the VM, as before; then its cached handle is evicted so the next
        // step reattaches (restores the stopped sandbox from the snapshot just taken) instead of reusing a dead one.
        const closing = (async () => {
          try {
            own = await handle.captureState();
            entry.latest = own;
            return own;
          } finally {
            pool.retired.add(handle);
            if (entry.handle === handle) entry.handle = null;
            await evict(handle);
          }
        })();
        entry.closing = closing;
        try {
          return await closing;
        } finally {
          if (entry.closing === closing) entry.closing = null;
          prune();
        }
      },
      async shutdown(): Promise<void> {
        // The process is exiting (eve's shutdown plugin): stop the VM whoever else is using it.
        finish();
        pool.retired.add(handle);
        if (entry.handle === handle) entry.handle = null;
        await handle.shutdown();
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
      entry = { key, handle: null, holders: new Map(), opening: null, closing: null, latest: null, touched: Date.now() };
      pool.entries.set(key, entry);
    }
    const ownId = input.tags?.sessionId;
    const holder = typeof ownId === "string" && ownId ? ownId : `anonymous:${++anonymous}`;
    const token = Symbol(holder);
    entry.holders.set(holder, token); // supersedes this session's previous step, committed or not
    try {
      for (;;) {
        if (entry.closing) {
          await entry.closing.catch(() => {});
          continue;
        }
        if (entry.handle) return lease(entry, entry.handle, input, holder, token);
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
