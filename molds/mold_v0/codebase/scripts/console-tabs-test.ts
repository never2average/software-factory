// Console tabs from pack.json (mold_v0-058; molds/mold_v0/MOLD.md "Pack and record-area contract"), and the charts that
// draw the metrics (mold_v0-063).
//   npm run test:console-tabs            offline
//   CONSOLE_TABS_TYPECHECK=off           skip the TypeScript check of the build copy (the slow part)
//   CONSOLE_TABS_SNAPSHOT_DIR=<dir>      keep the rendered page (DOM) and screenshots (light, dark) there
//   CONSOLE_TABS_CSS=<file>              the console's compiled CSS for the screenshots (from a next build)
//   CONSOLE_TABS_UPDATE=1                rewrite the sidebar snapshots (after a deliberate change)
//
// 1. Zero packs: the console's sidebar (/app and /admin) is the shell's own (a snapshot: scripts/fixtures/console-nav/
//    zero-packs.json; taken before mold_v0-058, retaken by mold_v0-039 when the product's entries moved to its pack),
//    and the pack page route has no page.
//    A pack with no tabs (fixture_tracker) keeps the shell's sidebar plus what the pack adds, as before (fixture_tracker.json).
// 2. Packs that declare tabs (fixture_vulns, fixture_adoption): the /app sidebar is exactly the declared tabs, in order and
//    groups, each tab limited to the roles that may read what it shows; each tab with a page of its own is a page of the
//    route; the /admin sidebar is unchanged by tabs.
// 3. A rendered check in a headless browser (when the machine has one: CHROME_BIN, or a Playwright cache): the console's
//    chart and board components, bundled, drawing the vulnerability overview and the board: bars, lines and stacks with
//    colour tokens only (no hex), legends for two series or more, an ordinal ramp for severity, an accessible summary
//    per chart, a table view; the board's columns are the lifecycle's states in order. The tabs' empty states (mold_v0-107:
//    a section named by its title, its text, its link) and a table that scrolls sideways, a labelled region the keyboard
//    can reach (mold_v0-114), beside one that fits, which is not a tab stop.
// 3b. A merged tab (mold_v0-135, scripts/fixtures/packs/fixture_status): its sidebar entry and roles, and in the headless
//    browser its table (the source column, every area's fields, each row opening the record of its first area), its
//    board (no moves), its timeline, its empty state and a narrow table the keyboard can scroll; a one-area tab's own
//    columns.
// 4. The build copy's console typechecks with the tabs (and the merged tab's build copy too).
// 5. A home tab (mold_v0-134): fixture_vulns' overview, labelled Home, includes the Setup page's checklist and the
//    notices (its Due soon tab dropped): the sidebar loses that tab, /app and /app/notices redirect to the home tab, and
//    the tab page itself (the console's TabPage, bundled, its API answered in the page) draws the checklist (the next
//    step's prompt, the connection panel), the first five notices and the charts, in that order; with every step done the
//    checklist is one line that opens again. Screenshots with CONSOLE_TABS_SNAPSHOT_DIR (home-*.png).
// 5b. One checklist (mold_v0-146): the setup steps and the pack's steps merged into one ordered list (setup-steps.ts:
//    the shell's first, a pack step that stands for a shell step takes its place, the shell steps after it follow it); on
//    the home tab one list, one count, the connection panel inside its connect step (no panel beside it), a done step's
//    text behind its label.
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
function buildCopy(name: string, packs: string[], edit?: (packsDir: string) => void) {
  const copy = path.join(TMP, name);
  const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
  for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
  mkdirSync(path.join(copy, "packs"), { recursive: true });
  cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
  for (const p of packs) cpSync(path.join(ROOT, "scripts", "fixtures", "packs", p), path.join(copy, "packs", p), { recursive: true });
  edit?.(path.join(copy, "packs"));
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
import { appPageParams } from '@/features/packs/registry';
import { tabPageParams, findTab } from '@/features/tabs/registry';
import { tabPortalNav, packTabs } from '@/config/pack-nav.generated';
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, adminNav, tabPortalNav, packTabs, params: [...appPageParams(), ...tabPageParams()],
  vulnerabilities: findTab('vulnerabilities'), billing: findTab('billing') }));
`;
type Nav = { portalNav: any[]; adminNav: any[]; tabPortalNav: any[]; packTabs: any[]; params: { page: string }[]; vulnerabilities: any; billing: any };
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

/** The theme's tokens (web/src/styles: the theme's surfaces and text, the chart colours), and the console's compiled CSS when given. */
function consoleCss(web: string): string {
  const theme = readFileSync(path.join(web, "src", "styles", "themes", "supabase.css"), "utf8").replace(/\[data-theme='supabase'\] \{\s*@theme[\s\S]*$/, "");
  const viz = readFileSync(path.join(web, "src", "styles", "theme.css"), "utf8");
  return `${theme}\n${viz.slice(viz.indexOf("/*\n * Chart colours"))}\n${process.env.CONSOLE_TABS_CSS ? readFileSync(process.env.CONSOLE_TABS_CSS, "utf8") : ""}
    body { background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; margin: 16px; }
    /* The utility classes the table's and the board's sideways scroll rely on, for a run without the compiled CSS. */
    .overflow-x-auto { overflow-x: auto; } .whitespace-nowrap { white-space: nowrap; } .w-max { width: max-content; }
    [data-slot="board-scroller"] > [role="list"] { display: flex; gap: 0.75rem; } .w-64 { width: 16rem; } .shrink-0 { flex-shrink: 0; }`;
}

/**
 * Draw the vulnerability overview's charts, one chart's table view and the board in a real browser: the console's own
 * components (charts.tsx, board.tsx), bundled with esbuild, fixed width, the theme's tokens; then read the DOM back.
 * With CONSOLE_TABS_SNAPSHOT_DIR, also a screenshot in the light and the dark theme.
 */
async function renderInBrowser(chrome: string, web: string, input: unknown) {
  const dom = await drawInBrowser(chrome, web, "overview", input, `import { createRoot } from 'react-dom/client';
import { packCharts, packTabs, recordAreas } from '@/config/pack-nav.generated';
import { ChartCell } from '@/features/tabs/charts';
import { BoardColumns } from '@/features/tabs/board';
import { EmptyState } from '@/features/tabs/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
const { answers, records } = (window as unknown as { __INPUT__: { answers: { name: string }[]; records: any } }).__INPUT__;
const results = new Map(answers.map((a) => [a.name, a]));
const tab = packTabs.find((t) => t.pack === 'fixture_vulns' && t.id === 'overview')!;
const chart = (n: string) => packCharts.find((c) => c.pack === 'fixture_vulns' && c.name === n)!;
const area = recordAreas.find((a) => a.name === 'audit_findings')!;
createRoot(document.getElementById('root')!).render(
  <div className='grid border-t border-l lg:grid-cols-2' style={{ width: 1180 }}>
    {tab.charts.map((n) => <div key={n} data-chart={n}><ChartCell chart={chart(n)} results={results as never} width={540} /></div>)}
    <div data-table='severity'><ChartCell chart={{ ...chart('severity'), type: 'table' }} results={results as never} width={540} /></div>
    <div data-board='1' style={{ gridColumn: '1 / -1' }}><BoardColumns area={area} by='state' detail data={records} role='member' onMove={() => {}} /></div>
    <div data-board='narrow' style={{ width: 600 }}><BoardColumns area={area} by='state' detail={false} data={records} role='viewer' /></div>
    <div data-empty='1'><EmptyState empty={packTabs.find((t) => t.pack === 'fixture_vulns' && t.id === 'applications')!.empty} id='empty-audit_apps' /></div>
    <div data-empty='2'><EmptyState empty={packTabs.find((t) => t.pack === 'fixture_vulns' && t.id === 'vulnerabilities')!.empty} id='empty-audit_findings' /></div>
    {[['wide', 1100], ['narrow', 240]].map(([k, w]) => (
      <div key={k} data-scroll={k} style={{ width: w as number }}>
        <Table label={area.label}>
          <TableHeader><TableRow><TableHead>Record</TableHead><TableHead>Severity</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
          <TableBody>{records.records.map((r: { key: string; title: string; data: { severity: string; state: string } }) => (
            <TableRow key={r.key}><TableCell>{r.title}</TableCell><TableCell>{r.data.severity}</TableCell><TableCell>{r.data.state}</TableCell></TableRow>))}</TableBody>
        </Table>
      </div>))}
  </div>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 1500);
`);
  const between = (open: RegExp) => { const m = open.exec(dom); if (!m) return ""; const rest = dom.slice(m.index); const next = rest.slice(1).search(/<div data-(chart|table|board|empty|scroll)=/); return next < 0 ? rest : rest.slice(0, next + 1); };
  const charts: Record<string, string> = {};
  for (const m of dom.matchAll(/<div data-chart="([a-z_]+)">/g)) charts[m[1]!] = between(new RegExp(`<div data-chart="${m[1]}">`));
  return { charts, table: between(/<div data-table="severity">/), board: between(/<div data-board="1"/), empty: [between(/<div data-empty="1"/), between(/<div data-empty="2"/)],
    wide: between(/<div data-scroll="wide"/), narrow: between(/<div data-scroll="narrow"/), boardNarrow: between(/<div data-board="narrow"/) };
}

/**
 * Bundle `entry` (a module of the console, its "@/..." imports resolved) with esbuild, draw it in the headless browser at
 * a fixed width with the theme's tokens, and return the DOM. With CONSOLE_TABS_SNAPSHOT_DIR, also `<name>-light.png`,
 * `<name>-dark.png` and `<name>-dom.html` (the overview's keep their names: overview-*.png, dom.html).
 */
async function drawInBrowser(chrome: string, web: string, name: string, input: unknown, entry: string) {
  const { build } = await import("esbuild");
  const dir = path.join(TMP, `render-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(web, "render-entry.tsx"), entry);
  writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
  try {
    await build({ entryPoints: [path.join(web, "render-entry.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(dir, "bundle.js"), absWorkingDir: web,
      tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error" });
  } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(web, f), { force: true }); }
  const css = consoleCss(web);
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
  if (process.env.CONSOLE_TABS_SNAPSHOT_DIR) {
    mkdirSync(process.env.CONSOLE_TABS_SNAPSHOT_DIR, { recursive: true });
    for (const dark of [false, true])
      spawnSync(chrome, [...args, `--screenshot=${path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, `${name}-${dark ? "dark" : "light"}.png`)}`, `file://${page(dark)}`], { timeout: 120_000 });
    writeFileSync(path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, name === "overview" ? "dom.html" : `${name}-dom.html`), dom);
  }
  return dom;
}

/**
 * Draw a build's home tab (mold_v0-134) in a real browser: the console's TabPage for fixture_vulns' overview, bundled,
 * its API answered in the page (the account, the setup steps, the pack's onboarding, seven notices, the metrics);
 * `complete`: every step done. Returns the DOM; with CONSOLE_TABS_SNAPSHOT_DIR also screenshots (light, dark).
 */
async function renderHome(chrome: string, web: string, complete: boolean): Promise<string> {
  const { build } = await import("esbuild");
  const dir = path.join(TMP, `render-home-${complete ? "done" : "open"}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(web, "render-home.tsx"), `import { createRoot } from 'react-dom/client';
import { packTabs } from '@/config/pack-nav.generated';
import { TabPage } from '@/features/tabs/tab-page';
const tab = packTabs.find((t) => t.pack === 'fixture_vulns' && t.id === 'overview')!;
createRoot(document.getElementById('root')!).render(<div style={{ width: 1180 }}><TabPage tab={tab} /></div>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 2500);
`);
  writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
  // The console's sign-in hooks without Clerk's package (the built-in one's, which read nothing until asked).
  writeFileSync(path.join(web, "render-auth.ts"), "export * from './src/lib/auth/builtin-client';\nexport const CLERK = false;\nexport const AUTH_PROVIDER = 'builtin';\n");
  try {
    await build({ entryPoints: [path.join(web, "render-home.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(dir, "bundle.js"), absWorkingDir: web,
      tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_AUTH_PROVIDER": '"builtin"' },
      alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error",
      plugins: [{ name: "auth", setup(b) { b.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({ path: path.join(web, "render-auth.ts") })); } }] });
  } finally { for (const f of ["render-home.tsx", "render-link.tsx", "render-auth.ts"]) rmSync(path.join(web, f), { force: true }); }
  const step = (id: string, label: string, done: boolean, help: string, prompt: string | null = null) => ({ id, label, done, at: done ? "2026-10-20T00:00:00.000Z" : null, help, prompt });
  const steps = [step("joined", "Join your team's account", true, "You accepted the invitation and signed in."),
    step("connected", "Add the connector to your AI client", complete, "Copy the URL into your client."),
    step("tools", "Switch the tools on", complete, "Turn the tools on in your client."),
    step("first_call", "Ask Fixture something", complete, "Your first question checks everything works end to end.", "What can Fixture do?")];
  const notices = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), kind: "due", area: "audit_findings", area_label: "Vulnerabilities", key: `f${i + 1}`, title: `Finding ${i + 1}`,
    due_on: `2026-10-2${i}`, created_at: "2026-10-20T00:00:00.000Z", emailed: i === 0, dismissed: false }));
  const answers = [{ name: "open_by_severity", label: "Open by severity", unit: "count", kind: "groups", description: null, measure: "count", rows: 4, as_of: "2026-10-21T12:00:00.000Z",
    groups: [["low", "Low", 0], ["medium", "Medium", 1], ["high", "High", 1], ["critical", "Critical", 2]].map(([key, label, value]) => ({ key, label, value })) }];
  const api: Record<string, unknown> = {
    "/api/app/me": { account_role: "owner", role_label: "Owner", permissions: ["read", "edit", "launch", "manage", "billing"], needs: {}, roles: [] },
    "/api/app/setup": { steps, done: steps.filter((x) => x.done).length, total: steps.length, clients: [], calls: 0, groups: [], errors: [], live: null,
      connect: { connector_url: "https://console.example.org/mcp", secret: false, clients: [{ id: "claude", client: "Claude", group: "chat", method: "ui", steps: "Settings, then Connectors.", verified: true, share: null }] } },
    "/api/onboarding": { steps: [{ pack: "fixture_vulns", id: "first_app", label: "Add a first application", help: "Describe one application you want audited.", done: complete, at: null }], done: complete ? 1 : 0, total: 1 },
    "/api/notices": { notices },
    "/api/metrics": { metrics: answers },
  };
  const css = consoleCss(web);
  const page = (dark: boolean) => {
    const f = path.join(dir, dark ? "dark.html" : "light.html");
    writeFileSync(f, `<!doctype html><html data-theme="supabase" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"></div><script>const API = ${JSON.stringify(api).replace(/</g, "\\u003c")};
window.fetch = async (url) => { const p = new URL(String(url), 'http://console.test').pathname; const body = API[p];
  return new Response(JSON.stringify(body ?? { error: 'no ' + p }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } }); };</script><script src="bundle.js"></script></body></html>`);
    return f;
  };
  const args = ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=10000", "--window-size=1220,2400"];
  const r = spawnSync(chrome, [...args, "--dump-dom", `file://${page(false)}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `the browser ran: ${r.stderr.slice(0, 1000)}`);
  assert.match(r.stdout, /data-ready="1"/, `the home tab rendered (${r.stdout.slice(0, 300)})`);
  if (process.env.CONSOLE_TABS_SNAPSHOT_DIR) {
    mkdirSync(process.env.CONSOLE_TABS_SNAPSHOT_DIR, { recursive: true });
    for (const dark of [false, true])
      spawnSync(chrome, [...args, `--screenshot=${path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, `home-${complete ? "done" : "open"}-${dark ? "dark" : "light"}.png`)}`, `file://${page(dark)}`], { timeout: 120_000 });
    writeFileSync(path.join(process.env.CONSOLE_TABS_SNAPSHOT_DIR, `home-${complete ? "done" : "open"}.html`), r.stdout);
  }
  return r.stdout;
}

try {
  // ---------- 1. zero packs, and a pack with no tabs ----------
  {
    const zero = inConsole<Nav>(path.join(ROOT, "web"), NAV);
    // CONSOLE_TABS_UPDATE=1 rewrites the two snapshots after a deliberate change (mold_v0-039: the product's own entries
    // left the shell's sidebar for its host pack's nav, so a build with it still shows them where they were).
    if (process.env.CONSOLE_TABS_UPDATE === "1") writeFileSync(path.join(SNAP, "zero-packs.json"), `${navOnly(zero)}\n`);
    assert.equal(navOnly(zero), readFileSync(path.join(SNAP, "zero-packs.json"), "utf8").trim(), "zero packs: the /app and /admin sidebars are the shell's own, as in the snapshot");
    assert.deepEqual([zero.tabPortalNav, zero.packTabs, zero.params], [[], [], []], "zero packs: no tab, and the pack page route has no page (its placeholder is a 404)");
    const tracker = inConsole<Nav>(path.join(buildCopy("tracker", ["fixture_tracker"]), "web"), NAV);
    if (process.env.CONSOLE_TABS_UPDATE === "1") writeFileSync(path.join(SNAP, "fixture_tracker.json"), `${navOnly(tracker)}\n`);
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
      ["Adoption", ["Pick rate /app/pick-rate", "Tasks /app/tasks", "Products /app/products", "Simulations /app/simulations"]],
      ["Account", ["Usage /app/activity", "Profile /app/profile"]],
      ["Audit", ["Overview /app/overview", "Vulnerabilities /app/vulnerabilities", "Applications /app/applications",
        "Controls /app/controls", "Audits /app/audits", "Reports /app/reports"]],
      ["Workspace", ["Application tokens /app/credentials", "Due soon /app/notices", "Billing /app/billing"]],
    ], "exactly the declared tabs, in order, grouped, labels in the pack's words (an area tab is named by its area), the shell's pages at their own addresses; a page two packs' tabs open is listed once, by the first (mold_v0-133)");
    const item = (t: string) => nav.portalNav.flatMap((g) => g.items).find((i: any) => i.title === t);
    assert.deepEqual(item("Applications").roles, ["member", "billing", "owner"], "an area a viewer may not read: its tab is not a viewer's");
    assert.deepEqual(item("Billing").roles, ["billing", "owner"], "a tab's own roles");
    assert.deepEqual(item("Vulnerabilities").roles, ["viewer", "member", "billing", "owner"]);
    assert.deepEqual([item("Overview").icon, item("Reports").icon, item("Vulnerabilities").icon], ["dashboard", "page", "shield"], "icons from the fixed set (a kind's own by default)");
    // Flat addresses (mold_v0-132): /app/tasks is the pack's tab now, never a host product's page.
    const tabUrls = new Set(nav.packTabs.map((t: any) => t.url));
    assert.ok(!nav.portalNav.flatMap((g) => g.items).some((i: any) => /pick-rate$|\/app\/personas|\/app\/tasks$|\/app\/context/.test(i.url) && !tabUrls.has(i.url)), "none of the shell's own product pages");
    assert.deepEqual(nav.params.map((p) => p.page), ["pick-rate", "tasks", "products", "simulations",
      "overview", "vulnerabilities", "applications", "controls", "audits", "reports"], "each tab with a page is a page of the flat route (/app/<id>)");
    assert.deepEqual([nav.vulnerabilities.views, nav.vulnerabilities.board_by, nav.vulnerabilities.timeline_by, nav.vulnerabilities.charts], [["table", "board", "timeline", "detail"], "state", "due", ["severity", "due"]], "an area tab: its views, a board by the lifecycle's field");
    assert.equal(nav.billing, null, "a shell page's tab has no page of its own");
    // Empty states (mold_v0-107): the pack's own where it says one, the shell's default in the build's words for the rest.
    const empty = Object.fromEntries(nav.packTabs.filter((t: any) => t.pack === "fixture_vulns").map((t: any) => [t.id, t.empty ?? null]));
    assert.deepEqual(empty.applications, { title: "No applications yet.", text: "Add the applications you want audited; each one is a folder of repositories.",
      cta: { label: "How to describe an application", href: "https://example.org/guides/applications" } }, "a tab's own empty state");
    assert.deepEqual(empty.audits, { title: "No audits yet.", text: "Ask your AI client to start “Audit an application”. Not connected yet? The Setup page shows how.", cta: { label: "Open setup", href: "/app" } }, "a runs tab pointing at its job kind");
    assert.equal(empty.vulnerabilities.title, "No vulnerabilities yet.", "the default names the area");
    assert.match(empty.controls.text, /^Every workspace shares these\./, "a shared area's default, in the build's words");
    assert.deepEqual([empty.overview, empty.billing], [null, null], "an overview and a shell page have none");
    const zeroAdmin = JSON.parse(readFileSync(path.join(SNAP, "zero-packs.json"), "utf8")).adminNav;
    assert.deepEqual(nav.adminNav.slice(0, zeroAdmin.length), zeroAdmin, "/admin keeps the shell's groups (tabs are the /app sidebar's)");
    console.log("✓ packs with tabs: the /app sidebar is exactly the 16 declared tabs (15 entries: one page two packs open is listed once) in 4 groups, each limited to the roles that may read it; 10 tab pages; /admin unchanged");
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
      const menu = /<select aria-label="Move Outdated TLS"[^>]*>(.*?)<\/select>/s.exec(render.board)?.[1] ?? "";
      assert.deepEqual([...menu.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]), ["", "triaged", "fixed"], "an open card's moves for a member: Triage, Mark fixed (accepting the risk is the owner's)");
      // Empty states and the table's scroll region (mold_v0-107, mold_v0-114).
      const [own, dflt] = render.empty;
      assert.match(own!, /<section aria-labelledby="empty-audit_apps-title" data-empty-state=""/, "an empty state is a section named by its title");
      assert.match(own!, /<h3 id="empty-audit_apps-title"[^>]*>No applications yet\.<\/h3>/, "its title");
      assert.match(own!, /<p[^>]*>Add the applications you want audited; each one is a folder of repositories\.<\/p>/, "its text, as text");
      assert.match(own!, /<a [^>]*href="https:\/\/example\.org\/guides\/applications"[^>]*rel="noopener noreferrer"[^>]*>How to describe an application<\/a>|<a [^>]*rel="noopener noreferrer"[^>]*href="https:\/\/example\.org\/guides\/applications"[^>]*>How to describe an application<\/a>/, "its link, opened without handing the page over");
      assert.match(dflt!, /<a [^>]*href="\/app"[^>]*>Open setup<\/a>/, "the default links to the Setup page");
      assert.doesNotMatch(dflt!, /noopener/, "a path of this site is a plain link");
      assert.doesNotMatch(render.wide, /tabindex=/, "a table that fits is not a tab stop");
      const container = /<div data-slot="table-container"[^>]*>/.exec(render.narrow)?.[0] ?? "";
      for (const attr of ['tabindex="0"', 'role="region"', 'aria-label="Vulnerabilities"']) assert.ok(container.includes(attr), `a table that scrolls sideways is a labelled region the keyboard can reach (${attr}): ${container}`);
      const boardScroller = /<div[^>]*data-slot="board-scroller"[^>]*>/.exec(render.boardNarrow)?.[0] ?? "";
      for (const attr of ['tabindex="0"', 'role="region"', 'aria-label="Vulnerabilities by State"']) assert.ok(boardScroller.includes(attr), `a board that scrolls sideways, with no control on its cards, is a named tab stop (${attr}): ${boardScroller}`);
      assert.doesNotMatch(render.boardNarrow, /<(a|select|button)\b/, "(that board has no control of its own: no detail view, a viewer)");
      console.log("✓ rendered: empty states (a named section, its text, a link: external with rel=noopener, the Setup page by default); a table or a board that scrolls sideways is a focusable labelled region, a table that fits is not");
      console.log("✓ rendered in a headless browser: the overview's 8 charts (tiles, ordinal severity bars, found vs fixed lines with a legend, stacked severity per week with 2px gaps), tokens only, each with a summary and a table view; the board by state");
    }
  }

  // ---------- 3b. a merged tab (mold_v0-135) ----------
  const mergedWeb = path.join(buildCopy("merged", ["fixture_status"]), "web");
  {
    const nav = inConsole<Nav>(mergedWeb, NAV);
    assert.deepEqual(nav.portalNav.map((g) => [g.label, g.items.map((i: any) => `${i.title} ${i.url} ${i.roles.join(",")}`)]), [
      ["Requirements", ["Our requirements /app/ours member,billing,owner", "Requirement library /app/library viewer,member,billing,owner"]],
    ], "a merged tab is one sidebar entry, for the roles that may read every one of its areas");
    const chrome = findChrome();
    if (!chrome) console.log("✓ (no headless browser on this machine: the merged tab's rendered check is skipped; set CHROME_BIN)");
    else {
      const row = (key: string, areas: string[], title: string | null, data: Record<string, unknown>) => ({ key, areas, title, data, updated_at: "2026-10-20T00:00:00.000Z" });
      const page = { next: null, records: [
        row("lib:001", ["req_status", "req_library"], "Library 001", { state: "done", due: "2026-11-02", code: "L-001", topic: "access", weight: "high" }),
        row("lib:003", ["req_status", "req_library"], "Library 003", { state: "planned", due: "2026-12-04", code: "L-003", topic: "data", weight: "high" }),
        row("own:a1", ["req_status", "req_own"], "Status of A-1", { state: "partial", code: "A-1", topic: "vendor", origin: "contract" }),
        row("own:a2", ["req_own"], "Own A-2", { code: "A-2", topic: "access", origin: "contract" }),
      ] };
      const library = { next: null, records: [{ key: "lib:001", title: "Library 001", data: { code: "L-001", topic: "access", weight: "high" }, updated_at: "2026-10-20T00:00:00.000Z" }] };
      const dom = await drawInBrowser(chrome, mergedWeb, "merged", { page, library }, `import { createRoot } from 'react-dom/client';
import { packTabs } from '@/config/pack-nav.generated';
import { BoardColumns, RecordTable, TimelineList } from '@/features/tabs/board';
import { EmptyState } from '@/features/tabs/empty';
import { viewArea, withSource } from '@/features/tabs/merged';
const { page, library } = (window as unknown as { __INPUT__: { page: any; library: any } }).__INPUT__;
const tab = packTabs.find((t) => t.id === 'ours')!;
const area = viewArea(tab)!;
const data = withSource(tab, page);
createRoot(document.getElementById('root')!).render(
  <div className='flex flex-col gap-6' style={{ width: 1180 }}>
    <div data-merged='table'><RecordTable area={area} detail data={data} /></div>
    <div data-merged='board'><BoardColumns area={area} by='state' detail data={data} role='member' /></div>
    <div data-merged='timeline'><TimelineList area={area} by='due' badge='state' detail data={data} /></div>
    <div data-merged='empty'><EmptyState empty={tab.empty} id='empty-req_status' /></div>
    <div data-merged='narrow' style={{ width: 360 }}><RecordTable area={area} detail={false} data={data} /></div>
    <div data-merged='library'><RecordTable area={viewArea(packTabs.find((t) => t.id === 'library')!)!} detail data={library} /></div>
  </div>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 1500);
`);
      const part = (k: string) => { const i = dom.indexOf(`<div data-merged="${k}"`); assert.ok(i >= 0, `${k} rendered`); const rest = dom.slice(i + 1); const j = rest.search(/<div data-merged=/); return j < 0 ? rest : rest.slice(0, j); };
      const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
      const table = part("table");
      assert.match(text(table), /\|Record\|Source\|Code\|Topic\|State\|Next due\|/, "the merged table's columns: the source, then fields of several areas");
      assert.match(text(table), /\|Library 001\|Shared\|L-001\|Access\|Done\|2026-11-02\|/, "a shared entry the workspace tracks: its state beside the library's fields");
      assert.match(text(table), /\|Library 003\|Shared\|L-003\|Data\|Planned\|/, "an option only the library declares keeps its label");
      assert.match(text(table), /\|Status of A-1\|Our own\|A-1\|Vendor\|Partial\|/, "its own requirement with a state");
      assert.match(text(table), /\|Own A-2\|Our own\|A-2\|Access\|/, "its own requirement with no state yet");
      assert.match(table, /href="\/app\/records\/req_status\/lib%3A001"/, "a row opens the record of its first area (the status)");
      assert.match(table, /href="\/app\/records\/req_own\/own%3Aa2"/, "a row only one area holds opens that area's record");
      const board = part("board");
      assert.match(text(board), /Unknown\|0\|None\|Planned\|1\|.*Partial\|1\|.*Done\|1\|.*Not applicable\|0\|None\|No value\|1\|Own A-2/s, "the board: a column per state, the rows with none under No value");
      assert.doesNotMatch(board, /<select/, "a merged tab's board offers no moves");
      const timeline = part("timeline");
      assert.match(text(timeline), /December 2026\|.*Library 003\|Planned\|November 2026\|.*Library 001\|Done\|No next due\|Status of A-1\|Own A-2\|/s, "the timeline by the status's date, newest first, each with its state; the undated after");
      assert.match(part("empty"), /<h3 id="empty-req_status-title"[^>]*>No requirement status yet\.<\/h3>/, "the merged tab's empty state, by its own area");
      const narrow = /<div data-slot="table-container"[^>]*>/.exec(part("narrow"))?.[0] ?? "";
      for (const attr of ['tabindex="0"', 'role="region"', 'aria-label="Our requirements"']) assert.ok(narrow.includes(attr), `a narrow merged table is a labelled region the keyboard can scroll (${attr}): ${narrow}`);
      assert.match(text(part("library")), /\|Record\|Code\|Weight\|Library 001\|L-001\|High\|/, "a one-area tab's own columns (not the area's list columns)");
      console.log("✓ rendered: a merged tab's table (source column, several areas' fields and options, each row opening its first area's record), board (by state, no moves), timeline, empty state and a narrow table the keyboard can scroll; a one-area tab's own columns");
    }
  }

  // ---------- 5. a home tab: the overview includes the Setup page's checklist and the notices (mold_v0-134) ----------
  {
    const home = buildCopy("home", ["fixture_vulns", "fixture_adoption"], (packs) => {
      const f = path.join(packs, "fixture_vulns", "pack.json");
      const j = JSON.parse(readFileSync(f, "utf8"));
      j.tabs = j.tabs.filter((t: { kind: string }) => t.kind !== "notices")
        .map((t: { id: string }) => (t.id === "overview" ? { ...t, label: "Home", include: ["setup", "notices"] } : t));
      j.onboarding = [{ id: "first_app", label: "Add a first application", help: "Describe one application you want audited.", done_when: "record:audit_apps" }];
      writeFileSync(f, JSON.stringify(j, null, 2));
    });
    const hweb = path.join(home, "web");
    const nav = inConsole<Nav>(hweb, NAV);
    const items = nav.portalNav.flatMap((g) => g.items.map((i: any) => `${g.label}: ${i.title} ${i.url}`));
    assert.equal(items.find((x) => x.startsWith("Audit: ")), "Audit: Home /app/overview", "the home tab first, in its group, by its label");
    assert.ok(!items.some((x) => x.includes("/app/notices")), `the notices tab is gone from the sidebar: ${items.join(", ")}`);
    const spec = nav.packTabs.find((t: any) => t.pack === "fixture_vulns" && t.id === "overview");
    assert.deepEqual([spec.include, spec.roles], [["setup", "notices"], ["viewer", "member", "billing", "owner"]], "its sections in order, and every role's");
    const routes = JSON.parse(readFileSync(path.join(hweb, "src", "config", "pack-routes.generated.json"), "utf8")).redirects.filter((r: any) => !r.source.startsWith("/app/packs/")).map((r: any) => `${r.source} -> ${r.destination}`);
    assert.deepEqual(routes, ["/app -> /app/overview", "/app/notices -> /app/overview", "/app/notices/:path* -> /app/overview"],
      "/app and /app/notices lead to the home tab (the pages stay, for a build without one)");
    console.log("✓ a home tab: the sidebar's Home, no Due soon tab; /app and /app/notices (and below) redirect to it");
    const chrome = findChrome();
    if (!chrome) console.log("✓ (no headless browser on this machine: the rendered home tab is skipped; set CHROME_BIN)");
    else {
      const open = await renderHome(chrome, hweb, false), done = await renderHome(chrome, hweb, true);
      const at = (html: string, re: RegExp) => { const m = re.exec(html); return m ? m.index : -1; };
      const order = [at(open, /data-home-section="setup"/), at(open, /data-home-section="notices"/), at(open, /data-chart-cell|class="grid border-t border-l/)];
      assert.ok(order.every((x) => x >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `setup, then notices, then the charts: ${order}`);
      const setup = open.slice(order[0]!, order[1]!);
      assert.match(setup, /<h2 id="home-setup-title"[^>]*>Setup<\/h2>/, "the checklist is a section named Setup");
      assert.equal([...setup.matchAll(/<ol class="mt-3">/g)].length, 1, "one list (mold_v0-146), not the pack's and the shell's");
      assert.equal([...setup.matchAll(/ of 5 steps done\./g)].length, 1, "one count");
      assert.match(setup, /1 of 5 steps done\./, "its progress across the setup steps and the packs' steps");
      const order146 = ["Join your team", "Add the connector to your AI client", "Switch the tools on", "Ask Fixture something", "Add a first application"].map((l) => setup.indexOf(l));
      assert.ok(order146.every((x, i) => x >= 0 && (i === 0 || x > order146[i - 1]!)), `the shell's steps, then the pack's: ${order146}`);
      assert.doesNotMatch(setup, /You accepted the invitation/, "compact: a done step says nothing more");
      assert.match(setup, /aria-expanded="false"[^>]*>Join your team(&#x27;|')s account/, "it opens from its label");
      assert.match(setup, /Pick your client.*Copy URL.*Test my connection/s, "the next open step is connecting: the connection panel is its body");
      assert.doesNotMatch(setup, /Connect your AI client/, "no connection panel beside the list");
      assert.doesNotMatch(setup, /Turn the tools on in your client\.|Describe one application you want audited\./, "compact: only the next open step's text");
      assert.match(setup, /id="onboarding-fixture_vulns-first_app"/, "the pack's step keeps its anchor");
      const notices = open.slice(order[1]!, order[2]!);
      assert.equal([...notices.matchAll(/href="\/app\/records\/audit_findings\//g)].length, 5, "the first five notices");
      assert.match(notices, /Show all 7/, "and a button for the rest");
      assert.match(notices, /<h2[^>]*>Due soon<\/h2>/, "a section named Due soon");
      assert.match(open, /aria-label="Open vulnerabilities by severity\./, "the charts draw below");
      const folded = /<section aria-labelledby="home-setup-title" data-home-section="setup" data-complete=""[\s\S]*?<\/section>/.exec(done)?.[0] ?? "";
      assert.match(folded, /You&#x27;re all set|You're all set/, "every step done: one line");
      assert.match(folded, /5 of 5 setup steps done\./, "saying how many");
      assert.match(folded, /aria-expanded="false"[^>]*>Show setup<\/button>/, "that opens again");
      assert.doesNotMatch(done, /Connect your AI client|Pick your client|<ol class="mt-3"/, "folded: no checklist, no connection panel");
      console.log("✓ rendered home tab: one checklist (shell steps then the pack's, one count, only the next one explained: the connection panel inside the connect step), five of seven notices with Show all, then the charts; all done, one line that opens again");
    }
    // 5b. the merge itself (mold_v0-146)
    const { mergeSetupSteps } = await import("../web/src/features/portal/setup-steps.js");
    const sh = (id: string, done = false) => ({ id, label: `shell ${id}`, done, at: null, help: `${id} help` });
    const pk = (id: string, covers: string | null = null) => ({ pack: "p", id, label: `pack ${id}`, help: null, done: false, at: null, covers });
    const shell = [sh("joined", true), sh("connected"), sh("tools"), sh("first_call")];
    const keys = (x: { key: string }[]) => x.map((k) => k.key).join(" ");
    assert.equal(keys(mergeSetupSteps(shell, [])), "shell:joined shell:connected shell:tools shell:first_call", "no pack steps: the shell's list");
    assert.equal(keys(mergeSetupSteps(shell, [pk("a"), pk("b")])), "shell:joined shell:connected shell:tools shell:first_call p/a p/b", "the shell's steps first, then the pack's");
    assert.equal(keys(mergeSetupSteps(shell, [pk("a"), pk("link", "connected"), pk("b")])), "shell:joined p/a p/link shell:tools shell:first_call p/b",
      "a pack step standing for the connect step takes its place; the shell's steps after it follow it");
    assert.equal(keys(mergeSetupSteps(shell, [pk("made", "joined"), pk("a"), pk("ask", "first_call")])), "p/made shell:connected shell:tools p/a p/ask",
      "each covered shell step is dropped once, in the pack's place");
    assert.equal(mergeSetupSteps(shell, [pk("link", "connected")]).find((x: { key: string }) => x.key === "p/link")?.shell, "connected", "the pack's connect step carries the connection panel");
    console.log("✓ one checklist (mold_v0-146): the shell's steps then the packs', a pack step standing for a shell step in its place with the shell's later steps after it");
    // 5c. the count (mold_v0-171): an optional step is shown and never counted, as the server's own done and total.
    const { stepProgress } = await import("../web/src/features/portal/setup-steps.js");
    const withOptional = mergeSetupSteps([sh("joined", true), sh("connected"), sh("tools"), { ...sh("dashboard"), optional: true }, sh("first_call"), sh("onboarded", true), sh("simulated", true), sh("reported")], []);
    assert.equal(withOptional.length, 8, "the optional step is in the list");
    assert.equal(withOptional.find((x: { key: string }) => x.key === "shell:dashboard")?.optional, true, "and carries optional");
    assert.deepEqual(stepProgress(withOptional), { done: 3, total: 7 }, "3 of 7, not 3 of 8");
    assert.deepEqual(stepProgress([{ ...sh("dashboard", true), optional: true }, sh("a", true)]), { done: 1, total: 1 }, "a done optional step is not counted either");
    assert.deepEqual(stepProgress(mergeSetupSteps(shell, [pk("a")])), { done: 1, total: 5 }, "with no optional step every step counts");
    console.log("✓ the checklist counts the steps that count (mold_v0-171): an optional step is shown, never in done or total (3 of 7 for eight steps with one optional)");
  }

  // ---------- 4. the console typechecks with the tabs ----------
  if (process.env.CONSOLE_TABS_TYPECHECK !== "off" && existsSync(path.join(ROOT, "web", "node_modules"))) {
    for (const [w, what] of [[web, "the declared tabs, charts and metrics"], [mergedWeb, "a merged tab"]] as const) {
      const r = spawnSync(path.join(ROOT, "web", "node_modules", ".bin", "tsc"), ["--noEmit"], { cwd: w, encoding: "utf8" });
      assert.equal(r.status, 0, `the console typechecks with ${what}: ${r.stdout.slice(0, 3000)}${r.stderr.slice(0, 1000)}`);
      console.log(`✓ the build copy's console typechecks with ${what}`);
    }
  } else console.log("✓ (typecheck of the build copy skipped)");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
