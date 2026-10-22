// The accessibility harness: axe-core (vendored, vendor/axe.min.js) over every console page of the app's lane copy, as
// served by the lane world (../console/world.mts), a row per page and a row per pack.
//   run from world.mts: run({origin, pages, packs, session, argv})
// A page fails on: a serious or critical violation of a WCAG 2.0/2.1/2.2 A or AA rule; an HTTP error, an error page, a
// signed-in page that sends its person to sign-in, or a page with no control to use (nothing measured is never a pass).
// Moderate and minor violations, and axe's `incomplete` (needs a person to judge), are counted in the detail column.
// Exit code: 0 every row passed, 1 a row failed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFor, load, playwright, report } from '../console/browser.mjs';

const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const FAILING = new Set(['serious', 'critical']);

export async function run(ctx) {
  const browser = await playwright().chromium.launch();
  const rows = [];
  try {
    for (const page of ctx.pages) {
      const { context, outside } = await contextFor(browser, ctx, page, { viewport: { width: 1280, height: 900 } });
      const p = await context.newPage();
      try {
        const got = await load(p, ctx, page);
        if (!got.ok) { rows.push({ pack: page.pack, page: page.path, measure: 'axe', status: 'fail', detail: got.why }); continue; }
        await p.addScriptTag({ content: AXE });
        const r = await p.evaluate(async (tags) => {
          const res = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
          return {
            violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(' ') ?? '' })),
            incomplete: res.incomplete.length,
          };
        }, TAGS);
        const bad = r.violations.filter((v) => FAILING.has(v.impact));
        const other = r.violations.filter((v) => !FAILING.has(v.impact));
        const detail = [
          bad.map((v) => `${v.impact} ${v.id} x${v.nodes} (${v.target.slice(0, 60)})`).join('; '),
          other.length ? `not failing: ${other.map((v) => `${v.impact} ${v.id} x${v.nodes}`).join(', ')}` : '',
          `${got.controls} controls`, got.note, r.incomplete ? `${r.incomplete} incomplete (a person must judge)` : '',
          outside.length ? `${outside.length} request(s) off this machine aborted (${[...new Set(outside)].slice(0, 3).join(', ')})` : '',
        ].filter(Boolean).join('; ');
        rows.push({ pack: page.pack, page: page.path, measure: 'axe', status: bad.length ? 'fail' : 'pass', detail });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(report('axe (WCAG 2.2 A/AA, serious and critical fail)', ctx.packs, rows));
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}
