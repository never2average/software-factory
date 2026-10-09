#!/usr/bin/env node
/**
 * Apply scripts/eve-patch/changes.mjs to a PRISTINE node_modules/eve, so `npx patch-package eve` can record
 * patches/eve+0.25.1.patch. A maintainer's tool, not part of install (install applies the recorded patch).
 *
 *   node scripts/eve-patch/apply.mjs               apply (refuses an eve that is not pristine 0.25.1)
 *   node scripts/eve-patch/apply.mjs --dry-run     check every anchor, write nothing
 *   node scripts/eve-patch/apply.mjs --regenerate  after editing changes.mjs or files/: take the installed patch off
 *                                                  (`patch-package --reverse`), apply this source, record the patch
 *                                                  (`patch-package eve`) and its hashes (check-eve-patch --record)
 *
 * Every `find` must occur EXACTLY ONCE in its file at the moment it is applied (changes to one file apply in order).
 * Nothing is written unless every change applies. Each touched .js file must then parse (`node --check`).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGES, NEW_FILES } from "./changes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const EVE = join(ROOT, "node_modules", "eve");
const DIST = join(EVE, "dist", "src");
const VERSION = "0.25.1";
const dryRun = process.argv.includes("--dry-run");
if (process.argv.includes("--regenerate")) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (NEW_FILES.some((rel) => existsSync(join(DIST, rel)))) run("npx", ["patch-package", "--reverse"]);
  run(process.execPath, [fileURLToPath(import.meta.url)]);
  run("npx", ["patch-package", "eve"]);
  run(process.execPath, [join(ROOT, "scripts/check-eve-patch.mjs"), "--record"]);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(EVE, "package.json"), "utf8"));
if (pkg.version !== VERSION) {
  console.error(`eve-patch: node_modules/eve is ${pkg.version}; this patch is written for ${VERSION} exactly.`);
  process.exit(1);
}
for (const rel of NEW_FILES) {
  if (existsSync(join(DIST, rel))) {
    console.error(`eve-patch: node_modules/eve already has ${rel} — it is patched. Start from a pristine copy (see the header).`);
    process.exit(1);
  }
}

const count = (text, needle) => {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
};

const contents = new Map();
const failures = [];
for (const [i, change] of CHANGES.entries()) {
  const path = join(DIST, change.file);
  if (!contents.has(change.file)) contents.set(change.file, readFileSync(path, "utf8"));
  const text = contents.get(change.file);
  const n = count(text, change.find);
  if (n !== 1) {
    failures.push(`#${i} ${change.file}: the anchor occurs ${n} times, not once (${change.why})`);
    continue;
  }
  contents.set(change.file, text.replace(change.find, () => change.replace));
}
if (failures.length) {
  console.error(`eve-patch: ${failures.length} change(s) do not apply; nothing was written:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`eve-patch: all ${CHANGES.length} changes apply to ${contents.size} files, plus ${NEW_FILES.length} new files (dry run, nothing written)`);
  process.exit(0);
}
for (const [rel, text] of contents) writeFileSync(join(DIST, rel), text);
for (const rel of NEW_FILES) {
  mkdirSync(dirname(join(DIST, rel)), { recursive: true });
  copyFileSync(join(HERE, "files", rel), join(DIST, rel));
}
for (const rel of [...contents.keys(), ...NEW_FILES].filter((r) => r.endsWith(".js"))) {
  try {
    execFileSync(process.execPath, ["--check", join(DIST, rel)], { stdio: "pipe" });
  } catch (error) {
    console.error(`eve-patch: ${rel} does not parse after patching:\n${error.stderr?.toString() ?? error}`);
    process.exit(1);
  }
}
console.log(`eve-patch: applied ${CHANGES.length} changes to ${contents.size} files and added ${NEW_FILES.length} files in node_modules/eve`);
