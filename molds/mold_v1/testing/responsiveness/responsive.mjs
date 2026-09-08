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
// every request to a live fde-* host is aborted and counted, and the count is printed in the footer as
// evidence. Interaction rows only ever click in-page controls whose accessible name is not an auth or
// destructive verb, and each click asserts the URL did not change.
//
// Exit 0 every row within budget · 1 a row is over budget (the table carries `| fail |`, which the
// runner also forbids) · 2 bad usage · 3 the target stopped answering mid-run, so nothing was measured.
// A skipped row NEVER lifts the exit code: unmeasured must never read as pass.
import { createRequire } from "node:module";
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
const ROUTES = ["/", "/onboard", "/workspace"];
const TOUCH_VIEWPORTS = ["mobile-390", "tablet-820"];
const LIVE = /(^|\.)fde-(agent|agent-api|task-workflow)\./i;   // HARD RULE 2: never touched, only counted.

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = (arg("--url", "") || "").replace(/\/+$/, "");
const ONLY = arg("--only", "all");
if (!BASE) { console.error("usage: responsive.mjs --url <base> [--only layout|targets|interaction]"); process.exit(2); }

const rows = [];
const row = (name, result, detail) => rows.push({ name, result, detail: String(detail).replace(/\|/g, "/") });
let blocked = 0, navFailures = 0, navAttempts = 0;

// Installed before any script on the page: layout-shift and event timing must be observed from the
// first frame, so `buffered: true` alone is not enough — the observer has to exist before paint.
const INIT = () => {
  window.__cls = 0;
  window.__inp = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration > window.__inp) window.__inp = e.duration;
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
  await ctx.route("**/*", (r) => {
    let host = ""; try { host = new URL(r.request().url()).hostname; } catch {}
    if (LIVE.test(host)) { blocked++; return r.abort(); }
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
  return { controls: vis.length, chars: (document.body ? document.body.innerText : "").trim().length };
}, CONTROLS);
const notRendered = (c) => c.controls ? null
  : `the route answered 2xx but rendered no interactive control (${c.chars} chars of body text): nothing was `
    + `measured here, so this row cannot pass — the deployment is serving a shell, not the application`;

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
async function confirm(sample, budget) {
  const runs = [];
  let last;
  for (let i = 0; i < CONFIRM; i++) {
    last = await sample();
    if (last.err || last.dead || last.skip) return { last, runs };
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
    for (const route of ROUTES) {
      const label = `layout ${route} @ ${vp.name}`;
      const probe = async () => {
        const { page, err } = await open(ctx, route);
        if (err) return { err };
        const c = await census(page);
        const dead = notRendered(c);
        if (dead) { await page.close(); return { dead, c }; }
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
    for (const route of ROUTES) {
      const label = `targets ${route} @ ${vp.name}`;
      const { page, err } = await open(ctx, route);
      if (err) { row(label, "skipped", `did not load: ${err}`); continue; }
      const c = await census(page);
      const dead = notRendered(c);
      if (dead) { row(label, "fail", dead); await page.close(); continue; }
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
    // Click rows: /workspace is the only route with in-page controls. On / and /onboard the only
    // controls are "Continue with Google" and the email-code button; clicking either leaves the app,
    // so they are declared out of scope rather than clicked and mis-measured.
    const label = `interaction /workspace click @ ${vp.name}`;
    const clickProbe = async () => {
      const { page, err } = await open(ctx, "/workspace");
      if (err) return { err };
      const c = await census(page);
      const dead = notRendered(c);
      if (dead) { await page.close(); return { dead }; }
      const n = await page.evaluate(() => {
        const UNSAFE = /sign ?in|sign ?up|google|continue with|log ?in|log ?out|delete|remove|submit|send|invite|upload/i;
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
    const clicked = await confirm(clickProbe, BUDGET.inpMs);
    if (clicked.last.err) row(label, "skipped", `did not load: ${clicked.last.err}`);
    else if (clicked.last.dead) row(label, "fail", clicked.last.dead);
    else if (clicked.last.skip) row(label, "skipped", clicked.last.skip);
    else row(label, clicked.best > BUDGET.inpMs ? "fail" : "pass",
      clicked.best > BUDGET.inpMs
        ? `INP over budget ${BUDGET.inpMs}ms on all ${clicked.runs.length} runs: ${seen(clicked.runs, "ms")}`
        : (clicked.last.navigated ? `stopped after ${clicked.last.clicked} click(s): the page navigated, so later clicks were not measured · ` : `${clicked.last.clicked} in-page click(s) · `)
          + `INP=${seen(clicked.runs, "ms")} (budget ${BUDGET.inpMs}ms)`);
    // Keyboard focus rows: pressing Tab is safe on every route and is the one interaction a
    // keyboard-only user makes constantly.
    for (const route of ROUTES) {
      const klabel = `interaction ${route} keyboard @ ${vp.name}`;
      const kbProbe = async () => {
        const { page, err } = await open(ctx, route);
        if (err) return { err };
        const c = await census(page);
        const dead = notRendered(c);
        if (dead) { await page.close(); return { dead }; }
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
      const k = await confirm(kbProbe, BUDGET.inpMs);
      if (k.last.err) { row(klabel, "skipped", `did not load: ${k.last.err}`); continue; }
      if (k.last.dead) { row(klabel, "fail", k.last.dead); continue; }
      row(klabel, k.best > BUDGET.inpMs ? "fail" : "pass",
        k.best > BUDGET.inpMs
          ? `INP over budget ${BUDGET.inpMs}ms on all ${k.runs.length} runs: ${seen(k.runs, "ms")}`
          : `${k.last.presses} Tab press(es) over ${k.last.c.controls} rendered control(s) · INP=${seen(k.runs, "ms")} (budget ${BUDGET.inpMs}ms)`);
    }
    await ctx.close();
  }
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
console.log(`\n_target ${BASE} · viewports ${[...usedVp].sort((x, y) => x - y).join("/") || "none"} · ${blocked} request(s) to live fde-* hosts blocked · ` +
            `${rows.length} rows: ${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped_`);
// Nothing measured at all is not a pass. The runner's precondition probe should have caught a target
// that was already down, so losing every route mid-run is an anomaly worth surfacing loudly.
if (navAttempts && navFailures === navAttempts) {
  console.error(`the target stopped answering mid-run: ${navFailures}/${navAttempts} navigations failed, so nothing was measured`);
  process.exit(3);
}
process.exit(n("fail") ? 1 : 0);
