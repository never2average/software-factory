// mold_v0-336: building blocks for lists and record panels, generic, no database (the toggle's API is
// scripts/blocks-ui-336-server-test.ts; both run by `npm run test:blocks-ui`):
//   1. The keys: a page action `toggle` (a boolean field on or off) and an action's `look: "link"`; a merged tab's column of
//      a field per source area (`{by_source, label, id?}`); an area's and a tab's `plural`. Each parses, each wrong use is
//      refused with its path (the schema) or at build (src/metric-spec.ts checkViews); a pack naming none builds as before.
//   2. The console's pure parts, bundled as the console builds them: a merged tab's source column (one field, the mapped
//      fields' options, each row's value from its own area), the rows' plural (the tab's, its area's, its areas' joined),
//      one of a plural ("1 catalog entry", "1 hosting account or catalog entry").
//   3. Drawn: a list's cards on a phone as one compact row that scrolls (no sparkline below 640px), two by two when asked.
//   4. The wiring: a merged tab's row from a later area opens that area's own record panel (never the tab's columns); a
//      toggle is a switch (header) or an on/off item (menu); a declared text-link action is a bare link the outline checks
//      allow (and the static outline scan still passes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordAreaSchema, TabSchema } from "../src/pack-api.js";
import { checkViews, tabColumns, viewsOf } from "../src/metric-spec.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const ok = (m: string) => console.log(`✓ ${m}`);
const ALL = ["owner", "member", "viewer", "billing"];

const CONN = { name: "conns", label: "Connections", plural: "hosting accounts", role: "source", scope: "workspace",
  fields: [{ name: "provider", label: "Provider", type: "text" }, { name: "use_for_builds", label: "Builds use it", type: "boolean" },
    { name: "token", label: "Token", type: "text", encrypted: true }, { name: "secret_flag", label: "Sealed", type: "boolean", encrypted: true },
    { name: "tested", label: "Tested", type: "boolean", set_by: "action" },
    { name: "status", label: "Health", type: "enum", options: [{ value: "untested", label: "Not tested" }, { value: "working", label: "Working" }] }],
  permissions: { read: ALL, create: ["owner"], update: ["owner", "member"], delete: ["owner"] },
  detail: { tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["provider"] }] }],
    actions: [{ kind: "edit", place: "primary", look: "link" }, { kind: "toggle", field: "use_for_builds" }] } };
const CAT = { name: "catalog", label: "Catalog", plural: "catalog entries", role: "source", scope: "platform",
  fields: [{ name: "provider", label: "Provider", type: "text" }, { name: "maturity", label: "Maturity", type: "enum", options: [{ value: "ga", label: "Ready to use" }, { value: "preview", label: "Preview" }] },
    { name: "docs", label: "Docs", type: "url" }, { name: "rank", label: "Rank", type: "number" }],
  permissions: { read: ALL } };
const MERGED = { id: "hosting", kind: "area", label: "Hosting", areas: [{ area: "conns", source: "This workspace" }, { area: "catalog", source: "Shared catalog" }],
  columns: [{ by_source: { conns: "status", catalog: "maturity" }, label: "State" }, "source", "provider"] };

const issues = (schema: { safeParse: (x: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, x: unknown) => {
  const r = schema.safeParse(x);
  return r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};
const refusedAt = (got: string[], at: string, re: RegExp) => assert.ok(got.some((m) => m.startsWith(`${at}:`) && re.test(m)), `refused at ${at} (${re}): ${JSON.stringify(got)}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const withActions = (actions: unknown[], area: Record<string, unknown> = CONN) => ({ ...clone(area), detail: { ...clone(CONN.detail), actions } });
const build = (areas: unknown[], tabs: unknown[]) => checkViews(viewsOf([{ id: "bb", definition: { recordAreas: areas, tabs } }]));

// 1. The keys.
{
  assert.deepEqual(issues(RecordAreaSchema, CONN), [], "a toggle on a boolean field, a link-look primary and a plural are an area");
  assert.deepEqual(issues(RecordAreaSchema, CAT), []);
  assert.deepEqual(issues(TabSchema, MERGED), [], "a merged tab's column of a field per source area");
  assert.deepEqual(issues(TabSchema, { ...MERGED, plural: "hosting accounts and catalog entries" }), [], "a tab's plural");
  const refusedArea: [string, unknown, RegExp][] = [
    ["detail.actions.0.field", withActions([{ kind: "toggle" }]), /names the boolean field/],
    ["detail.actions.1.field", withActions([{ kind: "edit", place: "primary" }, { kind: "toggle", field: "status" }]), /a enum field: a toggle turns a boolean field on and off/],
    ["detail.actions.0.field", withActions([{ kind: "toggle", field: "nope" }]), /nope is not one of the area's fields/],
    ["detail.actions.0.field", withActions([{ kind: "toggle", field: "secret_flag" }]), /encrypted/],
    ["detail.actions.0.field", withActions([{ kind: "toggle", field: "tested" }]), /set only by the app's actions/],
    ["detail.actions.0.roles", withActions([{ kind: "toggle", field: "use_for_builds", roles: ["viewer"] }]), /viewer is read-only/],
    ["detail.actions.0.kind", withActions([{ kind: "toggle", field: "rank" }], { ...CAT, fields: [...CAT.fields, { name: "rank", label: "Rank", type: "boolean" }] }), /shared \(platform\) area's records are written by platform staff/],
    ["detail.actions.0.look", withActions([{ kind: "toggle", field: "use_for_builds", place: "secondary", look: "link" }]), /a toggle is drawn as a switch/],
    ["detail.actions.0.look", withActions([{ kind: "copy_link", look: "link" }]), /look is for an action drawn as a button/],
    ["detail.actions.0.look", withActions([{ kind: "copy_link", place: "primary", look: "box" }]), /button|link/],
    ["detail.actions.0.field", withActions([{ kind: "edit", field: "use_for_builds" }]), /field is for a link or open_url or toggle action/],
    ["plural", { ...CONN, plural: "a {brace}" }, /plain text/],
  ];
  for (const [at, a, re] of refusedArea) refusedAt(issues(RecordAreaSchema, a), at, re);
  const refusedTab: [string, unknown, RegExp][] = [
    ["columns.0", { id: "one", kind: "area", area: "conns", columns: [{ by_source: { conns: "status" }, label: "State" }] }, /by_source is for a merged tab/],
    ["columns.0.by_source.other", { ...MERGED, columns: [{ by_source: { other: "status" }, label: "State" }] }, /other is not one of the tab's areas \(conns, catalog\)/],
    ["columns.0.by_source", { ...MERGED, columns: [{ by_source: {}, label: "State" }] }, /1 to 4 areas/],
    ["columns", { ...MERGED, columns: [{ by_source: { conns: "status" }, label: "State" }, { by_source: { catalog: "maturity" }, label: "state", id: "state" }] }, /listed twice/],
    ["plural", { id: "o", kind: "overview", charts: ["c"], plural: "things" }, /plural is for an area tab/],
  ];
  for (const [at, t, re] of refusedTab) refusedAt(issues(TabSchema, t), at, re);

  // At build: the fields named, one type, an id of its own; the columns in place.
  assert.deepEqual(build([CONN, CAT], [MERGED]), [], "the merged tab builds");
  const tab = TabSchema.parse(MERGED);
  assert.deepEqual(tabColumns(tab as never, viewsOf([{ id: "bb", definition: { recordAreas: [CONN, CAT], tabs: [] } }]).areas), ["state", "source", "provider"], "the column's id in its place (its label, lowercased)");
  const atBuild: [unknown, RegExp][] = [
    [{ ...MERGED, columns: [{ by_source: { conns: "status", catalog: "nope" }, label: "State" }] }, /column state: nope is not a field of area catalog/],
    [{ ...MERGED, columns: [{ by_source: { conns: "status", catalog: "rank" }, label: "State" }] }, /conns\.status is enum and catalog\.rank is number: the fields one column shows are one type/],
    [{ ...MERGED, columns: [{ by_source: { conns: "status", catalog: "maturity" }, label: "Provider" }] }, /area conns, catalog has a field named provider: give the column its own id/],
    [{ ...MERGED, columns: [{ by_source: { conns: "token" }, label: "Key" }] }, /conns\.token is encrypted/],
  ];
  for (const [t, re] of atBuild) { const p = build([CONN, CAT], [t]); assert.ok(p.some((m) => re.test(m)), `${re}: ${JSON.stringify(p)}`); }
  // A pack naming none of the keys builds as before.
  const plain = { ...clone(CONN), plural: undefined, detail: { ...clone(CONN.detail), actions: [{ kind: "edit", place: "primary" }] } };
  assert.deepEqual(build([plain, CAT], [{ ...MERGED, columns: ["status", "maturity", "source", "provider"] }]), []);
  ok(`the keys: toggle, look, a source column and plural parse; ${refusedArea.length + refusedTab.length} wrong uses refused with their path, ${atBuild.length} at build; none of them builds as before`);
}

// 2 and 3. The console's own code, bundled (its tsconfig paths, its React), the generated registry replaced by these areas.
let out: Record<string, any>;
{
  const { build: esbuild } = await import("esbuild");
  const webDir = path.join(ROOT, "web");
  const tmp = mkdtempSync(path.join(tmpdir(), "blocks-336-"));
  try {
    const conn = { ...clone(CONN), pack: "bb", description: null, icon: "box", list_columns: ["provider"], links: [], lifecycle: null };
    const cat = { ...clone(CAT), pack: "bb", description: null, icon: "box", list_columns: ["provider"], links: [], lifecycle: null };
    writeFileSync(path.join(tmp, "registry.ts"), `export const recordAreas = ${JSON.stringify([conn, cat])};\nexport const recordAdminNav = [];\nexport const packTabs = [];\n`);
    writeFileSync(path.join(tmp, "link.tsx"), "export default function Link({ href, children, ...p }: any) { return <a href={href} {...p}>{children}</a>; }\n");
    const tab = { pack: "bb", id: "hosting", kind: "area", label: "Hosting", description: null, icon: "box", url: "/app/hosting", roles: ALL, area: "conns", charts: [],
      columns: ["state", "source", "provider"], areas: [{ area: "conns", rows: "all", source: "This workspace" }, { area: "catalog", rows: "all", source: "Shared catalog" }],
      source_columns: [{ id: "state", label: "State", by_source: { conns: "status", catalog: "maturity" } }] };
    writeFileSync(path.join(tmp, "entry.tsx"), `import { renderToStaticMarkup as r } from 'react-dom/server';
import { viewArea, withSource, tabPlural } from '@/features/tabs/merged';
import { oneOf } from '@/components/layout/table-pager';
import { StatStrip } from '@/components/layout/section';
const tab: any = ${JSON.stringify(tab)};
const a = viewArea(tab)!;
const page = withSource(tab, { next: null, records: [
  { key: 'mine', title: 'Mine', data: { provider: 'vercel', status: 'working' }, updated_at: '', areas: ['conns'] },
  { key: 'vercel', title: 'Vercel', data: { provider: 'vercel', maturity: 'preview' }, updated_at: '', areas: ['catalog'] },
  { key: 'both', title: 'Both', data: { status: 'untested', maturity: 'ga' }, updated_at: '', areas: ['conns', 'catalog'] },
  { key: 'none', title: 'None', data: {}, updated_at: '', areas: ['catalog'] }] });
const items = [1, 2, 3, 4].map((n) => ({ label: 'Card ' + n, value: String(n), spark: [1, 2, n] }));
process.stdout.write('\\u0001' + JSON.stringify({
  field: a.fields.find((f: any) => f.name === 'state'), plural: (a as any).plural ?? null,
  values: page.records.map((x: any) => [x.key, x.data.state, x.data.source]),
  plurals: [tabPlural(tab), tabPlural({ ...tab, plural: 'rows' }), tabPlural({ area: 'conns' } as any), tabPlural({ area: 'other' } as any),
    tabPlural({ ...tab, areas: [...tab.areas, { area: 'other', rows: 'all', source: null }] })],
  one: ['records', 'people', 'catalog entries', 'buckets', 'addresses', 'boxes', 'hosting accounts and catalog entries', 'access', 'keys, buckets and disks'].map(oneOf),
  strip: r(<StatStrip quad strip items={items} />), grid: r(<StatStrip quad items={items} />),
}));
`);
    await esbuild({ entryPoints: [path.join(tmp, "entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(tmp, "out.cjs"), absWorkingDir: webDir,
      tsconfig: path.join(webDir, "tsconfig.json"), nodePaths: [path.join(webDir, "node_modules")], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      alias: { "next/link": path.join(tmp, "link.tsx") }, logLevel: "error",
      plugins: [{ name: "registry", setup(b) { b.onResolve({ filter: /pack-nav\.generated$/ }, () => ({ path: path.join(tmp, "registry.ts") })); } }] });
    const run = spawnSync(process.execPath, [path.join(tmp, "out.cjs")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(run.status, 0, `render: ${run.stderr.slice(0, 2000)}`);
    out = JSON.parse(run.stdout.slice(run.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  const f = out.field;
  assert.equal(f.label, "State");
  assert.equal(f.type, "enum");
  assert.deepEqual(f.options.map((o: { value: string }) => o.value), ["untested", "working", "ga", "preview"], "every mapped field's options, once");
  assert.deepEqual(f.by_source, { conns: "status", catalog: "maturity" });
  assert.equal(out.plural, null, "a merged tab's rows are not its own area's plural");
  assert.deepEqual(out.values, [["mine", "working", "This workspace"], ["vercel", "preview", "Shared catalog"], ["both", "untested", "This workspace"], ["none", null, "Shared catalog"]],
    "each row's State is its own area's field (a row both hold: the first area's), the source column as before");
  assert.deepEqual(out.plurals, ["hosting accounts and catalog entries", "rows", "hosting accounts", null, null],
    "the rows' plural: the areas' joined, the tab's own, one area's, none declared (records), not every area declaring one (records)");
  assert.deepEqual(out.one, ["record", "person", "catalog entry", "bucket", "address", "box", "hosting account or catalog entry", "access", "key, bucket or disk"]);
  ok("console: a source column's field and each row's value, the rows' plural, one of a plural");

  const strip = out.strip as string, grid = out.grid as string;
  assert.match(strip, /data-strip=""/);
  assert.match(strip, /max-sm:flex max-sm:w-max/, "one row on a phone, as wide as its cards");
  assert.equal((strip.match(/max-sm:w-\[10\.5rem\]/g) ?? []).length, 4, "each card a fixed compact width");
  assert.match(strip, /max-sm:hidden/, "no sparkline on a phone");
  assert.match(strip, /max-sm:text-lg/, "a smaller number");
  assert.match(strip, /sm:max-lg:even:border-l/, "two by two from 640px, as before");
  assert.doesNotMatch(grid, /data-strip|max-sm:flex|max-sm:hidden/, "without strip: as before (two by two on a phone)");
  const cards = src("features/tabs/sparklines.tsx");
  assert.match(cards, /useScrollsSideways/);
  assert.match(cards, /className=\{strip && count !== 5 \? 'max-sm:overflow-x-auto/, "the row scrolls inside the cards' section");
  assert.match(cards, /scrollRegion\(label\)/, "a keyboard reaches it while it scrolls (axe scrollable-region-focusable)");
  assert.match(src("features/tabs/tab-page.tsx"), /label='Headline numbers' strip=\{false\}/, "the home page's headline row stays two by two");
  ok("drawn: a list's cards on a phone are one compact scrolling row (no sparkline), two by two from 640px; the home headline row as before");
}

// 4. The wiring.
{
  const pages = src("features/records/record-pages.tsx");
  assert.match(pages, /const rowArea = \(r: RecordRow\): RecordAreaSpec => \(recordArea\(r\) === area\.name \? area : findRecordArea\(base, recordArea\(r\)\) \?\? area\)/,
    "a merged tab's row of a later area is that area's record");
  assert.match(pages, /properties=\{\(r\) => source\?\.properties !== false && !laidOut\(r\) && !foreign\(r\)\}/, "never the tab's columns as its facts");
  assert.match(pages, /laidOut\(r\) \? <RecordDetailBody area=\{rowArea\(r\)\}[\s\S]{0,80}foreign\(r\) \? <RecordDetailBody area=\{rowArea\(r\)\}/, "its own panel: laid out, else its own fields");
  assert.match(pages, /const noun = source\?\.noun \?\? plural \?\? area\.plural \?\? 'records'/, "the footer's word");
  assert.match(pages, /const by = bySource\(f\);[\s\S]{0,1200}badgeColor\(rl, mf\.name, x\)/, "a source column's cell in its row's own area's badge colours");
  const acts = src("features/records/page-actions.tsx");
  assert.match(acts, /if \(a\.kind === 'toggle'\) return <ToggleSwitch/, "a toggle in the header is a switch");
  assert.match(acts, /<DropdownMenuSwitchItem checked=\{!!a\.on\}/, "in a menu an on/off item");
  assert.match(acts, /takeAction\(host\.area, host\.record\.key, a\.id, \{ on: !a\.on \}\)/, "it asks for the other way round");
  assert.match(acts, /if \(a\.look === 'link'[\s\S]{0,120}<TextAction a=\{a\} busy=\{busy\} take=\{take\} primary rail \/>/, "the rail's main action as a bare link when declared");
  assert.match(acts, /<button type='button' data-text-action=''/);
  assert.match(src("components/ui/dropdown-menu.tsx"), /function DropdownMenuSwitchItem/);
  const allow = readFileSync(path.join(ROOT, "scripts", "console-outlines.ts"), "utf8");
  assert.match(allow, /\["features\/records\/page-actions\.tsx", "data-text-action=''"/, "the static outline scan allows the declared text link, saying why");
  assert.match(readFileSync(path.join(ROOT, "..", "testing", "console", "outlines.mjs"), "utf8"), /\[data-text-action\]'\)/, "and the browser's");
  const scan = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "console-outlines.ts")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(scan.status, 0, `the outline scan: ${scan.stdout.slice(-1500)}${scan.stderr.slice(-500)}`);
  ok("wiring: a catalog row opens its own panel; a toggle is a switch or an on/off item; a declared text link is the one unboxed action, and the outline scan passes");
}
console.log("blocks-ui: ok");
