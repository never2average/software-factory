#!/usr/bin/env node
/**
 * sandbox:prewarm — build the sandbox templates of a BUILT agent ONE AT A TIME, on the server that will serve it.
 *
 * For a deployment that is not on Vercel (docs/self-hosting/SANDBOX.md). On Vercel, `eve build` provisions the
 * templates inside the Vercel builder and this script is not used.
 *
 * WHY IT EXISTS. A production eve server cannot build a template on demand ("Sandbox template … is not provisioned
 * … Run eve build or invoke prewarmAppSandboxes() before serving traffic"), so they must exist before it starts.
 * `eve start` does build them first, but (measured, eve 0.25.1, a 4-vCPU host):
 *
 *   · all at once: nine microVMs booted together, one timed out waiting for its agent relay, and the whole start
 *     exited 1 (eve's prewarm is a bare Promise.all with no concurrency setting);
 *   · a killed start leaves its lock directories behind, and the next start then sits at "initializing 9 sandbox
 *     templates..." in silence (eve only treats a lock as stale after 30 minutes, and gives up at 15);
 *   · its parent process holds 2.3-2.5 GB for the life of the service.
 *
 * So: clear locks nobody holds, prewarm serially (one template, then the next; a failed one is retried, the rest
 * still run), report, and exit. Then start the server itself: `node .output/server/index.mjs`.
 *
 * AND IT REFUSES TO BUILD ON EVE'S DEFAULTS. Under SANDBOX_BACKEND=microsandbox every agent node of the BUILT agent
 * (the root, every specialist, every pack specialist) must have a microsandbox backend created from the SANDBOX_*
 * settings: at least SANDBOX_CPUS virtual CPUs and the whole network deny list. `npm run build:eve` arranges that
 * (scripts/lib/sandbox-overlay.mjs); a node without it would start on eve's default of 1 vCPU and allow-all egress,
 * which on the first real server hung a template for 1h50m. Such a node is named and nothing is started.
 *
 * AND IT DOES NOT HANG. An attempt that is not ready within --template-timeout seconds (default 600) has its VM
 * killed, and under microsandbox so does one whose VM stops responding (no heartbeat and no command output for
 * --stall seconds, default 90: a wedged guest kernel). The template is then started again on a fresh VM, up to
 * --retries more times (mold_v1-226). If its last attempt hangs too, it is reported with its node and the settings it
 * was started with, and the templates after it are not tried.
 *
 *   npm run build:eve          # on the server, at its final path (the build output is not relocatable)
 *   npm run sandbox:prewarm    # this script
 *
 *   --retries <n>     extra attempts per template after a failure or a hang, each on a fresh VM (default 1, at most
 *                     5; or SANDBOX_PREWARM_RETRIES). At most retries + 1 attempts of --template-timeout each.
 *   --link-runtime    SANDBOX_BACKEND=microsandbox only: if the microsandbox runtime is not installed for this user,
 *                     link the copy npm already installed (node_modules/@superradcompany/microsandbox-*) into
 *                     ~/.microsandbox/{bin,lib}. No download, no system package.
 *   --template-timeout <s>  seconds one attempt may take (default 600; or SANDBOX_PREWARM_TIMEOUT_S). An attempt that
 *                     takes longer has its VM killed and the template is started again on a fresh VM while attempts
 *                     remain; after the last one the run stops, exit 1.
 *   --stall <s>       SANDBOX_BACKEND=microsandbox only: an attempt whose VM shows no sign of life (heartbeat, command
 *                     output) for this long is ended the same way, without waiting out --template-timeout (default
 *                     90, or 0 when --template-timeout is 90 or less; 0 turns it off; or SANDBOX_PREWARM_STALL_S).
 *   --plan            start nothing: print, as JSON, every agent node's sandbox in the built agent (definition,
 *                     backend, template key, the SANDBOX_* settings it carries) and which would be refused. Exit 1
 *                     if any would be.
 *   --locks-only      only clear stale locks, then exit
 *   --force-locks     remove every template lock, held or not (only when you know nothing else is prewarming: a
 *                     dead owner's process id can be reused by an unrelated process, which then looks "running")
 *   --self-test       run this file's own checks (no eve, no sandbox, no network) and exit
 *
 * Run it as the user the server runs as, with the server's environment (SANDBOX_BACKEND and friends): templates and
 * locks live under <app>/.eve/sandbox-cache and, for microsandbox, that user's ~/.microsandbox.
 *
 * It imports eve's internal modules by path (the public package exports no serial prewarm). That is checked
 * at start and said plainly if an eve upgrade moves them.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const APP_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const args = process.argv.slice(2);
const has = (name) => args.includes(name);

/* ---- stale locks ------------------------------------------------------------------------------------------------ */

/** eve's own lock directory for template prewarm (execution/sandbox/template-prewarm-lock.js). */
export const locksRoot = (appRoot) => join(appRoot, ".eve", "sandbox-cache", "template-locks");

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // it exists, it is someone else's
  }
}

/** A lock with no readable owner is given this long to be a lock that is still being written. */
const OWNERLESS_GRACE_MS = 60_000;

/**
 * Remove every template lock whose owner is gone. Returns `{ removed: [...], held: [...] }`.
 *
 * eve writes `<key>.lock/owner.json` = `{ createdAt, pid }` and removes the directory when the prewarm ends. A lock
 * whose pid is not running was left by a process that was killed; it is removed. A lock whose pid IS running is
 * someone's prewarm in progress; it is left alone and reported. A lock with no readable owner is removed once it is
 * older than a minute.
 */
export function clearStaleLocks(appRoot, { alive = pidAlive, now = Date.now(), self = process.pid, force = false } = {}) {
  const root = locksRoot(appRoot);
  const removed = [];
  const held = [];
  if (!existsSync(root)) return { removed, held };
  for (const backend of readdirSync(root)) {
    const dir = join(root, backend);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".lock")) continue;
      const lock = join(dir, name);
      let pid = null;
      try {
        pid = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid;
      } catch {
        pid = null;
      }
      const label = `${backend}/${name}`;
      if (force) {
        rmSync(lock, { recursive: true, force: true });
        removed.push({ lock: label, pid });
        continue;
      }
      if (Number.isInteger(pid) && pid !== self && alive(pid)) {
        held.push({ lock: label, pid });
        continue;
      }
      if (pid === null && now - statSync(lock).mtimeMs < OWNERLESS_GRACE_MS) {
        held.push({ lock: label, pid: null });
        continue;
      }
      rmSync(lock, { recursive: true, force: true });
      removed.push({ lock: label, pid });
    }
  }
  return { removed, held };
}

/* ---- one at a time ---------------------------------------------------------------------------------------------- */

/**
 * A `dispatch` for eve's prewarm that runs the templates one after another, whatever order eve asks in, retries a
 * failed one, and keeps going after a failure so one bad template does not leave the rest unbuilt.
 *
 * eve calls `dispatch` for every template at once and awaits them all, so the first rejection ends ITS wait while the
 * queue here is still running; `settled()` resolves when the queue is empty, with every outcome.
 *
 * A HUNG ATTEMPT IS RETRIED ON A FRESH VM (mold_v1-226). An attempt ends early in two ways: it is still running after
 * `timeoutMs`, or `watchGuest` (below: the VM's heartbeat and command log) says its guest stopped responding. Either
 * way its VM is killed (`onTimeout`), the abandoned attempt is given `settleMs` to finish its own cleanup, and the
 * template is started again: eve's prewarm boots a new VM under a new name for every call. Every such hang on record
 * was one guest that wedged seconds after boot, and the next VM built the same template in under a minute. Attempts
 * are bounded: `retries + 1` in all, for failures and hangs alike, each at most `timeoutMs`. A template whose LAST
 * attempt hung is reported timed out and nothing is started after it: what hung it that many times will hang the next.
 */
export function serialDispatch({
  retries = 1,
  log = () => {},
  beforeRetry = () => {},
  timeoutMs = 0,
  onTimeout = async () => {},
  describe = () => "",
  watchGuest = null,
  settleMs = 30_000,
} = {}) {
  // No lock is touched here: eve takes each template's lock (in this process) before it calls dispatch and releases
  // it when the returned promise settles, so a retry runs inside the lock it already holds.
  let chain = Promise.resolve();
  const outcomes = [];
  let running = 0;
  let maxRunning = 0;
  /** Set by the first template whose last attempt hung. Nothing is started after it. */
  let stopped = null;
  const attempts = retries + 1;
  const dispatch = ({ backend, input }) => {
    const run = async () => {
      const started = Date.now();
      if (stopped) {
        const error = new Error(`not attempted: template ${stopped} timed out before it`);
        outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, skipped: true, attempts: 0, ms: 0, error: error.message });
        throw error;
      }
      let lastError;
      const hangs = [];
      for (let attempt = 1; attempt <= attempts; attempt++) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        let timer;
        let watch = null;
        let work = null;
        try {
          work = Promise.resolve().then(() => backend.prewarm(input));
          work.catch(() => {}); // after a hang nobody awaits it: its late rejection (the VM was killed) must not crash the report
          const ends = [work];
          if (timeoutMs > 0) ends.push(new Promise((_, reject) => (timer = setTimeout(() => reject(new PrewarmTimeout(timeoutMs)), timeoutMs))));
          if (watchGuest) {
            watch = watchGuest({ backend, input, attempt });
            ends.push(watch.stalled.then((stall) => Promise.reject(new PrewarmStalled(stall))));
          }
          const result = await Promise.race(ends);
          outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: true, reused: Boolean(result?.reused), attempts: attempt, ms: Date.now() - started, ...(hangs.length ? { hangs: [...hangs] } : {}) });
          return result;
        } catch (error) {
          lastError = error;
          if (error instanceof PrewarmTimeout || error instanceof PrewarmStalled) {
            // The attempt is still running somewhere behind `work`: kill what it started, and let eve's own cleanup of
            // it (it removes the dead VM) finish before a new VM is booted for the same template.
            const stall = error instanceof PrewarmStalled ? error.stall : null;
            clearTimeout(timer);
            watch?.stop();
            let killed = "";
            try {
              killed = String((await onTimeout({ backend, input, vm: stall?.vm ?? null })) ?? "");
            } catch (killError) {
              killed = `could not kill its VM: ${String(killError?.message ?? killError)}`;
            }
            await settle(work, settleMs);
            const settings = describe({ backend, input });
            const what = stall
              ? `stopped responding on attempt ${attempt} of ${attempts}, ${Math.round((Date.now() - started) / 1000)}s in: ${stall.why}`
              : `timed out after ${Math.round(timeoutMs / 1000)}s on attempt ${attempt} of ${attempts}`;
            const message = `${what}${settings ? ` (${settings})` : ""}${killed ? `; ${killed}` : ""}`;
            hangs.push(stall ? `attempt ${attempt}: stopped responding (${stall.why})` : `attempt ${attempt}: timed out after ${Math.round(timeoutMs / 1000)}s`);
            if (attempt < attempts) {
              log(`template ${input.templateKey} (${backend.name}) ${message}; starting it again on a fresh VM`);
              await beforeRetry({ backend, input, attempt, hung: true });
              continue;
            }
            stopped = input.templateKey;
            log(`template ${input.templateKey} (${backend.name}) ${message}`);
            const earlier = hangs.length > 1 ? ` (earlier: ${hangs.slice(0, -1).join("; ")})` : "";
            outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, timedOut: true, stalled: Boolean(stall), attempts: attempt, ms: Date.now() - started, error: `${message}${earlier}`, hangs: [...hangs] });
            throw new Error(`template ${input.templateKey} ${message}`);
          }
          log(`template ${input.templateKey} (${backend.name}) failed on attempt ${attempt}: ${String(error?.message ?? error).slice(0, 300)}`);
          if (attempt < attempts) await beforeRetry({ backend, input, attempt, hung: false });
        } finally {
          clearTimeout(timer);
          watch?.stop();
          running--;
        }
      }
      outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, attempts, ms: Date.now() - started, error: String(lastError?.message ?? lastError), ...(hangs.length ? { hangs: [...hangs] } : {}) });
      throw lastError;
    };
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  };
  return { dispatch, outcomes, settled: async () => { await chain; return outcomes; }, maxConcurrency: () => maxRunning, stoppedAt: () => stopped };
}

/** Wait for `promise` to settle, at most `ms`. Never throws. */
async function settle(promise, ms) {
  if (!promise || !(ms > 0)) return;
  let timer;
  await Promise.race([promise.then(() => {}, () => {}), new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

class PrewarmTimeout extends Error {
  constructor(ms) {
    super(`no result after ${ms} ms`);
  }
}

class PrewarmStalled extends Error {
  constructor(stall) {
    super(`the template VM stopped responding: ${stall.why}`);
    this.stall = stall;
  }
}

/* ---- a guest that stopped responding (microsandbox) -------------------------------------------------------------- */

/**
 * WHY. A template VM whose guest kernel wedges ("BUG: scheduling while atomic", then an oops; mold_v1-190) never says
 * so: eve's prewarm just waits, and the run sat out the whole --template-timeout with "sandbox started" as the only
 * line in the VM's command log. Measured on the first self-hosted server (2026-10-09 and 10-10): the guest's heartbeat
 * stopped about 4 s after boot, or never started. A live guest writes it about once a second, busy or idle.
 *
 * WHAT IS READ, per VM, under `<MSB_HOME or ~/.microsandbox>/sandboxes/<name>/` (read only, never written):
 *   runtime/heartbeat.json   rewritten by the guest's agent about once a second; its modification time is the beat
 *   logs/exec.log            the command log: a line per output chunk, "--- sandbox started/stopped ---"
 *   logs/runtime.log         the VM runner's log ("Vmm is stopping." when it ends)
 *
 * WHICH VMS. Those that appear under sandboxes/ while the attempt runs (eve names them eve-sbx-…; a template is built
 * on an eve-sbx-tpl-tmp VM and, once its network policy is applied, on an eve-sbx-ses VM restored from it). A VM that
 * has stopped (eve stops the first one to snapshot it) is not judged. Neither is anything that was already there.
 *
 * THE VERDICT. A running VM with no sign of life (a heartbeat, a command-log line) for `stallMs` has stopped
 * responding. A template build that is merely slow keeps beating, so it runs on to --template-timeout as before.
 */
export const microsandboxHome = (env = process.env) => env.MSB_HOME?.trim() || join(homedir(), ".microsandbox");

const VM_PREFIX = "eve-sbx-";
const mtimeOf = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};
const tailOf = (path, bytes = 4096) => {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
};

/** What one VM's directory says: `{ heartbeatMs, execLogMs, stopped, onlyStarted }` (times are host clock, ms). */
export function readGuest(dir) {
  const exec = tailOf(join(dir, "logs", "exec.log"));
  const runtime = tailOf(join(dir, "logs", "runtime.log"));
  const lines = exec.split("\n").filter((l) => l.trim());
  return {
    heartbeatMs: mtimeOf(join(dir, "runtime", "heartbeat.json")),
    execLogMs: mtimeOf(join(dir, "logs", "exec.log")),
    stopped: exec.includes("--- sandbox stopped ---") || /Vmm is stopping/.test(runtime),
    onlyStarted: lines.length === 1 && lines[0].includes("sandbox started"),
  };
}

/**
 * Why a VM has stopped responding, or null. `firstSeenMs` is when the watcher first saw its directory; a VM with no
 * heartbeat yet is judged from then.
 */
export function judgeGuest({ firstSeenMs, heartbeatMs = null, execLogMs = null, stopped = false, onlyStarted = false }, now, stallMs) {
  if (stopped || !(stallMs > 0)) return null;
  const lastSign = Math.max(firstSeenMs, heartbeatMs ?? 0, execLogMs ?? 0);
  const quiet = now - lastSign;
  if (quiet < stallMs) return null;
  const secs = (ms) => Math.round(ms / 1000);
  const beat = heartbeatMs === null ? `no heartbeat in the ${secs(now - firstSeenMs)} s since it appeared` : `its heartbeat stopped ${secs(now - heartbeatMs)} s ago`;
  const log = onlyStarted ? `its command log holds only "sandbox started"` : `nothing new in its command log for ${secs(now - Math.max(firstSeenMs, execLogMs ?? 0))} s`;
  return `${beat}, ${log}`;
}

const listVmDirs = (root) => {
  try {
    return readdirSync(root).filter((name) => name.startsWith(VM_PREFIX));
  } catch {
    return [];
  }
};

/**
 * A `watchGuest` for serialDispatch: per attempt, `{ stalled, stop, seen }`. `stalled` resolves with
 * `{ vm, why }` once a VM that appeared during the attempt has stopped responding for `stallMs`; it never rejects.
 */
export function guestWatcher({ root, stallMs, pollMs = 2_000, now = () => Date.now(), list = listVmDirs, read = readGuest }) {
  return () => {
    const before = new Set(list(root));
    const firstSeen = new Map();
    let timer = null;
    let done = false;
    let resolve;
    const stalled = new Promise((r) => (resolve = r));
    const poll = () => {
      if (done) return;
      const t = now();
      for (const name of list(root)) {
        if (before.has(name)) continue;
        if (!firstSeen.has(name)) firstSeen.set(name, t);
        const why = judgeGuest({ firstSeenMs: firstSeen.get(name), ...read(join(root, name)) }, t, stallMs);
        if (why) {
          done = true;
          resolve({ vm: name, why: `${name}: ${why}` });
          return;
        }
      }
      timer = setTimeout(poll, pollMs);
      timer.unref?.();
    };
    if (stallMs > 0) poll();
    return {
      stalled,
      stop() {
        done = true;
        clearTimeout(timer);
      },
      seen: () => [...firstSeen.keys()],
    };
  };
}

/* ---- killing a template VM that hung ---------------------------------------------------------------------------- */

/** eve names a template's build VM `eve-sbx-tpl-tmp…` (execution/sandbox/bindings/microsandbox-lifecycle.js). */
const TEMPLATE_VM_NAME = "eve-sbx-tpl-tmp";

/** Every process this user can see: `{ pid, ppid, uid, cmdline }`. Linux /proc; empty elsewhere. */
export function listProcesses() {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read from the LAST ")".
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      out.push({ pid: Number(name), ppid, uid: statSync(`/proc/${name}`).uid, cmdline });
    } catch {
      /* it exited while we looked */
    }
  }
  return out;
}

/**
 * The processes of a template VM this prewarm started: every descendant of this process, and every process of this
 * user whose command line names a template build VM (the VM's runner may be detached from us) or one of `names` (the
 * VM the guest watcher found unresponsive, which may be an eve-sbx-ses VM: eve moves a template build onto one when
 * it applies the network policy). Never this process.
 */
export function templateVmProcesses(processes, { self = process.pid, uid = process.getuid?.(), names = [] } = {}) {
  const children = new Map();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const found = new Map();
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid) || child.pid === self) continue;
      found.set(child.pid, child);
      walk(child.pid);
    }
  };
  walk(self);
  const named = (cmdline) => cmdline.includes(TEMPLATE_VM_NAME) || names.some((name) => name && cmdline.includes(name));
  for (const p of processes) if (p.pid !== self && p.uid === uid && named(p.cmdline)) found.set(p.pid, p);
  return [...found.values()].sort((a, b) => a.pid - b.pid);
}

/** SIGKILL them. Returns one line saying what was killed, for the report. */
export function killTemplateVm({ processes = listProcesses(), kill = (pid) => process.kill(pid, "SIGKILL"), self = process.pid, uid = process.getuid?.(), names = [] } = {}) {
  const targets = templateVmProcesses(processes, { self, uid, names });
  const killed = [];
  for (const p of targets) {
    try {
      kill(p.pid);
      killed.push(p.pid);
    } catch {
      /* already gone */
    }
  }
  return killed.length ? `killed its VM (pid ${killed.join(", ")})` : "found no VM process of its to kill";
}

/* ---- every node's sandbox, in the BUILT agent -------------------------------------------------------------------- */

/** The key a build-time wrapper tags its backend with (scripts/lib/sandbox-overlay.mjs `SETTINGS_TAG`). */
const SETTINGS_TAG = Symbol.for("app.sandbox.settings");
const EVE_DEFAULT_SANDBOX = "eve:default-sandbox";

/** A backend eve resolves on first use (`lazyBackend`): its `name` is a getter. That is what "no backend named" is. */
const isLazyBackend = (backend) => typeof Object.getOwnPropertyDescriptor(backend ?? {}, "name")?.get === "function";

/** The SANDBOX_* settings a backend was created from, or null: `{ cpus, memoryMiB, deny }`. */
export function backendSettings(backend) {
  const tag = backend?.[SETTINGS_TAG];
  if (!tag || typeof tag !== "object") return null;
  const policy = tag.networkPolicy;
  return { cpus: tag.cpus, memoryMiB: tag.memoryMiB, deny: policy && typeof policy === "object" ? [...(policy.subnets?.deny ?? [])] : [] };
}

/** `cpus=2, memoryMiB=1024, deny=[…]` for a report line; says so when the backend carries no settings. */
export function describeBackend(backend) {
  const s = backendSettings(backend);
  if (s) return `cpus=${s.cpus}, memoryMiB=${s.memoryMiB}, deny=[${s.deny.join(" ")}]`;
  return isLazyBackend(backend) ? "eve's default backend options: 1 vCPU, 1024 MiB, allow-all egress" : "backend options unknown: not created from the SANDBOX_* settings";
}

/**
 * Why this node's sandbox must not be started under SANDBOX_BACKEND=microsandbox, or null. `required` is
 * `{ cpus, deny }` from this process's own SANDBOX_* settings. Reads nothing but the node's resolved definition, and
 * deliberately not `backend.name` of a lazy backend first: resolving eve's default probes for a Docker daemon.
 */
export function sandboxRefusal({ nodeId, definition }, required) {
  const label = nodeId === "__root__" || nodeId === "root" ? "root" : nodeId;
  const rebuild = "Rebuild on this server with SANDBOX_BACKEND=microsandbox set (`npm run build:eve`): the build gives every agent node the SANDBOX_* settings.";
  if (definition.sourceId === EVE_DEFAULT_SANDBOX) {
    return `${label}: no sandbox definition in this build, so eve's default backend (Docker if a daemon answers, else a microsandbox with 1 vCPU and allow-all egress: fewer than SANDBOX_CPUS=${required.cpus}, no deny list). ${rebuild}`;
  }
  const backend = definition.backend;
  if (isLazyBackend(backend)) {
    return `${label}: its sandbox definition (${definition.logicalPath}) names no backend, so eve's default (1 vCPU and allow-all egress: fewer than SANDBOX_CPUS=${required.cpus}, no deny list). ${rebuild}`;
  }
  if (backend?.name !== "microsandbox") return `${label}: its sandbox definition (${definition.logicalPath}) pins the "${backend?.name}" backend, not microsandbox. ${rebuild}`;
  const settings = backendSettings(backend);
  if (!settings) return `${label}: its microsandbox backend (${definition.logicalPath}) was not created from the SANDBOX_* settings, so its CPUs and network policy cannot be vouched for. ${rebuild}`;
  if (!(settings.cpus >= required.cpus)) return `${label}: would start with ${settings.cpus} vCPU(s), fewer than SANDBOX_CPUS=${required.cpus} (${definition.logicalPath}).`;
  const missing = required.deny.filter((cidr) => !settings.deny.includes(cidr));
  if (missing.length) return `${label}: would start without the network deny list (missing ${missing.join(", ")}; ${definition.logicalPath}).`;
  return null;
}

/** eve's internals, by path, with a plain error if an upgrade moved one. */
async function eveModule(eveRoot, eveVersion, path, names) {
  const file = join(eveRoot, "dist/src", path);
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Could not load eve's ${path} (eve ${eveVersion}): ${String(error?.message ?? error)}. This script was written against eve 0.25.1; re-read eve's execution/sandbox/prewarm.js.`);
  }
  for (const name of names) {
    if (typeof mod[name] !== "function") throw new Error(`eve ${eveVersion} no longer exports ${name} from ${path}. This script was written against eve 0.25.1.`);
  }
  return mod;
}

/**
 * Every agent node's sandbox in the built agent at `<appRoot>/.output`, loaded the way eve's own
 * `prewarmBuiltAppSandboxes` loads it: `[{ nodeId, definition, plan, templateKey, seedFiles }]`, sorted by node.
 * Starts nothing.
 */
export async function loadBuiltSandboxes(appRoot, { eveRoot, eveVersion }) {
  const load = (path, ...names) => eveModule(eveRoot, eveVersion, path, names);
  const { createDiskRuntimeCompiledArtifactsSource, createBundledRuntimeCompiledArtifactsSource } = await load("runtime/compiled-artifacts-source.js", "createDiskRuntimeCompiledArtifactsSource", "createBundledRuntimeCompiledArtifactsSource");
  const { resolvePackageSourceFilePath } = await load("internal/application/package.js", "resolvePackageSourceFilePath");
  const { loadCompileMetadata } = await load("runtime/loaders/compile-metadata.js", "loadCompileMetadata");
  const { loadCompiledManifest } = await load("runtime/loaders/manifest.js", "loadCompiledManifest");
  const { loadCompiledModuleMapFromAuthoredSource } = await load("internal/authored-module-map-loader.js", "loadCompiledModuleMapFromAuthoredSource");
  const { withBundledCompiledArtifacts } = await load("runtime/loaders/bundled-artifacts.js", "withBundledCompiledArtifacts");
  const { resolveRuntimeAgentGraph } = await load("runtime/resolve-agent-graph.js", "resolveRuntimeAgentGraph");
  const { createRuntimeSandboxTemplatePlan } = await load("runtime/sandbox/template-plan.js", "createRuntimeSandboxTemplatePlan");
  const { createRuntimeSandboxTemplateKey } = await load("runtime/sandbox/keys.js", "createRuntimeSandboxTemplateKey");

  const output = join(appRoot, ".output");
  const disk = createDiskRuntimeCompiledArtifactsSource(output, { moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"), sandboxAppRoot: appRoot });
  const [metadata, manifest, moduleMap] = await Promise.all([
    loadCompileMetadata({ compiledArtifactsSource: disk }),
    loadCompiledManifest({ compiledArtifactsSource: disk }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource: disk }),
  ]);
  const nodes = [];
  await withBundledCompiledArtifacts({ manifest, metadata: metadata ?? undefined, moduleMap, sessionId: "built-app-sandbox-plan" }, async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    for (const [nodeId, node] of graph.nodesByNodeId.entries()) {
      const sandbox = node.sandboxRegistry.sandbox;
      if (sandbox === null) continue;
      const { definition, workspaceResourceRoot } = sandbox;
      const plan = createRuntimeSandboxTemplatePlan({ definition, workspaceResourceRoot });
      // The key needs the backend's name. For a lazy backend that resolves eve's default (on Vercel: no probe).
      const lazy = isLazyBackend(definition.backend);
      const backendName = definition.backend.name;
      const templateKey = await createRuntimeSandboxTemplateKey({ backendName, compiledArtifactsSource, nodeId, sourceId: definition.sourceId, templatePlan: plan });
      nodes.push({ nodeId, definition, plan, templateKey, backendName, lazy });
    }
  });
  return nodes.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
}

/** One node as the plan prints it (`--plan`), with the refusal it would get under the given requirement. */
export function planRow(node, required) {
  const { nodeId, definition, plan, templateKey, backendName, lazy } = node;
  return {
    node: nodeId,
    definition: definition.sourceId === EVE_DEFAULT_SANDBOX ? "eve default (none authored)" : definition.logicalPath,
    backend: backendName,
    backendNamedByDefinition: !lazy,
    template: plan.kind,
    templateKey,
    bootstrap: definition.bootstrap !== undefined,
    settings: backendSettings(definition.backend),
    refused: required ? sandboxRefusal(node, required) : null,
  };
}

/* ---- the microsandbox runtime ----------------------------------------------------------------------------------- */

/**
 * Link the runtime npm installed (msb and libkrunfw, in the platform package) into `<home>/.microsandbox/{bin,lib}`,
 * which is where microsandbox looks. Returns the links made. Existing files are left as they are.
 */
export function linkMicrosandboxRuntime({ packageDir, home = homedir() }) {
  const made = [];
  for (const sub of ["bin", "lib"]) {
    const from = join(packageDir, sub);
    if (!existsSync(from)) throw new Error(`The microsandbox platform package has no ${sub}/ directory (${from}).`);
    const to = join(home, ".microsandbox", sub);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      const target = join(to, file);
      let present = true;
      try {
        lstatSync(target);
      } catch {
        present = false;
      }
      if (present) continue;
      symlinkSync(join(from, file), target);
      made.push(target);
    }
  }
  return made;
}

function microsandboxPlatformPackage(require) {
  // microsandbox's "exports" does not list ./package.json, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // (first real server, 2026-10-04). "./native" is exported with a default condition; the package root is two up.
  const dir = join(dirname(dirname(require.resolve("microsandbox/native"))), "..", "@superradcompany");
  const found = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("microsandbox-")) : [];
  if (found.length !== 1) {
    throw new Error(`Expected exactly one microsandbox platform package under ${dir}, found ${found.length ? found.join(", ") : "none"}. Run npm ci on this server.`);
  }
  return join(dir, found[0]);
}

/* ---- the data room's file links (filesystem storage) ------------------------------------------------------------ */

/**
 * With STORAGE_DRIVER=filesystem a sandbox downloads data-room files from the web app's own address. Resolve that
 * name HERE, on the server, and refuse if any address it resolves to is in the sandbox deny list
 * (agent/lib/sandbox-settings.ts `storageReachConflict`). Null when there is nothing to check or no conflict.
 */
export async function storageReach(env, { resolve = lookupAll } = {}) {
  const settings = await import(pathToFileURL(join(APP_ROOT, "agent/lib/sandbox-settings.ts")).href);
  const storage = settings.sandboxStorageOrigin(env);
  if (!storage) return null;
  let addresses;
  try {
    addresses = await resolve(storage.host);
  } catch (error) {
    return `The data room's file links point at ${storage.origin} (${storage.setting}), and that name does not resolve on this server (${String(error?.code ?? error)}). A sandbox could not download them.`;
  }
  return settings.storageReachConflict(env, addresses);
}

async function lookupAll(host) {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/* ---- self-test -------------------------------------------------------------------------------------------------- */

async function selfTest() {
  let passed = 0;
  const failures = [];
  const check = (what, ok, detail) => {
    if (ok) passed++;
    else failures.push(what);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-prewarm-selftest-"));
  try {
    // Stale locks.
    const app = join(scratch, "app");
    const lock = (backend, key, owner, ageMs = 0) => {
      const dir = join(locksRoot(app), backend, `${key}.lock`);
      mkdirSync(dir, { recursive: true });
      if (owner !== undefined) writeFileSync(join(dir, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
      if (ageMs) {
        const t = new Date(Date.now() - ageMs);
        utimesSync(dir, t, t);
      }
      return dir;
    };
    check("no lock directory at all is not an error", clearStaleLocks(join(scratch, "nothing")).removed.length === 0);
    const dead = lock("microsandbox", "tpl-dead", { createdAt: new Date().toISOString(), pid: 999_999_991 });
    const live = lock("microsandbox", "tpl-live", { createdAt: new Date().toISOString(), pid: 4242 });
    const mine = lock("microsandbox", "tpl-mine", { createdAt: new Date().toISOString(), pid: process.pid });
    const fresh = lock("vercel", "tpl-being-written", undefined);
    const garbled = lock("vercel", "tpl-garbled-old", "{not json", 5 * 60_000);
    const ownerlessOld = lock("docker", "tpl-ownerless-old", undefined, 5 * 60_000);
    writeFileSync(join(locksRoot(app), "microsandbox", "not-a-lock.txt"), "x");
    const alive = (pid) => pid === 4242 || pid === process.pid;
    const result = clearStaleLocks(app, { alive });
    check("a lock whose owner process is gone is removed", !existsSync(dead) && result.removed.some((r) => r.lock === "microsandbox/tpl-dead.lock"), result);
    check("a lock whose owner process is running is LEFT and reported with its pid", existsSync(live) && result.held.some((h) => h.lock === "microsandbox/tpl-live.lock" && h.pid === 4242), result);
    check("a lock this very process left earlier is removed (it is not held by anyone else)", !existsSync(mine));
    check("a lock still being written (no owner yet, seconds old) is left", existsSync(fresh) && result.held.some((h) => h.lock === "vercel/tpl-being-written.lock" && h.pid === null));
    check("a lock with an unreadable owner, minutes old, is removed", !existsSync(garbled));
    check("a lock with no owner file, minutes old, is removed", !existsSync(ownerlessOld));
    check("only *.lock entries are touched", existsSync(join(locksRoot(app), "microsandbox", "not-a-lock.txt")));
    check("every backend's directory is covered", result.removed.map((r) => r.lock.split("/")[0]).sort().join() === "docker,microsandbox,microsandbox,vercel", result.removed);
    check("the real liveness check: this process is alive, pid 999999991 is not", pidAlive(process.pid) && !pidAlive(999_999_991) && !pidAlive(0) && !pidAlive(-1));
    check("a second pass finds nothing left to remove", clearStaleLocks(app, { alive }).removed.length === 0);

    const forced = lock("microsandbox", "tpl-forced", { createdAt: new Date().toISOString(), pid: 4242 });
    check("--force-locks removes even a lock whose owner looks alive", clearStaleLocks(app, { alive, force: true }).removed.some((r) => r.lock === "microsandbox/tpl-forced.lock") && !existsSync(forced) && !existsSync(live));

    // Which sandboxes are refused under microsandbox. The shapes are eve's: a definition that names no backend gets
    // a lazy one (its `name` is a getter); one made by a build-time wrapper carries the settings it was made from.
    const required = { cpus: 2, memoryMiB: 1024, deny: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"] };
    const lazy = () => {
      let resolved = 0;
      const backend = { get name() { resolved++; return "microsandbox"; }, create() {}, prewarm() {} };
      return { backend, resolved: () => resolved };
    };
    const tagged = (cpus, deny = required.deny, memoryMiB = 1024) => ({ name: "microsandbox", create() {}, prewarm() {}, [SETTINGS_TAG]: { cpus, memoryMiB, networkPolicy: { allow: ["*"], subnets: { deny } } } });
    const bare = sandboxRefusal({ nodeId: "subagents/fixture-bare", definition: { sourceId: "eve:default-sandbox", logicalPath: "eve:framework/default-sandbox", backend: lazy().backend } }, required);
    check("a specialist with NO sandbox definition in the build is refused, by name, with what it would start on", /^subagents\/fixture-bare: no sandbox definition/.test(bare ?? "") && /1 vCPU and allow-all egress/.test(bare) && /SANDBOX_CPUS=2/.test(bare), bare);
    const packLazy = lazy();
    const pack = sandboxRefusal({ nodeId: "subagents/fixture-pack", definition: { sourceId: "x", logicalPath: "subagents/fixture-pack/sandbox/sandbox.ts", backend: packLazy.backend } }, required);
    check("a definition with a bootstrap but no backend (what a pack ships) is refused, naming its file", /^subagents\/fixture-pack: its sandbox definition \(subagents\/fixture-pack\/sandbox\/sandbox\.ts\) names no backend/.test(pack ?? ""), pack);
    check("…without resolving eve's default backend (that probes for a Docker daemon)", packLazy.resolved() === 0);
    check("a microsandbox backend that carries no settings is refused: its CPUs cannot be vouched for", /was not created from the SANDBOX_\* settings/.test(sandboxRefusal({ nodeId: "__root__", definition: { sourceId: "x", logicalPath: "sandbox.ts", backend: { name: "microsandbox", create() {}, prewarm() {} } } }, required) ?? ""));
    check("fewer CPUs than SANDBOX_CPUS is refused, with both numbers", /^root: would start with 1 vCPU\(s\), fewer than SANDBOX_CPUS=2/.test(sandboxRefusal({ nodeId: "__root__", definition: { sourceId: "x", logicalPath: "sandbox.ts", backend: tagged(1) } }, required) ?? ""));
    const noDeny = sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(2, ["10.0.0.0/8"]) } }, required);
    check("a missing deny-list entry is refused, naming the entries", /without the network deny list \(missing 169\.254\.0\.0\/16, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 127\.0\.0\.0\/8/.test(noDeny ?? ""), noDeny);
    check("another backend (docker) is refused", /pins the "docker" backend/.test(sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: { name: "docker", create() {}, prewarm() {} } } }, required) ?? ""));
    check("the configured settings pass, and so do more CPUs and extra deny entries", sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(2) } }, required) === null && sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(4, [...required.deny, "203.0.113.7/32"]) } }, required) === null);
    check("a report line gives a backend's settings, or says it runs on eve's defaults", describeBackend(tagged(2)) === `cpus=2, memoryMiB=1024, deny=[${required.deny.join(" ")}]` && /eve's default backend options: 1 vCPU/.test(describeBackend(lazy().backend)));

    // One at a time.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let active = 0;
    let peak = 0;
    const order = [];
    const failing = new Map([["t3", 1], ["t5", 99]]); // t3 fails once, t5 always
    const backend = {
      name: "fake",
      async prewarm(input) {
        active++;
        peak = Math.max(peak, active);
        order.push(input.templateKey);
        await sleep(15);
        active--;
        const left = failing.get(input.templateKey) ?? 0;
        if (left > 0) {
          failing.set(input.templateKey, left - 1);
          throw new Error(`timed out waiting for agent relay (${input.templateKey})`);
        }
        return { reused: input.templateKey === "t1" };
      },
    };
    const retried = [];
    const serial = serialDispatch({ retries: 1, beforeRetry: ({ input }) => retried.push(input.templateKey) });
    // As eve calls it: every template dispatched at once, awaited together.
    const all = Promise.all(["t1", "t2", "t3", "t4", "t5", "t6"].map((templateKey) => serial.dispatch({ backend, input: { templateKey } })));
    const rejected = await all.then(() => null, (e) => e);
    const outcomes = await serial.settled();
    check("never more than one template is being built at a time", peak === 1 && serial.maxConcurrency() === 1, { peak });
    check("templates run in the order they were asked for, a failed one retried in place", order.join() === "t1,t2,t3,t3,t4,t5,t5,t6", order);
    check("a template that fails once succeeds on its retry", outcomes.find((o) => o.templateKey === "t3")?.ok === true && outcomes.find((o) => o.templateKey === "t3").attempts === 2, outcomes);
    check("a template that keeps failing is reported failed, with its error", outcomes.find((o) => o.templateKey === "t5")?.ok === false && /agent relay/.test(outcomes.find((o) => o.templateKey === "t5").error));
    check("the templates AFTER a failed one are still built", outcomes.find((o) => o.templateKey === "t6")?.ok === true && outcomes.length === 6);
    check("eve's own wait still sees the failure", rejected instanceof Error && /t5/.test(rejected.message));
    check("the retry hook ran once per retry", retried.join() === "t3,t5", retried);
    check("a reused template is told apart from a built one", outcomes.find((o) => o.templateKey === "t1").reused === true && outcomes.find((o) => o.templateKey === "t2").reused === false);

    // A template whose attempt hangs (mold_v1-226): its VM is killed and it is started again on a fresh one.
    const settings = { cpus: 2, memoryMiB: 1024, networkPolicy: { allow: ["*"], subnets: { deny: required.deny } } };
    /** A backend whose prewarm hangs for the keys in `hangs` (how many attempts each), and finishes otherwise. */
    const hanging = (hangs) => {
      const calls = [];
      const left = new Map(Object.entries(hangs));
      let cleanups = 0;
      const backend = {
        name: "microsandbox",
        [SETTINGS_TAG]: settings,
        prewarm(input) {
          const vm = `vm${calls.length + 1}`; // eve boots a new VM, under a new name, for every call
          calls.push({ key: input.templateKey, vm, at: Date.now() });
          const n = left.get(input.templateKey) ?? 0;
          if (n > 0) {
            left.set(input.templateKey, n - 1);
            // A wedged guest: nothing comes back until its VM is killed; then eve's own cleanup runs and it rejects.
            return new Promise((_, reject) => backend.onKill.push(() => setTimeout(() => (cleanups++, calls.at(-1).cleanedAt = Date.now(), reject(new Error(`runtime error: ${vm} was killed`))), 20)));
          }
          return Promise.resolve({ reused: false });
        },
        onKill: [],
        kill() {
          const pending = backend.onKill.splice(0);
          for (const f of pending) f();
          return pending.length ? "killed its VM (pid 4242)" : "found no VM process of its to kill";
        },
        calls,
        cleanups: () => cleanups,
      };
      return backend;
    };
    const describeIt = ({ backend: b, input }) => `node subagents/${input.templateKey}; ${describeBackend(b)}`;

    // 1. A timeout, then a fresh VM that builds it (the 2026-10-09 and 10-10 root hangs: the next VM took under a minute).
    const once = hanging({ h2: 1 });
    const onceLines = [];
    const onceKills = [];
    const onceRun = serialDispatch({ retries: 2, timeoutMs: 60, log: (l) => onceLines.push(l), describe: describeIt, onTimeout: async ({ input }) => (onceKills.push(input.templateKey), once.kill()) });
    const onceAll = await Promise.allSettled(["h1", "h2", "h3"].map((templateKey) => onceRun.dispatch({ backend: once, input: { templateKey } })));
    const onceOut = await onceRun.settled();
    const h2once = onceOut.find((o) => o.templateKey === "h2");
    check("a template whose attempt timed out is started again, on a fresh VM, and is built", h2once?.ok === true && h2once.attempts === 2 && once.calls.filter((c) => c.key === "h2").map((c) => c.vm).join() === "vm2,vm3", { h2once, calls: once.calls });
    check("…the hung attempt's VM is killed before the next one is booted, and eve's cleanup of it has run", onceKills.join() === "h2" && once.cleanups() === 1 && once.calls[2].at >= once.calls[1].cleanedAt, once.calls);
    check("…the log says so plainly, with the attempt count and the settings it was started with", onceLines.some((l) => /^template h2 \(microsandbox\) timed out after 0s on attempt 1 of 3 \(node subagents\/h2; cpus=2, memoryMiB=1024, deny=\[169\.254\.0\.0\/16 .*\]\); killed its VM \(pid 4242\); starting it again on a fresh VM$/.test(l)), onceLines);
    check("…the templates after it are built too, and eve's own wait sees no failure", onceOut.map((o) => `${o.templateKey}:${o.ok}`).join() === "h1:true,h2:true,h3:true" && onceAll.every((r) => r.status === "fulfilled") && onceRun.stoppedAt() === null, onceOut);
    check("…and the report records the hang it got past", /attempt 1: timed out/.test(h2once?.hangs?.join() ?? ""), h2once);

    // 2. Bounded: a template that hangs on every attempt ends the run after retries + 1 attempts, as before.
    const always = hanging({ h2: 99 });
    const alwaysKills = [];
    const alwaysLines = [];
    const alwaysRun = serialDispatch({ retries: 2, timeoutMs: 40, log: (l) => alwaysLines.push(l), describe: describeIt, onTimeout: async ({ input }) => (alwaysKills.push(input.templateKey), always.kill()) });
    const t0 = Date.now();
    const alwaysAll = await Promise.allSettled(["h1", "h2", "h3", "h4"].map((templateKey) => alwaysRun.dispatch({ backend: always, input: { templateKey } })));
    const alwaysOut = await alwaysRun.settled();
    const h2always = alwaysOut.find((o) => o.templateKey === "h2");
    check("a template that hangs on every attempt is tried exactly retries + 1 times, each on its own VM, then given up on", always.calls.filter((c) => c.key === "h2").length === 3 && new Set(always.calls.filter((c) => c.key === "h2").map((c) => c.vm)).size === 3 && h2always?.timedOut === true && h2always.attempts === 3 && Date.now() - t0 < 5_000, { h2always, calls: always.calls });
    check("…every hung VM is killed", alwaysKills.join() === "h2,h2,h2" && always.cleanups() === 3, alwaysKills);
    check("…the report names the template, its node, its settings, the kill, and the earlier attempts", /^timed out after 0s on attempt 3 of 3 \(node subagents\/h2; cpus=2, memoryMiB=1024, deny=\[.*\]\); killed its VM \(pid 4242\) \(earlier: attempt 1: timed out after 0s; attempt 2: timed out after 0s\)$/.test(h2always?.error ?? ""), h2always?.error);
    check("…the templates after it are not started, and are reported as not tried", always.calls.map((c) => c.key).join() === "h1,h2,h2,h2" && alwaysOut.filter((o) => o.skipped).map((o) => o.templateKey).join() === "h3,h4" && alwaysRun.stoppedAt() === "h2", alwaysOut);
    check("…the one before it was built, and eve's own wait sees the rest fail", alwaysOut.find((o) => o.templateKey === "h1")?.ok === true && alwaysAll.map((r) => r.status).join() === "fulfilled,rejected,rejected,rejected");
    const none = hanging({ h2: 99 });
    const noneRun = serialDispatch({ retries: 0, timeoutMs: 30, onTimeout: async () => none.kill() });
    await noneRun.dispatch({ backend: none, input: { templateKey: "h2" } }).catch(() => {});
    check("with --retries 0 a hung template gets exactly one attempt", none.calls.length === 1 && (await noneRun.settled())[0].timedOut === true);

    // 3. A guest that stopped responding is replaced long before the timeout.
    const frozen = hanging({ h2: 1 });
    const frozenKills = [];
    const frozenLines = [];
    const frozenRun = serialDispatch({
      retries: 1,
      timeoutMs: 60_000,
      log: (l) => frozenLines.push(l),
      describe: describeIt,
      onTimeout: async ({ vm }) => (frozenKills.push(vm), frozen.kill()),
      watchGuest: ({ input, attempt }) => {
        let timer;
        const stalled = new Promise((r) => {
          if (input.templateKey === "h2" && attempt === 1) timer = setTimeout(() => r({ vm: "eve-sbx-ses-frozen", why: 'eve-sbx-ses-frozen: its heartbeat stopped 90 s ago, its command log holds only "sandbox started"' }), 30);
        });
        return { stalled, stop: () => clearTimeout(timer) };
      },
    });
    const f0 = Date.now();
    await Promise.allSettled(["h1", "h2"].map((templateKey) => frozenRun.dispatch({ backend: frozen, input: { templateKey } })));
    const frozenOut = await frozenRun.settled();
    check("a guest that stopped responding ends its attempt at once, not at the timeout (60 s here), and the template is built on a fresh VM", frozenOut.find((o) => o.templateKey === "h2")?.ok === true && frozenOut.find((o) => o.templateKey === "h2").attempts === 2 && Date.now() - f0 < 5_000, { frozenOut, ms: Date.now() - f0 });
    check("…the unresponsive VM is the one killed by name", frozenKills.join() === "eve-sbx-ses-frozen", frozenKills);
    check("…and the log says why", frozenLines.some((l) => /template h2 \(microsandbox\) stopped responding on attempt 1 of 2, \d+s in: eve-sbx-ses-frozen: its heartbeat stopped 90 s ago, its command log holds only "sandbox started" \(node subagents\/h2;.*\); killed its VM \(pid 4242\); starting it again on a fresh VM/.test(l)), frozenLines);
    const frozenTwice = hanging({ h2: 9 });
    const twiceRun = serialDispatch({ retries: 1, timeoutMs: 60_000, onTimeout: async () => frozenTwice.kill(), watchGuest: () => ({ stalled: new Promise((r) => setTimeout(() => r({ vm: "x", why: "x: no heartbeat in the 90 s since it appeared" }), 20)), stop() {} }) });
    await twiceRun.dispatch({ backend: frozenTwice, input: { templateKey: "h2" } }).catch(() => {});
    const twiceOut = (await twiceRun.settled())[0];
    check("a guest that stops responding on the last attempt too is reported timed out (the TIMED OUT line a caller looks for), and marked a stall", twiceOut.timedOut === true && twiceOut.stalled === true && frozenTwice.calls.length === 2 && /stopped responding on attempt 2 of 2/.test(twiceOut.error), twiceOut);
    const quietWatch = serialDispatch({ retries: 1, timeoutMs: 5_000, watchGuest: () => ({ stalled: new Promise(() => {}), stop() {} }) });
    await quietWatch.dispatch({ backend: hanging({}), input: { templateKey: "h1" } });
    check("a template that finishes in time is unaffected by the timeout and the watcher", (await quietWatch.settled())[0].ok === true);

    // 4. An abandoned attempt that never settles does not hold the next one forever.
    const stuck = { name: "microsandbox", calls: 0, prewarm() { this.calls++; return this.calls === 1 ? new Promise(() => {}) : Promise.resolve({ reused: false }); } };
    const stuckRun = serialDispatch({ retries: 1, timeoutMs: 30, settleMs: 40 });
    const s0 = Date.now();
    await stuckRun.dispatch({ backend: stuck, input: { templateKey: "h1" } });
    check("an attempt that does not end when its VM is killed is waited for at most settleMs, then the next is started", stuck.calls === 2 && Date.now() - s0 < 2_000 && (await stuckRun.settled())[0].ok === true);
    const killFails = serialDispatch({ retries: 0, timeoutMs: 30, settleMs: 10, onTimeout: async () => { throw new Error("EPERM"); } });
    await killFails.dispatch({ backend: { name: "x", prewarm: () => new Promise(() => {}) }, input: { templateKey: "h2" } }).catch(() => {});
    check("a kill that fails is said, and the timeout is still reported", /could not kill its VM: EPERM/.test((await killFails.settled())[0].error));

    // 5. The guest watcher, on microsandbox's own files (layout as on the server: sandboxes/<name>/{runtime,logs}).
    const msb = join(scratch, "msb", "sandboxes");
    const vmDir = (name, { heartbeatAgeMs = null, execLines = ["--- sandbox started ---"], execAgeMs = 0, runtime = "" } = {}) => {
      const dir = join(msb, name);
      mkdirSync(join(dir, "runtime"), { recursive: true });
      mkdirSync(join(dir, "logs"), { recursive: true });
      if (heartbeatAgeMs !== null) {
        const hb = join(dir, "runtime", "heartbeat.json");
        writeFileSync(hb, JSON.stringify({ heartbeat_seq: 3, activity_seq: 5 }));
        const t = new Date(Date.now() - heartbeatAgeMs);
        utimesSync(hb, t, t);
      }
      const exec = join(dir, "logs", "exec.log");
      writeFileSync(exec, execLines.map((d) => JSON.stringify({ t: new Date().toISOString(), s: "system", d: `${d}\n` })).join("\n") + "\n");
      const te = new Date(Date.now() - execAgeMs);
      utimesSync(exec, te, te);
      writeFileSync(join(dir, "logs", "runtime.log"), runtime);
      return dir;
    };
    const frozenRead = readGuest(vmDir("eve-sbx-ses-f16f", { heartbeatAgeMs: 120_000, execAgeMs: 120_000 }));
    check("a VM's heartbeat and command log are read from its directory", frozenRead.heartbeatMs !== null && frozenRead.onlyStarted === true && frozenRead.stopped === false, frozenRead);
    const now = Date.now();
    check("a running VM whose heartbeat stopped long ago, with only \"sandbox started\" logged, has stopped responding", /^its heartbeat stopped 120 s ago, its command log holds only "sandbox started"$/.test(judgeGuest({ firstSeenMs: now - 200_000, ...frozenRead }, now, 90_000) ?? ""), judgeGuest({ firstSeenMs: now - 200_000, ...frozenRead }, now, 90_000));
    check("…but not before the stall window has passed since it was first seen", judgeGuest({ firstSeenMs: now - 30_000, ...frozenRead }, now, 90_000) === null);
    check("a VM that never wrote a heartbeat (the 2026-10-09 hang) has stopped responding once the window has passed", /^no heartbeat in the 100 s since it appeared/.test(judgeGuest({ firstSeenMs: now - 100_000, ...readGuest(vmDir("eve-sbx-ses-6908", { execAgeMs: 100_000 })) }, now, 90_000) ?? ""));
    check("a VM whose heartbeat is fresh is alive, even with nothing in its command log for minutes (a quiet install)", judgeGuest({ firstSeenMs: now - 600_000, ...readGuest(vmDir("eve-sbx-tpl-tmp-busy", { heartbeatAgeMs: 1_000, execAgeMs: 300_000 })) }, now, 90_000) === null);
    check("a VM whose command log moves is alive", judgeGuest({ firstSeenMs: now - 600_000, ...readGuest(vmDir("eve-sbx-tpl-tmp-talks", { heartbeatAgeMs: 300_000, execLines: ["--- sandbox started ---", "Collecting x"], execAgeMs: 2_000 })) }, now, 90_000) === null);
    check("a VM that stopped (eve snapshots the first template VM) is not judged", judgeGuest({ firstSeenMs: now - 600_000, ...readGuest(vmDir("eve-sbx-tpl-tmp-done", { heartbeatAgeMs: 300_000, execLines: ["--- sandbox started ---", "--- sandbox stopped ---"], execAgeMs: 300_000 })) }, now, 90_000) === null && readGuest(vmDir("eve-sbx-tpl-tmp-vmm", { heartbeatAgeMs: 300_000, runtime: "INFO msb_krun_vmm: Vmm is stopping.\n" })).stopped === true);
    check("a stall window of 0 turns the verdict off", judgeGuest({ firstSeenMs: 0, heartbeatMs: 0 }, now, 0) === null);
    check("an unreadable or missing VM directory reads as no signs, not an error", readGuest(join(msb, "gone")).heartbeatMs === null);

    // The watcher: only VMs that appear during the attempt, polled until one stops responding.
    rmSync(msb, { recursive: true, force: true });
    vmDir("eve-sbx-ses-already-frozen", { heartbeatAgeMs: 900_000, execAgeMs: 900_000 }); // there before the attempt (a chat's VM): never judged
    let clock = Date.now();
    const watcher = guestWatcher({ root: msb, stallMs: 90_000, pollMs: 5, now: () => clock });
    const w = watcher({ input: { templateKey: "h2" }, attempt: 1 });
    let verdict = null;
    w.stalled.then((v) => (verdict = v));
    await sleep(30);
    check("a VM that was already there when the attempt started is not judged", verdict === null);
    vmDir("eve-sbx-tpl-tmp-new", { heartbeatAgeMs: 0, execLines: ["--- sandbox started ---", "--- sandbox stopped ---"] }); // the first template VM, stopped
    mkdirSync(join(msb, "not-a-vm"), { recursive: true });
    await sleep(30);
    vmDir("eve-sbx-ses-new", { heartbeatAgeMs: 0 }); // the VM the build moved onto
    await sleep(30);
    clock += 60_000;
    await sleep(30);
    check("a new VM is not judged before the stall window has passed", verdict === null && w.seen().includes("eve-sbx-ses-new") && !w.seen().includes("not-a-vm"), w.seen());
    clock += 60_000;
    await sleep(40);
    check("the new running VM that went quiet is named once the window has passed, and the stopped one is not", verdict?.vm === "eve-sbx-ses-new" && /^eve-sbx-ses-new: its heartbeat stopped \d+ s ago, its command log holds only "sandbox started"$/.test(verdict.why), verdict);
    const w2 = watcher({ input: { templateKey: "h3" }, attempt: 1 });
    w2.stop();
    let v2 = null;
    w2.stalled.then((v) => (v2 = v));
    clock += 600_000;
    await sleep(30);
    check("a stopped watcher says nothing", v2 === null);
    check("the microsandbox home is MSB_HOME when set, else ~/.microsandbox", microsandboxHome({ MSB_HOME: "/srv/msb" }) === "/srv/msb" && microsandboxHome({}) === join(homedir(), ".microsandbox"));

    // 6. The options.
    const opts = (argv, env) => {
      try {
        return prewarmOptions(argv, env);
      } catch (error) {
        return String(error.message);
      }
    };
    check("defaults: 1 retry (2 attempts), 600 s per attempt, a VM silent for 90 s is replaced", JSON.stringify(opts([], {})) === JSON.stringify({ retries: 1, timeoutS: 600, stallS: 90 }));
    check("the command line wins over the environment", JSON.stringify(opts(["--retries", "2", "--template-timeout", "300", "--stall", "45"], { SANDBOX_PREWARM_RETRIES: "4", SANDBOX_PREWARM_TIMEOUT_S: "900", SANDBOX_PREWARM_STALL_S: "120" })) === JSON.stringify({ retries: 2, timeoutS: 300, stallS: 45 }));
    check("the environment is read when the command line is silent", JSON.stringify(opts([], { SANDBOX_PREWARM_RETRIES: "3", SANDBOX_PREWARM_TIMEOUT_S: "900", SANDBOX_PREWARM_STALL_S: "0" })) === JSON.stringify({ retries: 3, timeoutS: 900, stallS: 0 }));
    check("a short per-attempt timeout turns the watcher off by default instead of refusing", JSON.stringify(opts(["--template-timeout", "60"], {})) === JSON.stringify({ retries: 1, timeoutS: 60, stallS: 0 }));
    check("out of range is refused plainly: retries over 5, a stall not under the timeout, a stall under 15 s, a fraction", /--retries/.test(opts(["--retries", "6"], {})) && /--stall/.test(opts(["--stall", "600"], {})) && /--stall/.test(opts(["--stall", "5"], {})) && /--retries/.test(opts(["--retries", "1.5"], {})));
    // Which processes are a hung template's VM.
    const procs = [
      { pid: 1, ppid: 0, uid: 0, cmdline: "init" },
      { pid: 100, ppid: 1, uid: 1000, cmdline: "node scripts/sandbox-prewarm-serial.mjs" }, // this script
      { pid: 101, ppid: 100, uid: 1000, cmdline: "msb run --vcpus 1" }, // its child
      { pid: 102, ppid: 101, uid: 1000, cmdline: "krun worker" }, // a grandchild
      { pid: 200, ppid: 1, uid: 1000, cmdline: "msb supervisor --name eve-sbx-tpl-tmp-abc --vcpus 1" }, // detached, named
      { pid: 201, ppid: 1, uid: 1000, cmdline: "msb supervisor --name eve-sbx-ses-xyz" }, // a live SESSION: never
      { pid: 202, ppid: 1, uid: 2000, cmdline: "msb supervisor --name eve-sbx-tpl-tmp-other-user" }, // not ours
      { pid: 300, ppid: 1, uid: 1000, cmdline: "node .output/server/index.mjs" },
    ];
    check("the VM of a hung template is this script's descendants and this user's template build VMs; never a session VM, another user's, or the server", templateVmProcesses(procs, { self: 100, uid: 1000 }).map((p) => p.pid).join() === "101,102,200", templateVmProcesses(procs, { self: 100, uid: 1000 }));
    const signalled = [];
    const said = killTemplateVm({ processes: procs, self: 100, uid: 1000, kill: (pid) => { if (pid === 102) throw new Error("ESRCH"); signalled.push(pid); } });
    check("they are killed, and the line says which", signalled.join() === "101,200" && said === "killed its VM (pid 101, 200)", said);
    check("nothing to kill is said plainly", killTemplateVm({ processes: procs.slice(0, 2), self: 100, uid: 1000, kill: () => {} }) === "found no VM process of its to kill");
    check("the real process table is readable and holds this process", process.platform !== "linux" || listProcesses().some((p) => p.pid === process.pid && p.ppid === process.ppid));

    // The data room's file links under the filesystem storage driver.
    const fsEnv = (extra) => ({ SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "filesystem", ...extra });
    const resolvesTo = (...addresses) => ({ resolve: async () => addresses });
    check("no storage driver set (Vercel Blob): nothing to check", (await storageReach({ SANDBOX_BACKEND: "microsandbox", WEB_ORIGIN: "https://app.example.com" }, resolvesTo("10.0.0.5"))) === null);
    check("filesystem storage on a public address: reachable, no conflict", (await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.example.com" }), resolvesTo("203.0.113.7"))) === null);
    const priv = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.internal" }), resolvesTo("10.1.2.3"));
    check("a storage origin that resolves to a private address is refused, naming the address and the rule", /app\.internal/.test(priv ?? "") && /10\.1\.2\.3/.test(priv) && /10\.0\.0\.0\/8/.test(priv), priv);
    const own = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.example.com", SANDBOX_DENY_SUBNETS: "203.0.113.7" }), resolvesTo("203.0.113.7"));
    check("…and so is the host's public address once it is added to SANDBOX_DENY_SUBNETS", /203\.0\.113\.7\/32/.test(own ?? ""), own);
    check("WEB_ORIGIN is used when STORAGE_PUBLIC_URL is unset, as the storage driver does", /WEB_ORIGIN/.test((await storageReach(fsEnv({ WEB_ORIGIN: "http://127.0.0.1:3000" }), resolvesTo("127.0.0.1"))) ?? ""));
    check("an IPv6 address in an extra deny entry is matched", /2001:db8::\/32/.test((await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://v6.example.com", SANDBOX_DENY_SUBNETS: "2001:db8::/32" }), resolvesTo("2001:db8::7"))) ?? ""));
    const unresolved = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://nowhere.invalid" }), { resolve: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
    check("a name that does not resolve on the server is refused too", /does not resolve/.test(unresolved ?? "") && /ENOTFOUND/.test(unresolved), unresolved);

    // The microsandbox runtime link.
    const pkg = join(scratch, "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "bin", "msb"), "#!/bin/sh\n");
    writeFileSync(join(pkg, "lib", "libkrunfw.so.5"), "x");
    const home = join(scratch, "home");
    const made = linkMicrosandboxRuntime({ packageDir: pkg, home });
    check("the runtime files are linked into ~/.microsandbox/{bin,lib}", made.length === 2 && lstatSync(join(home, ".microsandbox", "bin", "msb")).isSymbolicLink() && readFileSync(join(home, ".microsandbox", "lib", "libkrunfw.so.5"), "utf8") === "x", made);
    check("linking again changes nothing", linkMicrosandboxRuntime({ packageDir: pkg, home }).length === 0);
    let missing = null;
    try {
      linkMicrosandboxRuntime({ packageDir: join(scratch, "nope"), home });
    } catch (error) {
      missing = error;
    }
    check("a missing platform package is a plain error", /no bin\/ directory/.test(String(missing?.message)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length ? `\nsandbox-prewarm-serial --self-test: ${failures.length} FAILED` : `\nsandbox-prewarm-serial --self-test: ${passed} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

/* ---- options ---------------------------------------------------------------------------------------------------- */

/**
 * `{ retries, timeoutS, stallS }` from the command line, then the environment, then the defaults (1 retry, 600 s per
 * attempt, a VM silent for 90 s is replaced; with a per-attempt timeout of 90 s or less the timeout alone ends it). Throws a plain message for a value out of range.
 */
export function prewarmOptions(argv, env = {}) {
  const valueIn = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const whole = (raw) => (/^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN);
  const retries = whole(valueIn("--retries", env.SANDBOX_PREWARM_RETRIES?.trim() || "1"));
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error("--retries (or SANDBOX_PREWARM_RETRIES) takes a whole number from 0 to 5.");
  const timeoutS = whole(valueIn("--template-timeout", env.SANDBOX_PREWARM_TIMEOUT_S?.trim() || "600"));
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 86_400) throw new Error("--template-timeout (or SANDBOX_PREWARM_TIMEOUT_S) takes a whole number of seconds from 1 to 86400.");
  const stallS = whole(valueIn("--stall", env.SANDBOX_PREWARM_STALL_S?.trim() || (timeoutS > 90 ? "90" : "0")));
  if (!Number.isInteger(stallS) || stallS < 0 || (stallS > 0 && stallS < 15) || (stallS > 0 && stallS >= timeoutS)) {
    throw new Error("--stall (or SANDBOX_PREWARM_STALL_S) takes 0 (off) or a whole number of seconds from 15 to less than --template-timeout.");
  }
  return { retries, timeoutS, stallS };
}

/* ---- main ------------------------------------------------------------------------------------------------------- */

/** What every node must have under microsandbox, from THIS process's settings: `{ cpus, memoryMiB, deny }`. Null otherwise. */
async function requiredSettings(env) {
  const settings = await import(pathToFileURL(join(APP_ROOT, "agent/lib/sandbox-settings.ts")).href);
  const micro = settings.microsandboxSettings(env);
  return micro ? { cpus: micro.cpus, memoryMiB: micro.memoryMiB, deny: [...micro.networkPolicy.subnets.deny] } : null;
}

const labelOf = (nodeId) => (nodeId === "__root__" ? "root" : nodeId);

/**
 * eve bundles the sandbox definitions from agent/ AGAIN when it prewarms (and when this script reads the plan), so
 * under microsandbox the wrappers the build used are put back for exactly as long as this runs, under the build's
 * own lock (a build in progress is waited for; a killed run's wrappers are removed by the next build or prewarm).
 * With the setting unset nothing is locked, written or moved.
 */
async function main() {
  if (has("--locks-only") || (process.env.SANDBOX_BACKEND ?? "").trim().toLowerCase() !== "microsandbox") return await run();
  const { withAgentTreeLock } = await import("./eve-build.mjs");
  const { applySandboxOverlay, buildStampProblem } = await import("./lib/sandbox-overlay.mjs");
  return await withAgentTreeLock(`sandbox:prewarm ${args.join(" ")}`.trim(), async () => {
    const applied = applySandboxOverlay(APP_ROOT);
    // The server runs what was bundled into .output: it must be a build made with these wrappers.
    return await run(existsSync(join(APP_ROOT, ".output")) ? buildStampProblem(APP_ROOT, applied) : null);
  });
}

async function run(stampProblem = null) {
  const t0 = Date.now();
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const say = (line) => console.log(`${at()} ${line}`);
  const { retries, timeoutS, stallS } = prewarmOptions(args, process.env);
  const backendSetting = (process.env.SANDBOX_BACKEND ?? "").trim().toLowerCase() || "vercel";

  if (!has("--plan")) {
    const { removed, held } = clearStaleLocks(APP_ROOT, { force: has("--force-locks") });
    for (const r of removed) say(`removed ${has("--force-locks") ? "" : "stale "}template lock ${r.lock} (owner ${r.pid ?? "unknown"}${has("--force-locks") ? "" : " is not running"})`);
    if (held.length) {
      for (const h of held) console.error(`${at()} template lock ${h.lock} is held by ${h.pid === null ? "a process that is still writing it" : `pid ${h.pid}, which is running`}`);
      throw new Error("Another prewarm (or an `eve start` / `eve build`) is running against this app. Wait for it or stop it, then run this again. If you are sure nothing is (a dead owner's process id can be reused), run with --force-locks.");
    }
    if (has("--locks-only")) {
      say(`locks checked (${removed.length} removed)`);
      return;
    }
  }

  if (!existsSync(join(APP_ROOT, ".output"))) {
    throw new Error("There is no built agent here (.output/ is missing). Run `npm run build:eve` on this server first.");
  }
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const eveVersion = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version;

  // EVERY node's sandbox in the built agent, before anything is started. Under microsandbox each must carry the
  // SANDBOX_* settings; one that would start on eve's defaults is named and nothing is built.
  const required = await requiredSettings(process.env);
  if (required && stampProblem && !has("--plan")) throw new Error(`${stampProblem} Nothing was started.`);
  const nodes = await loadBuiltSandboxes(APP_ROOT, { eveRoot, eveVersion });
  const rows = nodes.map((node) => planRow(node, required));
  const refused = rows.filter((r) => r.refused);
  const byTemplate = new Map(nodes.filter((n) => n.templateKey).map((n) => [n.templateKey, n]));
  if (has("--plan")) {
    console.log(JSON.stringify({ eve: eveVersion, backendSetting, required, build: stampProblem, nodes: rows }, null, 2));
    if (stampProblem) throw new Error(stampProblem);
    if (refused.length) throw new Error(`${refused.length} of ${rows.length} sandbox(es) would be refused.`);
    return;
  }
  if (required) {
    if (refused.length) {
      for (const r of refused) console.error(`${at()} REFUSED ${r.refused}`);
      throw new Error(`${refused.length} of ${rows.length} sandbox(es) would not start with the SANDBOX_* settings (SANDBOX_CPUS=${required.cpus} and the network deny list). Nothing was started.`);
    }
    say(`all ${rows.length} agent node(s) carry the SANDBOX_* settings (cpus=${required.cpus}, memoryMiB=${required.memoryMiB}, deny=[${required.deny.join(" ")}]): ${rows.map((r) => labelOf(r.node)).join(", ")}`);
  }

  if (backendSetting === "microsandbox") {
    if (!existsSync("/dev/kvm")) throw new Error("SANDBOX_BACKEND=microsandbox needs KVM, and this host has no /dev/kvm.");
    const { isInstalled } = await import("microsandbox");
    if (!isInstalled()) {
      if (!has("--link-runtime")) {
        throw new Error("The microsandbox runtime is not installed for this user (~/.microsandbox/bin/msb, ~/.microsandbox/lib/libkrunfw*). Run this again with --link-runtime to link the copy npm installed (no download).");
      }
      for (const link of linkMicrosandboxRuntime({ packageDir: microsandboxPlatformPackage(require) })) say(`linked ${link}`);
      if (!isInstalled()) throw new Error("The microsandbox runtime was linked but still does not report as installed. Check ~/.microsandbox and that this user is in the kvm group.");
    }
  }

  if (backendSetting === "microsandbox") {
    // The filesystem storage driver's file links point at the web app: a sandbox must be able to reach it.
    const conflict = await storageReach(process.env);
    if (conflict) throw new Error(conflict);
  }

  const { prewarmBuiltAppSandboxes } = await eveModule(eveRoot, eveVersion, "execution/sandbox/prewarm.js", ["prewarmBuiltAppSandboxes"]);

  const nodeOf = (templateKey) => {
    const node = byTemplate.get(templateKey);
    return node ? labelOf(node.nodeId) : "unknown node";
  };
  // The guest watcher reads microsandbox's own files; another backend has none to read.
  const watching = backendSetting === "microsandbox" && stallS > 0;
  say(
    `prewarming sandbox templates one at a time (eve ${eveVersion}, SANDBOX_BACKEND=${backendSetting}, ${retries + 1} attempt(s) per template, ` +
      `${timeoutS}s per attempt${watching ? `, a VM silent for ${stallS}s is replaced` : ""})`,
  );
  const serial = serialDispatch({
    retries,
    timeoutMs: timeoutS * 1000,
    log: (line) => say(line),
    describe: ({ backend, input }) => `node ${nodeOf(input.templateKey)}; ${describeBackend(backend)}`,
    onTimeout: async ({ vm }) => killTemplateVm({ names: vm ? [vm] : [] }),
    watchGuest: watching ? guestWatcher({ root: join(microsandboxHome(), "sandboxes"), stallMs: stallS * 1000 }) : null,
  });
  // The same rule again at the last moment, on the very backend object about to be used: eve resolved the graph a
  // second time for this call, and a template must never start on a backend that was not checked.
  const guarded = ({ backend, input }) => {
    const refusal = required ? sandboxRefusal({ nodeId: nodeOf(input.templateKey), definition: { sourceId: "", logicalPath: "the built agent", backend } }, required) : null;
    if (refusal) return Promise.reject(new Error(`REFUSED ${refusal}`));
    return serial.dispatch({ backend, input });
  };
  let failure = null;
  try {
    await prewarmBuiltAppSandboxes({
      appRoot: APP_ROOT,
      dispatch: guarded,
      log: (line) => {
        if (!/elapsed\)|bootstrap run:/.test(line)) say(String(line).slice(0, 200));
      },
    });
  } catch (error) {
    failure = error;
  }
  const outcomes = await serial.settled();
  const failed = outcomes.filter((o) => !o.ok);
  for (const o of outcomes) {
    const state = o.ok ? (o.reused ? "reused" : "built ") : o.timedOut ? "TIMED OUT" : o.skipped ? "NOT TRIED" : "FAILED";
    say(`${state} ${o.templateKey} (${nodeOf(o.templateKey)}; ${o.backend}, ${(o.ms / 1000).toFixed(0)}s${o.attempts > 1 ? `, ${o.attempts} attempts` : ""})${o.ok ? "" : `: ${o.error.slice(0, 400)}`}`);
  }
  if (failed.length || failure) {
    if (failure && !failed.length) console.error(`${at()} ${String(failure?.message ?? failure)}`);
    throw new Error(`${failed.length || 1} of ${outcomes.length || "the"} sandbox template(s) could not be built. The server must not be started until this passes.`);
  }
  say(`${outcomes.length} sandbox template(s) ready (${outcomes.filter((o) => o.reused).length} reused, ${outcomes.filter((o) => !o.reused).length} built). Start the server: node .output/server/index.mjs`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (has("--self-test")) await selfTest();
  else {
    try {
      await main();
      process.exit(0);
    } catch (error) {
      console.error(`sandbox:prewarm: ${String(error?.message ?? error)}`);
      process.exit(1);
    }
  }
}
