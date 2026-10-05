/**
 * A STAMPED COPY LEAVES NOTHING BEHIND, AND THE GUARD SEES IT WHEN SOMETHING DOES (factory task mold_v1-188).
 *
 * Against a scratch git repository shaped like this one (package.json with `check:generated`, profiles/, a generated
 * file), never this checkout:
 *
 *  1. scripts/lib/checkout-copy.mjs: a copy made with temporaryCopy() is gone after every way out of the process
 *     that made it: a normal end, a thrown error, `process.exit(2)` from inside a step (which skips `finally`),
 *     SIGINT and SIGTERM (exit status 130 / 143), and SIGTERM while a child process is running. The repository
 *     itself (profiles/, the generated file) is byte for byte what it was. --keep keeps the copy.
 *  2. copyDir refuses a name that is not a plain name under .ui-vocabulary/ (no `..`, no `/`, no empty name).
 *  3. scripts/check-checkout-clean.mjs passes on the commit, and fails naming the file on a profile left in
 *     profiles/, on an edited generated file, and on an edited committed profile; it passes again once restored.
 *
 * Run: npm run test:checkout-copy
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./lib/wait.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HELPER = join(ROOT, "scripts/lib/checkout-copy.mjs");
const GUARD = join(ROOT, "scripts/check-checkout-clean.mjs");

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`}`);
  }
};

const scratch = mkdtempSync(join(tmpdir(), "checkout-copy-"));
const repo = join(scratch, "repo");
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
/** Every file of the repository outside .git and .ui-vocabulary, with its content: what "unchanged" means. */
const tree = () => {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(join(repo, d))) {
      if (n === ".git" || (d === "" && n === ".ui-vocabulary")) continue;
      const rel = d ? `${d}/${n}` : n;
      try {
        out[rel] = readFileSync(join(repo, rel), "utf8");
      } catch {
        walk(rel);
      }
    }
  };
  walk("");
  return JSON.stringify(out);
};
const copies = () => (existsSync(join(repo, ".ui-vocabulary")) ? readdirSync(join(repo, ".ui-vocabulary")) : []);

try {
  mkdirSync(join(repo, "profiles"), { recursive: true });
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "check:generated": "node gen.mjs && git diff HEAD --exit-code -- lib/profile.generated.ts" } }));
  writeFileSync(join(repo, "profiles/00-default.json"), '{"vocabulary":{}}\n');
  writeFileSync(join(repo, "lib/profile.generated.ts"), "export const P = {};\n");
  writeFileSync(join(repo, ".gitignore"), ".ui-vocabulary/\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "scratch");
  const committed = tree();

  console.log("1. A copy is removed on every way out");
  /** A child that makes a copy, stamps a profile in it, writes `ready`, then ends the way `how` says. */
  const childScript = (how) => `
    import { writeFileSync, cpSync } from "node:fs";
    import { join } from "node:path";
    import { spawn } from "node:child_process";
    import { temporaryCopy } from ${JSON.stringify(HELPER)};
    const keep = ${JSON.stringify(how === "keep")};
    const { dir } = temporaryCopy(${JSON.stringify(repo)}, "probe", { keep });
    writeFileSync(join(dir, "profiles", "50-relabelled.json"), "{}");
    writeFileSync(join(dir, "lib", "profile.generated.ts"), "export const P = { relabelled: true };\\n");
    const how = ${JSON.stringify(how)};
    if (how === "child") spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(join(scratch, "ready"))}, dir);
    if (how === "throw") throw new Error("a step failed");
    if (how === "exit") process.exit(2);
    if (how === "signal" || how === "child") setTimeout(() => {}, 60000);
  `;
  const ways = [
    ["a normal end", "end", null, 0],
    ["a thrown error", "throw", null, 1],
    ["process.exit(2) from a failed step (finally blocks do not run)", "exit", null, 2],
    ["SIGINT", "signal", "SIGINT", 130],
    ["SIGTERM", "signal", "SIGTERM", 143],
    ["SIGTERM while a child process runs", "child", "SIGTERM", 143],
  ];
  for (const [label, how, signal, code] of ways) {
    rmSync(join(scratch, "ready"), { force: true });
    const proc = spawn(process.execPath, ["--input-type=module", "-e", childScript(how)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((r) => proc.on("exit", (c, s) => r(c ?? s)));
    if (signal) {
      await until("the child to make its copy", () => existsSync(join(scratch, "ready")), { timeout: 30_000 });
      check(`${label}: the copy existed while it ran, stamped`, copies().includes("probe") && existsSync(join(repo, ".ui-vocabulary/probe/profiles/50-relabelled.json")), copies());
      proc.kill(signal);
    }
    const status = await exited;
    check(`${label}: exit status ${code}`, status === code, { status, stderr: stderr.slice(-300) });
    check(`${label}: the copy is gone, and .ui-vocabulary/ with it`, !existsSync(join(repo, ".ui-vocabulary")), copies());
    check(`${label}: the repository is exactly the commit`, tree() === committed);
  }
  {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", childScript("keep")], { encoding: "utf8" });
    check("--keep: the copy stays (to iterate on it), and the repository is untouched", r.status === 0 && copies().includes("probe") && tree() === committed, r.stderr);
    const { removeCopy } = await import(HELPER);
    removeCopy(repo, "probe");
    check("…and removeCopy takes it and the empty .ui-vocabulary/ away", !existsSync(join(repo, ".ui-vocabulary")));
  }
  {
    // scripts/relabelled-build.mjs: removed if the build fails or is interrupted, kept once it has succeeded.
    const built = `import { temporaryCopy } from ${JSON.stringify(HELPER)}; const { keep } = temporaryCopy(${JSON.stringify(repo)}, "built"); keep();`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", built], { encoding: "utf8" });
    check("keep() once a build has succeeded: the copy outlives the process, for the checks after it", r.status === 0 && copies().includes("built"), r.stderr);
    const { removeCopy } = await import(HELPER);
    removeCopy(repo, "built");
  }
  {
    const script = `import { writeFileSync } from "node:fs"; import { scratchDir } from ${JSON.stringify(HELPER)}; const { dir } = scratchDir("checkout-copy-probe-"); writeFileSync(${JSON.stringify(join(scratch, "ready"))}, dir); setTimeout(() => {}, 60000);`;
    rmSync(join(scratch, "ready"), { force: true });
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    const exited = new Promise((r) => proc.on("exit", (c, sig) => r(c ?? sig)));
    await until("the child to make its scratch directory", () => existsSync(join(scratch, "ready")), { timeout: 30_000 });
    const made = readFileSync(join(scratch, "ready"), "utf8");
    proc.kill("SIGTERM");
    const status = await exited;
    check("scratchDir (test:ui-vocabulary's copies): gone after SIGTERM", status === 143 && made.includes("checkout-copy-probe-") && !existsSync(made), { status, made });
  }

  console.log("\n2. A copy name is a plain name under .ui-vocabulary/");
  const { copyDir } = await import(HELPER);
  for (const bad of ["", "..", "../x", "a/b", "/tmp", "x/../../y"]) {
    let threw = false;
    try {
      copyDir(repo, bad);
    } catch {
      threw = true;
    }
    check(`refused: ${JSON.stringify(bad)}`, threw);
  }
  check("accepted: workbook-route, under .ui-vocabulary/", copyDir(repo, "workbook-route") === join(repo, ".ui-vocabulary", "workbook-route"));

  console.log("\n3. The guard: profiles/ and the generated files are the commit");
  const guard = () => spawnSync(process.execPath, [GUARD, "--root", repo], { encoding: "utf8" });
  let g = guard();
  check("the commit: passes", g.status === 0, g.stdout + g.stderr);
  writeFileSync(join(repo, "profiles/50-relabelled.json"), "{}");
  g = guard();
  check("a profile left in profiles/: fails, naming it", g.status === 1 && g.stderr.includes("profiles/50-relabelled.json"), g.stderr);
  rmSync(join(repo, "profiles/50-relabelled.json"));
  writeFileSync(join(repo, "lib/profile.generated.ts"), "export const P = { relabelled: true };\n");
  g = guard();
  check("a generated file rebuilt from another profile: fails, naming it and how to put it back", g.status === 1 && g.stderr.includes("lib/profile.generated.ts") && g.stderr.includes("git checkout HEAD -- lib/profile.generated.ts"), g.stderr);
  git("checkout", "HEAD", "--", "lib/profile.generated.ts");
  writeFileSync(join(repo, "profiles/00-default.json"), '{"vocabulary":{"account":"x"}}\n');
  g = guard();
  check("an edited committed profile: fails, naming it", g.status === 1 && g.stderr.includes("profiles/00-default.json"), g.stderr);
  git("checkout", "HEAD", "--", "profiles/00-default.json");
  g = guard();
  check("restored: passes again", g.status === 0, g.stdout + g.stderr);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\ncheckout copy: ${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
