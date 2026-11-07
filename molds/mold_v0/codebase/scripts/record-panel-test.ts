// The record panel (mold_v0-278), offline: `npm run test:record-panel` [-- --shots <dir>].
//   a. The layout (web/src/lib/split-panel.ts, pure): the default share per kind, the clamps, the table's minimum (too
//      narrow: the panel takes it all), the splitter's keys, the remembered share, closing keeps every other parameter.
//   b. The sources: every list's row opens the panel (RecordView), never a page; the header holds only Expand and ⋯;
//      no list passes the old detailActions; a create or edit form's side panel closes the record panel.
//   c. Drawn in a real browser (Playwright, the console's own components bundled with esbuild and its compiled CSS):
//      a row click opens the panel with ?id= and no navigation; another row switches it (the row highlighted); the
//      splitter resizes it by drag and by ← → Home End, remembered after a reload; Expand / Collapse (&panel=full); Esc
//      closes it and focus returns to the row; ↑ ↓ walk the rows; a reload reopens it; closing keeps the address's other
//      parameters and the search typed; the ⋯ menu's labelled items with Open in its own page; one panel at a time;
//      unsaved changes asked before switching or closing; on a phone, a full-width layer with Back to list.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const W = path.join(ROOT, "web");
const SRC = path.join(W, "src");
const src = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const ok = (m: string) => console.log(`✓ ${m}`);
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;

// ---------------------------------------------------------------- a. the layout
{
  const s = await import(pathToFileURL(path.join(SRC, "lib", "split-panel.ts")).href);
  assert.deepEqual(s.splitLayout(1000, null, "detail"), { width: 400, full: false, auto: false, min: 360, max: 640 });
  assert.equal(s.splitLayout(1000, null, "editor").width, 500, "an editor: half");
  assert.equal(s.splitLayout(1000, 0.9, "detail").width, 640, "never past the table's minimum");
  assert.equal(s.splitLayout(1000, 0.1, "detail").width, 360, "never below its own");
  assert.deepEqual(s.splitLayout(700, null, "detail"), { width: 700, full: true, auto: true, min: 360, max: 360 }, "too narrow: the whole space, no Expand");
  assert.equal(s.splitLayout(1000, null, "detail", true).full, true, "expanded: the whole space");
  assert.equal(s.splitWidthForKey("ArrowLeft", false, 400, 1000), 416);
  assert.equal(s.splitWidthForKey("ArrowRight", true, 400, 1000), 360);
  assert.equal(s.splitWidthForKey("Home", false, 500, 1000), 360);
  assert.equal(s.splitWidthForKey("End", false, 500, 1000), 640);
  assert.equal(s.splitWidthForKey("a", false, 500, 1000), null);
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(s.writeSplitRatio(store, "accounts", 0.5), true);
  assert.equal(s.readSplitRatio(store, "accounts"), 0.5);
  assert.equal(s.readSplitRatio(store, "runs"), null, "remembered per panel type");
  assert.equal(s.writeSplitRatio(store, "accounts", 2), false, "an impossible share refused");
  assert.equal(s.readSplitRatio({ getItem: () => { throw new Error("blocked"); }, setItem() {} }, "x"), null, "blocked storage: none");
  assert.equal(s.closedSearch("?overdue=1&id=R-1&panel=full&panelTab=logs&q=a"), "?overdue=1&q=a", "closing keeps every other parameter");
  ok("the layout: 40% for details and half for an editor, clamped between 360 px and the table's 360 px minimum, the whole space when too narrow (no Expand) or expanded; ← → Home End; the share remembered per type (blocked storage: none); closing drops ?id, &panel, &panelTab only");
}

// ---------------------------------------------------------------- b. the sources
{
  const rv = src("components/layout/record-view.tsx"), dp = src("components/layout/detail-panel.tsx"), sp = src("features/tabs/side-panel.tsx");
  assert.match(rv, /\{current && detail && \(\s*<RecordPanel /, "RecordView: the open record is the panel beside the list");
  assert.doesNotMatch(rv, /if \(current && detail\) return/, "never the list replaced by the record");
  assert.match(rv, /onClick=\{detail \? \(e\) => \{ if \(\(e\.target as HTMLElement\)\.closest\('a\[href\]'\)\) return; openRow\(k\); \}/, "a row click opens its panel (a link in a cell stays a link)");
  assert.match(rv, /useQueryStates\(\{ \[DETAIL_PARAM\]: parseAsString, \[PANEL_PARAM\]: parseAsString, \[PANEL_TAB_PARAM\]: parseAsString \}, \{ history: 'replace'/, "the open row in the address, replaced (Back leaves the list)");
  const controls = /data-slot='detail-panel-controls'>([\s\S]*?)<\/div>/.exec(dp)?.[1] ?? "";
  assert.match(controls, /data-testid='detail-panel-expand'/);
  assert.match(controls, /\{menu \?\? <PanelMenu /);
  assert.equal((controls.match(/<Button\b/g) ?? []).length, 1, "the header's right: only Expand (and the ⋯ menu)");
  assert.match(dp, /aria-label='Close panel' title='Close \(Esc\)'/);
  assert.doesNotMatch(dp, /aria-modal|backdrop|onKeyDown=\{trap/i, "no backdrop, no focus trap");
  assert.match(sp, /closeRecordPanel\(\);/, "a form's side panel closes the record panel (one panel at a time)");
  assert.match(sp, /&& !inRecordPanel;/, "a form inside the record panel opens in its place");
  // No list keeps the old header buttons, and none sends a row to a page.
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx$/.test(f.name)) files.push(p); } };
  walk(path.join(SRC, "features"));
  for (const f of files) {
    const t = readFileSync(f, "utf8"), rel = path.relative(SRC, f);
    assert.doesNotMatch(t, /detailActions=/, `${rel}: no detailActions (the panel's ⋯ menu holds them)`);
    assert.doesNotMatch(t, /onOpenChange=\{\(k\)[^}]*router\.push/, `${rel}: a row never navigates`);
    assert.doesNotMatch(t, /openKey=\{null\}/, `${rel}: a row opens its panel`);
  }
  ok(`the sources: RecordView's rows open the panel (the address keeps it), the header holds only Expand and ⋯, Close is the ✕ (Esc), no backdrop or trap; no list of ${files.length} feature files keeps header buttons or sends a row to a page; a form's side panel closes the record panel`);
}

// ---------------------------------------------------------------- c. drawn
const ENTRY = `import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
type R = { key: string; name: string; status: string };
const rows: R[] = Array.from({ length: 24 }, (_, i) => ({ key: 'R-' + (101 + i), name: 'Record ' + (i + 1), status: i % 3 ? 'Open' : 'Closed' }));
const cols: RecordCol<R>[] = [
  { key: 'name', label: 'Name', title: true, keep: true, type: 'text', value: (r) => r.name, render: (r) => r.name },
  { key: 'key', label: 'Key', type: 'text', value: (r) => r.key, render: (r) => r.key },
  { key: 'status', label: 'Status', type: 'select', options: [{ value: 'Open' }, { value: 'Closed' }], value: (r) => r.status, render: (r) => r.status },
];
function Editor({ r }: { r: R }) {
  const [saved, setSaved] = useState('');
  return (<form onSubmit={(e) => { e.preventDefault(); setSaved('saved'); }} className='flex flex-col gap-2'>
    <p>Details of {r.name}</p>
    <label className='flex flex-col gap-1'>Note<input name='note' data-note='' className='border px-2 py-1' /></label>
    <button type='submit' data-save=''>Save</button><span data-saved=''>{saved}</span>
  </form>);
}
const two = new URLSearchParams(location.search).has('two');
const list = (id: string, keyed: R[]) => <RecordView<R> id={id} rows={keyed} rowKey={(r) => r.key} cols={cols} searchText={(r) => r.name + ' ' + r.key} empty='None' noun='records'
  detailTitle={(r) => r.name} detail={(r) => <Editor r={r} />} actions={() => [{ label: 'Archive', onSelect: () => {} }]}
  panelActions={(r) => [{ label: 'Copy key', onSelect: () => { document.body.setAttribute('data-copied', r.key); } }]} pageHref={(r) => '/records/' + r.key} />;
createRoot(document.getElementById('root')!).render(<NuqsAdapter><div className='flex min-h-svh flex-col p-4'>
  {two ? <div className='flex flex-col gap-4'>{list('first', rows.slice(0, 4))}{list('second', rows.slice(4, 8).map((r) => ({ ...r, key: 'S-' + r.key })))}</div> : list('panel-test', rows)}
</div></NuqsAdapter>);
(window as any).__loaded = Date.now();
`;

const playwright = (() => { try { return createRequire("/usr/lib/node_modules/")("playwright"); } catch { return null; } })();
if (!playwright) { console.log("✓ (no Playwright on this machine: the drawn checks skipped)"); process.exit(0); }
const tmp = mkdtempSync(path.join(tmpdir(), "record-panel-"));
const stubs: Record<string, string> = {
  "render-panel-entry.tsx": ENTRY,
  "render-panel-link.tsx": "export default function Link({ href, children, replace: _r, scroll: _s, prefetch: _p, ...rest }: any) { return <a href={href} {...rest}>{children}</a>; }\n",
  "render-panel-nav.ts": "export const useSearchParams = () => new URLSearchParams(location.search); export const usePathname = () => location.pathname;\nexport const useRouter = () => ({ replace: (u: string) => history.replaceState(null, '', u), push: (u: string) => history.pushState(null, '', u), refresh() {}, back() {}, prefetch() {} });\nexport function notFound(): never { throw new Error('not found'); } export function redirect(): never { throw new Error('redirect'); }\nexport const useParams = () => ({});\n",
};
const req = createRequire(path.join(W, "package.json"));
let bundle: Buffer, css: string;
try {
  for (const [f, t] of Object.entries(stubs)) writeFileSync(path.join(W, f), t);
  const { build } = await import(pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("esbuild")).href);
  await build({ entryPoints: [path.join(W, "render-panel-entry.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(tmp, "bundle.js"), absWorkingDir: W,
    tsconfig: path.join(W, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
    alias: { "next/link": path.join(W, "render-panel-link.tsx"), "next/navigation": path.join(W, "render-panel-nav.ts") } });
  bundle = readFileSync(path.join(tmp, "bundle.js"));
  const from = path.join(SRC, "styles", "globals.css");
  css = (await req("postcss")([req("@tailwindcss/postcss")({ base: W })]).process(readFileSync(from, "utf8"), { from })).css as string;
} finally { for (const f of Object.keys(stubs)) rmSync(path.join(W, f), { force: true }); }

const server = createServer((rq, rs) => {
  const u = new URL(rq.url ?? "/", "http://x");
  if (u.pathname === "/bundle.js") { rs.writeHead(200, { "content-type": "text/javascript" }); return void rs.end(bundle); }
  const dark = u.searchParams.get("dark") === "1";
  rs.writeHead(200, { "content-type": "text/html" });
  rs.end(`<!doctype html><html class="${dark ? "dark" : ""}" style="color-scheme:${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});
server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await playwright.chromium.launch();
const failures: string[] = [];
const check = (cond: unknown, what: string) => { if (cond) ok(what); else { failures.push(what); console.log(`✗ ${what}`); } };
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(String(e)));
  const qs = () => p.evaluate(() => location.search);
  const panel = p.locator('[data-slot="detail-panel"]');
  const row = (k: string) => p.locator(`tr[data-row-key="${k}"]`);
  const width = (sel: string) => p.evaluate((s: string) => document.querySelector(s)?.getBoundingClientRect().width ?? 0, sel);
  const settle = () => p.waitForTimeout(250);

  await p.goto(`${base}/?view=open`);
  await row("R-102").waitFor();
  const loaded = await p.evaluate(() => (window as any).__loaded);
  const before = await width('[data-slot="list-main"]');
  await row("R-102").click(); await settle();
  check(await panel.isVisible() && (await panel.getAttribute("data-row")) === "R-102", "a row click opens its panel");
  check(/[?&]id=R-102\b/.test(await qs()) && /view=open/.test(await qs()), `the address has ?id= (and keeps the list's own: ${await qs()})`);
  check(await p.evaluate((t: number) => (window as any).__loaded === t && location.pathname === "/", loaded), "no navigation: the same page, never reloaded");
  const after = await width('[data-slot="list-main"]');
  check(after < before - 300 && after > 360, `the table column narrows (${Math.round(before)} → ${Math.round(after)} px) and stays`);
  check((await row("R-102").getAttribute("data-state")) === "selected", "the open row highlighted");
  const pw = await width('[data-slot="detail-panel-host"]');
  check(Math.abs(pw - 0.4 * (await width('[data-slot="list-split"]') - 12)) < 3, `40% of the space at first (${Math.round(pw)} px)`);
  check(await p.locator('[data-slot="detail-panel-host"]').evaluate((el: Element) => getComputedStyle(el).position) === "static", "inline beside the list, not a layer over it");
  check((await p.locator('[role="dialog"], [aria-modal="true"]').count()) === 0, "no dialog, no backdrop");
  check((await p.getByRole("button", { name: "Close panel" }).getAttribute("title")) === "Close (Esc)", "Close: a ✕ labelled Close panel, tooltip Close (Esc)");
  check(await p.getByTestId("detail-panel-title").innerText() === "Record 2", "the title on the left of the header");

  await row("R-104").click(); await settle();
  check((await panel.getAttribute("data-row")) === "R-104" && /id=R-104/.test(await qs()), "another row switches the panel");
  check((await row("R-102").getAttribute("data-state")) !== "selected" && (await row("R-104").getAttribute("data-state")) === "selected", "the highlight moves with it");
  check(await panel.innerText().then((t: string) => t.includes("Details of Record 4")), "its body is the new record's");

  // The splitter: keyboard, then drag.
  const sep = p.getByRole("separator", { name: "Resize the panel" });
  const w0 = await width('[data-slot="detail-panel-host"]');
  await sep.focus(); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await settle();
  const w1 = await width('[data-slot="detail-panel-host"]');
  check(Math.round(w1 - w0) === 32, `← widens it by 16 px a press (${Math.round(w0)} → ${Math.round(w1)})`);
  await p.keyboard.press("ArrowRight"); await settle();
  check(Math.round(w1 - (await width('[data-slot="detail-panel-host"]'))) === 16, "→ narrows it");
  await p.keyboard.press("Home"); await settle();
  check(Math.round(await width('[data-slot="detail-panel-host"]')) === 360, "Home: its narrowest (360 px)");
  await p.keyboard.press("End"); await settle();
  const space = (await width('[data-slot="list-split"]')) - 12;
  check(Math.abs((await width('[data-slot="detail-panel-host"]')) - (space - 360)) < 2, "End: its widest (the table keeps 360 px)");
  check((await panel.getAttribute("data-row")) === "R-104", "the splitter's arrows never walk the rows");
  await p.keyboard.press("Home"); await settle();
  const box = (await sep.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
  await p.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 8 }); await p.mouse.up(); await settle();
  const dragged = await width('[data-slot="detail-panel-host"]');
  check(Math.abs(dragged - 510) < 4, `a drag resizes it (360 → ${Math.round(dragged)} px)`);
  check(await p.evaluate(() => localStorage.getItem("panel-width:panel-test")) !== null, "the width remembered for this panel type");

  // A reload reopens it, at the remembered width.
  await p.reload(); await row("R-101").waitFor(); await settle();
  check((await panel.getAttribute("data-row")) === "R-104", "a reload reopens the panel from ?id=");
  check(Math.abs((await width('[data-slot="detail-panel-host"]')) - dragged) < 4, "at the width it was given");

  // Expand / Collapse.
  await p.getByTestId("detail-panel-expand").click(); await settle();
  check(/panel=full/.test(await qs()) && (await p.getByTestId("detail-panel-expand").innerText()).includes("Collapse"), "Expand: &panel=full, the button now Collapse");
  check(!(await p.locator('[data-slot="list-main"]').isVisible()) && Math.abs((await width('[data-slot="detail-panel-host"]')) - (await width('[data-slot="list-split"]'))) < 2, "expanded: the panel the list's whole width");
  check((await p.getByRole("separator").count()) === 0, "no splitter while expanded");
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, "harness-expanded-light-1440.png") }); }
  await p.reload(); await row("R-101").waitFor({ state: "attached" }); await settle();
  check(/panel=full/.test(await qs()) && !(await p.locator('[data-slot="list-main"]').isVisible()), "a reload keeps it expanded");
  await p.getByTestId("detail-panel-expand").click(); await settle();
  check(!/panel=/.test(await qs()) && await p.locator('[data-slot="list-main"]').isVisible(), "Collapse: beside the list again");

  // The ⋯ menu.
  await p.getByTestId("panel-actions").click(); await settle();
  const items = await p.locator('[data-testid="panel-actions-menu"] [role="menuitem"]').allInnerTexts();
  check(JSON.stringify(items.map((x: string) => x.trim())) === JSON.stringify(["Copy key", "Archive", "Open in its own page"]), `⋯: every other action labelled, Open in its own page last (${items.join(" | ")})`);
  check((await p.locator('[data-testid="panel-actions-menu"] a[role="menuitem"]').getAttribute("href")) === "/records/R-104", "Open in its own page links to the record's page");
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "harness-menu-light-1440.png") });
  await p.keyboard.press("Escape"); await settle();
  check(await panel.isVisible(), "Esc closes the menu first, not the panel");

  // Esc from inside the panel: closed, focus on the row; then ↑ ↓.
  await p.locator("[data-note]").focus(); await p.keyboard.press("Escape"); await settle();
  check(!(await panel.isVisible()) && !/id=/.test(await qs()), "Esc closes it (focus in the panel)");
  check(await p.evaluate(() => document.activeElement?.getAttribute("data-row-key")) === "R-104", "focus goes back to its row");
  await p.keyboard.press("Enter"); await settle();
  check((await panel.getAttribute("data-row")) === "R-104", "Enter on a focused row opens it");
  await p.keyboard.press("ArrowDown"); await settle();
  check((await panel.getAttribute("data-row")) === "R-105" && await p.evaluate(() => document.activeElement?.getAttribute("data-row-key")) === "R-105", "↓ opens the next row, focus with it");
  await p.keyboard.press("k"); await settle();
  check((await panel.getAttribute("data-row")) === "R-104", "k (↑) the one before");
  await p.keyboard.press("Escape"); await settle();
  check(!(await panel.isVisible()), "Esc with focus on the list closes it too");

  // Closing keeps every list filter.
  await p.getByRole("searchbox").fill("Record 1"); await settle();
  await row("R-110").click(); await settle();
  await p.getByTestId("detail-panel-expand").click(); await settle(); await p.getByTestId("detail-panel-expand").click(); await settle();
  await p.getByRole("button", { name: "Close panel" }).click(); await settle();
  check((await qs()) === "?view=open", `closing drops only the panel's parameters (${await qs()})`);
  check((await p.getByRole("searchbox").inputValue()) === "Record 1" && (await row("R-102").count()) === 0, "and keeps the search typed");
  await p.getByRole("searchbox").fill(""); await settle();

  // Unsaved changes.
  await row("R-106").click(); await settle();
  await p.locator("[data-note]").fill("half written");
  await row("R-107").click(); await settle();
  check(await p.getByTestId("unsaved-dialog").isVisible(), "unsaved changes: switching rows asks first");
  await p.getByTestId("unsaved-keep").click(); await settle();
  check((await panel.getAttribute("data-row")) === "R-106" && (await p.locator("[data-note]").inputValue()) === "half written", "Keep editing: the same record, the text kept");
  await p.getByRole("button", { name: "Close panel" }).click(); await settle();
  check(await p.getByTestId("unsaved-dialog").isVisible(), "closing asks too");
  await p.getByTestId("unsaved-keep").click(); await settle();
  await row("R-107").click(); await settle();
  await p.getByTestId("unsaved-discard").click(); await settle();
  check((await panel.getAttribute("data-row")) === "R-107", "Discard changes: switched");
  await p.locator("[data-note]").fill("kept"); await p.locator("[data-save]").click(); await settle();
  await row("R-108").click(); await settle();
  check((await p.getByTestId("unsaved-dialog").count()) === 0 && (await panel.getAttribute("data-row")) === "R-108", "saved: switching asks nothing");
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "harness-open-light-1440.png") });

  // One panel at a time.
  await p.goto(`${base}/?two=1`); await row("R-101").waitFor();
  await row("R-101").click(); await settle();
  await row("S-R-106").click(); await settle();
  check((await panel.count()) === 1 && (await panel.getAttribute("data-row")) === "S-R-106", "one panel at a time: opening another list's closes the first");
  check(!errors.length, `no page error (${errors.join("; ")})`);
  await ctx.close();

  // A phone: the full-width layer with Back to list.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", colorScheme: "dark", hasTouch: true });
  const m = await phone.newPage();
  await m.goto(`${base}/?dark=1`); await m.locator('tr[data-row-key="R-103"]').waitFor();
  await m.locator('tr[data-row-key="R-103"]').click(); await m.waitForTimeout(250);
  const layer = await m.locator('[data-slot="detail-panel-host"]').evaluate((el: Element) => { const r = el.getBoundingClientRect(); return { pos: getComputedStyle(el).position, w: r.width, top: r.top }; });
  check(layer.pos === "fixed" && Math.round(layer.w) === 390 && layer.top === 64, `a phone: a full-width layer under the top bar (${JSON.stringify(layer)})`);
  check(await m.getByTestId("detail-panel-back").isVisible() && (await m.getByTestId("detail-panel-back").innerText()).includes("Back to list"), "with Back to list");
  check(!(await m.getByTestId("detail-panel-expand").isVisible()) && (await m.getByRole("separator").count()) === 0 || !(await m.getByRole("separator").isVisible()), "no Expand and no splitter on a phone");
  if (SHOTS) await m.screenshot({ path: path.join(SHOTS, "harness-phone-dark-390.png") });
  await m.getByTestId("detail-panel-back").click(); await m.waitForTimeout(250);
  check(!(await m.locator('[data-slot="detail-panel"]').isVisible()) && !/id=/.test(await m.evaluate(() => location.search)), "Back to list closes it");
  await phone.close();
} finally { await browser.close(); server.close(); rmSync(tmp, { recursive: true, force: true }); }
if (failures.length) { console.error(`\n${failures.length} drawn check(s) failed:\n  ${failures.join("\n  ")}`); process.exit(1); }
ok("drawn: every panel behaviour above, in a real browser at 1440 px and 390 px");
