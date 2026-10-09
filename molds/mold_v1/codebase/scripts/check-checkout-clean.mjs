/**
 * THE CHECKOUT IS THE COMMIT: profiles/ and every generated file as committed (factory task mold_v1-188).
 *
 * A check that stamps another deployment profile used to do it in the checkout (a profile copied into profiles/, the
 * generated files rebuilt from it) and leave it there: the next job in the same checkout then built and checked the
 * relabelled app as if it were the default one, or the stray profile was committed. Those checks now work in a copy
 * (scripts/lib/checkout-copy.mjs). This is the guard that holds it: it fails when anything under profiles/ or any
 * generated file (the paths `check:generated` compares, read from package.json) differs from HEAD, untracked files
 * included, and names each one with the command that puts it back. CI runs it first in verify and last in every
 * job (`if: always()`), so a step that leaves a stamp behind fails the job that ran it.
 *
 * Run: npm run check:checkout-clean   [-- --root <another checkout>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** --root <dir>: another checkout (scripts/test-checkout-copy.mjs drives this against a scratch repository). */
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The generated paths, from the one place that lists them: `check:generated`'s `git diff HEAD … -- <paths>`. */
export function generatedPaths(pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))) {
  const script = pkg.scripts?.["check:generated"] ?? "";
  const at = script.lastIndexOf(" -- ");
  if (at < 0) throw new Error('check-checkout-clean: package.json "check:generated" no longer ends in `-- <paths>`; list the generated paths here');
  return script.slice(at + 4).trim().split(/\s+/).filter(Boolean);
}

export const GUARDED = ["profiles", ...generatedPaths()];

const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const inside = git(["rev-parse", "--is-inside-work-tree"]);
if (inside.status !== 0) {
  console.log("check-checkout-clean: SKIPPED — not a git checkout");
  process.exit(0);
}
const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...GUARDED]);
if (status.status !== 0) {
  console.error(`check-checkout-clean: git status failed: ${status.stderr}`);
  process.exit(2);
}
const lines = status.stdout.split("\n").filter(Boolean);
const copies = existsSync(join(ROOT, ".ui-vocabulary")) ? readdirSync(join(ROOT, ".ui-vocabulary")) : [];
if (copies.length) console.log(`check-checkout-clean: note — .ui-vocabulary/ holds ${copies.join(", ")} (a copy kept with --keep, or left by a run that was killed with SIGKILL); it is git-ignored and never read by this checkout's build`);

if (!lines.length) {
  console.log(`check-checkout-clean: profiles/ and the ${GUARDED.length - 1} generated paths are exactly the commit`);
  process.exit(0);
}
const untracked = lines.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
const changed = lines.filter((l) => !l.startsWith("??")).map((l) => l.slice(3));
console.error("check-checkout-clean: this checkout differs from its commit where a stamped profile would leave its mark:");
for (const l of lines) console.error(`  ${l}`);
console.error(
  "\nA check that builds under another profile must stamp a copy (scripts/lib/checkout-copy.mjs), never this checkout." +
    (untracked.length ? `\nTo put the checkout back: remove ${untracked.join(" ")}` : "") +
    (changed.length ? `${untracked.length ? ", then" : "\nTo put the checkout back:"} git checkout HEAD -- ${changed.join(" ")}` : "") +
    "\n(or, if the change is meant, regenerate with `npm run build:generated` and commit it)",
);
process.exit(1);
