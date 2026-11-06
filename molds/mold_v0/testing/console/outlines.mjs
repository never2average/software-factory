// The outline harness (mold_v0-251): every button and every text box a person can see on a console page has a visible
// outline, in the light and the dark theme. Run from world.mts, alone or in a suite:
//   render.py <app> --codebase <lane copy> --suite outlines [--pages auto]      (or: -- outlines.mjs [--widths 1280,390])
//   run({origin, pages, packs, session, argv}); argv: [--widths 1280,390] [--themes light,dark]
// What is measured, on each page, at each width and theme, in the page's main content and its top bar (the sidebar's
// navigation is left as it is, by design): every visible control that is a button (a <button> or [role=button] whose role is
// a button: not a tab, switch, checkbox, radio, menu item or option, which have their own look; any element the shared
// Button draws, [data-slot=button], a link drawn as a button included) and every text box (an <input> a person types into,
// a <textarea>; a box inside an input group is judged by its group's frame). Each must have a border on all four sides,
// drawn (not none or hidden), wider than zero, in a colour that is not transparent and shows against what is behind it
// (contrast 1.1:1 or more against the backdrop the border is drawn over, the element's own fill when it reaches under the
// border, else the nearest painted ancestor's). A row per page, width and theme: pass, or fail with the controls that have
// none (named by their text or label, tag and data-slot). Exit 0 / 1.
import { contextFor, load, playwright, report } from './browser.mjs';

const opt = (argv, k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const COLOR_MODE_KEY = 'console-color-mode';

/** In the page: the controls that lack a visible outline. */
export function measure() {
  const NOT_BUTTON = new Set(['tab', 'switch', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'treeitem', 'gridcell', 'row', 'link']);
  const TEXT = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time']);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  /** Any CSS colour (oklch, color-mix, rgba...) as sRGB 0-255 and alpha 0-1, read back off a canvas. */
  const rgba = (c) => {
    g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data; return [r, gg, b, a / 255];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = ([r, gg, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
  const contrast = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
  /** What a border of `el` is drawn over: its ancestors' fills, composited from the page down. */
  const backdrop = (el, includeSelf) => {
    const chain = [];
    for (let e = includeSelf ? el : el.parentElement; e; e = e.parentElement) chain.push(e);
    let col = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (col[3] === 0) col = rgba(getComputedStyle(document.body).backgroundColor);
    if (col[3] === 0) col = [255, 255, 255, 1];
    col = over(col, [255, 255, 255, 1]);
    for (const e of chain.reverse()) { const bg = rgba(getComputedStyle(e).backgroundColor); if (bg[3] > 0) col = over(bg, col); }
    return col;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  // Out of scope: the sidebar's navigation (and the docs' own page list, data-sidebar-nav), the info panel's edge handle,
  // and a date picker's day cells (scripts/console-outlines.ts ALLOW says why for each).
  const inScope = (el) => !el.closest('[data-sidebar], [data-slot="sidebar"], [data-slot="sidebar-container"], [data-sidebar-nav], [data-slot="infobar-rail"], [data-day]') && !!el.closest('main, header');
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(no name)';
  const seen = new Set(), bad = [];
  let n = 0;
  const judge = (el, what) => {
    if (seen.has(el)) return; seen.add(el);
    if (!inScope(el) || !visible(el)) return;
    n += 1;
    const s = getComputedStyle(el);
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const why = [];
    for (const side of sides) {
      const w = parseFloat(s[`border${side}Width`]), style = s[`border${side}Style`], c = rgba(s[`border${side}Color`]);
      // In a button group (components/ui/button-group.tsx) neighbours share an edge: the one after drops its own, the one
      // before draws it.
      const group = el.parentElement?.dataset.slot === 'button-group';
      const vertical = el.parentElement?.dataset.orientation === 'vertical';
      if (group && el.previousElementSibling && side === (vertical ? 'Top' : 'Left')) continue;
      if (!(w > 0) || style === 'none' || style === 'hidden') { why.push(`no ${side.toLowerCase()} border`); continue; }
      if (c[3] === 0) { why.push(`${side.toLowerCase()} border transparent`); continue; }
      const under = backdrop(el, s.backgroundClip === 'border-box');
      const k = contrast(over(c, under), under);
      if (k < 1.1) why.push(`${side.toLowerCase()} border ${k.toFixed(2)}:1 against its backdrop`);
    }
    if (why.length) bad.push(`${what} "${name(el)}" <${el.tagName.toLowerCase()}${el.dataset.slot ? ` data-slot=${el.dataset.slot}` : ''}>: ${[...new Set(why.map((w) => w.replace(/^(top|right|bottom|left) /, '')))].join(', ')}`);
  };
  for (const el of document.querySelectorAll('button, [role="button"], [data-slot="button"]')) {
    const role = el.getAttribute('role');
    if (role && NOT_BUTTON.has(role) && el.dataset.slot !== 'button') continue;
    // A part of a framed control (a chip and its remove mark: data-outline='group') is outlined by the frame; a clear mark
    // drawn inside another button, by that button.
    judge(el.closest('[data-outline="group"]') ?? (el.parentElement?.closest('button') || el), 'button');
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.tagName === 'INPUT' && !TEXT.has((el.getAttribute('type') || '').toLowerCase())) continue;
    const group = el.closest('[data-slot="input-group"]');
    judge(group ?? el, 'text box');
  }
  return { n, bad };
}

export async function run(ctx) {
  const widths = opt(ctx.argv, '--widths', '1280').split(',').map(Number).filter(Boolean);
  const themes = opt(ctx.argv, '--themes', 'light,dark').split(',').filter(Boolean);
  const browser = await playwright().chromium.launch();
  const rows = [];
  try {
    for (const page of ctx.pages) {
      for (const width of widths) {
        for (const theme of themes) {
          const phone = width < 600;
          const { context } = await contextFor(browser, ctx, page, { viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
          // The console keeps its theme per browser (components/themes/color-mode.ts); pages outside it have one look.
          await context.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }, [COLOR_MODE_KEY, theme]);
          const p = await context.newPage();
          const measureName = `outlines @ ${width} ${theme}`;
          try {
            const got = await load(p, ctx, page);
            if (!got.ok) { rows.push({ pack: page.pack, page: page.path, measure: measureName, status: 'fail', detail: got.why }); continue; }
            const isDark = await p.evaluate(() => document.documentElement.classList.contains('dark'));
            const m = await p.evaluate(measure);
            const shown = /^\/(app|admin)(\/|$)/.test(new URL(p.url()).pathname) && isDark !== (theme === 'dark') ? ` (the page drew ${isDark ? 'dark' : 'light'})` : '';
            rows.push({ pack: page.pack, page: page.path, measure: measureName, status: m.bad.length ? 'fail' : 'pass',
              detail: m.bad.length ? `${m.bad.length} of ${m.n} without an outline: ${m.bad.slice(0, 12).join('; ')}${m.bad.length > 12 ? '; ...' : ''}${shown}` : `${m.n} controls outlined${shown}${got.note ? `; ${got.note}` : ''}` });
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(report(`outlines (every button and text box in the main content and top bar; ${widths.join(', ')} px; ${themes.join(', ')})`, ctx.packs, rows));
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}
