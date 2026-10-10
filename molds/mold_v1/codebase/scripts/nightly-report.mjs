#!/usr/bin/env node
/**
 * THE NIGHTLY REPORT (.github/workflows/nightly.yml, the `report` job). Reads what the night's run did — the full CI
 * (`ci / …` jobs), its second pass when the first failed (`retry / …`), and the repeats (`repeat <group> #<n>`, whose
 * per-test results scripts/nightly-repeat.mjs wrote) — and writes:
 *
 *   <out>/report.json        { failing, title, body, comment }: what the workflow's `gh issue` step files. `body` is
 *                            the issue's text (this night and the trend), `comment` this night alone.
 *   <out>/nightly-history.json   the last HISTORY_KEEP nights (the previous night's artifact plus this one).
 *   <out>/flaky-rates.md     per test and per CI job, how often it failed over the kept nights.
 *
 * and the same to the run's summary page. For every failing job: the failing step, the failing check lines from its
 * log, a link to the log, and whether it failed again: on the retry pass (a CI job) or in how many of the repeats (a
 * repeated test). It writes nothing to GitHub; the token needs `actions: read` only.
 *
 *   node scripts/nightly-report.mjs --results nightly-results --out nightly-out   (in the workflow; GITHUB_* env)
 *   node scripts/nightly-report.mjs --self-test                                    (offline, fixtures)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failLines } from "./nightly-repeat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HISTORY_KEEP = 120;
export const TREND_NIGHTS = 30;
export const LABEL = "nightly-failure";

/** Which pass a job of the run belongs to, by its name as GitHub shows it. */
export function classify(name) {
  let m = /^ci \/ (.+)$/.exec(name);
  if (m) return { pass: "ci", job: m[1] };
  m = /^retry \/ (.+)$/.exec(name);
  if (m) return { pass: "retry", job: m[1] };
  m = /^repeat (\S+) #(\d+)$/.exec(name);
  if (m) return { pass: "repeat", group: m[1], attempt: Number(m[2]) };
  return { pass: "other" };
}

/** ci.yml's step names (a `${{ … }}` in one matches anything) to the npm scripts the step runs. */
export function stepScripts(ciYaml) {
  const out = [];
  const lines = ciYaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {6}- name: (.+)$/.exec(lines[i]);
    if (!m) continue;
    let body = "";
    for (let j = i + 1; j < lines.length && !/^ {6}- /.test(lines[j]) && !/^ {2}\S/.test(lines[j]); j++) body += `${lines[j]}\n`;
    const scripts = [...body.matchAll(/npm run ([\w:.-]+)/g)].map((x) => x[1]);
    const pattern = new RegExp(`^${m[1].trim().split(/\$\{\{[^}]*\}\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    out.push({ pattern, scripts });
  }
  return (stepName) => [...new Set(out.filter((s) => s.pattern.test(stepName)).flatMap((s) => s.scripts))];
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (s) => (s ? `\`${String(s).replace(/`/g, "'")}\`` : "");

/**
 * Everything the report says, from plain data (no network): `jobs` as the API lists them (name, conclusion,
 * html_url, steps), `logs` failing check lines per job id, `repeats` the result files, `history` earlier nights.
 */
export function buildReport({ run, jobs, logs, repeats, history, ciYaml }) {
  const scriptsOf = stepScripts(ciYaml);
  const ciJobs = jobs.filter((j) => classify(j.name).pass === "ci");
  const retryJobs = new Map(jobs.filter((j) => classify(j.name).pass === "retry").map((j) => [classify(j.name).job, j]));
  const repeatJobs = new Map(jobs.filter((j) => classify(j.name).pass === "repeat").map((j) => [`${classify(j.name).group}#${classify(j.name).attempt}`, j]));
  const failedSteps = (j) => (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name);

  // Repeated tests: runs, failures, which attempts, seeds, first failing lines.
  const tests = {};
  for (const file of repeats) {
    for (const r of file.results) {
      const t = (tests[r.test] ??= { runs: 0, failures: 0, failed: [], group: file.group });
      t.runs++;
      if (!r.ok) {
        t.failures++;
        t.failed.push({ attempt: file.attempt, seed: r.seed, replay: r.replay, lines: r.failLines, url: repeatJobs.get(`${file.group}#${file.attempt}`)?.html_url });
      }
    }
  }

  // Failing jobs: every CI job that failed, and every other job that failed outside its tests (setup, a lost runner).
  const rows = [];
  for (const j of ciJobs.filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out")) {
    const name = classify(j.name).job;
    const steps = failedSteps(j);
    const retry = retryJobs.get(name);
    const onRetry = !retry ? "not retried" : retry.conclusion === "failure" || retry.conclusion === "timed_out" ? `**reproduced on retry** ([log](${retry.html_url}))` : retry.conclusion === "success" ? "passed on retry: intermittent" : `retry ${retry.conclusion ?? "did not finish"}`;
    const repeated = steps.flatMap(scriptsOf).flatMap((s) => Object.entries(tests).filter(([n]) => n === s || n.startsWith(`${s} `)));
    const alsoRepeats = repeated.map(([n, t]) => `${n}: failed ${t.failures} of ${t.runs} repeats`).join("; ");
    rows.push({ job: `ci / ${name}`, steps, lines: logs[j.id] ?? [], url: j.html_url, onRetry: alsoRepeats ? `${onRetry}; ${alsoRepeats}` : onRetry });
  }
  for (const j of jobs.filter((j) => classify(j.name).pass === "repeat" && (j.conclusion === "failure" || j.conclusion === "timed_out" || j.conclusion === "cancelled"))) {
    const steps = failedSteps(j).filter((s) => !/^Repeat/.test(s));
    const c = classify(j.name);
    const hasResults = repeats.some((f) => f.group === c.group && f.attempt === c.attempt);
    if (steps.length || !hasResults) rows.push({ job: j.name, steps: steps.length ? steps : [`(${j.conclusion}; no test results)`], lines: logs[j.id] ?? [], url: j.html_url, onRetry: "see the other attempts" });
  }
  for (const j of jobs.filter((j) => classify(j.name).pass === "other" && j.name !== "report" && (j.conclusion === "failure" || j.conclusion === "timed_out"))) {
    rows.push({ job: j.name, steps: failedSteps(j), lines: logs[j.id] ?? [], url: j.html_url, onRetry: "not retried" });
  }

  const flaky = Object.entries(tests).filter(([, t]) => t.failures > 0).sort((a, b) => b[1].failures - a[1].failures);
  const failing = rows.length > 0 || flaky.length > 0;
  const date = run.date.slice(0, 10);

  const entry = {
    run_id: run.id,
    url: run.url,
    date: run.date,
    sha: run.sha,
    branch: run.branch,
    event: run.event,
    ok: !failing,
    ci: Object.fromEntries(ciJobs.map((j) => [classify(j.name).job, j.conclusion])),
    retry: Object.fromEntries([...retryJobs].map(([n, j]) => [n, j.conclusion])),
    tests: Object.fromEntries(Object.entries(tests).map(([n, t]) => [n, { runs: t.runs, failures: t.failures }])),
  };
  const kept = [...(history ?? []).filter((h) => h.run_id !== run.id), entry].slice(-HISTORY_KEEP);
  const rates = flakyRates(kept);

  // This night, as a comment.
  const night = [];
  night.push(`### ${failing ? "Nightly failed" : "Nightly passed"}: ${date}, \`${run.branch}\` at \`${run.sha.slice(0, 7)}\` ([run](${run.url}))`);
  if (rows.length) {
    night.push("", "**Failing jobs**", "", "| Job | Failing step | Failing checks (from the log) | Log | Failed again? |", "|---|---|---|---|---|");
    for (const r of rows) {
      night.push(`| ${cell(r.job)} | ${cell(r.steps.join("; ") || "(no step marked failed)")} | ${cell(r.lines.slice(0, 4).map(code).join("<br>") || "(none matched; see the log)")} | [log](${r.url}) | ${cell(r.onRetry)} |`);
    }
  }
  if (flaky.length) {
    night.push("", `**Repeated tests that failed** (each attempt on its own runner)`, "", "| Test | Failed | Attempts that failed | First failing check | Replay |", "|---|---|---|---|---|");
    for (const [n, t] of flaky) {
      const verdict = t.failures === t.runs ? `${t.failures} of ${t.runs}: reproduced every time` : `${t.failures} of ${t.runs}: intermittent`;
      const attempts = t.failed.map((f) => (f.url ? `[#${f.attempt}](${f.url})` : `#${f.attempt}`)).join(", ");
      const first = t.failed.find((f) => f.lines?.length)?.lines[0];
      night.push(`| ${code(n)} | ${verdict} | ${attempts} | ${cell(code(first) || "(see the log)")} | ${code(t.failed[0]?.replay)} |`);
    }
  }
  if (failing) {
    const retried = rows.filter((r) => r.job.startsWith("ci / "));
    const reproduced = retried.filter((r) => r.onRetry.includes("reproduced on retry")).length;
    const summary = [];
    if (retried.length) summary.push(`${reproduced} of ${retried.length} failing CI job(s) failed again on the retry pass${reproduced < retried.length ? " (the rest passed: intermittent)" : ""}`);
    if (flaky.length) summary.push(`${flaky.filter(([, t]) => t.failures < t.runs).length} of ${flaky.length} repeated test(s) failed only some of the time`);
    if (summary.length) night.push("", `Reproduced? ${summary.join("; ")}.`);
  }
  const passedRepeats = Object.values(tests).reduce((a, t) => a + t.runs - t.failures, 0);
  night.push("", `Repeats this night: ${Object.keys(tests).length} tests, ${Object.values(tests).reduce((a, t) => a + t.runs, 0)} runs, ${passedRepeats} passed.`);

  const trend = trendMarkdown(rates, kept.length);
  const title = run.branch === "main" ? "Nightly CI is failing" : `Nightly CI is failing on ${run.branch}`;
  const body = [
    ...night,
    "",
    trend,
    "",
    `<sub>Filed by .github/workflows/nightly.yml (scripts/nightly-report.mjs). Each failing night updates this text and adds a comment; a passing night adds a comment. Close it when the cause is fixed.</sub>`,
  ].join("\n");
  return { failing, title, body, comment: night.join("\n"), history: kept, rates, ratesMarkdown: trend, rows, tests };
}

/** Per test and per CI job over the last TREND_NIGHTS nights of the history. */
export function flakyRates(history) {
  const recent = history.slice(-TREND_NIGHTS);
  const tests = {};
  const jobs = {};
  for (const h of recent) {
    for (const [n, t] of Object.entries(h.tests ?? {})) {
      const x = (tests[n] ??= { runs: 0, failures: 0, nights: 0, lastFailure: null });
      x.runs += t.runs;
      x.failures += t.failures;
      x.nights++;
      if (t.failures) x.lastFailure = { date: h.date, url: h.url };
    }
    for (const [n, c] of Object.entries(h.ci ?? {})) {
      const x = (jobs[n] ??= { nights: 0, failed: 0, intermittent: 0, lastFailure: null });
      x.nights++;
      if (c === "failure" || c === "timed_out") {
        x.failed++;
        if (h.retry?.[n] === "success") x.intermittent++;
        x.lastFailure = { date: h.date, url: h.url };
      }
    }
  }
  return { nights: recent.length, tests, jobs };
}

export function trendMarkdown(rates, kept) {
  const out = [`**Trend, last ${rates.nights} night(s)** (history artifact \`nightly-history\`, ${kept} kept)`, ""];
  const t = Object.entries(rates.tests).sort((a, b) => b[1].failures / b[1].runs - a[1].failures / a[1].runs || a[0].localeCompare(b[0]));
  out.push("| Repeated test | Runs | Failures | Rate | Last failure |", "|---|---|---|---|---|");
  for (const [n, x] of t) out.push(`| ${code(n)} | ${x.runs} | ${x.failures} | ${x.runs ? ((100 * x.failures) / x.runs).toFixed(1) : "0.0"}% | ${x.lastFailure ? `[${x.lastFailure.date.slice(0, 10)}](${x.lastFailure.url})` : "none"} |`);
  const j = Object.entries(rates.jobs).filter(([, x]) => x.failed);
  if (j.length) {
    out.push("", "| CI job | Nights | Failed | Of which passed on retry | Last failure |", "|---|---|---|---|---|");
    for (const [n, x] of j.sort((a, b) => b[1].failed - a[1].failed)) out.push(`| ${cell(n)} | ${x.nights} | ${x.failed} | ${x.intermittent} | [${x.lastFailure.date.slice(0, 10)}](${x.lastFailure.url}) |`);
  } else out.push("", "No CI job failed in these nights.");
  return out.join("\n");
}

// --- the network edges (the workflow only) ---

async function api(path, { raw = false } = {}) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function listJobs(repo, runId) {
  const jobs = [];
  for (let page = 1; page < 20; page++) {
    const r = await api(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...r.jobs);
    if (jobs.length >= r.total_count || r.jobs.length === 0) break;
  }
  return jobs;
}

/** The newest earlier `nightly-history` artifact of the same branch (a branch's trial runs never mix into main's). */
export function priorArtifact(artifacts, runId, branch) {
  return artifacts.find((a) => !a.expired && String(a.workflow_run?.id) !== String(runId) && a.workflow_run?.head_branch === branch);
}

async function previousHistory(repo, runId, branch) {
  try {
    const r = await api(`/repos/${repo}/actions/artifacts?name=nightly-history&per_page=100`);
    const prior = priorArtifact(r.artifacts, runId, branch);
    if (!prior) return [];
    const zip = await api(prior.archive_download_url, { raw: true });
    const dir = mkdtempSync(join(tmpdir(), "nightly-history-"));
    writeFileSync(join(dir, "h.zip"), zip);
    const text = execFileSync("unzip", ["-p", join(dir, "h.zip"), "nightly-history.json"], { encoding: "utf8" });
    const parsed = JSON.parse(text);
    console.log(`history: ${parsed.length} earlier night(s) from run ${prior.workflow_run?.id}`);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.log(`::warning::no earlier nightly history (${String(e?.message ?? e)}); starting a new one`);
    return [];
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !runId || !process.env.GITHUB_TOKEN) {
    console.error("nightly-report: runs in the workflow (GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN); --self-test runs offline");
    process.exit(2);
  }
  const resultsDir = resolve(ROOT, arg("--results") ?? "nightly-results");
  const outDir = resolve(ROOT, arg("--out") ?? "nightly-out");
  const repeats = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8"))) : [];
  const jobs = await listJobs(repo, runId);
  const logs = {};
  for (const j of jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out")) {
    try {
      logs[j.id] = failLines(await api(`/repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true }).then((b) => b.toString("utf8")));
    } catch (e) {
      logs[j.id] = [`(log not readable: ${String(e?.message ?? e).slice(0, 120)})`];
    }
  }
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const run = {
    id: Number(runId),
    url: `${server}/${repo}/actions/runs/${runId}`,
    date: new Date().toISOString(),
    sha: process.env.GITHUB_SHA ?? "",
    branch: process.env.GITHUB_REF_NAME ?? "",
    event: process.env.GITHUB_EVENT_NAME ?? "",
  };
  const report = buildReport({ run, jobs, logs, repeats, history: await previousHistory(repo, runId, run.branch), ciYaml: readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8") });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify({ failing: report.failing, title: report.title, body: report.body, comment: report.comment, label: LABEL }, null, 2)}\n`);
  writeFileSync(join(outDir, "nightly-history.json"), `${JSON.stringify(report.history, null, 1)}\n`);
  writeFileSync(join(outDir, "flaky-rates.md"), `${report.ratesMarkdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.comment}\n\n${report.ratesMarkdown}\n`);
  console.log(report.comment);
  console.log(`\nnightly-report: ${report.failing ? "FAILING" : "passing"}; ${report.rows.length} failing job(s), ${Object.values(report.tests).filter((t) => t.failures).length} repeated test(s) with a failure; history ${report.history.length} night(s)`);
}

function selfTest() {
  let bad = 0;
  const check = (label, ok, detail) => {
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  };
  const ciYaml = [
    "jobs:",
    "  behaviour:",
    "    steps:",
    "      - name: Web Push (encryption, VAPID, payload, 410 cleanup)",
    "        run: npm run test:web-push",
    "  eve-runtime:",
    "    steps:",
    "      - name: Specialists report one at a time (eve patch, real eve runtime), shard ${{ matrix.shard }} of 2",
    "        if: always()",
    "        run: EVE_DETACH_SHARD=${{ matrix.shard }}/2 npm run test:specialist-detach",
    "  isolation:",
    "    steps:",
    "      - name: Chat queue",
    "        run: |",
    "          DATABASE_URL=x \\",
    "          npm run test:chat-queue-db",
  ].join("\n");
  const scriptsOf = stepScripts(ciYaml);
  check("a step name maps to the npm script it runs", JSON.stringify(scriptsOf("Web Push (encryption, VAPID, payload, 410 cleanup)")) === '["test:web-push"]');
  check("…with a matrix expression in the name", JSON.stringify(scriptsOf("Specialists report one at a time (eve patch, real eve runtime), shard 2 of 2")) === '["test:specialist-detach"]');
  check("…and a multi-line run", JSON.stringify(scriptsOf("Chat queue")) === '["test:chat-queue-db"]');
  check("jobs are told apart by pass", classify("ci / eve-runtime 1/2").job === "eve-runtime 1/2" && classify("retry / verify").pass === "retry" && classify("repeat db-races #3").attempt === 3 && classify("report").pass === "other");

  const url = (id) => `https://example.test/job/${id}`;
  const job = (id, name, conclusion, failedStep) => ({ id, name, conclusion, html_url: url(id), steps: [{ name: "Install", conclusion: "success" }, ...(failedStep ? [{ name: failedStep, conclusion: "failure" }] : [])] });
  const run = { id: 9, url: "https://example.test/run/9", date: "2026-10-11T02:00:00.000Z", sha: "abcdef1234567", branch: "main", event: "schedule" };
  const repeatsAllPass = [1, 2, 3].map((a) => ({ group: "random-timers", attempt: a, results: [{ test: "test:web-push", ok: true, seed: "1" }, { test: "test:own-listener", ok: true, seed: "2" }] }));
  const green = buildReport({ run, jobs: [job(1, "ci / behaviour", "success"), job(2, "repeat random-timers #1", "success"), job(3, "report", null)], logs: {}, repeats: repeatsAllPass, history: [], ciYaml });
  check("a green night is not failing and has no failing rows", !green.failing && green.rows.length === 0, green.rows);
  check("…and is recorded: 6 runs, 0 failures", green.history.length === 1 && green.history[0].ok && green.history[0].tests["test:web-push"].runs === 3);

  // A night with: one CI job that failed and passed on retry, one that failed twice, and a repeat failing 2 of 3.
  const repeats = [1, 2, 3].map((a) => ({
    group: "random-timers",
    attempt: a,
    results: [
      { test: "test:web-push", ok: a === 2, seed: `s${a}`, replay: `TEST_SEED=s${a} npm run test:web-push`, failLines: a === 2 ? [] : ["FAIL VAPID keys are read only when all three are present"] },
      { test: "test:own-listener", ok: true, seed: "x" },
    ],
  }));
  const jobs = [
    job(10, "ci / behaviour", "failure", "Web Push (encryption, VAPID, payload, 410 cleanup)"),
    job(11, "ci / eve-runtime 2/2", "failure", "Specialists report one at a time (eve patch, real eve runtime), shard 2 of 2"),
    job(12, "ci / verify", "success"),
    job(20, "retry / behaviour", "success"),
    job(21, "retry / eve-runtime 2/2", "failure", "Specialists report one at a time (eve patch, real eve runtime), shard 2 of 2"),
    job(30, "repeat random-timers #1", "failure", "Repeat"),
    job(31, "repeat random-timers #2", "success"),
    job(32, "repeat random-timers #3", "failure", "Repeat"),
    job(33, "repeat db-races #1", "failure", "Database (schema and the tenancy model)"),
    job(40, "report", null),
  ];
  const logs = { 10: ["FAIL VAPID keys are read only when all three are present"], 11: ["FAIL a late result is delivered once"] };
  const r = buildReport({ run, jobs, logs, repeats, history: green.history.map((h) => ({ ...h, run_id: 8 })), ciYaml });
  const behaviour = r.rows.find((x) => x.job === "ci / behaviour");
  const eve = r.rows.find((x) => x.job === "ci / eve-runtime 2/2");
  check("a failing night is failing", r.failing);
  check("a CI job that passed on the retry pass reads as intermittent", behaviour?.onRetry.startsWith("passed on retry: intermittent"), behaviour);
  check("…and names how its test did in the repeats", behaviour?.onRetry.includes("test:web-push: failed 2 of 3 repeats"), behaviour);
  check("a CI job that failed again reads as reproduced, with the retry's log", eve?.onRetry.includes("reproduced on retry") && eve.onRetry.includes(url(21)), eve);
  check("the failing step and its failing check lines are in the row", eve?.steps[0].startsWith("Specialists report one at a time") && eve.lines[0] === "FAIL a late result is delivered once");
  check("a repeat job that failed outside its tests (setup) is a row of its own", r.rows.some((x) => x.job === "repeat db-races #1" && x.steps[0].startsWith("Database")), r.rows.map((x) => x.job));
  check("a repeat job whose tests failed is not a row (the repeats table has it)", !r.rows.some((x) => x.job === "repeat random-timers #1"));
  check("the passing jobs and the report itself are not rows", !r.rows.some((x) => /verify|^report$/.test(x.job)));
  check("the body has the failing job, its log link, the test, its count and a replay", r.body.includes("ci / behaviour") && r.body.includes(url(10)) && r.body.includes("`test:web-push` | 2 of 3: intermittent") && r.body.includes("[#1](https://example.test/job/30)") && r.body.includes("TEST_SEED=s1 npm run test:web-push"), r.body);
  check("the body says what reproduced", r.body.includes("Reproduced? 1 of 2 failing CI job(s) failed again on the retry pass (the rest passed: intermittent); 1 of 1 repeated test(s) failed only some of the time."), r.body);
  check("the issue title is stable on main and names another branch", r.title === "Nightly CI is failing" && buildReport({ run: { ...run, branch: "x" }, jobs, logs, repeats, history: [], ciYaml }).title === "Nightly CI is failing on x");
  check("the history keeps the earlier night and adds this one", r.history.length === 2 && r.history[1].run_id === 9 && !r.history[1].ok && r.history[1].retry.behaviour === "success");
  check("the trend counts across nights: web-push 2 failures in 6 runs", r.rates.tests["test:web-push"].runs === 6 && r.rates.tests["test:web-push"].failures === 2 && r.ratesMarkdown.includes("| `test:web-push` | 6 | 2 | 33.3% |"), r.rates.tests);
  check("…and per CI job, with how many passed on retry", r.rates.jobs.behaviour.failed === 1 && r.rates.jobs.behaviour.intermittent === 1 && r.rates.jobs["eve-runtime 2/2"].intermittent === 0);
  const long = Array.from({ length: HISTORY_KEEP + 5 }, (_, i) => ({ run_id: i, date: "2026-01-01T00:00:00Z", url: "u", tests: {}, ci: {} }));
  check(`the history is capped at ${HISTORY_KEEP} nights, oldest dropped`, buildReport({ run, jobs: [], logs: {}, repeats: [], history: long, ciYaml }).history.length === HISTORY_KEEP);
  const arts = [
    { expired: false, workflow_run: { id: 9, head_branch: "main" } },
    { expired: false, workflow_run: { id: 7, head_branch: "trial" } },
    { expired: true, workflow_run: { id: 6, head_branch: "main" } },
    { expired: false, workflow_run: { id: 5, head_branch: "main" } },
  ];
  check("the earlier history is the newest unexpired one of the same branch, never this run's", priorArtifact(arts, 9, "main")?.workflow_run.id === 5 && priorArtifact(arts, 9, "trial")?.workflow_run.id === 7 && priorArtifact(arts, 9, "other") === undefined);
  check("a table cell cannot break the table", cell("a|b\nc") === "a\\|b c");
  console.log(`\nnightly-report self-test: ${bad ? `${bad} failed` : "all cases pass"}`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else await main();
}
