#!/usr/bin/env node
/**
 * THE NIGHTLY REPEATS (.github/workflows/nightly.yml, the `repeat` job). A check that fails one run in 256 passes
 * every PR; the web-push key length did exactly that until a CI run drew the bad key by chance. Each night the suites
 * below — the ones that draw random keys or ids, run on timers and leases, race two processes or two requests, or
 * serve a real runtime or browser — run several more times, each on its own runner (a matrix of group x attempt), and
 * every run is recorded so a rare failure is seen, counted and reported before it reaches a release.
 *
 * The commands are the ones CI runs, with the same settings (`--self-test` checks that every one is in ci.yml).
 * Nothing here is part of a PR run.
 *
 *   node scripts/nightly-repeat.mjs --group random-timers --attempt 3 [--out nightly-results] [--only test:web-push]
 *   node scripts/nightly-repeat.mjs --list          the groups, as JSON (the workflow's matrix must equal it)
 *   node scripts/nightly-repeat.mjs --self-test     the groups against package.json, ci.yml and nightly.yml
 *
 * Each test gets TEST_SEED (the one given, or a fresh one) and prints it; a test that draws from scripts/lib/test-seed.mjs
 * replays with it. The result file (<out>/<group>-<attempt>.json) holds per test: pass or fail, seconds, the seed, and
 * the failing check lines, for scripts/nightly-report.mjs. Exit 1 when any test failed.
 */
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The app's database role on the job's Postgres, as the isolation jobs in ci.yml name it
 * (postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test): ADMIN_URL's database as app_rw.
 */
export function appRwUrl(adminUrl = process.env.ADMIN_URL) {
  if (!adminUrl) return "";
  const u = new URL(adminUrl);
  u.username = "app_rw";
  u.password = "app_rw_test_password";
  return u.toString();
}
const APP_RW = "$APP_RW";

/**
 * What repeats, and why (each one read for randomness, timers and races; the history of flaky fixes names some).
 * `needs`: what the job must have set up first (the workflow does: `db` a Postgres with schema and app_rw, `build`
 * the production build and Chromium).
 */
export const GROUPS = {
  // Offline, one runner, ~2.5 min. Random keys and ids, timers, leases, stale locks, killed builds, listener ports.
  "random-timers": {
    tests: [
      { run: "test:web-push", why: "random P-256 keys and secrets (a 1-in-256 short private key)" },
      { run: "test:dataroom-folders", why: "random nanoid ids masked by the census (a 1-in-64 id once failed it)" },
      { run: "test:sandbox-backend", why: "prewarm stale locks, timeouts, killed and failed builds (timers, child processes)" },
      { run: "test:specialist-sweep", why: "two sweeps at once, a result racing the sweep" },
      { run: "test:specialist-handback", why: "a Stop racing a natural finish, a new turn" },
      { run: "test:eve-local-world-inline", why: "the inline-ownership lease boundary" },
      { run: "test:chat-reattach", why: "reader liveness and reopen budgets (timers)" },
      { run: "test:subagent-handback", why: "quiet seams on a virtual clock" },
      { run: "test:chat-send-gate", why: "the send gate over a stubbed fetch (timers)" },
      { run: "test:chat-buffered-turns", why: "buffered turns and the stuck queue (timers)" },
      { run: "test:own-listener", why: "free ports, squatters (listeners)" },
      { run: "test:workflow-leases", why: "lease expiry" },
      { run: "test:checkout-copy", why: "cleanup on every exit path (signals)" },
    ],
  },
  // The real eve runtime (`eve dev`, a scripted model): the per-result delegation, two shards as in CI (~3.5 min each).
  "detach-1": { tests: [{ run: "test:specialist-detach", env: { EVE_DETACH_SHARD: "1/2" }, why: "real runtime, detached specialists, late results (shard 1 of 2)" }] },
  "detach-2": { tests: [{ run: "test:specialist-detach", env: { EVE_DETACH_SHARD: "2/2" }, why: "real runtime, detached specialists, late results (shard 2 of 2)" }] },
  // The other checks on the real eve runtime.
  "eve-runtime": {
    tests: [
      { run: "test:specialist-batch", why: "real runtime: specialists handed back together, a message sent meanwhile" },
      { run: "test:callback-routes", why: "real runtime: hook resume refused" },
      { run: "test:session-affinity", why: "real runtime: one affinity value across steps and turns" },
      { run: "test:served-model-eve", why: "real runtime: the served model per step" },
    ],
  },
  // Against a real Postgres as app_rw: claims raced by separate processes, exactly-once queues, signed tokens.
  "db-races": {
    needs: "db",
    tests: [
      { run: "test:specialist-handback-db", env: { DATABASE_URL: APP_RW }, why: "two processes claim one hand-back, 12 rounds" },
      { run: "test:specialist-sweep-db", env: { DATABASE_URL: APP_RW }, why: "two sweeps claim one delegation, 12 rounds" },
      { run: "test:chat-queue-db", env: { DATABASE_URL: APP_RW }, why: "eight claimers racing for one session, 20 rounds" },
      { run: "test:record-areas-db", env: { DATABASE_URL: APP_RW }, why: "40-round write races; plan-dependent row order once failed it" },
      { run: "test:guest-signin-db", env: { DATABASE_URL: APP_RW }, why: "random keys and codes, concurrent sign-ins" },
      { run: "test:session-guard", env: { DATABASE_URL: APP_RW }, why: "generated JWT keys, leases and timers" },
      { run: "test:app-refresh-background-db", env: { DATABASE_URL: APP_RW }, why: "background refreshes, timers, random ids" },
    ],
  },
  // A production build served to Chromium: the checks that once failed on timing (polling a page, a worker).
  rendered: {
    needs: "build",
    tests: [
      { run: "test:push-sw", why: "service worker shows a push; reading too early once dropped one in three" },
      { run: "check:lazy-features", why: "rendered chat loads libraries on first use (waits on the page)" },
      { run: "check:workspace-refused", why: "rendered refusal; read before the workspaces arrived once" },
    ],
  },
};

/** The lines a failing check prints, across this repo's test scripts ("  FAIL x", "  ✗ x", "  FAILED: x", "not ok"). */
export function failLines(output, max = 12) {
  const out = [];
  for (const raw of String(output).split(/\r?\n/)) {
    // A GitHub log line starts with a timestamp; a local one does not.
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s*(FAIL(?:ED)?:?|✗|×|not ok)\s+\S/.test(line) && !/^\s*FAIL(?:ED)?:?\s+0\b/.test(line)) {
      const t = line.trim().slice(0, 300);
      if (!out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** One command, its output to the console as it comes and kept (the last 400 kB) for the result. */
export function runOne(command, args, env, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let kept = "";
    const keep = (chunk, stream) => {
      if (!quiet) stream.write(chunk);
      kept = (kept + chunk.toString()).slice(-400_000);
    };
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => keep(c, process.stdout));
    child.stderr.on("data", (c) => keep(c, process.stderr));
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, seconds: Math.round((Date.now() - started) / 100) / 10, output: kept }));
    child.on("error", (e) => resolve({ code: 1, signal: null, seconds: 0, output: String(e?.message ?? e) }));
  });
}

/** A test's name in the report: the npm script, and its shard when it has one. */
export const testName = (t) => (t.env?.EVE_DETACH_SHARD ? `${t.run} (shard ${t.env.EVE_DETACH_SHARD})` : t.run);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const group = arg("--group");
  const attempt = arg("--attempt") ?? "1";
  const outDir = resolve(ROOT, arg("--out") ?? "nightly-results");
  const only = arg("--only");
  const spec = GROUPS[group];
  if (!spec) {
    console.error(`nightly-repeat: --group must be one of ${Object.keys(GROUPS).join(", ")}`);
    process.exit(2);
  }
  if (spec.needs === "db" && !process.env.ADMIN_URL) {
    // The DB tests skip themselves without it and would read as passes: refuse instead.
    console.error("nightly-repeat: the db-races group needs ADMIN_URL (a Postgres with the schema pushed and app_rw bootstrapped)");
    process.exit(2);
  }
  const tests = spec.tests.filter((t) => !only || t.run === only);
  const results = [];
  for (const t of tests) {
    const seed = process.env.TEST_SEED?.trim() || String(randomInt(1, 2 ** 31));
    const name = testName(t);
    console.log(`::group::${name} — attempt ${attempt}, TEST_SEED=${seed}`);
    console.log(`why repeated: ${t.why}`);
    const env = Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, v === APP_RW ? appRwUrl() : v]));
    const r = await runOne("npm", ["run", t.run], { ...process.env, ...env, TEST_SEED: seed });
    console.log("::endgroup::");
    const ok = r.code === 0;
    const lines = ok ? [] : failLines(r.output);
    const replay = `${Object.entries({ ...env, TEST_SEED: seed }).map(([k, v]) => `${k}=${v}`).join(" ")} npm run ${t.run}`;
    if (ok) console.log(`ok   ${name} (${r.seconds}s)`);
    else {
      // An annotation on the run's summary page names the test; the job's log has the rest.
      const esc = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      const prop = (v) => esc(v).replace(/:/g, "%3A").replace(/,/g, "%2C");
      console.log(`::error title=${prop(`${name} failed (attempt ${attempt})`)}::${esc(lines[0] ?? `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`)} — replay: ${esc(replay)}`);
      console.log(`FAIL ${name} (${r.seconds}s, exit ${r.code}) — replay: ${replay}`);
      for (const l of lines) console.log(`     ${l}`);
    }
    results.push({ test: name, script: t.run, ok, exit: r.code, signal: r.signal, seconds: r.seconds, seed, replay, failLines: lines });
  }
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${group}-${attempt}.json`);
  writeFileSync(file, `${JSON.stringify({ group, attempt: Number(attempt), runner: process.env.RUNNER_NAME ?? null, results }, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${group}, attempt ${attempt}: ${results.length - failed.length} passed, ${failed.length} failed (${file.replace(`${ROOT}/`, "")})`);
  process.exit(failed.length ? 1 : 0);
}

async function selfTest() {
  let bad = 0;
  const check = (label, ok, detail) => {
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  };
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const nightly = readFileSync(join(ROOT, ".github/workflows/nightly.yml"), "utf8");
  const all = Object.values(GROUPS).flatMap((g) => g.tests);
  check("every repeated test is an npm script", all.every((t) => scripts[t.run]), all.filter((t) => !scripts[t.run]).map((t) => t.run));
  const inCi = (t) => new RegExp(`npm run ${t.run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|&|;)`, "m").test(ci);
  check("every repeated test is one CI runs (the repeats test what a PR is held to)", all.every(inCi), all.filter((t) => !inCi(t)).map((t) => t.run));
  const shards = all.filter((t) => t.run === "test:specialist-detach").map((t) => t.env?.EVE_DETACH_SHARD).sort();
  check("test:specialist-detach repeats both of CI's shards", JSON.stringify(shards) === JSON.stringify(["1/2", "2/2"]), shards);
  const m = /^\s*group:\s*\[([^\]]*)\]/m.exec(nightly);
  const matrix = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  check("nightly.yml's repeat matrix lists exactly these groups", JSON.stringify(matrix) === JSON.stringify(Object.keys(GROUPS)), { matrix, groups: Object.keys(GROUPS) });
  check("the db group's job has a Postgres (nightly.yml names the group for its service image)", nightly.includes("matrix.group == 'db-races'"));
  check("the build group's job builds and has Chromium", /matrix\.group == 'rendered'[\s\S]*npm run build/.test(nightly) && nightly.includes("./.github/actions/chromium"));
  // Unquoted, ` #` starts a YAML comment and every attempt's job is named alike; the report tells attempts apart by it.
  check("the repeat job's name carries the attempt (quoted: ` #` would start a YAML comment)", nightly.includes(`name: "repeat \${{ matrix.group }} #\${{ matrix.attempt }}"`));
  check("a cancelled night neither retries nor reports (a cancelled job is not a failing test)", (nightly.match(/if: \$\{\{ !cancelled\(\)/g) ?? []).length === 2 && !/^ {4}if: always\(\)/m.test(nightly));
  check("every test says why it repeats", all.every((t) => t.why && t.why.length > 10));
  // The failing-line reader, on the shapes this repo's tests print, and a GitHub log line.
  const sample = [
    "  ok   a passing check",
    "2026-10-10T06:49:11.6099454Z   FAIL VAPID keys are read only when all three are present and well-formed",
    "  ✗ the browser's own key decrypts it",
    "  FAILED: a label",
    "not ok 3 - a tap line",
    "12 passed, 0 failed",
    "FAIL 0 checks",
    "  \x1b[31mFAIL\x1b[0m coloured",
  ].join("\n");
  const lines = failLines(sample);
  check(
    "failLines reads FAIL, ✗, FAILED: and not ok lines (timestamps and colour off), never the summary",
    JSON.stringify(lines) === JSON.stringify(["FAIL VAPID keys are read only when all three are present and well-formed", "✗ the browser's own key decrypts it", "FAILED: a label", "not ok 3 - a tap line", "FAIL coloured"]),
    lines,
  );
  // The runner: exit code, output kept, a signal.
  const pass = await runOne(process.execPath, ["-e", "console.log('  ok   fine')"], process.env, { quiet: true });
  const fail = await runOne(process.execPath, ["-e", "console.log('  FAIL broke'); process.exit(3)"], process.env, { quiet: true });
  const killed = await runOne(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], process.env, { quiet: true });
  check("a passing command is exit 0 with its output kept", pass.code === 0 && pass.output.includes("fine"), pass);
  check("a failing command keeps its exit code and its FAIL line", fail.code === 3 && JSON.stringify(failLines(fail.output)) === '["FAIL broke"]', fail);
  check("a killed command is a failure that names the signal", killed.code !== 0 && killed.signal === "SIGTERM", killed);
  check("app_rw's address is ADMIN_URL's database as app_rw (the address ci.yml writes out)", appRwUrl("postgres://postgres:postgres@127.0.0.1:5432/workspace_test") === "postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test");
  check("a shard is part of the test's name", testName({ run: "test:x", env: { EVE_DETACH_SHARD: "1/2" } }) === "test:x (shard 1/2)" && testName({ run: "test:x" }) === "test:x");
  console.log(`\nnightly-repeat self-test: ${bad ? `${bad} failed` : "all cases pass"}`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) await selfTest();
  else if (process.argv.includes("--list")) console.log(JSON.stringify(Object.keys(GROUPS)));
  else await main();
}
