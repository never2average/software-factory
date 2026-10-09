#!/usr/bin/env node
/**
 * THE BUILD FAILS UNLESS THE INSTALLED EVE IS THE ONE THE PATCH IS FOR, WITH THE PATCH ON IT (mold_v1-184).
 *
 * agent-workspace patches eve 0.25.1 (patches/eve+0.25.1.patch, applied by patch-package in `postinstall`; the readable
 * source is scripts/eve-patch/). A patch applied to different code is worse than none, so every build checks:
 *
 *   1. package.json pins eve EXACTLY (no ^ or ~): a minor bump can never bring code the patch was not written for.
 *   2. The one eve patch in patches/ is for that version.
 *   3. node_modules/eve is that version.
 *   4. Every file the patch touches has exactly the content recorded when the patch was made
 *      (scripts/eve-patch/patched.sha256.json), and the patch file itself is the one recorded. An eve installed with
 *      --ignore-scripts (unpatched), carrying an older revision of the patch, or edited by hand fails here, by name.
 *
 *   node scripts/check-eve-patch.mjs              the check (prebuild:eve, CI)
 *   node scripts/check-eve-patch.mjs --record     after regenerating the patch (scripts/eve-patch/apply.mjs header)
 *   node scripts/check-eve-patch.mjs --self-test  the check's own cases, on a throwaway copy
 *
 * A failure says what to run: usually `npm ci` (which re-installs eve and applies the patch).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = "scripts/eve-patch/patched.sha256.json";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The files a patch-package patch touches, relative to node_modules/eve. */
export function patchedFiles(patchText) {
  const files = [];
  for (const m of patchText.matchAll(/^diff --git a\/node_modules\/eve\/(\S+) b\/node_modules\/eve\/\S+$/gm)) files.push(m[1]);
  return files;
}

/**
 * node_modules/eve as Node finds it from `root`: walking up the directories. A copy of the checkout made for a build
 * (scripts/relabelled-build.mjs) has no node_modules of its own and uses the checkout's.
 */
export function eveDir(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules/eve/package.json"))) return join(dir, "node_modules/eve");
    if (dirname(dir) === dir) return null;
  }
}

/** Every problem with `root` (a checkout). Empty when the patched eve is installed. */
export function problems(root, { record = true } = {}) {
  const out = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pinned = pkg.dependencies?.eve;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    out.push(`package.json must pin eve to an exact version (found ${JSON.stringify(pinned)}): the patch is written for one version's code`);
    return out;
  }
  const patches = existsSync(join(root, "patches")) ? readdirSync(join(root, "patches")).filter((f) => /^eve\+.*\.patch$/.test(f)) : [];
  if (patches.length !== 1 || patches[0] !== `eve+${pinned}.patch`) {
    out.push(`patches/ must hold exactly one eve patch, eve+${pinned}.patch, for the pinned version (found ${patches.join(", ") || "none"})`);
    return out;
  }
  const eve = eveDir(root);
  const installed = eve ? JSON.parse(readFileSync(join(eve, "package.json"), "utf8")).version : null;
  if (installed !== pinned) {
    out.push(`node_modules/eve is ${installed ?? "not installed"}, but package.json pins ${pinned}: run \`npm ci\``);
    return out;
  }
  if (!record) return out;
  const recordPath = join(root, RECORD);
  if (!existsSync(recordPath)) {
    out.push(`${RECORD} is missing: record it with \`node scripts/check-eve-patch.mjs --record\` after making the patch`);
    return out;
  }
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  const patchText = readFileSync(join(root, "patches", patches[0]), "utf8");
  if (rec.eve !== pinned || rec.patch !== `patches/${patches[0]}`) out.push(`${RECORD} was recorded for eve ${rec.eve} (${rec.patch}), not ${pinned}`);
  if (rec.patchSha256 !== sha256(patchText)) out.push(`patches/${patches[0]} is not the patch ${RECORD} was recorded from: re-record after regenerating it`);
  const files = patchedFiles(patchText);
  const recorded = Object.keys(rec.files ?? {}).sort();
  if (JSON.stringify(recorded) !== JSON.stringify([...files].sort())) out.push(`${RECORD} lists other files than the patch touches`);
  const wrong = [];
  for (const rel of files) {
    const path = join(eve, rel);
    const actual = existsSync(path) ? sha256(readFileSync(path)) : "missing";
    if (actual !== rec.files?.[rel]) wrong.push(rel);
  }
  if (wrong.length) {
    out.push(
      `node_modules/eve does not carry patches/${patches[0]} (${wrong.length} of ${files.length} files differ: ${wrong.slice(0, 4).join(", ")}${wrong.length > 4 ? ", …" : ""}). ` +
        "Run `npm ci` (it re-installs eve and applies the patch in postinstall); an install with --ignore-scripts skips the patch.",
    );
  }
  return out;
}

function recordNow(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const name = `patches/eve+${pkg.dependencies.eve}.patch`;
  const patchText = readFileSync(join(root, name), "utf8");
  const files = {};
  for (const rel of patchedFiles(patchText)) files[rel] = sha256(readFileSync(join(eveDir(root), rel)));
  const rec = { eve: pkg.dependencies.eve, patch: name, patchSha256: sha256(patchText), files };
  writeFileSync(join(root, RECORD), `${JSON.stringify(rec, null, 2)}\n`);
  console.log(`check-eve-patch: recorded ${Object.keys(files).length} patched files of eve ${rec.eve} in ${RECORD}`);
}

function selfTest() {
  let failures = 0;
  const expect = (what, ok) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
  };
  const base = mkdtempSync(join(tmpdir(), "check-eve-patch-"));
  try {
    const fresh = (name) => {
      const dir = join(base, name);
      mkdirSync(join(dir, "node_modules/eve/dist/src/execution"), { recursive: true });
      mkdirSync(join(dir, "patches"), { recursive: true });
      mkdirSync(join(dir, "scripts/eve-patch"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { eve: "1.2.3" } }));
      writeFileSync(join(dir, "node_modules/eve/package.json"), JSON.stringify({ version: "1.2.3" }));
      writeFileSync(join(dir, "node_modules/eve/dist/src/execution/a.js"), "patched();");
      writeFileSync(
        join(dir, "patches/eve+1.2.3.patch"),
        "diff --git a/node_modules/eve/dist/src/execution/a.js b/node_modules/eve/dist/src/execution/a.js\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-original();\n+patched();\n",
      );
      recordNowQuiet(dir);
      return dir;
    };
    const recordNowQuiet = (dir) => {
      const log = console.log;
      console.log = () => {};
      try {
        recordNow(dir);
      } finally {
        console.log = log;
      }
    };
    expect("a pinned version with its patch applied passes", problems(fresh("good")).length === 0);
    {
      const d = fresh("caret");
      writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { eve: "^1.2.3" } }));
      expect("a range (^1.2.3) fails", /pin eve to an exact version/.test(problems(d).join()));
    }
    {
      const d = fresh("bumped");
      writeFileSync(join(d, "node_modules/eve/package.json"), JSON.stringify({ version: "1.2.4" }));
      expect("an installed eve of another version fails", /node_modules\/eve is 1\.2\.4/.test(problems(d).join()));
    }
    {
      const d = fresh("unpatched");
      writeFileSync(join(d, "node_modules/eve/dist/src/execution/a.js"), "original();");
      expect("an eve installed without the patch (--ignore-scripts) fails, naming the file", /does not carry patches\/eve\+1\.2\.3\.patch.*execution\/a\.js/.test(problems(d).join()));
    }
    {
      const d = fresh("stale-patch");
      writeFileSync(join(d, "patches/eve+1.2.3.patch"), `${readFileSync(join(d, "patches/eve+1.2.3.patch"), "utf8")}\n`);
      expect("a patch edited after it was recorded fails", /is not the patch .* was recorded from/.test(problems(d).join()));
    }
    {
      const d = fresh("other-version-patch");
      rmSync(join(d, "patches/eve+1.2.3.patch"));
      writeFileSync(join(d, "patches/eve+1.2.2.patch"), "");
      expect("a patch for another version fails", /exactly one eve patch, eve\+1\.2\.3\.patch/.test(problems(d).join()));
    }
    {
      const d = fresh("no-record");
      rmSync(join(d, RECORD));
      expect("a missing record fails", /is missing/.test(problems(d).join()));
    }
    {
      const d = fresh("parent");
      const copy = join(d, ".copy");
      mkdirSync(join(copy, "patches"), { recursive: true });
      mkdirSync(join(copy, "scripts/eve-patch"), { recursive: true });
      for (const f of ["package.json", "patches/eve+1.2.3.patch", RECORD]) cpSync(join(d, f), join(copy, f));
      expect("a copy of the checkout without node_modules of its own uses the checkout's (as Node does)", problems(copy).length === 0);
    }
    // The real checkout's pin and patch name are consistent (whatever node_modules holds).
    expect("this checkout pins eve exactly and holds its patch", problems(ROOT, { record: false }).filter((p) => !/node_modules\/eve is/.test(p)).length === 0);
  } finally {
    if (base.startsWith(join(tmpdir(), "check-eve-patch-"))) rmSync(base, { recursive: true, force: true });
  }
  console.log(failures ? `check-eve-patch self-test: ${failures} FAILED` : "check-eve-patch self-test: all cases pass");
  process.exit(failures ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--record")) recordNow(ROOT);
  else {
    const found = problems(ROOT);
    if (found.length) {
      console.error(`check-eve-patch: FAIL\n  - ${found.join("\n  - ")}`);
      process.exit(1);
    }
    const rec = JSON.parse(readFileSync(join(ROOT, RECORD), "utf8"));
    console.log(`check-eve-patch: eve ${rec.eve} is installed with ${rec.patch} (${Object.keys(rec.files).length} files verified)`);
  }
}
