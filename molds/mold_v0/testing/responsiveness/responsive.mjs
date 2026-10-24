// The responsiveness harness: every console page of the app's lane copy, as served by the lane world
// (../console/world.mts), at a phone, a tablet and a desktop width; a row per page and width, and a row per pack.
//   run from world.mts: run({origin, pages, packs, session, argv}); argv: --only layout|targets (default both)
// layout   fails when the page scrolls sideways (the document is wider than the window by more than 1px; the widest
//          element that sticks out is named), and on an HTTP error, an error page, a signed-in page that sends its person
//          to sign-in, or a page with no control to use.
// targets  phone and tablet only: a visible control smaller than 24x24 CSS px fails (WCAG 2.2 2.5.8) unless a 24px circle
//          on its centre touches no other control (the spacing exception), or it is a link inside a line of text (the
//          inline exception). Named in the detail column, so every exemption can be checked by a person.
//          A control a person cannot see at all is not a target (mold_v0-088): one wholly outside the visible box of an
//          ancestor that clips its content (a table scrolled inside its own box, a closed panel with overflow hidden) is
//          left out, both as a target and as a neighbour, and named in the detail column ("not targets, clipped out of view").
//          Only a control with no visible pixel is left out: one partly inside its box is measured whole, as before.
// Layout is static: there is no timing budget here, so a slow machine cannot fail a row. Exit 0 all passed, 1 a row failed.
//   node responsive.mjs --self-test   the tap-target rules on fixed pages in the browser (no lane world): clipped controls
//                                     left out, visible and partly visible ones still measured; exit 0 when all hold
import { pathToFileURL } from 'node:url';
import { contextFor, load, playwright, report } from '../console/browser.mjs';

const VIEWPORTS = [
  { name: 'phone 390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, targets: true },
  { name: 'tablet 820', viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, targets: true },
  { name: 'desktop 1440', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, targets: false },
];

function layout() {
  const doc = document.documentElement;
  // clientWidth, not innerWidth: mobile emulation can widen the layout viewport to fit what overflows.
  const width = doc.clientWidth;
  const over = doc.scrollWidth - width;
  if (over <= 1) return { over: 0, culprit: '' };
  // The element that sticks out furthest and is not inside something that scrolls sideways itself.
  let worst = null, right = width + 1;
  const scrolls = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
  for (const e of document.body.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (r.width && r.right > right && !scrolls(e)) { right = r.right; worst = e; }
  }
  const name = worst ? `${worst.tagName.toLowerCase()}${worst.id ? '#' + worst.id : ''}${worst.classList[0] ? '.' + worst.classList[0] : ''}` : 'unknown';
  return { over, culprit: `${name} reaches ${Math.round(right)}px` };
}

export function targets() {
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="link"]';
  // Is any pixel of `e` (its border box `r`) inside every ancestor box that clips it? Walks the containing-block chain:
  // an ancestor with overflow other than visible clips what it contains, except a descendant positioned against a box
  // outside it (absolute: the nearest positioned or transformed ancestor; fixed: the window unless an ancestor is
  // transformed). The page itself (html, body) is not a clip: the person scrolls the page to anything below the fold.
  const shown = (e, r) => {
    let l = r.left, t = r.top, rt = r.right, b = r.bottom;
    const cs = getComputedStyle;
    const makesBlock = (s) => s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain);
    let pos = cs(e).position;
    for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      const contains = pos === 'fixed' ? makesBlock(s) : pos === 'absolute' ? s.position !== 'static' || makesBlock(s) : true;
      if (!contains) continue;
      const clipX = s.overflowX !== 'visible', clipY = s.overflowY !== 'visible';
      if (clipX || clipY) {
        const ar = a.getBoundingClientRect(), x0 = ar.left + a.clientLeft, y0 = ar.top + a.clientTop;
        if (clipX) { l = Math.max(l, x0); rt = Math.min(rt, x0 + a.clientWidth); }
        if (clipY) { t = Math.max(t, y0); b = Math.min(b, y0 + a.clientHeight); }
        if (rt - l < 1 || b - t < 1) return false;
      }
      pos = s.position;
    }
    return true;
  };
  const drawn = [...document.querySelectorAll(sel)].map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'));
  const all = drawn.filter(({ e, r }) => shown(e, r));
  const labelOf = (t) => `${t.e.tagName.toLowerCase()}${t.e.getAttribute('aria-label') ? `[${t.e.getAttribute('aria-label').slice(0, 30)}]` : ''} ${Math.round(t.r.width)}x${Math.round(t.r.height)}`;
  const clipped = drawn.filter((t) => !all.includes(t)).map(labelOf);
  const small = [], exempt = [];
  for (const t of all) {
    if (t.r.width >= 24 && t.r.height >= 24) continue;
    const label = labelOf(t);
    // Inline: a link that sits inside running text.
    if (t.e.tagName === 'A' && getComputedStyle(t.e).display === 'inline' && (t.e.parentElement?.innerText ?? '').trim().length > (t.e.innerText ?? '').trim().length + 20) { exempt.push(`${label} inline`); continue; }
    const cx = t.r.left + t.r.width / 2, cy = t.r.top + t.r.height / 2;
    const touches = all.some((o) => {
      if (o === t || o.e.contains(t.e) || t.e.contains(o.e)) return false;
      const nx = Math.max(o.r.left, Math.min(cx, o.r.right)), ny = Math.max(o.r.top, Math.min(cy, o.r.bottom));
      return Math.hypot(nx - cx, ny - cy) < 12;
    });
    if (touches) small.push(label); else exempt.push(`${label} spaced`);
  }
  return { checked: all.length, clipped, small, exempt };
}

export async function run(ctx) {
  const only = ctx.argv.includes('--only') ? ctx.argv[ctx.argv.indexOf('--only') + 1] : null;
  const measures = only ? [only] : ['layout', 'targets'];
  const browser = await playwright().chromium.launch();
  const rows = [];
  try {
    for (const page of ctx.pages) {
      for (const vp of VIEWPORTS) {
        const want = measures.filter((m) => m === 'layout' || vp.targets);
        if (!want.length) continue;
        const { name, targets: _t, ...opts } = vp;
        const { context } = await contextFor(browser, ctx, page, opts);
        const p = await context.newPage();
        try {
          const got = await load(p, ctx, page);
          if (!got.ok) { for (const m of want) rows.push({ pack: page.pack, page: page.path, measure: `${m} @ ${name}`, status: 'fail', detail: got.why }); continue; }
          if (want.includes('layout')) {
            const l = await p.evaluate(layout);
            rows.push({ pack: page.pack, page: page.path, measure: `layout @ ${name}`, status: l.over ? 'fail' : 'pass',
              detail: [l.over ? `scrolls sideways by ${l.over}px; ${l.culprit}` : `fits ${vp.viewport.width}px; ${got.controls} controls`, got.note].filter(Boolean).join('; ') });
          }
          if (want.includes('targets')) {
            const t = await p.evaluate(targets);
            rows.push({ pack: page.pack, page: page.path, measure: `targets @ ${name}`, status: t.small.length ? 'fail' : 'pass',
              detail: [t.small.length ? `under 24px with a neighbour: ${t.small.slice(0, 6).join(', ')}${t.small.length > 6 ? ` and ${t.small.length - 6} more` : ''}` : '',
                `${t.checked} targets`, t.clipped.length ? `not targets, clipped out of view by a box that scrolls or clips: ${t.clipped.slice(0, 4).join(', ')}${t.clipped.length > 4 ? ` and ${t.clipped.length - 4} more` : ''}` : '', t.exempt.length ? `exempt: ${t.exempt.slice(0, 4).join(', ')}${t.exempt.length > 4 ? ` and ${t.exempt.length - 4} more` : ''}` : ''].filter(Boolean).join('; ') });
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(report(`viewports (${measures.join(', ')})`, ctx.packs, rows));
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}

// ---- self-test: targets() on fixed pages at the phone width -------------------------------------------------------
const FIXTURE = `<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; } button { display: block; padding: 0; border: 0; margin: 0; }
  .sw { width: 32px; height: 18px; } .sq { width: 20px; height: 20px; }
</style></head><body>
  <!-- Each small control has another one 0-2px under it (within 12px of its centre) unless it is clipped away. -->
  <!-- 1. A table scrolled inside its own box: a switch below the box's bottom edge sits where the pager is drawn. -->
  <div style="height: 100px; overflow: auto; margin-top: 10px">
    <button class="sw" role="switch" aria-label="seen in box"></button><button class="sq" aria-label="under it"></button>
    <div style="height: 62px"></div>
    <button class="sw" role="switch" aria-label="scrolled away"></button>
    <div style="height: 300px"></div>
  </div>
  <button class="sq" aria-label="pager"></button>
  <!-- 2. A row scrolled sideways: the switch past the right edge of its box is clipped. -->
  <div style="margin-top: 60px; width: 200px; overflow-x: auto; white-space: nowrap">
    <span style="display: inline-block; width: 600px"></span><button class="sw" role="switch" aria-label="scrolled sideways" style="display: inline-block"></button>
  </div>
  <button class="sq" aria-label="under the row" style="margin-left: 205px"></button>
  <!-- 3. Half inside its box: measured whole, so it fails beside its neighbour as before. -->
  <div style="margin-top: 60px; height: 30px; overflow: hidden"><div style="height: 21px"></div><button class="sw" role="switch" aria-label="half shown"></button></div>
  <button class="sq" aria-label="under half" style="margin-top: 2px"></button>
  <!-- 4. Absolute against a box outside the clipping parent: drawn outside it, so not clipped. -->
  <div style="position: relative; margin-top: 60px; height: 60px">
    <div style="overflow: hidden; height: 10px"><button class="sw" role="switch" aria-label="escapes absolute" style="position: absolute; top: 30px; left: 0"></button></div>
    <button class="sq" aria-label="under absolute" style="position: absolute; top: 49px; left: 0"></button>
  </div>
  <!-- 5. Fixed inside a clipping parent: drawn against the window, so not clipped. -->
  <div style="overflow: hidden; height: 1px"><button class="sw" role="switch" aria-label="escapes fixed" style="position: fixed; bottom: 24px; left: 300px"></button></div>
  <button class="sq" aria-label="under fixed" style="position: fixed; bottom: 3px; left: 300px"></button>
  <!-- 6. Below the fold of the page itself: the page scrolls, so it is a target. -->
  <div style="height: 1400px"></div><button class="sw" role="switch" aria-label="below the fold"></button><button class="sq" aria-label="under fold"></button>
</body></html>`;

async function selfTest() {
  const browser = await playwright().chromium.launch();
  const fails = [];
  try {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await c.newPage();
    await p.setContent(FIXTURE);
    const t = await p.evaluate(targets);
    const small = t.small.join(' | ');
    const has = (label) => small.includes(`[${label}]`);
    const want = (ok, what) => { if (!ok) fails.push(what); };
    want(t.clipped.length === 2 && t.clipped.some((c) => c.includes('[scrolled away]')) && t.clipped.some((c) => c.includes('[scrolled sideways]')),
      `two controls clipped out of view (scrolled away, scrolled sideways), got ${t.clipped.join(', ')}`);
    want(!has('scrolled away') && !has('scrolled sideways'), 'a clipped control is not a target');
    want(!has('pager') && !has('under the row'), 'a clipped control is not a neighbour: the pager under the box has none');
    want(has('seen in box') && has('under it'), 'controls visible inside a scrolling box are still measured');
    want(has('half shown'), 'a control partly inside its box is measured whole');
    want(has('escapes absolute') && has('under absolute'), 'an absolute control drawn outside a clipping parent that does not contain it is measured');
    want(has('escapes fixed') && has('under fixed'), 'a fixed control inside a clipping parent is measured');
    want(has('below the fold') && has('under fold'), 'a control below the fold of the page is measured');
    if (fails.length) console.error(`small: ${small}\nexempt: ${t.exempt.join(' | ')}`);
  } finally {
    await browser.close();
  }
  if (fails.length) { console.error(`responsive: self-test failed:\n  ${fails.join('\n  ')}`); return 1; }
  console.log('responsive: 8 checks passed (tap targets: clipped controls left out as targets and neighbours; visible, partly visible, absolute, fixed and below-the-fold ones measured)');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--self-test')) process.exit(await selfTest());
