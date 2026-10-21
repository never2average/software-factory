// Console tabs from pack.json (mold_v0-058; molds/mold_v0/MOLD.md "Pack and record-area contract"), and the charts that
// draw the metrics (mold_v0-063).
//   npm run test:console-tabs            offline
//   CONSOLE_TABS_TYPECHECK=off           skip the TypeScript check of the build copy (the slow part)
//   CONSOLE_TABS_SNAPSHOT_DIR=<dir>      keep the rendered page (DOM) and screenshots (light, dark) there
//   CONSOLE_TABS_CSS=<file>              the console's compiled CSS for the screenshots (from a next build)
//
// 1. Zero packs: the console's sidebar (/app and /admin) is exactly what it was before tabs existed (a snapshot taken
//    from the code before mold_v0-058: scripts/fixtures/console-nav/zero-packs.json), and the pack page route has no page.
//    A pack with no tabs (fixture_tracker) keeps the shell's sidebar plus what the pack adds, as before (fixture_tracker.json).
// 2. Packs that declare tabs (fixture_vulns, fixture_adoption): the /app sidebar is exactly the declared tabs, in order and
//    groups, each tab limited to the roles that may read what it shows; each tab with a page of its own is a page of the
//    route; the /admin sidebar is unchanged by tabs.
// 3. A rendered check in a headless browser (when the machine has one: CHROME_BIN, or a Playwright cache): the console's
//    chart and board components, bundled, drawing the vulnerability overview and the board: bars, lines and stacks with
//    colour tokens only (no hex), legends for two series or more, an ordinal ramp for severity, an accessible summary
//    per chart, a table view; the board's columns are the lifecycle's states in order.
// 4. The build copy's console typechecks with the tabs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "console-tabs-"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SNAP = path.join(ROOT, "scripts", "fixtures", "console-nav");

/** A build copy of the codebase with these fixture packs, its registry generated (node_modules linked, never written). */
function buildCopy(name: string, packs: string[]) {
  const copy = path.join(TMP, name);
  const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
  for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
  mkdirSync(path.join(copy, "packs"), { recursive: true });
  cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
  for (const p of packs) cpSync(path.join(ROOT, "scripts", "fixtures", "packs", p), path.join(copy, "packs", p), { recursive: true });
  const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
  assert.equal(g.status, 0, `gen-packs in the ${name} copy: ${g.stderr}`);
  return copy;
}

/** Run a TypeScript module of the console (its "@/..." imports resolved) in `web`, and parse what it prints. */
function inConsole<T>(web: string, code: string, args: string[] = []): T {
  const file = path.join(web, `probe-${Math.random().toString(36).slice(2)}.tsx`);
  writeFileSync(file, code);
  try {
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file, ...args], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `console probe: ${r.stderr.slice(0, 2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(file, { force: true }); }
}
const NAV = `import { portalNav, adminNav } from '@/config/nav-config';
import { packPageParams } from '@/features/packs/registry';
import { tabPageParams, findTab } from '@/features/tabs/registry';
import { tabPortalNav, packTabs } from '@/config/pack-nav.generated';
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, adminNav, tabPortalNav, packTabs, params: [...packPageParams('app'), ...tabPageParams()],
  vulnerabilities: findTab('fixture_vulns', 'vulnerabilities'), billing: findTab('fixture_vulns', 'billing') }));
`;
type Nav = { portalNav: any[]; adminNav: any[]; tabPortalNav: any[]; packTabs: any[]; params: { pack: string; page: string }[]; vulnerabilities: any; billing: any };
const navOnly = (n: Nav) => JSON.stringify({ portalNav: n.portalNav, adminNav: n.adminNav }, null, 1);

/** A headless Chrome on this machine: CHROME_BIN, else one a Playwright install left in its cache. */
function findChrome(): string | null {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
    for (const sub of existsSync(path.join(cache, d)) ? readdirSync(path.join(cache, d)) : []) {
      const bin = path.join(cache, d, sub, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  return null;
}

/**
 * Draw the vulnerability overview's charts, one chart's table view and the board in a real browser: the console's own
 * components (charts.tsx, board.tsx), bundled with esbuild, fixed width, the theme's tokens; then read the DOM back.
 * With CONSOLE_TABS_SNAPSHOT_DIR, also a screenshot in the light and the dark theme.
 */
async function renderInBrowser(chrome: string, web: string, input: unknown) {
  const { build } = await import("esbuild");
  const dir = path.join(TMP, "render");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(web, "render-entry.tsx"), `import { createRoot } from 'react-dom/client';
import { packCharts, packTabs, recordAreas } from '@/config/pack-nav.generated';
import { ChartCell } from '@/features/tabs/charts';
import { BoardColumns } from '@/features/tabs/board';
const { answers, records } = (window as unknown as { __INPUT__: { answers: { name: string }[]; records: never } }).__INPUT__;
const results = new Map(answers.map((a) => [a.name, a]));
const tab = packTabs.find((t) => t.pack === 'fixture_vulns' && t.id === 'overview')!;
const chart = (n: string) => packCharts.find((c) => c.pack === 'fixture_vulns' && c.name === n)!;
const area = recordAreas.find((a) => a.name === 'audit_findings')!;
createRoot(document.getElementById('root')!).render(
  <div className='grid border-t border-l lg:grid-cols-2' style={{ width: 1180 }}>
    {tab.charts.map((n) => <div key={n} data-chart={n}><ChartCell chart={chart(n)} results={results as never} width={540} /></div>)}
    <div data-table='severity'><ChartCell chart={{ ...chart('severity'), type: 'table' }} results={results as never} width={540} /></div>
    <div data-board='1' style={{ gridColumn: '1 / -1' }}><BoardColumns area={area} by='state' detail data={records} /></div>
  </div>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 1500);
`);
  writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
  try {
    await build({ entryPoints: [path.join(web, "render-entry.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(dir, "bundle.js"), absWorkingDir: web,
      tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error" });
  } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(web, f), { force: true }); }
  // The theme's tokens (web/src/styles: the theme's surfaces and text, the chart colours), and the console's compiled CSS when given.
  const theme = readFileSync(path.join(web, "src", "styles", "themes", "supabase.css"), "utf8").replace(/\[data-theme='supabase'\] \{\s*@theme[\s\S]*$/, "");
  const viz = readFileSync(path.join(web, "src", "styles", "theme.css"), "utf8");
  const css = `${theme}\n${viz.slice(viz.indexOf("/*\n * Chart colours"))}\n${process.env.CONSOLE_TABS_CSS ? readFileSync(process.env.CONSOLE_TABS_CSS, "utf8") : ""}
    body { background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; margin: 16px; }`;
  const page = (dark: boolean) => {
    const f = path.join(dir, dark ? "dark.html" : "light.html");
    writeFileSync(f, `<!doctype html><html data-theme="supabase" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"></div><script>window.__INPUT__ = ${JSON.stringify(input).replace(/</g, "\\u003c")};</script><script src="bundle.js"></script></body></html>`);
    return f;
  };
  const args = ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=8000", "--window-size=1220,3200"];
  const r = spawnSync(chrome, [...args, "--dump-dom", `file://${page(false)}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `the browser ran: ${r.stderr.slice(0, 1000)}`);
  const dom = r.stdout;
  assert.match(dom, /data-ready="1"/, `the page rendered (${dom.slice(0, 300)})`);
  const between = (open: RegExp) => { const m = open.exec(dom); if (!m) return ""; const rest = dom.slice(m.index); const next = rest.slice(1).search(/<div data-(chart|table|board)=/); return next < 0 ? rest : rest.slice(0, next + 1); };
  const charts: Record<string, string> = {};
  for (const m of dom.matchAll(/<div data-chart="([a-z_]+)">/g)) charts[m[1]!] = between(new RegExp(`<div data-chart="${m[1]}">`));
  if (process.env.CONSOLE_TABS_SNAPSHOT_DIR) {
    mkdirSync(process.env.CONSOLE_TABS_SNAPSHOT_DIR, { recursive: true });
    for (const dark of [false, true])
      spawnSync(chrome, [...args, `--screenshot=${path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, dark ? "overview-dark.png" : "overview-light.png")}`, `file://${page(dark)}`], { timeout: 120_000 });
    writeFileSync(path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, "dom.html"), dom);
  }
  return { charts, table: between(/<div data-table="severity">/), board: between(/<div data-board="1"/) };
}

try {
  // ---------- 1. zero packs, and a pack with no tabs ----------
  {
    const zero = inConsole<Nav>(path.join(ROOT, "web"), NAV);
    assert.equal(navOnly(zero), readFileSync(path.join(SNAP, "zero-packs.json"), "utf8").trim(), "zero packs: the /app and /admin sidebars are exactly as before mold_v0-058");
    assert.deepEqual([zero.tabPortalNav, zero.packTabs, zero.params], [[], [], []], "zero packs: no tab, and the pack page route has no page (its placeholder is a 404)");
    const tracker = inConsole<Nav>(path.join(buildCopy("tracker", ["fixture_tracker"]), "web"), NAV);
    assert.equal(navOnly(tracker), readFileSync(path.join(SNAP, "fixture_tracker.json"), "utf8").trim(), "a pack with no tabs: the shell's sidebar and its additions, as before");
    console.log("✓ zero packs: the /app and /admin sidebars equal the snapshot taken before tabs (and no tab page); a pack with no tabs keeps the old sidebar too");
  }

  // ---------- 2. packs that declare tabs ----------
  const copy = buildCopy("tabs", ["fixture_vulns", "fixture_adoption"]);
  const web = path.join(copy, "web");
  {
    const nav = inConsole<Nav>(web, NAV);
    assert.deepEqual(nav.portalNav, nav.tabPortalNav, "the /app sidebar is the declared tabs");
    const shape = nav.portalNav.map((g) => [g.label, g.items.map((i: any) => `${i.title} ${i.url}`)]);
    assert.deepEqual(shape, [
      ["Adoption", ["Pick rate /app/packs/fixture_adoption/pick-rate", "Tasks /app/packs/fixture_adoption/tasks", "Products /app/packs/fixture_adoption/products", "Simulations /app/packs/fixture_adoption/simulations"]],
      ["Account", ["Usage /app/activity", "Profile /app/profile"]],
      ["Audit", ["Overview /app/packs/fixture_vulns/overview", "Vulnerabilities /app/packs/fixture_vulns/vulnerabilities", "Applications /app/packs/fixture_vulns/applications",
        "Controls /app/packs/fixture_vulns/controls", "Audits /app/packs/fixture_vulns/audits", "Reports /app/packs/fixture_vulns/reports"]],
      ["Workspace", ["Application tokens /app/credentials", "Due soon /app/notices", "Activity /app/activity", "Billing /app/billing"]],
    ], "exactly the declared tabs, in order, grouped, labels in the pack's words (an area tab is named by its area), the shell's pages at their own addresses");
    const item = (t: string) => nav.portalNav.flatMap((g) => g.items).find((i: any) => i.title === t);
    assert.deepEqual(item("Applications").roles, ["member", "billing", "owner"], "an area a viewer may not read: its tab is not a viewer's");
    assert.deepEqual(item("Billing").roles, ["billing", "owner"], "a tab's own roles");
    assert.deepEqual(item("Vulnerabilities").roles, ["viewer", "member", "billing", "owner"]);
    assert.deepEqual([item("Overview").icon, item("Reports").icon, item("Vulnerabilities").icon], ["dashboard", "page", "shield"], "icons from the fixed set (a kind's own by default)");
    assert.ok(!nav.portalNav.flatMap((g) => g.items).some((i: any) => /pick-rate$|\/app\/personas|\/app\/tasks$|\/app\/context/.test(i.url) && !i.url.includes("/packs/")), "none of the shell's own product pages");
    assert.deepEqual(nav.params.map((p) => `${p.pack}/${p.page}`), ["fixture_adoption/pick-rate", "fixture_adoption/tasks", "fixture_adoption/products", "fixture_adoption/simulations",
      "fixture_vulns/overview", "fixture_vulns/vulnerabilities", "fixture_vulns/applications", "fixture_vulns/controls", "fixture_vulns/audits", "fixture_vulns/reports"], "each tab with a page is a page of the route");
    assert.deepEqual([nav.vulnerabilities.views, nav.vulnerabilities.board_by, nav.vulnerabilities.timeline_by, nav.vulnerabilities.charts], [["table", "board", "timeline", "detail"], "state", "due", ["severity", "due"]], "an area tab: its views, a board by the lifecycle's field");
    assert.equal(nav.billing, null, "a shell page's tab has no page of its own");
    const zeroAdmin = JSON.parse(readFileSync(path.join(SNAP, "zero-packs.json"), "utf8")).adminNav;
    assert.deepEqual(nav.adminNav.slice(0, zeroAdmin.length), zeroAdmin, "/admin keeps the shell's groups (tabs are the /app sidebar's)");
    console.log("✓ packs with tabs: the /app sidebar is exactly the 16 declared tabs in 4 groups, each limited to the roles that may read it; 10 tab pages; /admin unchanged");
  }

  // ---------- 3. a rendered snapshot of the overview and the board ----------
  {
    const week = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
    const base = { description: null, measure: "count", rows: 8, as_of: "2026-10-21T12:00:00.000Z" };
    const sev = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["critical", "Critical"]];
    const answers = [
      { ...base, name: "open_findings", label: "Open vulnerabilities", unit: "count", kind: "single", value: 4 },
      { ...base, name: "overdue_findings", label: "Overdue", unit: "count", kind: "single", value: 2 },
      { ...base, name: "time_to_fix", label: "Average time to fix", unit: "days", kind: "single", value: 5.333333, measure: "duration" },
      { ...base, name: "fix_rate", label: "Fixed", unit: "percent", kind: "single", value: 0.375, measure: "rate" },
      { ...base, name: "open_by_severity", label: "Open by severity", unit: "count", kind: "groups", groups: sev.map(([k, l], i) => ({ key: k, label: l, value: [0, 1, 1, 2][i] })) },
      { ...base, name: "opened_per_week", label: "Found", unit: "count", kind: "series", buckets: week, series: [{ key: null, label: "Found", values: [0, 0, 1, 1, 2, 1, 2, 1] }] },
      { ...base, name: "fixed_per_week", label: "Fixed", unit: "count", kind: "series", buckets: week, series: [{ key: null, label: "Fixed", values: [0, 0, 1, 0, 2, 0, 1, 0] }] },
      { ...base, name: "open_due_status", label: "Open against their fix-by date", unit: "count", kind: "groups", groups: [{ key: "overdue", label: "Overdue", value: 2 }, { key: "due_soon", label: "Due within 7 days", value: 1 }, { key: "later", label: "Later", value: 1 }] },
      { ...base, name: "open_by_app", label: "Open by application", unit: "count", kind: "groups", groups: [{ key: "web", label: "Web app", value: 3 }, { key: "api", label: "API", value: 1 }] },
      { ...base, name: "open_by_regulator", label: "Open by regulator", unit: "count", kind: "groups", groups: [{ key: "central_bank", label: "Central bank", value: 2 }, { key: "securities", label: "Securities regulator", value: 1 }, { key: "privacy", label: "Data protection", value: 1 }] },
      { ...base, name: "median_fix_by_severity", label: "Median time to fix", unit: "days", kind: "groups", measure: "duration", groups: sev.map(([k, l], i) => ({ key: k, label: l, value: [3, null, 10, null][i] })) },
      { ...base, name: "found_weekly_by_severity", label: "Found by severity", unit: "count", kind: "series", buckets: week,
        series: [[0, 0, 0, 0, 1, 0, 1, 0], [0, 0, 0, 0, 0, 1, 0, 1], [0, 0, 0, 1, 0, 0, 1, 0], [0, 0, 1, 0, 1, 0, 0, 0]].map((values, i) => ({ key: sev[i]![0], label: sev[i]![1], values })) },
    ];
    const records = { next: null, records: [
      ["f1", "Outdated TLS", "open", "critical"], ["f2", "Weak password rule", "triaged", "high"], ["f3", "Open bucket", "fixed", "high"], ["f4", "Verbose errors", "open", "medium"],
      ["f6", "Old library", "accepted", "medium"], ["f7", "Session fixation", "reopened", "critical"]].map(([key, title, state, severity]) => ({ key, title, data: { state, severity, app: "web" }, updated_at: "2026-10-20T00:00:00.000Z" })) };
    const chrome = findChrome();
    if (!chrome) console.log("✓ (no headless browser on this machine: the rendered check is skipped; set CHROME_BIN)");
    else {
      const render = await renderInBrowser(chrome, web, { answers, records });
      const c = render.charts;
      assert.deepEqual(Object.keys(c), ["headline", "severity", "open_vs_fixed", "due", "by_app", "by_regulator", "fix_time", "weekly_severity"], "every chart of the overview renders");
      for (const [name, html] of Object.entries(c)) {
        assert.doesNotMatch(html, /(fill|stroke)="#[0-9a-f]{3,8}"/i, `${name}: colours are tokens, never hex`);
        if (name !== "headline") {
          assert.match(html, /<svg/, `${name}: drawn`);
          assert.match(html, /role="img" aria-label="[^"]+\./, `${name}: a summary for screen readers`);
          assert.match(html, /Show table/, `${name}: a table view`);
        }
      }
      assert.match(c.headline!, /Open vulnerabilities<\/dt><dd[^>]*>4<\/dd>.*Overdue<\/dt><dd[^>]*>2<\/dd>.*Average time to fix<\/dt><dd[^>]*>5\.3 days<\/dd>.*Fixed<\/dt><dd[^>]*>37\.5%<\/dd>/s, "the stat tiles");
      assert.match(c.severity!, /aria-label="Open vulnerabilities by severity\. Low 0, Medium 1, High 1, Critical 2\."/, "the severity summary");
      const fills = (html: string, cls: string) => [...html.matchAll(/<path[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(cls)).map((t) => /fill="([^"]+)"/.exec(t)?.[1]);
      assert.deepEqual(fills(c.severity!, "recharts-rectangle"), ["var(--viz-ord-2)", "var(--viz-ord-4)", "var(--viz-ord-5)"], "severity bars on the ordinal ramp, low light to critical dark (the zero bar draws nothing)");
      assert.match(c.severity!, /aria-label="Legend".*Low.*Medium.*High.*Critical/s, "an ordinal legend");
      const lines = [...c.open_vs_fixed!.matchAll(/<path[^>]*recharts-line-curve[^>]*>/g)].map((m) => /stroke="([^"]+)"/.exec(m[0])?.[1]);
      assert.deepEqual(lines, ["var(--viz-1)", "var(--viz-2)"], "found and fixed: two lines, two categorical slots");
      assert.match(c.open_vs_fixed!, /aria-label="Legend".*Found.*Fixed/s, "a legend for two series");
      assert.doesNotMatch(c.by_app!, /aria-label="Legend"/, "one series: no legend box (the title names it)");
      assert.deepEqual(fills(c.by_app!, "recharts-rectangle"), ["var(--viz-1)", "var(--viz-1)"], "one series, one hue");
      const stacks = fills(c.weekly_severity!, "recharts-rectangle");
      assert.equal(stacks.length, 8, "8 stacked segments (one per finding found in the window)");
      assert.ok(stacks.every((f) => /^var\(--viz-ord-\d\)$/.test(f!)), "stacked by severity on the ordinal ramp");
      assert.match(c.weekly_severity!, /stroke="var\(--background\)" stroke-width="2"/, "a 2px surface gap between stacked segments");
      assert.match(render.table, /<caption class="sr-only">Open vulnerabilities by severity<\/caption>.*Group.*Open by severity.*Low.*0.*Critical.*2/s, "the table view of a chart");
      assert.match(render.board, /Open<\/span>.*Triaged<\/span>.*Fixed<\/span>.*Risk accepted<\/span>.*Reopened<\/span>/s, "the board's columns: the lifecycle's states, in order");
      assert.match(render.board, /Open<\/span><span[^>]*>2<\/span>/, "two open");
      assert.match(render.board, /href="\/app\/records\/audit_findings\/f7"/, "a card opens the record (the detail view)");
      console.log("✓ rendered in a headless browser: the overview's 8 charts (tiles, ordinal severity bars, found vs fixed lines with a legend, stacked severity per week with 2px gaps), tokens only, each with a summary and a table view; the board by state");
    }
  }

  // ---------- 4. the console typechecks with the tabs ----------
  if (process.env.CONSOLE_TABS_TYPECHECK !== "off" && existsSync(path.join(ROOT, "web", "node_modules"))) {
    const r = spawnSync(path.join(ROOT, "web", "node_modules", ".bin", "tsc"), ["--noEmit"], { cwd: web, encoding: "utf8" });
    assert.equal(r.status, 0, `the console typechecks with the declared tabs: ${r.stdout.slice(0, 3000)}${r.stderr.slice(0, 1000)}`);
    console.log("✓ the build copy's console typechecks with the declared tabs, charts and metrics");
  } else console.log("✓ (typecheck of the build copy skipped)");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
