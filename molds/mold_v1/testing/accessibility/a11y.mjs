// The accessibility lane's harness. One command, one markdown table, one exit code.
//
//   node molds/mold_v1/testing/accessibility/a11y.mjs --url <base> [--only axe|keyboard|auth]
//                                                     [--routes /,/onboard,/workspace] [--json <path>]
//                                                     [--session-env MOLD_V1_SESSION_TOKEN]
//
// Exit 0 every graded row passed · 1 a row failed, or a declared route did not render · 2 nothing was
// measured — bad usage, or no usable session (missing, malformed, expired, or refused by the
// deployment). An unmeasured run never exits 0.
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
//
// WHAT `--only auth` IS FOR (mold_v1-040). The three routes above are the SIGNED-OUT app: `/` and
// `/onboard` are the sign-in page (2 controls, both sign-in buttons) and `/workspace` is a shell whose
// every panel says "loading…" forever because /api/ops/* answers 401. This lane used to grade only
// those and print `pass`, so a green accessibility lane certified a sign-in page — the product itself
// (the chat thread, the ops centre, the workflow builder) was never rendered, never traversed, and the
// one row that admitted it said `not-covered`.
//
// So `--only auth` grades the product. It signs in with the app's OWN kind of session: the ES256
// "email-session" token lib/auth-session.ts defines and lib/ops-auth.ts admits on its signature alone
// (the emailed one-time code gates the mint ROUTE, app/api/auth/email/verify, not the token). For an
// application the factory provisioned, the factory holds that app's AUTH_JWT_PRIVATE_KEY by name, so
// .claude/scripts/lib/session.py signs one for the app's own FDE (application.workspace.fde_self.email)
// and hands it to this harness by NAME in an environment variable — lane.json runs the check through
// it. An operator who signed in and lent that browser's session wins over a minted one. The harness
// stores whichever it was given under the same localStorage key the app's own sign-in writes
// (app/_components/auth-gate.tsx), which is the whole of what "being signed in" means to this client.
//
// It cannot be faked into a pass, and that is deliberate:
//   - THIS FILE never mints, and never sees a key. It reads one variable. Without it this check does not
//     run at all and the lane is `skipped` (the precondition in lane.json), never `pass`;
//   - a token the SERVER refuses grades nothing. Every authenticated surface first asks the deployment
//     itself (a read-only GET /api/ops/orgs carrying the token) whether the credential resolves to a
//     workspace. 401/403 prints the status and the surface is `not-covered`, and the run exits 2 —
//     never a quiet fall back to grading the shell, and never `pass`. It is not `fail` either: a
//     credential the deployment refuses says the operator's paste went stale (a session copied out of
//     a browser lasts about an hour), not that the application is broken, and `fail` here would revert
//     a healthy deployment. That verdict is taken BEFORE a browser opens, by session-live.py, the
//     check's precondition in lane.json: an unusable session makes the check — and so the lane —
//     `skipped`. This path is the same answer for the narrow case where the session dies mid-run;
//   - a surface that renders the signed-out shell anyway fails. Each surface names a control that only
//     exists once its own content has rendered, and the row also compares the control census against
//     the SAME url loaded with no session: if signing in changed nothing, the shell is what got
//     measured, and the row says so and fails.
// The browser is also held READ-ONLY: every request that is not a GET/HEAD is aborted and counted, so
// running this against a real deployment cannot write to it (HARD RULE 2). The count is printed.
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = join(HERE, "vendor/axe.min.js");
const AXE_V = (readFileSync(AXE, "utf8").match(/axe v([\d.]+)/) || [, "?"])[1];
const FAIL_IMPACTS = new Set(["serious", "critical"]);
const DEFAULT_ROUTES = ["/", "/onboard", "/workspace"]; // measured signed-OUT: the mold's three page routes
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// The product surface, behind a signed-in identity. Each entry names a control that appears ONLY when
// that surface's own content has rendered — the shell (header + tab strip) renders either way, so
// "the page had controls on it" is not evidence that the ops centre or the builder was measured.
// `?tab=` is the app's own deep link into a workspace tab (app/_components/ops/workspace-panel.tsx),
// so these are real addresses, not a click path this harness invented.
const AUTH_SURFACES = [
  { name: "/ chat thread",            path: "/",                      marker: /new chat|open sidebar/i, what: 'the chat thread\'s "New chat" control (or "Open sidebar" on a phone, where the sidebar starts closed and "New chat" lives inside it)' },
  { name: "/workspace people",        path: "/workspace?tab=people",   marker: /\binvite\b/i,    what: 'the People tab\'s "Invite" control' },
  { name: "/workspace audit",         path: "/workspace?tab=audit",    marker: /\bactor\b/i,     what: "the Audit trail's actor filter" },
  // `needs`: a service beyond the web app that this surface is a client of. lane-url.py passes
  // `--without <service>` for a target=vm fixture, which runs the web app alone (infra/vm/README.md), and
  // the surface is then declared `not-covered` with that reason rather than failed on a control the
  // service would have rendered. A deployment gets no such flag: there, an absent builder IS a defect.
  { name: "/workspace builder",       path: "/workspace?tab=workflows", marker: /new workflow/i, what: 'the workflow builder\'s "New workflow" control', needs: "task-workflow" },
];

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = (arg("--url", "") || "").replace(/\/+$/, "");
const only = arg("--only", "all");
const routes = arg("--routes", DEFAULT_ROUTES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const jsonOut = arg("--json", "");
const SESSION_ENV = arg("--session-env", "MOLD_V1_SESSION_TOKEN");
// Services the target does not run (`--without task-workflow`, repeatable). Only lane-url.py emits it, and
// only for a vm fixture; a surface that `needs` one is printed `not-covered` — "declared off on this
// fixture", the one phrase lane.json's stdout_not lets through and its skip_on then records the whole
// check `skipped` (the lane cannot be `pass` with a surface unopened) — instead of failed, and never `pass`.
const WITHOUT = new Set(process.argv.flatMap((x, i) => (x === "--without" && process.argv[i + 1] ? [process.argv[i + 1]] : [])));
if (!base) { console.error("usage: a11y.mjs --url <base> [--only axe|keyboard|auth] [--routes a,b] [--json f] [--session-env NAME] [--without <service>]"); process.exit(2); }
const ORIGIN = new URL(base).origin;
// `--without` is a statement about a FIXTURE — the mold started on this box, which lane-url.py only ever names
// at a loopback address. So it is honoured only when --url is loopback (the same two hosts lane-url.py
// accepts) and dropped, loudly, anywhere else: on a deployment every surface is measured and an absent
// service is a defect, and no future lane.json edit can reach the `declared off on this fixture` row there.
const LOOPBACK = ["127.0.0.1", "localhost"].includes(new URL(base).hostname);
if (WITHOUT.size && !LOOPBACK) {
  console.error(`--without ${[...WITHOUT].join(", ")} ignored: ${base} is not a loopback fixture, so every surface is measured and a missing service fails its row`);
  WITHOUT.clear();
}

// ESM ignores NODE_PATH, so the global playwright is reached through a require rooted at it.
let chromium;
try { chromium = createRequire("/usr/lib/node_modules/")("playwright").chromium; }
catch { console.error("playwright is not installed globally: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

// THE CREDENTIAL IS READ BY NAME AND NEVER PRINTED. Only its shape, the identity it names and its
// expiry are reported, so a report can say WHICH identity the product was measured as without the
// report becoming the place the token leaks. The claims are decoded, not verified — the deployment's
// own answer to GET /api/ops/orgs is the only verdict that counts, and it is measured below.
function readSession() {
  const raw = (process.env[SESSION_ENV] || "").trim();
  if (!raw) return { missing: true };
  const parts = raw.split(".");
  if (parts.length !== 3) return { bad: `${SESSION_ENV} is set but is not a JWT (expected three dot-separated parts)` };
  let c = {};
  try { c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { /* claims stay empty */ }
  const expired = typeof c.exp === "number" && c.exp * 1000 < Date.now();
  return { token: raw, who: c.email || c.sub || "(the token names no email)", exp: c.exp, expired };
}

// A locally built mold bakes a rewrite of /eve/v1/* to the LIVE fde-agent-api into routes-manifest.json,
// so a browser that touches those paths pulls a live production project into a test run. This lane is
// read-only on the app under test and must never reach the live factory projects: those requests are
// aborted in the browser and counted, and a non-zero count is reported rather than hidden.
const LIVE = /(^|\.)fde-(agent|agent-api|task-workflow)[^.]*\./i;   // any host, not just *.vercel.app
const PROXY_PATHS = /\/(eve\/v1|\.well-known\/workflow)\//;
let blocked = 0, writes = 0;
// Read-only, enforced rather than intended. Signed OUT the app issues no writes worth speaking of;
// signed IN it does — presence, telemetry, a chat-session backfill — and this lane grades a REAL
// deployment. A measurement harness that can POST to the application it is grading is one bad
// selector away from changing the tenant's data, so every non-GET is aborted and counted (HARD RULE 8:
// the safe value, not the convenient one). Nothing here needs a write to render.
const guard = (target) => target.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  if (LIVE.test(u.hostname) || PROXY_PATHS.test(u.pathname)) { blocked++; return r.abort(); }
  if (req.method() !== "GET" && req.method() !== "HEAD") { writes++; return r.abort(); }
  return r.continue();
});

const rows = [], detail = [];
let refused = false;   // the deployment turned the session away: this run measured nothing, and grades nothing
// One markdown cell per row: a pipe would end the cell early and a newline would end the TABLE, so a
// label lifted out of the page (a two-line button) is flattened here rather than corrupting the report.
const row = (name, result, why) => rows.push({ name, result, why: String(why).replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 400) });

const open = async (ctx, route) => {
  const page = await ctx.newPage();
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
  return { interactive: vis.length, chars: (document.body ? document.body.innerText : "").trim().length,
           names: vis.map(el => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName).trim().slice(0, 40)) };
}, CONTROLS);
const notRendered = (c) => c.interactive ? null
  : `the route answered 2xx but rendered no interactive control (${c.chars} chars of body text): nothing was `
  + `graded here, so this row cannot pass — the deployment is serving a shell, not the application`;

// The SERVER's verdict on the credential, not the client's. The app's own ops client sends exactly
// this (app/_components/ops/lib.ts: Authorization: Bearer <the localStorage token>), and the route is
// a read-only GET. 200 means this deployment verified the token with its own AUTH_JWT_PUBLIC_KEY and
// resolved a workspace for the identity; 401 means the token is not this deployment's, or has expired.
const serverAcceptsSession = (page) => page.evaluate(async () => {
  try {
    const t = localStorage.getItem("workspace-google-token") || localStorage.getItem("fde-google-token");
    if (!t) return { status: -1, why: "no session was installed in this browser" };
    const r = await fetch("/api/ops/orgs", { headers: { authorization: "Bearer " + t } });
    return { status: r.status };
  } catch (e) { return { status: -1, why: String(e).slice(0, 120) }; }
});

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const newCtx = async (token) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (token) {
    // The same key the app's own sign-in writes, and ONLY on the application's own origin: an init
    // script runs in EVERY frame, including third-party sign-in iframes, and a credential must never
    // be written into somebody else's storage.
    await ctx.addInitScript(({ t, o }) => {
      // Both spellings: the app reads `workspace-google-token` (lib/browser-storage.ts STORAGE_KEYS.token,
      // fde-agent #47) and falls back to the legacy `fde-google-token`; a deployment older than #47 reads
      // only the legacy one. Writing both keeps the harness correct on either side of the alias removal.
      try { if (location.origin === o) { localStorage.setItem("workspace-google-token", t); localStorage.setItem("fde-google-token", t); } } catch { /* private mode */ }
    }, { t: token, o: ORIGIN });
  }
  await guard(ctx);
  return ctx;
};
const anon = await newCtx(null);

if (only === "all" || only === "axe") {
  for (const route of routes) {
    const { page, status, err } = await open(anon, route);
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

// The keyboard walk, factored out because the authenticated surfaces are traversed the same way.
const walk = async (page) => {
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
  return { seen, interactive, problems };
};

if (only === "all" || only === "keyboard") {
  for (const route of routes) {
    const { page, status, err } = await open(anon, route);
    if (status < 200 || status >= 300) { row(`keyboard ${route}`, "skipped", err || `route answered HTTP ${status}: not rendered, so not graded`); await page.close(); continue; }
    const dead = notRendered(await census(page));
    if (dead) { row(`keyboard ${route}`, "fail", dead); await page.close(); continue; }
    const { seen, interactive, problems } = await walk(page);
    row(`keyboard ${route}`, problems.length ? "fail" : "pass",
        problems.join(" · ") || `${seen.length} tabbable of ${interactive} interactive, all with a focus indicator: ${seen.slice(0, 4).map(s => s.tag + ":" + (s.label || "-")).join(", ")}`);
    detail.push({ route, keyboard: seen, interactive });
    await page.close();
  }
  // Signposting, not a measurement. The product surface is graded by `--only auth`, which needs a
  // session this check does not have; saying so here keeps a green unauthenticated table from reading
  // as "the workspace is accessible". `not-covered` rather than `skipped`, because it is a declared
  // boundary of THIS check (README, "Not covered"), not a route that failed to render.
  row("keyboard workflow-builder", "not-covered",
      `graded by the authenticated check instead (a11y.mjs --only auth), which needs a session token in ${SESSION_ENV}; ` +
      "signed out this check sees the workspace shell only");
}

if (only === "all" || only === "auth") {
  const s = readSession();
  // An expired token is not a weaker session, it is no session: the deployment will refuse it and the
  // signed-out shell is what would be graded. It joins "missing" and "malformed" here, before a
  // browser opens, instead of being graded and reported as a defect of the application.
  const stale = s.expired ? `the session in ${SESSION_ENV} expired at ${new Date(s.exp * 1000).toISOString()}` : "";
  if (s.missing || s.bad || stale) {
    // NOTHING WAS MEASURED, so nothing is graded. Every surface is printed `not-covered` with the
    // reason, and the exit code is 2 — this run cannot stand for the product. In the lane the check is
    // gated on the variable's PRESENCE (lane.json `requires: env`), so the runner skips it and the lane
    // becomes `skipped`; a lane can never be `pass` while the product surface went unmeasured.
    for (const su of AUTH_SURFACES) row(`auth ${su.name}`, "not-covered", s.bad || (stale && `${stale}, so this run would measure the signed-out shell, not the product`) ||
      `no session token in ${SESSION_ENV}: this surface renders only for a signed-in identity`);
    console.log("| check | result | detail |");
    console.log("|---|---|---|");
    const w0 = Math.max(...rows.map(r => r.name.length), 5);
    for (const r of rows) console.log(`| ${r.name.padEnd(w0)} | ${r.result} | ${r.why} |`);
    // Real counts, not zeros: with `--only all` this table also carries the signed-out rows that DID
    // run, and a footer that under-reports them would be its own small lie.
    const cnt = (x) => rows.filter((r) => r.result === x).length;
    console.log(`\n_target ${base} · axe-core ${AXE_V} · ${rows.length} rows: ${cnt("pass")} pass, ${cnt("fail")} fail, ` +
                `${cnt("skipped")} skipped, ${cnt("not-covered")} declared not covered_`);
    console.error((s.bad || stale || `${SESSION_ENV} is not set`) + ". The signed-in product surface (chat thread, ops centre, " +
      "workflow builder) was NOT measured. Sign in to this application as the factory's test identity and export that browser " +
      'session: see molds/mold_v1/testing/accessibility/README.md, "Authenticated coverage".');
    await browser.close();
    process.exit(2);
  }
  const authed = await newCtx(s.token);
  console.error(`signed in as ${s.who}${s.exp ? ` (token expires ${new Date(s.exp * 1000).toISOString()})` : ""}` +
                `${s.expired ? " — ALREADY EXPIRED" : ""}; the token itself is never printed`);
  for (const su of AUTH_SURFACES) {
    if (su.needs && WITHOUT.has(su.needs)) {
      // Not measured, and said so: this fixture does not run the service the surface is a client of.
      row(`auth ${su.name}`, "not-covered", `declared off on this fixture: it does not run the ${su.needs} service, which ${su.what} ` +
        `needs (--without ${su.needs} from lane-url.py), so this surface was not opened and nothing here grades it`);
      continue;
    }
    // The same url with NO session, first. It is the control sample: if the signed-in render is the
    // same size as the signed-out one, the session bought nothing and the shell is what got measured.
    const shell = await open(anon, su.path);
    const shellC = shell.status >= 200 && shell.status < 300 ? await census(shell.page) : { interactive: -1 };
    await shell.page.close();

    const { page, status, err } = await open(authed, su.path);
    const label = `auth ${su.name}`;
    if (status < 200 || status >= 300) { row(label, "skipped", err || `route answered HTTP ${status}: not rendered, so not graded`); await page.close(); continue; }
    const accepted = await serverAcceptsSession(page);
    if (accepted.status !== 200) {
      // NOTHING WAS MEASURED. A refused credential leaves the signed-out shell on screen, so this row
      // has no opinion about the application — grading it `fail` would revert a healthy deployment
      // over a stale paste. `not-covered` + exit 2 says what happened; the check's precondition
      // (session-live.py) is what turns the ordinary version of this into a `skipped` lane.
      refused = true;
      row(label, "not-covered", `the deployment refused this session: GET /api/ops/orgs answered ${accepted.status}${accepted.why ? ` (${accepted.why})` : ""}. ` +
        `This run measured nothing about the product — refresh ${SESSION_ENV} and run it again.`);
      await page.close(); continue;
    }
    // Client-rendered panels arrive after their ops fetches resolve; networkidle already waited for
    // those, and this is the small settle for the render that follows them.
    await page.waitForTimeout(1500);
    const c = await census(page);
    const dead = notRendered(c);
    if (dead) { row(label, "fail", dead); await page.close(); continue; }
    const marked = su.marker.test(c.names.join(" | "));
    if (!marked || c.interactive <= shellC.interactive) {
      row(label, "fail", `signed in and accepted (200), but this surface did not render: ${marked ? "" : `${su.what} is absent; `}` +
        `${c.interactive} control(s) signed in vs ${shellC.interactive} signed out. The shell renders either way, so grading this ` +
        "would have certified the shell, not the surface.");
      detail.push({ surface: su.name, names: c.names, shell: shellC.interactive });
      await page.close(); continue;
    }
    await page.addScriptTag({ path: AXE });
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
    row(`auth axe ${su.name}`, bad.length ? "fail" : "pass",
        `${c.interactive} control(s) rendered (shell alone: ${shellC.interactive}) · WCAG A/AA serious+critical: ${fmt(bad)} · reported only: ${fmt(rest)} · ${res.passes} rules passed · ${res.incomplete.length} need review`);
    const { seen, interactive, problems } = await walk(page);
    row(`auth keyboard ${su.name}`, problems.length ? "fail" : "pass",
        problems.join(" · ") || `${seen.length} tabbable of ${interactive} interactive, all with a focus indicator: ${seen.slice(0, 4).map(x => x.tag + ":" + (x.label || "-")).join(", ")}`);
    detail.push({ surface: su.name, ...res, keyboard: seen, shell: shellC.interactive });
    await page.close();
  }
  await authed.close();
}

await anon.close();
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
if (writes) console.error(`blocked ${writes} non-GET request(s) from the page: this lane is read-only on the application it grades`);
// A declared ROUTE that was not rendered cannot be reported green: exit 0 here would let the runner
// record `pass` for a page nothing looked at. (The workflow-builder signpost row is a declared
// limitation of the unauthenticated check, not a route, so it may stay `not-covered` without failing
// the check — README, "Not covered".)
if (refused) {
  console.error(`the deployment refused ${SESSION_ENV} part-way through, so the signed-in surfaces were NOT measured and ` +
    "nothing here grades the application. Sign in again and re-run with a fresh session: " +
    'molds/mold_v1/testing/accessibility/README.md, "Authenticated coverage".');
  process.exit(2);
}
const unrendered = rows.filter(r => r.result === "skipped");
if (unrendered.length) {
  console.error(`${unrendered.length} declared route(s) did not render, so this check cannot pass: ` +
    unrendered.map(r => r.name).join(", ") + ". The lane's target-up.py precondition is what turns an " +
    "app that is simply not deployed into a skipped lane instead of this.");
  process.exit(1);
}
process.exit(failed.length ? 1 : 0);
