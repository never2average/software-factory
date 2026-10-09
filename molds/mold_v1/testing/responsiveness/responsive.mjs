// The responsiveness lane's rows. One command, a markdown table, one exit code.
//
//   node molds/mold_v1/testing/responsiveness/responsive.mjs --url <base> [--only layout|targets|interaction]
//
// WHY THIS EXISTS, AND WHY IT GRADES THE WAY IT DOES.
//
// "Responsive" is the easiest lane in the factory to fake. Load three pages at three widths, see no
// exception, print `pass`. That measures nothing: a layout can be unusable at 320px and still return
// HTTP 200 at every width. So every row here is a NUMBER compared against a written budget, and the
// budget is a published standard rather than a taste call — see README.md for the citations.
//
// The one judgement call worth stating up front is what counts as "clipped". On this mold /workspace
// renders an ops-centre tab strip that is 475px wide inside a 390px viewport: "Project workflows" and
// "Audit trail" sit past the right edge. A naive check calls that a mobile layout bug. It is not — the
// strip is `overflow-x: auto`, and scrolling it brings "Audit trail" from right=459 back to right=374,
// inside the viewport. That is a deliberate, correct responsive pattern. A control is only reported
// UNREACHABLE when the harness has actually tried to scroll it into view and it stayed outside. The
// check does the scroll and re-measures rather than guessing from CSS, because guessing from CSS is
// what would make this lane cry wolf on every horizontal tab strip in every future mold.
//
// HARD RULE 2 (read-only on the live projects) is enforced in the browser, not by good intentions:
// every request to a live project's host — and every same-origin path the mold rewrites INTO one, which is
// how /eve/v1/* reaches the live API project — is aborted and counted, and the count is in the footer as
// evidence. Interaction rows only ever click in-page controls whose accessible name is not an auth or
// destructive verb, and each click asserts the URL did not change.
//
// Exit 0 every row within budget · 1 a row is over budget (the table carries `| fail |`, which the
// runner also forbids) · 2 nothing was measured — bad usage, or no usable session (missing, malformed,
// expired, or refused by the deployment) · 3 the target stopped answering mid-run.
// A skipped row NEVER lifts the exit code: unmeasured must never read as pass.
import { createRequire } from "node:module";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire("/usr/lib/node_modules/")("playwright");

const BUDGET = {
  overflowPx: 1,      // WCAG 2.1 SC 1.4.10 Reflow. 0px of horizontal document scroll; 1px absorbs subpixel rounding.
  cls: 0.10,          // Core Web Vitals "good" boundary for Cumulative Layout Shift.
  tapMinPx: 24,       // WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA, with the inline+spacing exceptions.
  tapAdvisoryPx: 44,  // SC 2.5.5 Enhanced / platform HIG. Reported, never failed.
  inpMs: 200,         // Core Web Vitals "good" boundary for Interaction to Next Paint.
};
const VIEWPORTS = [
  { name: "reflow-320",   w: 320,  h: 800,  touch: true  },
  { name: "mobile-390",   w: 390,  h: 844,  touch: true  },
  { name: "tablet-820",   w: 820,  h: 1180, touch: true  },
  { name: "desktop-1440", w: 1440, h: 900,  touch: false },
];
const ROUTES = ["/", "/onboard", "/workspace"];   // the SIGNED-OUT app: sign-in page, sign-in page, shell
const TOUCH_VIEWPORTS = ["mobile-390", "tablet-820"];
// HARD RULE 2: the live factory projects are never touched, only counted. TWO tests, because a
// hostname test alone does not cover this mold. next.config.ts:33 rewrites the SAME-ORIGIN paths
// /eve/v1/* and /.well-known/workflow/* to EVE_API, which lib/agent-url.ts defaults to the LIVE
// API project whenever the env var is missing, and forwards the Authorization header. The browser
// only ever sees https://<app-under-test>/eve/v1/..., so the hostname never matches and Vercel proxies
// the test session straight into a production project. Signed out that path is unreachable (the chat
// shell never renders); signed in, `/` is the chat thread and chat-shell.tsx / agent-chat.tsx /
// cockpit.tsx all fetch /eve/v1/session/*. So the PATH is blocked too, at the same place.
// The live projects' names are this machine's own (state/factory.local.json -> live_projects, found by walking up
// from this file); a host whose first label starts with one of them is the live deployment. None named: none blocked
// by name (the proxy paths below are blocked either way).
const LIVE = (() => {
  let names = [];
  for (let d = HERE_DIR; d !== dirname(d); d = dirname(d)) {
    try { names = Object.values(JSON.parse(readFileSync(join(d, "state", "factory.local.json"), "utf8")).live_projects || {}); break; } catch { /* not here */ }
  }
  names = names.filter((n) => typeof n === "string" && n);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return names.length ? new RegExp(`(^|\\.)(${names.map(esc).join("|")})[^.]*\\.`, "i") : /(?!)/;
})();
const PROXY_PATHS = /\/(eve\/v1|\.well-known\/workflow)\//;

// ---- the product, behind a signed-in identity (--auth) -------------------------------------------
// Signed out, this lane measures a sign-in page (2 controls) and a workspace shell whose panels say
// "loading…" for ever because /api/ops/* answers 401 — and it printed `pass` for all of it. The layout
// of the thing customers actually use at 320px, the tap targets in the ops centre, the latency of the
// workflow builder: all UNMEASURED behind a green lane (mold_v1-040).
//
// `--auth` measures those. The session is the app's OWN kind: the ES256 "email-session" token
// lib/auth-session.ts defines and lib/ops-auth.ts admits on its signature alone (the emailed code gates
// the mint route, not the token). The factory holds a provisioned app's AUTH_JWT_PRIVATE_KEY by name,
// so .claude/scripts/lib/session.py signs one for the app's own operator (application.workspace.operator_self.email)
// and hands it over BY NAME in an environment variable — lane.json runs each --auth check through it,
// and a session an operator signed in for and lent wins over a minted one. It is stored under the same
// localStorage key the app's own sign-in writes. Nothing HERE mints, forges or weakens anything:
//   - no variable, no run: this file reads one variable and never sees a key; the precondition in
//     lane.json makes a missing or unusable session a `skipped` lane, never `pass`;
//   - a token the SERVER refuses grades nothing: the deployment's own read-only GET /api/ops/orgs is
//     the verdict, not the client's opinion of its own localStorage. The row is `not-covered` and the
//     run exits 2 — never `pass`, and not `fail` either, because a refused credential says the
//     operator's paste went stale (a browser session lasts about an hour), not that the application
//     is broken, and a `fail` lane reverts the application. The ordinary version of that is caught
//     BEFORE a browser opens by session-live.py, the checks' precondition in lane.json, which makes
//     an unusable session a `skipped` check and a `skipped` lane;
//   - a surface that renders the signed-out shell anyway fails: each one names a control that appears
//     only with its own content, and the census is compared against the same url with no session.
// `?tab=` is the app's own deep link into a workspace tab (app/_components/ops/workspace-panel.tsx).
const AUTH_SURFACES = [
  { name: "/ chat",              path: "/",                        marker: /new chat|open sidebar/i, what: 'the chat thread\'s "New chat" control (or "Open sidebar" on a phone, where the sidebar starts closed and "New chat" lives inside it)' },
  { name: "/workspace people",   path: "/workspace?tab=people",    marker: /\binvite\b/i,   what: 'the People tab\'s "Invite" control' },
  { name: "/workspace audit",    path: "/workspace?tab=audit",     marker: /\bactor\b/i,    what: "the Audit trail's actor filter" },
  // `needs`: a service beyond the web app that this surface is a client of. lane-url.py passes
  // `--without <service>` for a target=vm fixture, which runs the web app alone (infra/vm/README.md), and
  // the surface is then declared `not-covered` with that reason rather than failed on a control the
  // service would have rendered. A deployment gets no such flag: there, an absent builder IS a defect.
  { name: "/workspace builder",  path: "/workspace?tab=workflows", marker: /new workflow/i, what: 'the workflow builder\'s "New workflow" control', needs: "task-workflow" },
];

// ---- INP: a median over several samples, with the machine's load beside each (mold_v1-083) ---------
// INP on this shared 4-vCPU VM swung 32-376ms on an UNCHANGED page. One sample is a coin toss, and even
// "fail only if every repeat is over" let a single fast sample decide a row. So an INP row takes at
// least INP_MIN samples, and at most INP_MAX, stopping as soon as the MEDIAN of INP_MAX is decided on
// one side of the budget (a majority of samples is already under it, or already over it). The verdict
// is the median of the samples taken; p75 and every sample are printed, each with the 1-minute load
// average it was taken at, so a slow VM is visible in the row rather than hidden in a pass or a fail.
// Overridable for a quiet box or a paranoid run: RESP_INP_MIN / RESP_INP_MAX.
const INP_MIN = Math.max(1, Number(process.env.RESP_INP_MIN) || 3);
const INP_MAX = Math.max(INP_MIN, Number(process.env.RESP_INP_MAX) || 5);
const CPUS = os.cpus().length || 1;
// Past this much wall time the run stops buying extra samples (max falls to min) so the added samples can
// never push a check into lanes.py's timeout_s, which is a FAIL. The median of INP_MIN is still graded.
const T0 = Date.now();
const SAMPLING_SOFT_MS = (Number(process.env.RESP_SAMPLING_SOFT_S) || 540) * 1000;
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
async function sampleTiming(sample, budget, { min = INP_MIN, max = INP_MAX, load = () => os.loadavg()[0],
                                              late = () => Date.now() - T0 > SAMPLING_SOFT_MS } = {}) {
  const runs = [], loads = [];
  let capped = false;
  if (late() && max > min) { max = min; capped = true; }
  const need = Math.floor(max / 2) + 1;   // samples on one side of the budget that fix the median of `max`
  let last;
  for (let i = 0; i < max; i++) {
    const l = load();
    last = await sample();
    if (last.err || last.dead || last.skip || last.gate) return { last, runs, loads };
    runs.push(last.value); loads.push(l);
    const under = runs.filter((v) => v <= budget).length, over = runs.length - under;
    if (runs.length >= min && (under >= need || over >= need)) break;
  }
  const median = quantile(runs, 0.5), p75 = quantile(runs, 0.75);
  return { last, runs, loads, median, p75, over: median > budget, capped };
}
/** One cell: the verdict statistic, the spread and every sample with its load, plus a noise note. */
function inpDetail(r, budget) {
  const ms = (v) => String(Math.round(v));
  const samples = r.runs.map((v, i) => `${ms(v)}@${r.loads[i].toFixed(1)}`).join(", ");
  const notes = [];
  const peak = Math.max(...r.loads);
  if (peak >= CPUS) notes.push(`load reached ${peak.toFixed(1)} on ${CPUS} CPUs while sampling, so these numbers include the VM's own contention`);
  const spread = Math.max(...r.runs) - Math.min(...r.runs);
  if (r.runs.length > 1 && spread > budget / 2) notes.push(`samples spread ${ms(spread)}ms: noisy, graded on the median, not the worst`);
  if (r.capped) notes.push(`the run was past its sampling time budget, so this row took ${r.runs.length} sample(s), not up to ${INP_MAX}`);
  return `INP median ${ms(r.median)}ms, p75 ${ms(r.p75)}ms over ${r.runs.length} sample(s) [${samples} (ms@load1)] (budget ${budget}ms, median graded)`
    + (notes.length ? ` · noise: ${notes.join("; ")}` : "");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  // Pure checks of the INP statistic: no browser, no network, no target.
  const seq = (vals) => { let i = 0; return async () => ({ value: vals[i++] }); };
  const calm = () => 0.5, busy = () => 6.2;
  const fails = [];
  const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
  let r = await sampleTiming(seq([32, 376, 40, 48, 999]), 200, { min: 3, max: 5, load: calm });
  eq("one slow sample buys a 4th and does not fail", [r.runs, r.median, r.over], [[32, 376, 40, 48], 44, false]);
  r = await sampleTiming(seq([376, 300, 250, 10, 10]), 200, { min: 3, max: 5, load: calm });
  eq("three slow samples fail without more", [r.runs.length, r.median, r.over], [3, 300, true]);
  r = await sampleTiming(seq([210, 50, 220, 60, 70]), 200, { min: 3, max: 5, load: calm });
  eq("an undecided row samples to the max", [r.runs.length, r.median, r.over], [5, 70, false]);
  r = await sampleTiming(seq([210, 250, 50, 230, 20]), 200, { min: 3, max: 5, load: calm });
  eq("a majority over fails even with fast samples", [r.runs.length, r.median, r.over], [4, 220, true]);
  r = await sampleTiming(seq([24, 32, 40]), 200, { min: 3, max: 5, load: calm });
  eq("a healthy row costs exactly INP_MIN samples", r.runs.length, 3);
  eq("p75 interpolates", r.p75, 36);
  r = await sampleTiming(async () => ({ err: "HTTP 502" }), 200, { load: calm });
  eq("a load error ends sampling and is reported", [r.last.err, r.runs.length], ["HTTP 502", 0]);
  r = await sampleTiming(seq([32, 376, 40]), 200, { min: 3, max: 3, load: busy });
  const d = inpDetail(r, 200);
  if (!/median 40ms/.test(d) || !/32@6\.2/.test(d) || !/noise: load reached 6\.2/.test(d) || !/spread 344ms/.test(d)) fails.push(`inpDetail: ${d}`);
  r = await sampleTiming(seq([30, 40, 50]), 200, { min: 3, max: 5, load: calm });
  if (/noise/.test(inpDetail(r, 200))) fails.push(`a calm, tight row printed a noise note: ${inpDetail(r, 200)}`);
  r = await sampleTiming(seq([210, 50, 220, 60, 70]), 200, { min: 3, max: 5, load: calm, late: () => true });
  eq("past the time budget a row stops at min", [r.runs.length, r.median, r.over, r.capped], [3, 210, true, true]);
  if (!/sampling time budget/.test(inpDetail(r, 200))) fails.push("a capped row does not say so");
  eq("quantile of one", [quantile([7], 0.5), quantile([7], 0.75)], [7, 7]);
  if (fails.length) { console.error("self-test FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("self-test ok: 12 INP sampling checks");
  process.exit(0);
}
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = (arg("--url", "") || "").replace(/\/+$/, "");
const ONLY = arg("--only", "all");
const AUTH = args.includes("--auth");
const SESSION_ENV = arg("--session-env", "MOLD_V1_SESSION_TOKEN");
// Services the target does not run (`--without task-workflow`, repeatable). Only lane-url.py emits it, and
// only for a vm fixture; a surface that `needs` one is printed `not-covered` — "declared off on this
// fixture", the one phrase lane.json's stdout_not lets through and its skip_on then records the whole
// check `skipped` (the lane cannot be `pass` with a surface unopened) — instead of failed, and never `pass`.
const WITHOUT = new Set(args.flatMap((x, i) => (x === "--without" && args[i + 1] ? [args[i + 1]] : [])));
const declaredOff = (su) => AUTH && su.needs && WITHOUT.has(su.needs)
  ? `declared off on this fixture: it does not run the ${su.needs} service, which ${su.what} needs (--without ${su.needs} from lane-url.py), so this surface was not opened and nothing here measures it`
  : null;
if (!BASE) { console.error("usage: responsive.mjs --url <base> [--only layout|targets|interaction] [--auth] [--session-env NAME] [--without <service>] | --self-test"); process.exit(2); }
const ORIGIN = new URL(BASE).origin;
// `--without` is a statement about a FIXTURE — the mold started on this box, which lane-url.py only ever names
// at a loopback address. So it is honoured only when --url is loopback (the same two hosts lane-url.py
// accepts) and dropped, loudly, anywhere else: on a deployment every surface is measured and an absent
// service is a defect, and no future lane.json edit can reach the `declared off on this fixture` row there.
const LOOPBACK = ["127.0.0.1", "localhost"].includes(new URL(BASE).hostname);
if (WITHOUT.size && !LOOPBACK) {
  console.error(`--without ${[...WITHOUT].join(", ")} ignored: ${BASE} is not a loopback fixture, so every surface is measured and a missing service fails its row`);
  WITHOUT.clear();
}

// The credential is read BY NAME and never printed: only the identity it names and its expiry, so a
// report can say who the product was measured as without becoming the place the token leaks. Claims
// are decoded, not verified — the deployment's own answer is the verdict (see authGate).
function readSession() {
  const raw = (process.env[SESSION_ENV] || "").trim();
  if (!raw) return { missing: true };
  const parts = raw.split(".");
  if (parts.length !== 3) return { bad: `${SESSION_ENV} is set but is not a JWT (expected three dot-separated parts)` };
  let c = {};
  try { c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { /* claims stay empty */ }
  return { token: raw, who: c.email || c.sub || "(the token names no email)", exp: c.exp,
           expired: typeof c.exp === "number" && c.exp * 1000 < Date.now() };
}
const SESSION = AUTH ? readSession() : { missing: true };
// An expired token is not a weaker session, it is no session: the deployment refuses it and the
// signed-out shell is what would be measured. So it is handled with "missing" and "malformed" below,
// never graded — an unmeasured run must not be able to say anything about the application.
const STALE = AUTH && SESSION.expired
  ? `the session in ${SESSION_ENV} expired at ${new Date(SESSION.exp * 1000).toISOString()}` : "";
let refused = false;   // the deployment turned the session away mid-run: measured nothing, grades nothing

/** What each mode iterates: the three page routes, or the four authenticated surfaces. */
const surfaces = () => AUTH ? AUTH_SURFACES : ROUTES.map((p) => ({ name: p, path: p, marker: null }));

const rows = [];
// One markdown cell per row: a pipe ends the cell early and a newline ends the TABLE, so a label
// lifted out of the page (a two-line button) is flattened rather than corrupting the report.
const row = (name, result, detail) => rows.push({ name, result, detail: String(detail).replace(/\s+/g, " ").replace(/\|/g, "/").trim() });
let blocked = 0, navFailures = 0, navAttempts = 0, writes = 0;

// Installed before any script on the page: layout-shift and event timing must be observed from the
// first frame, so `buffered: true` alone is not enough — the observer has to exist before paint.
const INIT = () => {
  window.__cls = 0;
  window.__inp = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    // INP is over INTERACTIONS only: the entries a key, a tap or a click produce carry an interactionId > 0
    // (keydown/keyup, pointerdown/pointerup, click). Every other event entry has interactionId 0 and is not one.
    // This took the slowest event of ANY kind, and the slowest was always a `pointerover` Chromium fires 60-300 ms
    // into the load because the reused context's cursor sits where the new document appears: before hydration, on
    // a busy main thread, nothing a person did. So `interaction / keyboard` graded that load-time hover (median
    // 232 ms, samples 128-304 ms, onfinance_hfc 2026-10-08T161911Z) while the six Tab presses it names took 32-56 ms.
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.interactionId > 0 && e.duration > window.__inp) window.__inp = e.duration;
    }).observe({ type: "event", buffered: true, durationThreshold: 0 });
  } catch { /* a browser without these entry types leaves the metrics at 0; the row says so. */ }
};

const usedVp = new Set();   // the footer reports the viewports this RUN actually visited, not the matrix
async function newCtx(browser, vp) {
  usedVp.add(vp.w);
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch, isMobile: vp.touch,
    deviceScaleFactor: vp.touch ? 3 : 1, reducedMotion: "no-preference",
  });
  await ctx.addInitScript(INIT);
  if (AUTH && SESSION.token) {
    // The same key the app's own sign-in writes (app/_components/auth-gate.tsx), and ONLY on the
    // application's own origin: an init script runs in EVERY frame, third-party sign-in iframes
    // included, and a credential must never be written into somebody else's storage.
    await ctx.addInitScript(({ t, o }) => {
      // The key the app reads (lib/browser-storage.ts STORAGE_KEYS.token, since upstream #47).
      try { if (location.origin === o) localStorage.setItem("workspace-google-token", t); } catch { /* private mode */ }
    }, { t: SESSION.token, o: ORIGIN });
  }
  await ctx.route("**/*", (r) => {
    const req = r.request();
    let host = "", path = ""; try { const u = new URL(req.url()); host = u.hostname; path = u.pathname; } catch {}
    if (LIVE.test(host) || PROXY_PATHS.test(path)) { blocked++; return r.abort(); }
    // READ-ONLY, enforced rather than intended. Signed in, this app writes on its own (presence,
    // telemetry, a chat-session backfill) and this lane CLICKS. A harness that can POST to the
    // deployment it is grading is one selector away from changing a tenant's data, so every non-GET
    // is aborted and counted (HARD RULE 8: the safe value, not the convenient one). Nothing measured
    // here needs a write: layout, tap size and INP are all properties of the rendered page.
    if (req.method() !== "GET" && req.method() !== "HEAD") { writes++; return r.abort(); }
    return r.continue();
  });
  return ctx;
}

async function open(ctx, route) {
  navAttempts++;
  const page = await ctx.newPage();
  try {
    const res = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45000 });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
  } catch (e) {
    await page.close().catch(() => {});
    navFailures++;
    return { err: e.message.split("\n")[0].slice(0, 120) };
  }
  await page.waitForTimeout(1200);   // let late shifts (fonts, hydration) land in CLS before it is read
  return { page };
}

// ---- did the application actually render? --------------------------------------------------------
// A 200 is not a rendered application. An empty shell, or a Next.js client-side crash, answers 200 and
// then satisfies every budget below VACUOUSLY: 0px of overflow, CLS 0, 0 tap targets, no control to
// click. That is exactly how this lane came to print 24 green rows against a deployment that rendered
// nothing at all. So every row starts by counting what the browser can actually see, and a declared
// page route that rendered no interactive control FAILS the row rather than passing it for free.
// (`target-up.py`, the lane's precondition, catches the app that was never deployed and the 200 that
// came from something other than this mold — that is a `skipped` lane. Reaching here means the mold's
// own HTML arrived and then produced nothing, which is a defect of the deployment, not of the plan.)
const CONTROLS = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[tabindex]:not([tabindex="-1"])';
const census = (page) => page.evaluate((SEL) => {
  const vis = [...document.querySelectorAll(SEL)].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length;
  });
  return { controls: vis.length, chars: (document.body ? document.body.innerText : "").trim().length,
           names: vis.map((el) => ((el.getAttribute("aria-label") || el.textContent || el.tagName) + "").trim().slice(0, 40)) };
}, CONTROLS);
const notRendered = (c) => c.controls ? null
  : `the route answered 2xx but rendered no interactive control (${c.chars} chars of body text): nothing was `
    + `measured here, so this row cannot pass — the deployment is serving a shell, not the application`;

// ---- did we actually get IN? ---------------------------------------------------------------------
// Two facts, both measured, before any authenticated row is graded:
//   1. the DEPLOYMENT accepted the credential — a read-only GET /api/ops/orgs carrying the same bearer
//      the app's own ops client sends (app/_components/ops/lib.ts). 401 means the token is not this
//      deployment's or has expired, and what is on screen is the signed-out shell;
//   2. the SURFACE rendered — the control that only exists once its own content is there, and a census
//      strictly larger than the same url loaded with no session. The shell renders either way, so
//      without this a green row would certify the shell. Nothing measured is never a pass.
const serverAcceptsSession = (page) => page.evaluate(async () => {
  try {
    const t = localStorage.getItem("workspace-google-token");
    if (!t) return { status: -1, why: "no session was installed in this browser" };
    const r = await fetch("/api/ops/orgs", { headers: { authorization: "Bearer " + t } });
    return { status: r.status };
  } catch (e) { return { status: -1, why: String(e).slice(0, 120) }; }
});
const shellSeen = new Map();   // "<viewport> <path>" -> control count with NO session, measured once
async function shellControls(browser, vp, path) {
  const key = `${vp.name} ${path}`;
  if (shellSeen.has(key)) return shellSeen.get(key);
  const saved = SESSION.token;
  SESSION.token = null;                       // this one context gets no session: it IS the control sample
  const ctx = await newCtx(browser, vp);
  SESSION.token = saved;
  const { page, err } = await open(ctx, path);
  // -1 when the signed-out sample itself did not load. The comparison is then not evidence either way,
  // so the row falls back to the marker alone — which is the strict half of the gate, not the loose one.
  let n = -1;
  if (!err) { n = (await census(page)).controls; await page.close(); }
  await ctx.close();
  shellSeen.set(key, n);
  return n;
}
/** null when the surface is genuinely signed in and rendered, else the sentence that fails the row. */
async function authGate(page, su, shell) {
  if (!AUTH) return null;
  const a = await serverAcceptsSession(page);
  if (a.status !== 200) {
    // NOTHING WAS MEASURED, so nothing is graded: `refused` makes the row `not-covered` and the run
    // exit 2. See the header — a stale credential is the operator's to refresh, not a defect to
    // revert an application over.
    refused = true;
    return `the deployment refused this session: GET /api/ops/orgs answered ${a.status}${a.why ? ` (${a.why})` : ""}. ` +
      `This row measured nothing about the product — refresh ${SESSION_ENV} and run it again.`;
  }
  await page.waitForTimeout(1500);            // the panels render after their ops fetches resolve
  const c = await census(page);
  const marked = su.marker.test(c.names.join(" | "));
  if (!marked || c.controls <= shell) {
    return `signed in and accepted (200), but this surface did not render: ${marked ? "" : `${su.what} is absent; `}` +
      `${c.controls} control(s) signed in vs ${shell} signed out — the shell renders either way, so grading this would ` +
      "have measured the shell, not the surface.";
  }
  return null;
}

// ---- repeat-and-confirm, for the two budgets that move on their own -------------------------------
// Overflow, clipping and tap size are geometry: measure them twice and you get the same answer. CLS
// and INP are not. Measured once, `interaction / keyboard @ desktop-1440` swung 32 -> 176 -> 208 ->
// 208ms across four consecutive runs against an UNCHANGED deployment: two runs in four would have
// reverted a healthy application, filed a task, and told a non-technical operator their app had been
// pulled out of service — on 4% of overshoot on a shared 4-vCPU box running headless chromium. A
// budget that fires on measurement noise is not a defect, so a timing row is re-measured up to
// CONFIRM times and fails only when the budget is exceeded on EVERY run. It is not a weakening: a
// genuinely slow interaction cannot come in under budget on a repeat, and every sample is printed, so
// a borderline number stays visible instead of being smoothed away.
const CONFIRM = 3;
// (INP no longer goes through here: see sampleTiming, a median over 3-5 samples. CLS still does.)
async function confirm(sample, budget) {
  const runs = [];
  let last;
  for (let i = 0; i < CONFIRM; i++) {
    last = await sample();
    if (last.err || last.dead || last.skip || last.gate) return { last, runs };
    runs.push(last.value);
    if (last.value <= budget) break;
  }
  return { last, runs, best: Math.min(...runs) };
}
const seen = (runs, unit, dp = 0) => {
  const f = (v) => (dp ? v.toFixed(dp) : String(Math.round(v)));
  return runs.length > 1 ? `${runs.map(f).join("/")}${unit} over ${runs.length} runs, best ${f(Math.min(...runs))}${unit}` : `${f(runs[0])}${unit}`;
};

// ---- layout: horizontal overflow, cumulative layout shift, and content that cannot be reached ------
async function layout(browser) {
  for (const vp of VIEWPORTS) {
    const ctx = await newCtx(browser, vp);
    for (const su of surfaces()) {
      const label = `layout ${su.name} @ ${vp.name}`;
      if (declaredOff(su)) { row(label, "not-covered", declaredOff(su)); continue; }
      const shell = AUTH ? await shellControls(browser, vp, su.path) : -1;
      const probe = async () => {
        const { page, err } = await open(ctx, su.path);
        if (err) return { err };
        const c = await census(page);
        const dead = notRendered(c);
        if (dead) { await page.close(); return { dead, c }; }
        const gate = await authGate(page, su, shell);
        if (gate) { await page.close(); return { gate }; }
        // CLS is snapshotted BEFORE the reachability probe, because scrolling to test reachability can
        // itself provoke shifts and would otherwise pollute the number this row grades.
        const m = await page.evaluate(() => {
          const de = document.documentElement;
          return { overflow: Math.max(0, de.scrollWidth - de.clientWidth), cls: window.__cls, vw: de.clientWidth };
        });
        const reach = await page.evaluate(() => {
          const de = document.documentElement, vw = de.clientWidth, vh = de.clientHeight;
          const SEL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[tabindex]:not([tabindex="-1"])';
          const named = (el) => ((el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.tagName) + "").trim().slice(0, 24);
          // Reachable means a person can actually get a pointer onto it: its centre is inside the
          // viewport AND hit-testing that centre lands on the control. The hit test is what catches a
          // control clipped by an `overflow: hidden` ancestor or buried under an overlay while its
          // rectangle still reads as "on screen" — geometry alone calls those visible.
          const hits = (el, r) => {
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            if (x < 0 || y < 0 || x > vw || y > vh) return false;
            const hit = document.elementFromPoint(x, y);
            return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
          };
          // `overflow: hidden` still scrolls under SCRIPT control, so scrollIntoView happily "rescues" a
          // control that no person can ever reach with a mouse, a finger or a keyboard. That is the whole
          // clipped-content defect, so it is tested BEFORE any scrolling and is never scrolled away.
          const clippedByHidden = (el) => {
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
              const cs = getComputedStyle(a);
              const hx = /hidden|clip/.test(cs.overflowX), hy = /hidden|clip/.test(cs.overflowY);
              if (!hx && !hy) continue;
              const ar = a.getBoundingClientRect(), r = el.getBoundingClientRect();
              if (hx && (r.right <= ar.left + 1 || r.left >= ar.right - 1)) return `clipped by an overflow-x:${cs.overflowX} ancestor a user cannot scroll`;
              if (hy && (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1)) return `clipped by an overflow-y:${cs.overflowY} ancestor a user cannot scroll`;
            }
            return null;
          };
          const off = [], stuck = [];
          for (const el of document.querySelectorAll(SEL)) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            const hidden = clippedByHidden(el);
            if (hidden) { stuck.push(`${named(el)} [${hidden}]`); continue; }
            if (hits(el, r)) continue;
            off.push(named(el));
            // Try to reach it the way a person would, then look again.
            el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
            const after = el.getBoundingClientRect();
            if (!hits(el, after)) {
              const why = (after.right > vw + 1 || after.left < -1) ? `still past the edge, right=${Math.round(after.right)} > ${vw}`
                        : "clipped or covered: hit-testing its centre does not reach it";
              stuck.push(`${named(el)} [${why}]`);
            }
          }
          return { off: off.length, offNames: off.slice(0, 4), stuck };
        });
        await page.close();
        return { value: m.cls, m, reach, c };
      };
      const { last, runs, best } = await confirm(probe, BUDGET.cls);
      if (last.err) { row(label, "skipped", `did not load: ${last.err}`); continue; }
      if (last.dead) { row(label, "fail", last.dead); continue; }
      if (last.gate) { row(label, refused ? "not-covered" : "fail", last.gate); continue; }
      const { m, reach, c } = last;
      const bad = [];
      if (m.overflow > BUDGET.overflowPx) bad.push(`horizontal scroll ${m.overflow}px at ${m.vw}px wide (budget 0px, WCAG 1.4.10)`);
      if (best > BUDGET.cls) bad.push(`CLS over budget ${BUDGET.cls} on all ${runs.length} runs: ${seen(runs, "", 4)}`);
      if (reach.stuck.length) bad.push(`${reach.stuck.length} control(s) unreachable even after scrolling: ${reach.stuck.slice(0, 3).join(", ")}`);
      const note = reach.off
        ? `${reach.off} control(s) past the edge (${reach.offNames.join(", ")}), all reachable by scrolling`
        : "no control past the edge";
      row(label, bad.length ? "fail" : "pass",
        bad.length ? bad.join(" · ") : `${c.controls} control(s) rendered · hOverflow=${m.overflow}px · CLS=${seen(runs, "", 4)} (budget ${BUDGET.cls}) · ${note}`);
    }
    await ctx.close();
  }
}

// ---- targets: WCAG 2.2 SC 2.5.8 Target Size (Minimum), exceptions included -------------------------
async function targets(browser) {
  for (const vp of VIEWPORTS.filter((v) => TOUCH_VIEWPORTS.includes(v.name))) {
    const ctx = await newCtx(browser, vp);
    for (const su of surfaces()) {
      const label = `targets ${su.name} @ ${vp.name}`;
      if (declaredOff(su)) { row(label, "not-covered", declaredOff(su)); continue; }
      const shell = AUTH ? await shellControls(browser, vp, su.path) : -1;
      const { page, err } = await open(ctx, su.path);
      if (err) { row(label, "skipped", `did not load: ${err}`); continue; }
      const c = await census(page);
      const dead = notRendered(c);
      if (dead) { row(label, "fail", dead); await page.close(); continue; }
      const gate = await authGate(page, su, shell);
      if (gate) { row(label, refused ? "not-covered" : "fail", gate); await page.close(); continue; }
      const t = await page.evaluate(({ min, advisory }) => {
        const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"]';
        const all = [];
        for (const el of document.querySelectorAll(SEL)) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || el.hasAttribute("disabled") || !el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          all.push({ el, r, cs, name: ((el.getAttribute("aria-label") || el.textContent || el.tagName) + "").trim().slice(0, 22) });
        }
        const under = [], advisories = [], exempt = [];
        for (const t of all) {
          const size = Math.min(t.r.width, t.r.height);
          if (size < advisory) advisories.push(`${t.name} ${Math.round(t.r.width)}x${Math.round(t.r.height)}`);
          if (size >= min) continue;
          // Exception 1 (Inline): the target sits in a sentence or block of text.
          if (t.cs.display.startsWith("inline") && t.el.closest("p,li,label,td,th,figcaption")) { exempt.push(`${t.name} (inline in text)`); continue; }
          // Exception 2 (Spacing): a 24px circle centred on this target intersects no other target's.
          const cx = t.r.left + t.r.width / 2, cy = t.r.top + t.r.height / 2;
          const crowded = all.some((o) => o !== t &&
            Math.hypot(cx - (o.r.left + o.r.width / 2), cy - (o.r.top + o.r.height / 2)) < min);
          if (!crowded) { exempt.push(`${t.name} ${Math.round(t.r.width)}x${Math.round(t.r.height)} (spacing exception: nearest target >= ${min}px away)`); continue; }
          under.push(`${t.name} ${Math.round(t.r.width)}x${Math.round(t.r.height)}`);
        }
        return { n: all.length, under, exempt, advisories };
      }, { min: BUDGET.tapMinPx, advisory: BUDGET.tapAdvisoryPx });
      await page.close();
      // Zero targets is not "none under 24px". It is a row that measured nothing, and a row that
      // measured nothing is never a pass — the whole reason this lane could read green on a dead page.
      if (!t.n) { row(label, "fail", `${c.controls} control(s) rendered but 0 of them is a tap target: this row measured nothing, so it cannot pass`); continue; }
      const detail = [`${t.n} target(s)`,
        t.under.length ? `UNDER ${BUDGET.tapMinPx}px: ${t.under.join(", ")}` : `none under ${BUDGET.tapMinPx}px`,
        t.exempt.length ? `exempt: ${t.exempt.slice(0, 3).join("; ")}` : null,
        t.advisories.length ? `reported only (<${BUDGET.tapAdvisoryPx}px, SC 2.5.5 AAA): ${t.advisories.slice(0, 3).join(", ")}` : null,
      ].filter(Boolean).join(" · ");
      row(label, t.under.length ? "fail" : "pass", detail);
    }
    await ctx.close();
  }
}

// ---- interaction: Interaction to Next Paint on in-page controls, and on keyboard focus -------------
async function interaction(browser) {
  for (const vp of VIEWPORTS.filter((v) => ["mobile-390", "desktop-1440"].includes(v.name))) {
    const ctx = await newCtx(browser, vp);
    // Click rows. Signed out, /workspace is the only route with in-page controls: on / and /onboard the
    // only controls are "Continue with Google" and the email-code button, and clicking either leaves the
    // app, so they are declared out of scope rather than clicked and mis-measured. Signed in, every
    // authenticated surface has real in-page controls, and those are the clicks a customer actually
    // makes — which is the point of --auth.
    for (const su of (AUTH ? AUTH_SURFACES : [{ name: "/workspace", path: "/workspace", marker: null }])) {
    const label = `interaction ${su.name} click @ ${vp.name}`;
    if (declaredOff(su)) { row(label, "not-covered", declaredOff(su)); continue; }
    const shell = AUTH ? await shellControls(browser, vp, su.path) : -1;
    const clickProbe = async () => {
      const { page, err } = await open(ctx, su.path);
      if (err) return { err };
      const c = await census(page);
      const dead = notRendered(c);
      if (dead) { await page.close(); return { dead }; }
      const gate = await authGate(page, su, shell);
      if (gate) { await page.close(); return { gate }; }
      const n = await page.evaluate(() => {
        // A denylist of VERBS, as a second fence behind the read-only request guard (every non-GET is
        // aborted, so a click cannot reach the server even if one slips through). Widened for the
        // signed-in surfaces, where the buttons on screen are no longer only "Continue with Google":
        // save, publish, archive, revoke and friends are exactly the ones a measurement must not press.
        const UNSAFE = /sign ?in|sign ?up|google|continue with|log ?in|log ?out|sign ?out|delete|remove|submit|send|invite|upload|save|publish|archive|revoke|disconnect|reset|clear|export|import|run\b|deploy|approve|reject/i;
        let i = 0;
        for (const el of document.querySelectorAll("button")) {
          // NOT el.type: HTMLButtonElement.type reports "submit" for any <button> with no type
          // attribute, so testing the property skips every plain button and silently empties this row.
          if (el.disabled || el.closest("form") || el.getAttribute("type") === "submit") continue;
          const name = ((el.getAttribute("aria-label") || el.textContent || "") + "").trim();
          const r = el.getBoundingClientRect();
          if (!name || UNSAFE.test(name) || r.width < 1 || r.height < 1) continue;
          el.setAttribute("data-resp-safe", String(i++));
          if (i >= 4) break;
        }
        return i;
      });
      if (!n) { await page.close(); return { skip: "no in-page control on this route was safe to click (all are auth or destructive verbs)" }; }
      const before = page.url();
      let clicked = 0, navigated = false;
      for (let i = 0; i < n; i++) {
        await page.click(`[data-resp-safe="${i}"]`, { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        clicked++;
        if (page.url() !== before) { navigated = true; break; }
      }
      const inp = await page.evaluate(() => window.__inp);
      await page.close();
      return { value: inp, clicked, navigated };
    };
    const clicked = await sampleTiming(clickProbe, BUDGET.inpMs);
    if (clicked.last.err) row(label, "skipped", `did not load: ${clicked.last.err}`);
    else if (clicked.last.dead) row(label, "fail", clicked.last.dead);
    else if (clicked.last.gate) row(label, refused ? "not-covered" : "fail", clicked.last.gate);
    else if (clicked.last.skip) row(label, "skipped", clicked.last.skip);
    else row(label, clicked.over ? "fail" : "pass",
      (clicked.over ? `INP median over budget · ` : "")
        + (clicked.last.navigated ? `stopped after ${clicked.last.clicked} click(s): the page navigated, so later clicks were not measured · ` : `${clicked.last.clicked} in-page click(s) · `)
        + inpDetail(clicked, BUDGET.inpMs));
    }
    // Keyboard focus rows: pressing Tab is safe on every route and is the one interaction a
    // keyboard-only user makes constantly.
    for (const su of surfaces()) {
      const klabel = `interaction ${su.name} keyboard @ ${vp.name}`;
      if (declaredOff(su)) { row(klabel, "not-covered", declaredOff(su)); continue; }
      const kshell = AUTH ? await shellControls(browser, vp, su.path) : -1;
      const kbProbe = async () => {
        const { page, err } = await open(ctx, su.path);
        if (err) return { err };
        const c = await census(page);
        const dead = notRendered(c);
        if (dead) { await page.close(); return { dead }; }
        const gate = await authGate(page, su, kshell);
        if (gate) { await page.close(); return { gate }; }
        let presses = 0;
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Tab");
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          presses++;
        }
        const inp = await page.evaluate(() => window.__inp);
        await page.close();
        return { value: inp, presses, c };
      };
      const k = await sampleTiming(kbProbe, BUDGET.inpMs);
      if (k.last.err) { row(klabel, "skipped", `did not load: ${k.last.err}`); continue; }
      if (k.last.dead) { row(klabel, "fail", k.last.dead); continue; }
      if (k.last.gate) { row(klabel, refused ? "not-covered" : "fail", k.last.gate); continue; }
      row(klabel, k.over ? "fail" : "pass",
        (k.over ? `INP median over budget · ` : "")
          + `${k.last.presses} Tab press(es) over ${k.last.c.controls} rendered control(s) · ` + inpDetail(k, BUDGET.inpMs));
    }
    await ctx.close();
  }
}

// --auth with no credential measures NOTHING, so it grades nothing: every surface prints
// `not-covered` with the reason and the run exits 2. In the lane the check is gated on the variable's
// PRESENCE (lane.json `requires: env`), so the runner skips the check and the lane becomes `skipped` —
// a lane can never read `pass` while the product surface went unmeasured.
if (AUTH && (SESSION.missing || SESSION.bad || STALE)) {
  for (const su of AUTH_SURFACES) {
    row(`${ONLY === "all" ? "auth" : ONLY} ${su.name}`, "not-covered",
        SESSION.bad || (STALE && `${STALE}, so this run would measure the signed-out shell, not the product`) ||
        `no session token in ${SESSION_ENV}: this surface renders only for a signed-in identity`);
  }
  const w0 = Math.max(...rows.map((r) => r.name.length));
  console.log("| check | result | detail |");
  console.log("|---|---|---|");
  for (const r of rows) console.log(`| ${r.name.padEnd(w0)} | ${r.result} | ${r.detail} |`);
  console.log(`\n_target ${BASE} · viewports none · 0 request(s) to the live projects or the /eve/v1 proxy blocked · ` +
              `${rows.length} rows: 0 pass, 0 fail, 0 skipped, ${rows.length} declared not covered_`);
  console.error((SESSION.bad || STALE || `${SESSION_ENV} is not set`) + ". The signed-in product surface (chat thread, " +
    "ops centre, workflow builder) was NOT measured at any viewport. Sign in to this application as the factory's test identity " +
    'and export that browser session: see molds/mold_v1/testing/responsiveness/README.md, "Authenticated coverage".');
  process.exit(2);
}
if (AUTH) {
  console.error(`signed in as ${SESSION.who}${SESSION.exp ? ` (token expires ${new Date(SESSION.exp * 1000).toISOString()})` : ""}` +
                `${SESSION.expired ? " — ALREADY EXPIRED" : ""}; the token itself is never printed`);
}

const browser = await chromium.launch();
try {
  if (ONLY === "all" || ONLY === "layout") await layout(browser);
  if (ONLY === "all" || ONLY === "targets") await targets(browser);
  if (ONLY === "all" || ONLY === "interaction") await interaction(browser);
} finally {
  await browser.close();
}

if (!rows.length) { console.error(`--only ${ONLY} matched no rows`); process.exit(2); }
const w = Math.max(...rows.map((r) => r.name.length));
console.log("| check | result | detail |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.name.padEnd(w)} | ${r.result} | ${r.detail} |`);
const n = (s) => rows.filter((r) => r.result === s).length;
console.log(`\n_target ${BASE} · ${AUTH ? "SIGNED IN" : "signed out"} · viewports ${[...usedVp].sort((x, y) => x - y).join("/") || "none"} · ` +
            `${blocked} request(s) to the live projects or the /eve/v1 proxy blocked · ${writes} non-GET request(s) blocked (this lane is read-only) · ` +
            `${rows.length} rows: ${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped, ` +
            `${n("not-covered")} declared not covered_`);
// Nothing measured at all is not a pass. The runner's precondition probe should have caught a target
// that was already down, so losing every route mid-run is an anomaly worth surfacing loudly.
if (navAttempts && navFailures === navAttempts) {
  console.error(`the target stopped answering mid-run: ${navFailures}/${navAttempts} navigations failed, so nothing was measured`);
  process.exit(3);
}
if (refused) {
  // Exit 2 = nothing was measured. Not 1: `fail` reverts the application (lanes.py), and a credential
  // this deployment turned away is the operator's to refresh, not a defect of the app. The check's
  // precondition, session-live.py, is what catches the ordinary stale paste before a browser opens.
  console.error(`the deployment refused ${SESSION_ENV} part-way through, so the signed-in surfaces were NOT measured at any ` +
    "viewport and nothing here grades the application. Sign in again and re-run with a fresh session: " +
    'molds/mold_v1/testing/responsiveness/README.md, "Authenticated coverage".');
  process.exit(2);
}
if (n("skipped")) {
  // Line 28 said a skipped row never lifts the exit code; exit 0 did exactly that. A skipped row here
  // means a route did not load, so nothing was measured on it — and an unmeasured row graded `pass` is
  // the one failure mode this lane exists to prevent. It is reported, not silently tolerated.
  console.error(`${n("skipped")} row(s) measured nothing (route did not load); a lane cannot pass on unmeasured rows`);
  process.exit(1);
}
process.exit(n("fail") ? 1 : 0);
