#!/usr/bin/env node
/**
 * THE EVE PATCH SURVIVES A SECOND INSTALL, AND AN INSTALL OVER AN OLDER PATCH — on the installed node_modules.
 *
 * Vercel builds run `npm install` over node_modules restored from the build cache, which re-runs `postinstall` on an
 * eve that already carries a patch: the SAME one (a redeploy), or the PREVIOUS revision of it (the first deploy after the
 * patch changed). Plain `patch-package --error-on-fail` handles the first and fails the second ("Failed to apply patch
 * for package eve"): that broke the live deploy of #133. `postinstall` is now scripts/eve-patch/postinstall.mjs.
 *
 *   1. installed and patched (CI has just run `npm ci`): postinstall again succeeds and changes nothing; plain
 *      patch-package again succeeds too
 *   2. eve carries something else (stands in for an older revision of the patch, or a hand edit): plain patch-package
 *      FAILS — the defect, reproduced — and postinstall puts eve back as published (the lockfile's tarball, integrity
 *      checked) and applies the patch: `check:eve-patch` passes afterwards
 *
 * Changes node_modules/eve while it runs and always leaves it patched. Needs the npm registry (or npm's cache).
 *
 *   npm run test:eve-patch-install
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { postinstall, patchPackage, restorePristineEve } from "./eve-patch/postinstall.mjs";
import { problems } from "./check-eve-patch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EVE = join(ROOT, "node_modules/eve");
let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 600)}`}`);
};
/** A digest of every file of eve except its nested node_modules. */
function tree() {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (p === join(EVE, "node_modules")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(EVE, p)).update(readFileSync(p));
    }
  };
  walk(EVE);
  return h.digest("hex");
}
const quietPatchPackage = () => spawnSync(join(ROOT, "node_modules/.bin/patch-package"), ["--error-on-fail"], { cwd: ROOT, stdio: "pipe" }).status === 0;

try {
  check("to begin with, eve is installed with the patch (check:eve-patch)", problems(ROOT).length === 0, problems(ROOT));
  const before = tree();

  console.log("an install over an eve that already carries this patch (a redeploy from the build cache):");
  check("postinstall again succeeds", postinstall(ROOT) === 0);
  check("…and changes nothing", tree() === before);
  check("plain `patch-package --error-on-fail` again succeeds too (it sees the patch applied)", quietPatchPackage());

  console.log("\nan install over an eve that carries something else (an earlier revision of the patch, an edit):");
  const victim = join(EVE, "dist/src/execution/turn-workflow.js");
  const text = readFileSync(victim, "utf8");
  const anchor = "detachInbox={pending:void 0,timers:0}";
  check("(the file the stand-in edits carries this patch's code)", text.includes(anchor));
  writeFileSync(victim, text.replace(anchor, "detachInbox={pending:void 0,timers:0,previousRevision:!0}"));
  check("plain `patch-package --error-on-fail` FAILS on it — what broke the Vercel deploy", !quietPatchPackage());
  check("postinstall puts eve back as published and applies the patch (exit 0)", postinstall(ROOT) === 0);
  check("…eve is exactly the patched eve again (check:eve-patch passes, the same files as before)", problems(ROOT).length === 0 && tree() === before, problems(ROOT));
  check("…and a further install changes nothing", postinstall(ROOT) === 0 && tree() === before);
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
} finally {
  // Never leave a broken eve behind.
  if (problems(ROOT).length > 0) {
    try {
      restorePristineEve(ROOT);
      patchPackage(ROOT);
    } catch {
      /* reported below */
    }
    if (problems(ROOT).length > 0) failures.push("node_modules/eve was left unpatched: run `npm ci`");
  }
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
