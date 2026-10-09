/**
 * A STAMPED COPY OF THIS CHECKOUT, AND NOTHING LEFT BEHIND (factory task mold_v1-188).
 *
 * The checks that build the app under another deployment profile (check:ui-vocabulary, the isolation job's data room
 * workbook route) must not stamp the checkout itself: a profile copied into profiles/ and the files regenerated from
 * it stayed behind after a local run, so the next job in the same checkout built the relabelled app, or a stray
 * profile was committed. They work in a copy made here, under ROOT/.ui-vocabulary/<name> (git-ignored; inside the
 * checkout so the copy resolves this checkout's node_modules by walking up, which Turbopack needs), and the copy is
 * removed on every way out: a normal end, an error, `process.exit`, SIGINT, SIGTERM and SIGHUP.
 *
 * scripts/check-checkout-clean.mjs is the guard: it fails when profiles/ or a generated file differs from the commit.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const COPIES = ".ui-vocabulary";

/** The files of this checkout: git's view when there is one (tracked + untracked, not ignored), else a walk. */
export function checkoutFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.split("\0").filter((f) => f && !f.startsWith(`${COPIES}/`) && existsSync(join(root, f)));
  const skip = new Set(["node_modules", ".next", ".git", COPIES, "test-results", ".eve", ".vercel"]);
  const walk = (d) => readdirSync(join(root, d)).flatMap((n) => (skip.has(n) ? [] : statSync(join(root, d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk("");
}

/** The copy's directory for `name`, refused unless it is a plain name under ROOT/.ui-vocabulary. */
export function copyDir(root, name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name))) throw new Error(`checkout-copy: "${name}" is not a plain copy name`);
  const base = resolve(root, COPIES);
  const dir = resolve(base, name);
  if (!dir.startsWith(base + sep)) throw new Error(`checkout-copy: ${dir} is not under ${base}`);
  return dir;
}

/** Remove a copy made here (and ROOT/.ui-vocabulary once it is empty). Safe to call twice. */
export function removeCopy(root, name) {
  const dir = copyDir(root, name);
  rmSync(dir, { recursive: true, force: true });
  const base = resolve(root, COPIES);
  if (existsSync(base) && !readdirSync(base).length) rmSync(base, { recursive: true, force: true });
}

/** A fresh copy of the checkout's files at ROOT/.ui-vocabulary/<name> (an old one of that name is replaced). */
export function makeCopy(root, name) {
  const dir = copyDir(root, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of checkoutFiles(root)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(root, f), join(dir, f));
  }
  return dir;
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
const cleanups = new Set();
let installed = false;
function runCleanups() {
  for (const fn of [...cleanups]) {
    cleanups.delete(fn);
    try {
      fn();
    } catch (e) {
      console.error(`cleanup failed: ${String(e?.message ?? e)}`);
    }
  }
}

/**
 * Run `fn` (synchronous) when this process ends, however it ends: after the event loop drains, on `process.exit`
 * (which skips `finally` blocks), or on SIGINT / SIGTERM / SIGHUP (exit status 128 + the signal's number, as a
 * shell reports it). Returns a function that runs it now and unregisters it; `.cancel()` on that function
 * unregisters it without running it.
 */
export function onAnyExit(fn) {
  if (!installed) {
    installed = true;
    process.on("exit", runCleanups);
    for (const [signal, number] of Object.entries(SIGNALS)) {
      process.on(signal, () => {
        console.error(`\n${signal}: cleaning up before exit`);
        runCleanups();
        process.exit(128 + number);
      });
    }
  }
  cleanups.add(fn);
  const now = () => {
    if (cleanups.delete(fn)) fn();
  };
  now.cancel = () => void cleanups.delete(fn);
  return now;
}

/**
 * makeCopy, removed on every way out unless `keep`. Returns { dir, remove, keep }: `remove()` removes it now;
 * `keep()` leaves it in place when this process ends (a build kept for the checks that run after it).
 */
export function temporaryCopy(root, name, { keep = false } = {}) {
  const cleanup = onAnyExit(() => removeCopy(root, name));
  if (keep) cleanup.cancel();
  const dir = makeCopy(root, name);
  const remove = () => {
    cleanup.cancel();
    removeCopy(root, name);
  };
  return { dir, remove, keep: cleanup.cancel };
}

/** A scratch directory under the system's temporary folder, removed on every way out (or by `remove()`). */
export function scratchDir(prefix) {
  if (!/^[a-z0-9][a-z0-9-]*-$/.test(prefix)) throw new Error(`checkout-copy: "${prefix}" is not a plain prefix ending in "-"`);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const remove = onAnyExit(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, remove };
}
