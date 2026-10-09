#!/usr/bin/env node
/**
 * `eve build` (or `eve dev`) without the specialists the deployment profile excludes.
 *
 * eve makes every directory under agent/subagents/ a specialist the model can delegate to — the directory name is
 * the tool name, its description the roster line — and has no switch to leave one out (checked: discovery,
 * advertised-tools and the dynamic-tool override rules; a same-named dynamic tool REPLACES a subagent tool, it
 * cannot remove it). So the excluded directories (profiles/*.json `specialists.exclude`, read by
 * scripts/lib/profile-specialists.mjs) are hidden from eve for exactly the duration of this command, under a LOCK:
 *
 *   .eve-build-hidden/lock.json   { pid, hidden: [...], command, at } — created exclusively (O_EXCL). While its
 *                                 pid is alive, no other run touches agent/subagents/: a second build WAITS for it
 *                                 (up to EVE_BUILD_LOCK_WAIT_MS, default 20 min) and then REFUSES — it never builds
 *                                 the full roster, and never restores what the running build hid.
 *   .eve-build-hidden/subagents/  the hidden directories (gitignored).
 *
 * Restoring is pid-aware: only the owning run restores (on exit, failure or SIGINT/SIGTERM/SIGHUP), or anyone who
 * finds the lock's pid DEAD (a SIGKILL, an OOM) — the next run of this script, scripts/gen-subagent-meta.mjs, or
 * `--restore`. Nothing is moved outside a build: the tree, a git checkout and `git status` are unchanged by the
 * profile. With the default profile nothing is hidden (the lock is still taken, so two builds serialise).
 *
 * THE SANDBOX BACKEND, under the same lock. With `SANDBOX_BACKEND=microsandbox` (a deployment that is not on Vercel)
 * every agent node's sandbox slot holds a generated wrapper for the duration of the command, so the root, every
 * specialist and every pack specialist get SANDBOX_CPUS, SANDBOX_MEMORY_MIB and the network deny list
 * (scripts/lib/sandbox-overlay.mjs has the why). The wrappers are removed with the lock, by the same pid-aware rule.
 * `npm run sandbox:prewarm` takes this lock and puts them back while it runs: eve bundles the definitions again there.
 * With the setting unset (every Vercel build) no file is written or moved and eve reads the sources as they are.
 *
 *   node scripts/eve-build.mjs [build|dev|...eve args]     (npm run build:eve / dev:eve)
 *   node scripts/eve-build.mjs --plan                      print {"hide":[...]} and exit (tests)
 *   node scripts/eve-build.mjs --restore                   restore a DEAD run's hidden directories and exit
 */
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excludedSpecialists } from "./lib/profile-specialists.mjs";
import { applySandboxOverlay, removeSandboxOverlay, sandboxBackendOf, writeBuildStamp } from "./lib/sandbox-overlay.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SUB = join(ROOT, "agent/subagents");
const DIR = join(ROOT, ".eve-build-hidden");
const HIDDEN = join(DIR, "subagents");
const LOCK = join(DIR, "lock.json");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK, "utf8"));
  } catch {
    return existsSync(LOCK) ? { pid: 0, hidden: [] } : null;
  }
}

/** Put back what a run hid. Only called by the owner, or for a lock whose owner is dead. */
function restoreFrom(lock) {
  const restored = [];
  // The sandbox wrappers first: they are found by their marker, so a killed build's are removed too.
  removeSandboxOverlay(ROOT);
  for (const key of lock?.hidden ?? []) {
    if (!existsSync(join(HIDDEN, key))) continue;
    if (existsSync(join(SUB, key))) throw new Error(`eve-build: both agent/subagents/${key} and .eve-build-hidden/subagents/${key} exist; keep the one you meant and delete the other`);
    try {
      renameSync(join(HIDDEN, key), join(SUB, key));
      restored.push(key);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e; // another process restored it first
    }
  }
  // Remove THIS lock only — never one a waiting run took in the meantime.
  const now = readLock();
  if (now && now.pid === lock?.pid && now.at === lock?.at) rmSync(LOCK, { force: true });
  try { if (existsSync(HIDDEN) && readdirSync(HIDDEN).length === 0) rmdirSync(HIDDEN); } catch { /* another run's */ }
  try { if (existsSync(DIR) && readdirSync(DIR).length === 0) rmdirSync(DIR); } catch { /* another run's */ }
  return restored;
}

/**
 * Restore a crashed run's directories — and ONLY a crashed run's. Returns what was restored, or [] when there is
 * no lock or its owner is alive (a build in progress is left alone). Safe to call from any generator.
 */
export function restoreHidden() {
  const lock = readLock();
  if (!lock) return [];
  if (alive(lock.pid) && lock.pid !== process.pid) return [];
  return restoreFrom(lock);
}

/** The pid holding the lock, if a live run holds it. */
export function lockHolder() {
  const lock = readLock();
  return lock && alive(lock.pid) && lock.pid !== process.pid ? lock : null;
}

/** Take the lock atomically WITH its content (write a private file, then hard-link it into place: EEXIST if held). */
function tryLock(hide, command) {
  mkdirSync(DIR, { recursive: true });
  const mine = join(DIR, `.lock-${process.pid}`);
  writeFileSync(mine, JSON.stringify({ pid: process.pid, hidden: hide, command, at: new Date().toISOString() }));
  try {
    linkSync(mine, LOCK);
    return true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

async function acquire(hide, command) {
  const waitMs = Number(process.env.EVE_BUILD_LOCK_WAIT_MS ?? 20 * 60_000);
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    if (tryLock(hide, command)) return;
    const holder = readLock();
    if (!holder || !alive(holder.pid)) {
      // The previous owner died: its directories come back before anyone takes the lock.
      const back = restoreFrom(holder);
      if (back.length) console.error(`eve-build: restored ${back.join(", ")} left hidden by a run that died (pid ${holder?.pid})`);
      continue;
    }
    if (Date.now() >= deadline) {
      console.error(`eve-build: another eve run (pid ${holder.pid}: ${holder.command ?? "?"}) is using agent/subagents/ in this directory; refusing rather than building with the wrong roster. Stop it, or wait and retry.`);
      process.exit(75);
    }
    if (!told) {
      console.error(`eve-build: waiting for eve run pid ${holder.pid} (${holder.command ?? "?"}) to finish…`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Run `fn` holding this directory's lock, for another script that must change agent/ for a while the way a build
 * does (scripts/sandbox-prewarm-serial.mjs puts the sandbox wrappers back while eve bundles the definitions).
 * Waits for a running build like a second build would; releases by the same pid-aware rule, on a signal too.
 */
export async function withAgentTreeLock(command, fn) {
  await acquire([], command);
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    restoreFrom(readLock());
  };
  const onSignal = (sig) => {
    release();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, onSignal);
  try {
    return await fn();
  } finally {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(sig, onSignal);
    release();
  }
}

const plan = () => excludedSpecialists(ROOT).filter((k) => existsSync(join(SUB, k, "agent.ts")));

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--restore") {
    const holder = lockHolder();
    if (holder) { console.error(`eve-build: pid ${holder.pid} is still running; nothing restored`); process.exit(75); }
    const back = restoreHidden();
    console.error(back.length ? `eve-build: restored ${back.join(", ")}` : "eve-build: nothing to restore");
    process.exit(0);
  }
  if (args[0] === "--plan") { console.log(JSON.stringify({ hide: plan() })); process.exit(0); }

  const command = (args.length ? args : ["build"]).join(" ");
  // The lock first, THEN what to hide: while another run holds it, its hidden directories are not on disk, and a
  // plan made then would hide nothing and build the full roster.
  await acquire([], command);
  const hide = plan();
  {
    const lock = readLock();
    const tmp = join(DIR, `.lock-${process.pid}.next`);
    writeFileSync(tmp, JSON.stringify({ ...lock, hidden: hide }));
    renameSync(tmp, LOCK); // atomic replace: a reader sees the old lock or the new one, never half of one
  }
  let done = false;
  let wrapped = null;
  const release = () => {
    if (done) return;
    done = true;
    try { restoreFrom(readLock()); } catch (e) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
  };
  try {
    if (hide.length) {
      mkdirSync(HIDDEN, { recursive: true });
      for (const key of hide) renameSync(join(SUB, key), join(HIDDEN, key));
      console.error(`eve-build: specialists.exclude — ${hide.join(", ")} hidden from eve for this run`);
    }
    // After the hiding: a hidden specialist is not built and needs no wrapper.
    if (sandboxBackendOf() === "microsandbox") {
      wrapped = applySandboxOverlay(ROOT);
      console.error(`eve-build: SANDBOX_BACKEND=microsandbox: the sandbox of every agent node takes the SANDBOX_* settings for this build (${wrapped.length}: ${wrapped.map((w) => w.node).join(", ")})`);
    }
  } catch (e) {
    release();
    throw e;
  }
  const eveBin = join(ROOT, "node_modules/.bin/eve");
  const child = spawn(existsSync(eveBin) ? eveBin : "eve", args.length ? args : ["build"], { cwd: ROOT, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { child.kill(sig); });
  child.on("exit", (code, signal) => {
    // A build made with the wrappers says so in its output: sandbox:prewarm refuses an output that does not.
    if (wrapped && code === 0 && (args[0] ?? "build") === "build") {
      try { writeBuildStamp(ROOT, wrapped); } catch (e) { console.error(`eve-build: could not write the sandbox stamp: ${e.message}`); code = 1; }
    }
    release();
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on("error", (e) => { release(); console.error(`eve-build: could not start eve: ${e.message}`); process.exit(1); });
}
