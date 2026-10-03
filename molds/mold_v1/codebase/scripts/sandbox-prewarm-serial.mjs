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
 *   npm run build:eve          # on the server, at its final path (the build output is not relocatable)
 *   npm run sandbox:prewarm    # this script
 *
 *   --retries <n>     extra attempts per template after a failure (default 1)
 *   --link-runtime    SANDBOX_BACKEND=microsandbox only: if the microsandbox runtime is not installed for this user,
 *                     link the copy npm already installed (node_modules/@superradcompany/microsandbox-*) into
 *                     ~/.microsandbox/{bin,lib}. No download, no system package.
 *   --locks-only      only clear stale locks, then exit
 *   --force-locks     remove every template lock, held or not (only when you know nothing else is prewarming: a
 *                     dead owner's process id can be reused by an unrelated process, which then looks "running")
 *   --self-test       run this file's own checks (no eve, no sandbox, no network) and exit
 *
 * Run it as the user the server runs as, with the server's environment (SANDBOX_BACKEND and friends): templates and
 * locks live under <app>/.eve/sandbox-cache and, for microsandbox, that user's ~/.microsandbox.
 *
 * It imports two of eve's internal modules by path (the public package exports no serial prewarm). That is checked
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
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

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
 */
export function serialDispatch({ retries = 1, log = () => {}, beforeRetry = () => {} } = {}) {
  // No lock is touched here: eve takes each template's lock (in this process) before it calls dispatch and releases
  // it when the returned promise settles, so a retry runs inside the lock it already holds.
  let chain = Promise.resolve();
  const outcomes = [];
  let running = 0;
  let maxRunning = 0;
  const dispatch = ({ backend, input }) => {
    const run = async () => {
      const started = Date.now();
      let lastError;
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          const result = await backend.prewarm(input);
          outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: true, reused: Boolean(result?.reused), attempts: attempt, ms: Date.now() - started });
          return result;
        } catch (error) {
          lastError = error;
          log(`template ${input.templateKey} (${backend.name}) failed on attempt ${attempt}: ${String(error?.message ?? error).slice(0, 300)}`);
          if (attempt <= retries) await beforeRetry({ backend, input, attempt });
        } finally {
          running--;
        }
      }
      outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, attempts: retries + 1, ms: Date.now() - started, error: String(lastError?.message ?? lastError) });
      throw lastError;
    };
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  };
  return { dispatch, outcomes, settled: async () => { await chain; return outcomes; }, maxConcurrency: () => maxRunning };
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
  const dir = join(dirname(require.resolve("microsandbox/package.json")), "..", "@superradcompany");
  const found = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("microsandbox-")) : [];
  if (found.length !== 1) {
    throw new Error(`Expected exactly one microsandbox platform package under ${dir}, found ${found.length ? found.join(", ") : "none"}. Run npm ci on this server.`);
  }
  return join(dir, found[0]);
}

/* ---- which specialists the setting does not reach --------------------------------------------------------------- */

/**
 * The declared specialists with NO sandbox definition of their own (no `sandbox.ts`, no `sandbox/`). eve gives those
 * its framework default backend, not the one `SANDBOX_BACKEND` selects in agent/sandbox.ts and
 * agent/subagents/research/sandbox.ts: off Vercel that is Docker when a daemon answers, else a microsandbox with
 * eve's defaults (1 vCPU, allow-all egress). Listed so an operator sees which sandboxes the deny list does not cover.
 */
export function specialistsWithoutSandbox(appRoot) {
  const dir = join(appRoot, "agent", "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((key) => statSync(join(dir, key)).isDirectory())
    .filter((key) => !existsSync(join(dir, key, "sandbox.ts")) && !existsSync(join(dir, key, "sandbox")))
    .sort();
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

    // Specialists the setting does not reach.
    for (const [key, file] of [["with-file", "sandbox.ts"], ["with-dir", "sandbox/workspace/x.txt"], ["bare", "agent.ts"], ["also-bare", "prompt.md"]]) {
      mkdirSync(dirname(join(app, "agent", "subagents", key, file)), { recursive: true });
      writeFileSync(join(app, "agent", "subagents", key, file), "x");
    }
    check("specialists with no sandbox definition of their own are listed, and only those", specialistsWithoutSandbox(app).join() === "also-bare,bare", specialistsWithoutSandbox(app));

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

/* ---- main ------------------------------------------------------------------------------------------------------- */

async function main() {
  const t0 = Date.now();
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const say = (line) => console.log(`${at()} ${line}`);
  const retries = Number(valueOf("--retries", "1"));
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error("--retries takes a whole number from 0 to 5.");
  const backendSetting = (process.env.SANDBOX_BACKEND ?? "").trim().toLowerCase() || "vercel";

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

  if (!existsSync(join(APP_ROOT, ".output"))) {
    throw new Error("There is no built agent here (.output/ is missing). Run `npm run build:eve` on this server first.");
  }
  const require = createRequire(import.meta.url);

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

  if (backendSetting === "microsandbox") {
    const bare = specialistsWithoutSandbox(APP_ROOT);
    if (bare.length) {
      console.warn(
        `${at()} WARNING: ${bare.length} specialist(s) have no sandbox definition of their own: ${bare.join(", ")}.\n` +
          "      eve gives those its DEFAULT backend, not the one SANDBOX_BACKEND selects: Docker if a daemon answers on this\n" +
          "      host, else a microsandbox with 1 vCPU and allow-all egress. The CPU, memory and network deny-list settings\n" +
          "      apply only to the root agent and the research specialist. See docs/self-hosting/SANDBOX.md.",
      );
    }
  }

  const eveRoot = dirname(require.resolve("eve/package.json"));
  const eveVersion = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version;
  const prewarmPath = join(eveRoot, "dist/src/execution/sandbox/prewarm.js");
  let prewarmBuiltAppSandboxes;
  try {
    ({ prewarmBuiltAppSandboxes } = await import(pathToFileURL(prewarmPath).href));
  } catch (error) {
    throw new Error(`Could not load eve's prewarm module (${prewarmPath}; eve ${eveVersion}): ${String(error?.message ?? error)}. This script was written against eve 0.25.1; re-read eve's execution/sandbox/prewarm.js.`);
  }
  if (typeof prewarmBuiltAppSandboxes !== "function") {
    throw new Error(`eve ${eveVersion} no longer exports prewarmBuiltAppSandboxes from execution/sandbox/prewarm.js. This script was written against eve 0.25.1.`);
  }

  say(`prewarming sandbox templates one at a time (eve ${eveVersion}, SANDBOX_BACKEND=${backendSetting}, retries ${retries})`);
  const serial = serialDispatch({ retries, log: (line) => say(line) });
  let failure = null;
  try {
    await prewarmBuiltAppSandboxes({
      appRoot: APP_ROOT,
      dispatch: serial.dispatch,
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
    say(`${o.ok ? (o.reused ? "reused" : "built ") : "FAILED"} ${o.templateKey} (${o.backend}, ${(o.ms / 1000).toFixed(0)}s${o.attempts > 1 ? `, ${o.attempts} attempts` : ""})${o.ok ? "" : `: ${o.error.slice(0, 300)}`}`);
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
