// The responsiveness harness: every console page of the app's lane copy, as served by the lane world
// (../console/world.mts), at a phone, a tablet and a desktop width; a row per page and width, and a row per pack.
//   run from world.mts: run({origin, pages, packs, session, argv}); argv: --only layout|targets (default both)
// layout   fails when the page scrolls sideways (the document is wider than the window by more than 1px; the widest
//          element that sticks out is named), and on an HTTP error, an error page, a signed-in page that sends its person
//          to sign-in, or a page with no control to use.
// targets  phone and tablet only: a visible control smaller than 24x24 CSS px fails (WCAG 2.2 2.5.8) unless a 24px circle
//          on its centre touches no other control (the spacing exception), or it is a link inside a line of text (the
//          inline exception). Named in the detail column, so every exemption can be checked by a person.
// Layout is static: there is no timing budget here, so a slow machine cannot fail a row. Exit 0 all passed, 1 a row failed.
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

function targets() {
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="link"]';
  const all = [...document.querySelectorAll(sel)].map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'));
  const small = [], exempt = [];
  for (const t of all) {
    if (t.r.width >= 24 && t.r.height >= 24) continue;
    const label = `${t.e.tagName.toLowerCase()}${t.e.getAttribute('aria-label') ? `[${t.e.getAttribute('aria-label').slice(0, 30)}]` : ''} ${Math.round(t.r.width)}x${Math.round(t.r.height)}`;
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
  return { checked: all.length, small, exempt };
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
                `${t.checked} targets`, t.exempt.length ? `exempt: ${t.exempt.slice(0, 4).join(', ')}${t.exempt.length > 4 ? ` and ${t.exempt.length - 4} more` : ''}` : ''].filter(Boolean).join('; ') });
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
