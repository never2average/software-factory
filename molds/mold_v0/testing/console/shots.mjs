// The screenshot harness (mold_v0-147): a full-page screenshot of every page the lane world serves (or the pages
// render.py --pages chose), at a phone and a desktop width, for a person to look at. Run from world.mts, usually in a suite
// with the lanes' own harnesses: render.py <app> --codebase <lane copy> --suite a11y,layout,shots [--pages auto].
//   run({origin, pages, packs, session, argv}); argv: --dir <folder> [--widths 390,1280]
// A row per page and width: pass when the page loaded and rendered something to use (browser.mjs load(): the same bar as
// the lanes), with the file written; fail when it did not. Files: <dir>/<page path as a name>@<width>.png. Exit 0 / 1.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { contextFor, load, playwright, report } from './browser.mjs';

const opt = (argv, k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
export const fileName = (path, width) =>
  `${(path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_')) || 'home'}@${width}.png`;

export async function run(ctx) {
  const dir = opt(ctx.argv, '--dir', 'lane-shots');
  const widths = opt(ctx.argv, '--widths', '390,1280').split(',').map(Number).filter(Boolean);
  mkdirSync(dir, { recursive: true });
  const browser = await playwright().chromium.launch();
  const rows = [];
  try {
    for (const page of ctx.pages) {
      for (const width of widths) {
        const phone = width < 600;
        const { context } = await contextFor(browser, ctx, page, { viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
        const p = await context.newPage();
        try {
          const got = await load(p, ctx, page);
          const file = join(dir, `${page.pack === 'shell' ? '' : page.pack + '--'}${fileName(page.path, width)}`);
          if (got.ok) await p.screenshot({ path: file, fullPage: true });
          rows.push({ pack: page.pack, page: page.path, measure: `shot @ ${width}`, status: got.ok ? 'pass' : 'fail', detail: got.ok ? [file, got.note].filter(Boolean).join('; ') : got.why });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(report(`screenshots (${widths.join(', ')} px) in ${dir}`, ctx.packs, rows));
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}
