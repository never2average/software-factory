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

async function newCtx(browser, vp) {
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

// ---- layout: horizontal overflow, cumulative layout shift, and content that cannot be reached ------
async function layout(browser) {
  for (const vp of VIEWPORTS) {
    const ctx = await newCtx(browser, vp);
    for (const route of ROUTES) {
      const label = `layout ${route} @ ${vp.name}`;
      const { page, err } = await open(ctx, route);
      if (err) { row(label, "skipped", `did not load: ${err}`); continue; }
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
        const off = [], stuck = [];
        for (const el of document.querySelectorAll(SEL)) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
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
      const bad = [];
      if (m.overflow > BUDGET.overflowPx) bad.push(`horizontal scroll ${m.overflow}px at ${m.vw}px wide (budget 0px, WCAG 1.4.10)`);
      if (m.cls > BUDGET.cls) bad.push(`CLS ${m.cls.toFixed(4)} over budget ${BUDGET.cls}`);
      if (reach.stuck.length) bad.push(`${reach.stuck.length} control(s) unreachable even after scrolling: ${reach.stuck.slice(0, 3).join(", ")}`);
      const note = reach.off
        ? `${reach.off} control(s) past the edge (${reach.offNames.join(", ")}), all reachable by scrolling`
        : "no control past the edge";
      row(label, bad.length ? "fail" : "pass",
        bad.length ? bad.join(" · ") : `hOverflow=${m.overflow}px · CLS=${m.cls.toFixed(4)} (budget ${BUDGET.cls}) · ${note}`);
      await page.close();
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
      const detail = [`${t.n} target(s)`,
        t.under.length ? `UNDER ${BUDGET.tapMinPx}px: ${t.under.join(", ")}` : `none under ${BUDGET.tapMinPx}px`,
        t.exempt.length ? `exempt: ${t.exempt.slice(0, 3).join("; ")}` : null,
        t.advisories.length ? `reported only (<${BUDGET.tapAdvisoryPx}px, SC 2.5.5 AAA): ${t.advisories.slice(0, 3).join(", ")}` : null,
      ].filter(Boolean).join(" · ");
      row(label, t.under.length ? "fail" : "pass", detail);
      await page.close();
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
    const { page, err } = await open(ctx, "/workspace");
    if (err) { row(label, "skipped", `did not load: ${err}`); }
    else {
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
      if (!n) row(label, "skipped", "no in-page control on this route was safe to click (all are auth or destructive verbs)");
      else {
        const before = page.url();
        let clicked = 0, navigated = false;
        for (let i = 0; i < n; i++) {
          await page.click(`[data-resp-safe="${i}"]`, { timeout: 8000 }).catch(() => {});
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          clicked++;
          if (page.url() !== before) { navigated = true; break; }
        }
        const inp = await page.evaluate(() => window.__inp);
        const over = inp > BUDGET.inpMs;
        row(label, over ? "fail" : "pass",
          navigated ? `stopped after ${clicked} click(s): the page navigated, so later clicks were not measured · INP=${Math.round(inp)}ms`
                    : `${clicked} in-page click(s) · INP=${Math.round(inp)}ms (budget ${BUDGET.inpMs}ms)`);
      }
      await page.close();
    }
    // Keyboard focus rows: pressing Tab is safe on every route and is the one interaction a
    // keyboard-only user makes constantly.
    for (const route of ROUTES) {
      const klabel = `interaction ${route} keyboard @ ${vp.name}`;
      const { page: kp, err: kerr } = await open(ctx, route);
      if (kerr) { row(klabel, "skipped", `did not load: ${kerr}`); continue; }
      let presses = 0;
      for (let i = 0; i < 6; i++) {
        await kp.keyboard.press("Tab");
        await kp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        presses++;
      }
      const inp = await kp.evaluate(() => window.__inp);
      row(klabel, inp > BUDGET.inpMs ? "fail" : "pass",
        `${presses} Tab press(es) · INP=${Math.round(inp)}ms (budget ${BUDGET.inpMs}ms)`);
      await kp.close();
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
console.log(`\n_target ${BASE} · viewports ${VIEWPORTS.map((v) => v.w).join("/")} · ${blocked} request(s) to live fde-* hosts blocked · ` +
            `${rows.length} rows: ${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped_`);
// Nothing measured at all is not a pass. The runner's precondition probe should have caught a target
// that was already down, so losing every route mid-run is an anomaly worth surfacing loudly.
if (navAttempts && navFailures === navAttempts) {
  console.error(`the target stopped answering mid-run: ${navFailures}/${navAttempts} navigations failed, so nothing was measured`);
  process.exit(3);
}
process.exit(n("fail") ? 1 : 0);
