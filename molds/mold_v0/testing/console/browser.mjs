// What the accessibility and responsiveness harnesses share: the VM-wide Playwright, a page that may reach the lane
// world only (127.0.0.1 / localhost: any other request is aborted and counted), loading one console page as the lane's
// person (or signed out), and the per-pack table every harness prints.
import { createRequire } from 'node:module';

export function playwright() {
  return createRequire('/usr/lib/node_modules/')('playwright');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const isLoopback = (u) => {
  try { return LOOPBACK.has(new URL(u).hostname); } catch { return false; }
};

/** A browser context for one page: signed in with fresh cookies, or signed out; every non-loopback request aborted. */
export async function contextFor(browser, ctx, page, options = {}) {
  if (!isLoopback(ctx.origin)) throw new Error(`refusing to grade ${ctx.origin}: the lane console is served on this machine only`);
  // No service worker (its fetches would bypass the route filter) and reduced motion (no fade caught half-way).
  const c = await browser.newContext({ baseURL: ctx.origin, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const outside = [];
  await c.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('data:') || u.startsWith('blob:') || isLoopback(u)) return route.continue();
    outside.push(new URL(u).host);
    return route.abort('blockedbyclient');
  });
  await c.routeWebSocket(/.*/, (ws) => {
    if (isLoopback(ws.url().replace(/^ws/, 'http'))) return ws.connectToServer();
    outside.push(new URL(ws.url()).host);
    return ws.close();
  });
  // `as`: one of the lane world's other people (world.mts sessionAs), else its workspace owner.
  if (page.signed_in) await c.addCookies(await (page.as && ctx.sessionAs?.[page.as] ? ctx.sessionAs[page.as]() : ctx.session()));
  return { context: c, outside };
}

/**
 * Load one page and let it settle: the network idle, then skeletons and spinners gone (up to 15s). Returns what the
 * harness needs to judge whether anything was rendered at all: the HTTP status, the address it ended on, the
 * interactive controls on it, and whether it is an error page.
 */
export async function load(p, ctx, page) {
  const res = await p.goto(page.path, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => ({ error: e }));
  if (res?.error) return { ok: false, why: `did not load: ${String(res.error.message).split('\n')[0]}` };
  const settled = await p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin'), null, { timeout: 15000 }).then(() => true, () => false);
  await p.waitForTimeout(300);
  const status = res?.status() ?? 0;
  const at = new URL(p.url());
  const facts = await p.evaluate(() => {
    const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="link"], [tabindex]:not([tabindex="-1"])')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    const text = document.body?.innerText ?? '';
    return { controls, error: /Application error|This page could not be found|Internal Server Error|Unhandled Runtime Error/.test(text) };
  });
  // A status page answers its own code (surface.mts `status`, mold_v0-131); any other page, under 400.
  if (status >= 400 && status !== page.status) return { ok: false, why: `HTTP ${status}` };
  if (page.signed_in && at.pathname.startsWith('/auth')) return { ok: false, why: `a signed-in page sent the lane's person to ${at.pathname}` };
  if (facts.error) return { ok: false, why: 'the page rendered an error page' };
  if (!facts.controls) return { ok: false, why: 'the page rendered no control to use: nothing was measured' };
  // A page still showing a skeleton or spinner after 15s is graded as it stands, and the row says so.
  return { ok: true, status, at: at.pathname, controls: facts.controls, note: settled ? '' : 'still loading after 15s (graded as it stood)' };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** The two tables every harness prints: a row per pack (its pages and how many failed), then a row per measurement. */
export function report(title, packs, rows) {
  const owners = ['shell', ...packs.map((p) => p.id)];
  for (const r of rows) if (!owners.includes(r.pack)) owners.push(r.pack);
  const out = [`### ${title}: a row per pack`, '', '| pack | pages | rows | failed | status |', '|---|---|---|---|---|'];
  for (const id of owners) {
    const mine = rows.filter((r) => r.pack === id);
    const pages = new Set(mine.map((r) => r.page)).size;
    const failed = mine.filter((r) => r.status === 'fail').length;
    const kind = id === 'shell' ? 'shell' : (packs.find((p) => p.id === id)?.kind ?? 'pack');
    // A pack that adds no console page has nothing here to grade: said so, never a pass.
    const status = !mine.length ? 'not-covered' : failed ? 'fail' : 'pass';
    out.push(`| ${cell(id)} (${kind}) | ${pages} | ${mine.length} | ${failed} | ${status === 'not-covered' ? 'not-covered (adds no console page)' : status} |`);
  }
  out.push('', `### ${title}: every row`, '', '| pack | page | measure | status | detail |', '|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${cell(r.pack)} | ${cell(r.page)} | ${cell(r.measure)} | ${r.status} | ${cell(r.detail)} |`);
  out.push('', `rows: ${rows.length} (${rows.filter((r) => r.status === 'fail').length} failed) over ${new Set(rows.map((r) => r.page)).size} pages`);
  return out.join('\n');
}
