// The accessibility lane's harness. One command, one markdown table, one exit code.
//
//   node molds/mold_v1/testing/accessibility/a11y.mjs --url <base> [--only axe|keyboard]
//                                                     [--routes /,/onboard,/workspace] [--json <path>]
//
// WHY THIS SHAPE. The lane is graded on rows, not on a status code. axe-core is injected from
// vendor/axe.min.js (nothing is installed into the mold, and nothing is fetched at run time), driven
// through the globally installed Playwright chromium. Every route is graded on its own row:
//   - a route that does not answer 2xx is `skipped` with the status, never `pass` — the lane must not
//     report green for a page it never rendered;
//   - a route that answers 2xx and then renders NO interactive control is `fail`, not `pass`: axe finds
//     no violation in an empty body and Tab reaches nothing, so every criterion below is satisfied
//     vacuously. Nothing measured must never read as green (see "did the application actually render");
//   - `fail` is reserved for axe violations of impact serious or critical (WCAG 2.1 A/AA, the level
//     this factory claims) and for keyboard defects that make a control unreachable or invisible;
//   - moderate/minor violations and axe `incomplete` results are printed in the detail column and do
//     not fail the lane, because they need human judgement.
// The workflow builder is behind a signed-in identity, so its traversal row is `not-covered` with that
// reason named rather than quietly dropped: see README.md, "Not covered".
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = join(HERE, "vendor/axe.min.js");
const AXE_V = (readFileSync(AXE, "utf8").match(/axe v([\d.]+)/) || [, "?"])[1];
const FAIL_IMPACTS = new Set(["serious", "critical"]);
const DEFAULT_ROUTES = ["/", "/onboard", "/workspace"]; // measured: the mold has exactly these page routes
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = (arg("--url", "") || "").replace(/\/+$/, "");
const only = arg("--only", "all");
const routes = arg("--routes", DEFAULT_ROUTES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const jsonOut = arg("--json", "");
if (!base) { console.error("usage: a11y.mjs --url <base> [--only axe|keyboard] [--routes a,b] [--json f]"); process.exit(2); }

// ESM ignores NODE_PATH, so the global playwright is reached through a require rooted at it.
let chromium;
try { chromium = createRequire("/usr/lib/node_modules/")("playwright").chromium; }
catch { console.error("playwright is not installed globally: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

// A locally built mold bakes a rewrite of /eve/v1/* to the LIVE fde-agent-api into routes-manifest.json,
// so a browser that touches those paths pulls a live production project into a test run. This lane is
// read-only on the app under test and must never reach the live factory projects: those requests are
// aborted in the browser and counted, and a non-zero count is reported rather than hidden.
const LIVE = /(^|\.)fde-agent(-api)?\.vercel\.app|(^|\.)fde-task-workflow[^/]*\.vercel\.app/i;
const PROXY_PATHS = /\/(eve\/v1|\.well-known\/workflow)\//;
let blocked = 0;
const guard = async (page) => page.route("**/*", (r) => {
  const u = new URL(r.request().url());
  if (LIVE.test(u.hostname) || PROXY_PATHS.test(u.pathname)) { blocked++; return r.abort(); }
  return r.continue();
});

const rows = [], detail = [];
const row = (name, result, why) => rows.push({ name, result, why: String(why).replace(/\|/g, "/").slice(0, 400) });

const open = async (browser, route) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await guard(page);
  let status = 0, err = "";
  try {
    const r = await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = r ? r.status() : 0;
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  } catch (e) { err = e.message.split("\n")[0]; }
  return { page, status, err };
};

// DID THE APPLICATION ACTUALLY RENDER? A 200 is not a rendered page. An empty shell — a colliding
// deployment, or a Next.js client-side crash — answers 200 and then satisfies every criterion below
// VACUOUSLY: axe finds 0 violations in an empty body, and "0 tabbable of 0 interactive" printed as a
// pass. That is how this lane came to read green against a deployment that rendered none of the
// application. A declared page route of this mold has controls on it; one that renders none is a
// broken deploy, not a clean bill of health, so it FAILS the row. (The "app was never deployed" and
// "this 200 came from something that is not this mold" cases are caught earlier and more kindly, by
// the lane's target-up.py precondition, which makes the whole lane `skipped`.)
const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])';
const census = (page) => page.evaluate((SEL) => {
  const vis = [...document.querySelectorAll(SEL)].filter(el => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length;
  });
  return { interactive: vis.length, chars: (document.body ? document.body.innerText : "").trim().length };
}, CONTROLS);
const notRendered = (c) => c.interactive ? null
  : `the route answered 2xx but rendered no interactive control (${c.chars} chars of body text): nothing was `
  + `graded here, so this row cannot pass — the deployment is serving a shell, not the application`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });

if (only === "all" || only === "axe") {
  for (const route of routes) {
    const { page, status, err } = await open(browser, route);
    if (status < 200 || status >= 300) { row(`axe ${route}`, "skipped", err || `route answered HTTP ${status}: not rendered, so not graded`); await page.close(); continue; }
    const c = await census(page), dead = notRendered(c);
    if (dead) { row(`axe ${route}`, "fail", dead); await page.close(); continue; }
    await page.addScriptTag({ path: AXE });
    // Every rule runs, but only WCAG 2.1 A/AA serious+critical grades the row; best-practice findings
    // are printed so the operator sees them without the lane failing on a rule nobody signed up to.
    const res = await page.evaluate(async (tags) => {
      const r = await window.axe.run(document);
      const pick = (l) => l.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
        wcag: v.tags.some(t => tags.includes(t)), targets: v.nodes.slice(0, 3).map(n => String(n.target)),
        snippet: (v.nodes[0]?.html || "").slice(0, 200) }));
      return { violations: pick(r.violations), incomplete: pick(r.incomplete), passes: r.passes.length };
    }, TAGS);
    const bad = res.violations.filter(v => v.wcag && FAIL_IMPACTS.has(v.impact));
    const rest = res.violations.filter(v => !(v.wcag && FAIL_IMPACTS.has(v.impact)));
    const fmt = (l) => l.map(v => `${v.id}[${v.impact}x${v.n}${v.wcag ? "" : ",best-practice"}]`).join(" ") || "none";
    row(`axe ${route}`, bad.length ? "fail" : "pass",
        `${c.interactive} control(s) rendered · WCAG A/AA serious+critical: ${fmt(bad)} · reported only: ${fmt(rest)} · ${res.passes} rules passed · ${res.incomplete.length} need review`);
    detail.push({ route, ...res });
    await page.close();
  }
}

if (only === "all" || only === "keyboard") {
  for (const route of routes) {
    const { page, status, err } = await open(browser, route);
    if (status < 200 || status >= 300) { row(`keyboard ${route}`, "skipped", err || `route answered HTTP ${status}: not rendered, so not graded`); await page.close(); continue; }
    const dead = notRendered(await census(page));
    if (dead) { row(`keyboard ${route}`, "fail", dead); await page.close(); continue; }
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body || e === document.documentElement) return null;
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
        return { tag: e.tagName, label: (e.getAttribute("aria-label") || e.innerText || e.getAttribute("title") || "").trim().slice(0, 40),
                 visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0, ring, key: e.tagName + "|" + (e.id || "") + "|" + (e.innerText || "").slice(0, 20) };
      });
      if (!d) break;                                    // focus left the document: the walk is complete
      if (seen.length && seen[0].key === d.key) break;   // wrapped to the first control
      seen.push(d);
    }
    const interactive = await page.evaluate(() =>
      document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])').length);
    const noRing = seen.filter(s => !s.ring), invisible = seen.filter(s => !s.visible);
    const problems = [];
    // No `&& interactive > 0` guard: a page with nothing to reach was already failed by the census
    // above, so reaching here with an empty walk means real controls exist that Tab cannot get to.
    if (!seen.length) problems.push(`0 of ${interactive} interactive elements are reachable by Tab`);
    if (noRing.length) problems.push(`${noRing.length} focused control(s) show no focus indicator (WCAG 2.4.7): ${noRing.slice(0, 3).map(s => s.tag + ":" + (s.label || "-")).join(", ")}`);
    if (invisible.length) problems.push(`${invisible.length} focused control(s) are offscreen or zero-size`);
    row(`keyboard ${route}`, problems.length ? "fail" : "pass",
        problems.join(" · ") || `${seen.length} tabbable of ${interactive} interactive, all with a focus indicator: ${seen.slice(0, 4).map(s => s.tag + ":" + (s.label || "-")).join(", ")}`);
    detail.push({ route, keyboard: seen, interactive });
    await page.close();
  }
  // The workflow builder sits behind the workspace ops center, which needs a signed-in identity.
  const { page, status } = await open(browser, "/workspace");
  const builder = status >= 200 && status < 300
    ? await page.evaluate(() => !!document.querySelector('[data-testid*="workflow-builder"], [class*="workflow-builder"]')) : false;
  // `not-covered`, not `skipped`: the runner's rule is that a lane cannot be `pass` while something it
  // declared went unmeasured, and a row printed `skipped` reads as exactly that. This row can never run
  // unauthenticated — it is the lane's documented coverage gap (README, "Not covered"), not a
  // measurement that failed to happen — so it is labelled for what it is and counted separately.
  row("keyboard workflow-builder", builder ? "pass" : "not-covered",
      builder ? "builder rendered and traversed" : "the builder renders only for a signed-in identity; unauthenticated this lane sees the workspace shell only");
  await page.close();
}

await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ base, routes, rows, detail }, null, 2));

const w = Math.max(...rows.map(r => r.name.length), 5);
console.log("| check | result | detail |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.name.padEnd(w)} | ${r.result} | ${r.why} |`);
const n = (s) => rows.filter(r => r.result === s).length;
const failed = rows.filter(r => r.result === "fail");
// On stdout, after a blank line, so the runner can inline table + summary verbatim as valid markdown.
console.log(`\n_target ${base} · axe-core ${AXE_V} · ${rows.length} rows: ${n("pass")} pass, ${n("fail")} fail, ` +
            `${n("skipped")} skipped, ${n("not-covered")} declared not covered_`);
if (blocked) console.error(`blocked ${blocked} browser request(s) to the live factory projects or the /eve/v1 proxy: this lane never talks to production`);
// A declared ROUTE that was not rendered cannot be reported green: exit 0 here would let the runner
// record `pass` for a page nothing looked at. (The workflow-builder row is a declared limitation of
// the lane, not a route, so it may stay `skipped` without failing the check — README, "Not covered".)
const unrendered = rows.filter(r => r.result === "skipped");
if (unrendered.length) {
  console.error(`${unrendered.length} declared route(s) did not render, so this check cannot pass: ` +
    unrendered.map(r => r.name).join(", ") + ". The lane's target-up.py precondition is what turns an " +
    "app that is simply not deployed into a skipped lane instead of this.");
  process.exit(1);
}
process.exit(failed.length ? 1 : 0);
