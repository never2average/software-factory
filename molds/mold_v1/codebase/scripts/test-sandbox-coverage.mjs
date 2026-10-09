/**
 * EVERY SANDBOX TAKES THE SANDBOX_* SETTINGS — the root, every specialist, and specialists a pack adds, with the
 * pack doing nothing for it (scripts/lib/sandbox-overlay.mjs, wired into scripts/eve-build.mjs and
 * scripts/sandbox-prewarm-serial.mjs). And with the setting unset, which is every Vercel build, eve is handed the
 * tree exactly as it is committed.
 *
 * What it guards against, measured on the first self-hosted server (2026-10-04): only the two definitions that named
 * the settings got them. The other specialists, and all four of a pack's, built their templates on eve's default
 * microsandbox, 1 vCPU and allow-all egress; the second template spun at 100% CPU for 1h50m.
 *
 * The test works on a COPY of the checkout stamped the way the factory stamps a deployment: the fixture profile that
 * mirrors a pack (scripts/fixtures/agent-vocabulary/50-relabelled.json, which excludes four base specialists) and two
 * fixture specialists (scripts/fixtures/sandbox-coverage/): `fixture-bare` with no sandbox file at all, and
 * `fixture-pack` with a pack-shaped `sandbox/sandbox.ts` (a bootstrap, seed files, no backend).
 *
 *   1. With a stand-in for `eve` that records the tree it is given (fast; part of `npm run test:sandbox-backend`):
 *      unset → eve sees the committed files and nothing else; microsandbox → eve sees a wrapper in every node's
 *      sandbox slot; afterwards, and after a failed or killed build, the tree is byte-identical.
 *   2. With the REAL `eve build` (two builds, about five minutes; its own CI job): the built agent's graph, read back
 *      by `sandbox:prewarm --plan`, has every node on a microsandbox backend carrying the configured CPUs, memory and
 *      deny list; a build made without the setting is refused by name. No sandbox is created: `--plan` starts nothing.
 *
 *   npm run test:sandbox-coverage              both parts
 *   node scripts/test-sandbox-coverage.mjs --no-build     part 1 only
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FIXTURE_PROFILE = join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const FIXTURE_SPECIALISTS = join(ROOT, "scripts/fixtures/sandbox-coverage/subagents");
const SETTINGS = ["SANDBOX_BACKEND", "SANDBOX_CPUS", "SANDBOX_MEMORY_MIB", "SANDBOX_DENY_SUBNETS", "STORAGE_DRIVER", "STORAGE_PUBLIC_URL", "WEB_ORIGIN"];
const DENY = ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"];
const EXCLUDED = ["configuration", "customer-context", "data-migration", "deployment"];

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
};

/** The environment without any sandbox or Vercel setting of the caller's, plus `extra`. */
const envWith = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SETTINGS.includes(k) && !k.startsWith("VERCEL"))), ...extra });

/** A copy of the checkout as a stamped deployment: the pack-like profile and the two fixture specialists. */
function stampedCopy(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of ["agent", "lib", "data", "scripts", "profiles", "package.json", "tsconfig.json", "dm.md"]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true, filter: (src) => !src.includes("__pycache__") });
  }
  cpSync(FIXTURE_PROFILE, join(dir, "profiles/50-relabelled.json"));
  cpSync(FIXTURE_SPECIALISTS, join(dir, "agent/subagents"), { recursive: true });
  return dir;
}

/** `{ "agent/…": sha256 }` for every file under agent/. */
function agentTree(dir) {
  const files = {};
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(join(dir, "agent"));
  return files;
}
const canonical = (tree) => JSON.stringify(Object.keys(tree).sort().map((k) => [k, tree[k]]));
const same = (a, b) => canonical(a) === canonical(b);
const sandboxFiles = (tree) => Object.keys(tree).filter((f) => /(^|\/)sandbox(\.authored)?\.ts$/.test(f)).sort();

/* ---- 1. what eve is handed ---------------------------------------------------------------------------------------- */

async function partStandIn() {
  console.log("\nWhat eve is handed (a stand-in for eve records the tree):");
  const dir = stampedCopy("sandbox-coverage-");
  try {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    // The stand-in: write what agent/ holds (path + sha256) to seen.txt, "build" an output, exit as told.
    writeFileSync(
      join(dir, "node_modules/.bin/eve"),
      `#!/bin/sh
find agent -type f | LC_ALL=C sort | xargs sha256sum > seen.txt
mkdir -p .output && date +%s%N > .output/nitro.json
[ -n "$STANDIN_SLEEP" ] && sleep "$STANDIN_SLEEP"
exit \${STANDIN_EXIT:-0}
`,
    );
    chmodSync(join(dir, "node_modules/.bin/eve"), 0o755);
    const build = (env) => spawnSync(process.execPath, ["scripts/eve-build.mjs", "build"], { cwd: dir, env: envWith(env), encoding: "utf8" });
    const seen = () => Object.fromEntries(readFileSync(join(dir, "seen.txt"), "utf8").trim().split("\n").map((l) => l.split(/\s+/).reverse()));
    const committed = agentTree(dir);
    const withoutExcluded = Object.fromEntries(Object.entries(committed).filter(([f]) => !EXCLUDED.some((k) => f.startsWith(`agent/subagents/${k}/`))));

    // Unset: every Vercel build.
    for (const [label, env] of [["unset", {}], ["empty", { SANDBOX_BACKEND: "" }], ['"vercel"', { SANDBOX_BACKEND: "vercel" }], ["unset on Vercel (VERCEL=1)", { VERCEL: "1" }]]) {
      const r = build(env);
      check(`${label}: eve is handed the committed files, byte for byte (no wrapper, nothing moved)`, r.status === 0 && same(seen(), withoutExcluded), r.stderr || sandboxFiles(seen()));
      check(`${label}: no sandbox stamp is written into the output, and the tree is unchanged afterwards`, !existsSync(join(dir, ".output/sandbox-overlay.json")) && same(agentTree(dir), committed));
      rmSync(join(dir, ".output"), { recursive: true, force: true });
    }
    check("…in which the fixture specialist has NO sandbox file and the pack-shaped one names no backend", !sandboxFiles(committed).some((f) => f.includes("fixture-bare")) && !/\bbackend\s*:|microsandbox\(|sandbox-settings/.test(readFileSync(join(dir, "agent/subagents/fixture-pack/sandbox/sandbox.ts"), "utf8")));

    // microsandbox.
    const r = build({ SANDBOX_BACKEND: "microsandbox" });
    const during = r.status === 0 ? seen() : {};
    const nodes = ["", ...readdirSync(join(dir, "agent/subagents")).filter((n) => existsSync(join(dir, "agent/subagents", n, "agent.ts")) && !EXCLUDED.includes(n)).map((n) => `subagents/${n}/`)];
    const slotOf = (node) => (committed[`agent/${node}sandbox/sandbox.ts`] || existsSync(join(dir, "agent", node, "sandbox")) ? `agent/${node}sandbox/sandbox.ts` : `agent/${node}sandbox.ts`);
    const wrapperOf = (node) => {
      const sha = during[slotOf(node)];
      return sha !== undefined && sha !== committed[slotOf(node)];
    };
    check("microsandbox: the build succeeds", r.status === 0, r.stderr);
    check(`microsandbox: eve is handed a wrapper in the sandbox slot of EVERY node it builds (${nodes.length}: the root and each specialist)`, nodes.every(wrapperOf), nodes.filter((n) => !wrapperOf(n)));
    check("…including the fixture specialist with no sandbox file", wrapperOf("subagents/fixture-bare/") && slotOf("subagents/fixture-bare/") === "agent/subagents/fixture-bare/sandbox.ts");
    check("…and the pack-shaped one, whose authored definition eve still gets, unchanged, beside it", wrapperOf("subagents/fixture-pack/") && during["agent/subagents/fixture-pack/sandbox/sandbox.authored.ts"] === committed["agent/subagents/fixture-pack/sandbox/sandbox.ts"]);
    check("…and the two definitions that already read the settings (root, research)", during["agent/sandbox.authored.ts"] === committed["agent/sandbox.ts"] && during["agent/subagents/research/sandbox.authored.ts"] === committed["agent/subagents/research/sandbox.ts"]);
    const others = (tree) => Object.fromEntries(Object.entries(tree).filter(([f]) => !/(^|\/)sandbox(\.authored)?\.ts$/.test(f)));
    check("…and nothing else in agent/ differs (seed files, prompts, tools)", same(others(during), others(withoutExcluded)));
    check("…the specialists the profile excludes are still hidden, and get no wrapper", !Object.keys(during).some((f) => EXCLUDED.some((k) => f.startsWith(`agent/subagents/${k}/`))));
    check("microsandbox: afterwards the tree is byte-identical to the committed one", same(agentTree(dir), committed), sandboxFiles(agentTree(dir)));
    const stamp = existsSync(join(dir, ".output/sandbox-overlay.json")) ? JSON.parse(readFileSync(join(dir, ".output/sandbox-overlay.json"), "utf8")) : null;
    check("microsandbox: the output is stamped with the nodes it was built for", stamp?.backend === "microsandbox" && stamp.nodes.length === nodes.length && stamp.nodes.some((n) => n.node === "subagents/fixture-bare" && n.authoredSha === null) && stamp.nodes.some((n) => n.node === "subagents/fixture-pack" && n.authoredSha === committed["agent/subagents/fixture-pack/sandbox/sandbox.ts"]), stamp);

    // A wrong value never builds.
    const wrong = build({ SANDBOX_BACKEND: "docker" });
    check("an unknown SANDBOX_BACKEND stops the build, and leaves the tree as it was", wrong.status !== 0 && /not supported/.test(wrong.stderr) && same(agentTree(dir), committed), wrong.stderr.slice(-300));

    // A failed build.
    rmSync(join(dir, ".output"), { recursive: true, force: true });
    const failed = build({ SANDBOX_BACKEND: "microsandbox", STANDIN_EXIT: "3" });
    check("a failed microsandbox build exits with eve's code, restores the tree", failed.status === 3 && same(agentTree(dir), committed));
    check("…and writes no stamp", !existsSync(join(dir, ".output/sandbox-overlay.json")));

    // A killed build: SIGKILL the wrapper while eve "runs"; the next run cleans up.
    const child = spawn(process.execPath, ["scripts/eve-build.mjs", "build"], { cwd: dir, env: envWith({ SANDBOX_BACKEND: "microsandbox", STANDIN_SLEEP: "30" }), stdio: "ignore", detached: true });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(join(dir, "agent/subagents/fixture-bare/sandbox.ts"))) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 300));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await new Promise((res) => child.on("exit", res));
    check("a build killed outright (SIGKILL) leaves its wrappers behind…", existsSync(join(dir, "agent/subagents/fixture-bare/sandbox.ts")) && existsSync(join(dir, "agent/sandbox.authored.ts")));
    const restore = spawnSync(process.execPath, ["scripts/eve-build.mjs", "--restore"], { cwd: dir, env: envWith(), encoding: "utf8" });
    check("…and `eve-build --restore` (or the next build, or the next prewarm) puts the tree back byte for byte", restore.status === 0 && same(agentTree(dir), committed), restore.stderr + JSON.stringify(sandboxFiles(agentTree(dir))));
    const after = build({});
    check("…after which an unset build again hands eve the committed files", after.status === 0 && same(seen(), withoutExcluded) && same(agentTree(dir), committed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- 2. the built agent, through the real eve --------------------------------------------------------------------- */

function plan(dir, env) {
  const r = spawnSync(process.execPath, ["scripts/sandbox-prewarm-serial.mjs", "--plan"], { cwd: dir, env: envWith(env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const start = r.stdout.indexOf("{\n");
  let json = null;
  try {
    json = JSON.parse(r.stdout.slice(start));
  } catch {
    json = null;
  }
  return { status: r.status, json, stderr: r.stderr.split("\n").filter((l) => !l.startsWith("[model]")).join("\n") };
}

function partRealBuild() {
  console.log("\nThe built agent, through the real `eve build` (nothing is started; this takes a few minutes):");
  const dir = stampedCopy("sandbox-coverage-real-");
  try {
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const committed = agentTree(dir);
    const realBuild = (env) => spawnSync(process.execPath, ["scripts/eve-build.mjs", "build"], { cwd: dir, env: envWith(env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const expected = ["__root__", "subagents/app-author", "subagents/browser", "subagents/evals", "subagents/fixture-bare", "subagents/fixture-pack", "subagents/follow-ups", "subagents/research", "subagents/workflow-author"];

    // Built with the setting.
    const built = realBuild({ SANDBOX_BACKEND: "microsandbox" });
    check("SANDBOX_BACKEND=microsandbox: the real eve builds the stamped copy with the wrappers in place", built.status === 0, built.stderr.slice(-600));
    check("…and the tree is byte-identical afterwards", same(agentTree(dir), committed));
    const tuned = plan(dir, { SANDBOX_BACKEND: "microsandbox", SANDBOX_CPUS: "4", SANDBOX_MEMORY_MIB: "2048", SANDBOX_DENY_SUBNETS: "203.0.113.7" });
    const rows = tuned.json?.nodes ?? [];
    const row = (node) => rows.find((r) => r.node === node);
    check("the plan of the built agent loads and refuses nothing", tuned.status === 0 && tuned.json?.build === null && rows.length > 0 && rows.every((r) => r.refused === null), tuned.stderr.slice(-600) || rows.filter((r) => r.refused));
    check(`it holds exactly the nodes this deployment builds (${expected.length}: the excluded specialists are not among them)`, rows.map((r) => r.node).join() === expected.join(), rows.map((r) => r.node));
    check("EVERY node's backend is microsandbox, named by its own definition (none left to eve's default)", rows.every((r) => r.backend === "microsandbox" && r.backendNamedByDefinition === true), rows.filter((r) => r.backend !== "microsandbox" || !r.backendNamedByDefinition));
    check(
      "EVERY node's backend carries the settings of the process that runs it: SANDBOX_CPUS=4, SANDBOX_MEMORY_MIB=2048",
      rows.every((r) => r.settings?.cpus === 4 && r.settings.memoryMiB === 2048),
      rows.filter((r) => r.settings?.cpus !== 4).map((r) => [r.node, r.settings]),
    );
    check("…and the whole deny list, with the deployment's own entry added", rows.every((r) => JSON.stringify(r.settings?.deny) === JSON.stringify([...DENY, "203.0.113.7/32"])), rows[0]?.settings);
    check("the specialist with NO sandbox file is one of them", row("subagents/fixture-bare")?.settings?.cpus === 4 && row("subagents/fixture-bare").bootstrap === false && row("subagents/fixture-bare").template === "none", row("subagents/fixture-bare"));
    check("the pack-shaped specialist is one of them, and still has ITS bootstrap and its seed-file template", row("subagents/fixture-pack")?.settings?.cpus === 4 && row("subagents/fixture-pack").bootstrap === true && row("subagents/fixture-pack").template === "bootstrap" && /^eve-sbx-tpl-microsandbox-/.test(row("subagents/fixture-pack").templateKey ?? ""), row("subagents/fixture-pack"));
    check("the root and the research specialist keep their bootstraps", row("__root__")?.bootstrap === true && row("subagents/research")?.bootstrap === true);
    check("a base specialist that only has seed files (skills) keeps its template", row("subagents/workflow-author")?.template === "workspace-content" && row("subagents/workflow-author").bootstrap === false, row("subagents/workflow-author"));
    check("reading the plan left the tree byte-identical", same(agentTree(dir), committed), sandboxFiles(agentTree(dir)));

    // Built WITHOUT the setting: what a Vercel build is, and what a server must never be started from.
    const unset = realBuild({});
    check("unset: the real eve builds the same copy from the committed files", unset.status === 0 && same(agentTree(dir), committed), unset.stderr.slice(-600));
    const vercel = plan(dir, { VERCEL: "1", VERCEL_PROJECT_ID: "prj_sandbox_coverage" });
    const vrow = (node) => (vercel.json?.nodes ?? []).find((r) => r.node === node);
    check("unset on Vercel: every node is on eve's own choice, Vercel Sandbox, and no definition names a backend", vercel.status === 0 && vercel.json.nodes.length === expected.length && vercel.json.nodes.every((r) => r.backend === "vercel" && r.backendNamedByDefinition === false && r.settings === null && r.refused === null), vercel.stderr.slice(-600) || vercel.json?.nodes);
    check("unset on Vercel: a specialist with no sandbox file has eve's default definition, as it always had", vrow("subagents/fixture-bare")?.definition === "eve default (none authored)" && vrow("subagents/workflow-author")?.definition === "eve default (none authored)", vrow("subagents/fixture-bare"));
    check("unset on Vercel: the pack-shaped specialist is its own authored file", vrow("subagents/fixture-pack")?.definition === "sandbox/sandbox.ts" && vrow("subagents/fixture-pack").bootstrap === true, vrow("subagents/fixture-pack"));
    const stale = plan(dir, { SANDBOX_BACKEND: "microsandbox" });
    check("a server set to microsandbox over a build made WITHOUT the setting is refused before anything starts", stale.status === 1 && /was not built with SANDBOX_BACKEND=microsandbox/.test(stale.stderr), stale.stderr.slice(-600));
    const bare = (stale.json?.nodes ?? []).find((r) => r.node === "subagents/fixture-bare");
    check("…and the specialists that would start on eve's defaults are named, with what they would start on", /^subagents\/fixture-bare: no sandbox definition in this build/.test(bare?.refused ?? "") && /1 vCPU and allow-all egress/.test(bare.refused), bare);
    const run = spawnSync(process.execPath, ["scripts/sandbox-prewarm-serial.mjs"], { cwd: dir, env: envWith({ SANDBOX_BACKEND: "microsandbox" }), encoding: "utf8" });
    check("…the prewarm itself exits 1 there, having started nothing", run.status === 1 && /Nothing was started/.test(run.stderr) && !/prewarming sandbox templates/.test(run.stdout), run.stderr.slice(-400));
    check("…and leaves the tree byte-identical", same(agentTree(dir), committed), sandboxFiles(agentTree(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await partStandIn();
if (!process.argv.includes("--no-build")) partRealBuild();
console.log(failures.length ? `\ntest-sandbox-coverage: ${failures.length} FAILED\n  - ${failures.join("\n  - ")}` : `\ntest-sandbox-coverage: ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);
