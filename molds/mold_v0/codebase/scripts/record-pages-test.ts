// The admin pages' words that come from the build (mold_v0-170), offline and without a browser:
//   npm run test:record-pages
//   1. A record area's empty state (web/src/features/records/empty.ts): titled by the area's label, never its raw key
//      pattern; for staff, where its rows come from (an upstream catalog: its name and repository, what to press, the
//      admin MCP's sync tool; an index running or failed is said so), with Data repositories as the way to fill it; for a
//      customer, no staff page.
//   2. The staff guide (web/src/content/staff-guide.ts): with no doc of the shell's or the packs' in the Guides group, the
//      admin Docs open on "<product> staff guide", written from the build: the product's name, the sidebar's pages in
//      their order, each with what it is for, linked to its address; no source path, no ticket number. A doc that is a
//      guide (a pack's staff_docs beta guide) takes its place.
//   3. A shared area's samples (src/pack-api.ts RecordAreaSchema): for the lanes only, shared (platform) areas only, each
//      key once, each data key a declared field.
//   4. The customer lists (mold_v0-176): a run's row in words (web/src/features/tabs/run-rows.ts), and every customer list
//      page drawing the console's database table (RecordView), none linking to a staff page.
//   5. A list tab's four cards (mold_v0-181): a card's number and its trend in words (web/src/features/tabs/spark-words.ts),
//      and every list a tab draws (an area's table, a board or timeline, runs, reports, schedules) showing them first:
//      the cards, then the search row, then the table (mold_v0-208: RecordView draws its summary above its toolbar), and
//      an area tab drawing no charts.
//   6. The Access log (mold_v0-205): the records' own table over the audit trails as a read-only system area (the data
//      adapter, RecordSource), with the trail's four cards above the search row, its filters (who, action, area, door,
//      the date range), the column picker, Download CSV and the row drawer; no table of its own.
//   7. The Access log is Billing's 4th tab (mold_v0-209): People, Teams, Budget rules, then Access log (?tab=access-log),
//      shown only where the profile turns audit.data on and only to the workspace's owners, with no title of its own;
//      /app/access-log is gone (no page, no route, no sidebar entry, no link), the staff /admin/access-log stays. Both
//      trails' tables have an Action and an Actor column (the platform trail's Kind split in two).
//   8. The staff record pages (mold_v0-212): /admin/records/<area> is the standard list with no title or description
//      above it (its cards from the staff route, its search row, its table), New record as the search row's primary action
//      and Edit on an open record only where the server offers them; the record's page is one details card. mold_v0-221:
//      New <noun> and Import in the search row on every shared area, Override on a repository's row, provenance and
//      overrides marked.
//   9. Settings (mold_v0-218): one /app/settings page with in-page tabs Credentials | Email (?tab=, no title above the
//      strip; one alone without a strip), each the standard list (four cards, the search row, the table; a row opens its
//      full details card; Add mailbox and Set sender in Email's search row); /app/credentials and /app/settings/email are
//      gone (no page, no route, no redirect, nothing in the console linking there).
//  10. No title or description above a list (mold_v0-231): every list route of both consoles (the pack tabs, the record
//      pages, Settings, Notices, Billing's Access log, the staff records, Compute, FinOps, Access log, Health, Requests,
//      Accounts, Configuration, Key vault, Journeys) walked from its page to the components that draw the list: no page
//      title, description or header row, and no heading, titled section or muted paragraph before its cards; and no other
//      list in a titled page frame.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The console's modules by path (as scripts/status-pages-test.ts loads them): the server's typecheck never reads web/.
const WEB = path.resolve(import.meta.dirname, "..", "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);

const ok = (m: string) => console.log(`✓ ${m}`);

// 1. Empty states.
const { recordEmptyText, repoOf, REPOSITORIES_URL } = await web("features/records/empty.ts");
const area = { label: "Library", scope: "platform" as const };
const catalog = { name: "lib_catalogs", kind: "upstream_catalog", index: "automatic" as const, upstream: { repo: "example/lib", commit: "abc" },
  state: { indexing: false, current: false, last_error: null, pin: null }, area_rows: [{ name: "library" }] };
const e1 = recordEmptyText(area, "admin", catalog);
assert.equal(e1.title, "No records in Library yet");
assert.match(e1.text, /an upstream catalog, example\/lib \(data repository lib_catalogs\)/);
assert.match(e1.text, /press Index now/);
assert.match(e1.text, /admin_sync_lib_catalogs/);
assert.deepEqual(e1.cta, { label: "Open Data repositories", href: REPOSITORIES_URL });
assert.doesNotMatch(e1.text, /</, "no raw key pattern or markup");
assert.match(recordEmptyText(area, "admin", { ...catalog, state: { ...catalog.state, indexing: true } }).text, /An index is running now/);
assert.match(recordEmptyText(area, "admin", { ...catalog, state: { ...catalog.state, last_error: "pin not found" } }).text, /The last index failed: pin not found/);
assert.match(recordEmptyText(area, "admin", { ...catalog, index: "manual" }).text, /indexed by hand/);
assert.match(recordEmptyText(area, "admin", { name: "files", kind: "workspace_files" }).text, /files repository: each workspace's files/);
const none = recordEmptyText(area, "admin", null);
assert.equal(none.cta, null);
assert.match(none.text, /admin MCP server and the data API/);
const app = recordEmptyText(area, "app", catalog);
assert.equal(app.cta, null, "a customer is never sent to a staff page");
assert.match(app.text, /shared by every workspace/);
assert.equal(repoOf("library", [catalog])?.name, "lib_catalogs");
assert.equal(repoOf("other", [catalog]), null);
ok("a record area's empty state: its label, where its rows come from and how staff fill it now; customers get no staff link");

// 2. The staff guide, in this build (the mold's own: no pack, the neutral profile, the shell's docs, none a guide).
const g = await web("content/staff-guide.ts");
const { ADMIN_DOCS } = await web("content/admin-docs.generated.ts");
assert.equal(g.staffGuideShown, !ADMIN_DOCS.some((d: { group: string; slug: string }) => g.adminDocGroup(d) === "Guides"));
assert.equal(g.adminDocGroup({ group: "", slug: "beta-guide" }), "Guides");
assert.equal(g.adminDocGroup({ group: "", slug: "budget-rules-spec" }), "Specs");
assert.equal(g.adminDocGroup({ group: "case-studies", slug: "case-studies-x" }), "Case studies");
assert.equal(g.adminDocGroup({ group: "", slug: "accounts" }), "Architecture");
const nav = [
  { label: "Onboarding", items: [{ title: "Overview", url: "/admin" }, { title: "Access requests", url: "/admin/requests" }, { title: "Accounts", url: "/admin/accounts" }] },
  { label: "Operations", items: [{ title: "Key vault", url: "/admin/keys" }, { title: "A pack page", url: "/admin/packs/p/x" }] },
];
const { title, markdown } = g.staffGuideMarkdown(nav);
const { profile } = await web("config/profile.generated.ts");
assert.equal(title, `${profile.name} staff guide`);
assert.ok(markdown.startsWith(`# ${title}\n`));
for (const h of [`## What ${profile.name} does`, "## Letting people in", "## The console, page by page", "## Every day"]) assert.ok(markdown.includes(h), h);
const table = markdown.slice(markdown.indexOf("| Page |"));
assert.deepEqual([...table.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\)/gm)].map((m) => `${m[1]} ${m[2]}`),
  ["Overview /admin", "Access requests /admin/requests", "Accounts /admin/accounts", "Key vault /admin/keys", "A pack page /admin/packs/p/x"]);
assert.match(table, /\| \[A pack page\]\(\/admin\/packs\/p\/x\) \| The product's own page, under Operations\. \|/);
assert.doesNotMatch(markdown, /src\/|\.ts\b|mold_v\d|ticket/i, "no source path or ticket number");
assert.doesNotMatch(markdown, /\{[a-z_]+\}/i, "every word placeholder filled");
ok(`the staff guide: "${title}", the sidebar's ${nav.flatMap((x) => x.items).length} pages in order with what each is for; no source path or ticket`);

// 3. Samples.
const { RecordAreaSchema } = await import("../src/pack-api.js");
const base = { name: "library", label: "Library", role: "source", scope: "platform", fields: [{ name: "code", label: "Code", type: "text" }] };
const parsed = RecordAreaSchema.safeParse({ ...base, samples: [{ key: "a-1", title: "A", data: { code: "x" } }] });
assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
const issues = (x: unknown) => { const r = RecordAreaSchema.safeParse(x); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
assert.match(issues({ ...base, scope: "workspace", samples: [{ key: "a", data: {} }] }).join("\n"), /samples: samples are for a shared \(platform\) area/);
assert.match(issues({ ...base, samples: [{ key: "a", data: { nope: 1 } }] }).join("\n"), /samples\.0\.data\.nope: nope is not one of the area's fields/);
assert.match(issues({ ...base, samples: [{ key: "a", data: {} }, { key: "a", data: {} }] }).join("\n"), /samples\.1\.key: sample a is declared twice/);
assert.ok(issues({ ...base, samples: [{ key: "../x", data: {} }] }).some((i) => i.startsWith("samples.0.key")));
ok("samples: shared areas only, each key once and a record key, each data key a declared field");

// 4. The customer lists are the same database table (mold_v0-176). A run's row in words (web/src/features/tabs/run-rows.ts),
// then, from the sources, every customer list page drawing RecordView (directly or through RecordTableView) and none of
// them linking to a staff page.
const rr = await web("features/tabs/run-rows.ts");
assert.deepEqual(rr.RUN_STATUSES.map((s: { value: string }) => s.value), ["queued", "running", "succeeded", "failed", "cancelled"]);
assert.equal(rr.statusLabel("succeeded"), "Succeeded");
assert.deepEqual(rr.runTarget({ targets: { asset: { area: "apps", key: "payments" } } }), { area: "apps", key: "payments" });
assert.equal(rr.runTarget({ targets: {} }), null);
assert.equal(rr.runTarget({ targets: { asset: { area: "apps" } } }), null, "a target needs its area and its key");
const t0 = "2026-10-01T10:00:00.000Z";
assert.equal(rr.runSeconds({ started_at: t0, ended_at: "2026-10-01T10:05:12.000Z", status: "succeeded" }), 312);
assert.equal(rr.runSeconds({ started_at: t0, ended_at: null, status: "running" }, Date.parse(t0) + 90_000), 90, "a running run: so far");
assert.equal(rr.runSeconds({ started_at: null, ended_at: null, status: "queued" }), null);
assert.equal(rr.runSeconds({ started_at: t0, ended_at: null, status: "failed" }), null, "ended with no end time: unknown, never a growing number");
assert.deepEqual([rr.duration(41), rr.duration(312), rr.duration(4020), rr.duration(null)], ["41s", "5m 12s", "1h 7m", ""]);
assert.equal(rr.resultCounts({ pass: 3, fail: 1, unknown: 0 }), "1 fail, 3 pass");
assert.deepEqual(["Applications", "Companies", "Boxes", "Status", "Address", "Control coverage"].map(rr.singular), ["Application", "Company", "Box", "Status", "Address", "Control coverage"]);
assert.equal(rr.runKindLabel("p", "nightly"), "nightly", "a kind the build does not declare reads as its name");
assert.equal(rr.targetLabel(), "Target", "no asset area in this build: Target");
ok("a run's row: its states in order, its target, how long it took (so far while running), its results, the target column's name");

const { readFileSync } = await import("node:fs");
const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const tab = src("features/tabs/tab-page.tsx");
assert.match(tab, /<RecordTableView area=\{area\} base='app'/, "an area tab's table is the records' database table");
assert.match(tab, /<RunsTable tab=\{tab\} reports=\{tab\.kind === 'reports'\}/, "runs and reports tabs are the runs' database table");
assert.doesNotMatch(tab, /<Table[\s>]/, "no table of its own left on the tab page");
const lists: Record<string, string> = {
  "features/records/record-pages.tsx": "the record areas' lists (and every area tab's table)",
  "features/tabs/runs.tsx": "runs and reports",
  "features/schedules/schedules-page.tsx": "schedules",
  "features/schedules/notices-page.tsx": "notices",
  "features/credentials/credentials-tab.tsx": "credentials",
  "features/email/email-tab.tsx": "senders and mailboxes",
};
for (const [file, what] of Object.entries(lists)) {
  const s = src(file);
  assert.match(s, /<RecordView</, `${what}: the database table`);
  assert.doesNotMatch(s.replace(/\/\/.*$/gm, ""), /['"`]\/admin\b/, `${what}: no link to a staff page`);
}
ok(`the customer lists are the database table, none linking to a staff page: ${Object.values(lists).join(", ")}`);

// 5. A list tab's four cards (mold_v0-181).
const sw = await web("features/tabs/spark-words.ts");
const fmt = (v: number | null, unit: string) => (v === null ? "—" : unit === "percent" ? `${Math.round(v * 100)}%` : unit === "usd" ? `$${v.toFixed(2)}` : String(v));
assert.deepEqual([sw.cardValue(0.25, "hours", fmt), sw.cardValue(1.5, "hours", fmt), sw.cardValue(null, "count", fmt)], ["15 min", "1.5", "—"], "an hour under one reads in minutes");
const W = 12;
assert.equal(sw.trendWords({ series: [0, 0, 1, 2, 4, 8], unit: "count", mode: "total" }, W, fmt), "Running total: rising over the last 12 weeks, from 0 to 8.");
assert.equal(sw.trendWords({ series: [null, 0.5, null, 0.25], unit: "percent", mode: "weekly" }, W, fmt), "Week by week: falling over the last 12 weeks, from 50% to 25%.", "weeks with nothing to measure are skipped");
assert.equal(sw.trendWords({ series: [100, 103], unit: "number", mode: "latest" }, W, fmt), "Week by week: steady over the last 12 weeks, at 103.");
assert.equal(sw.trendWords({ series: [null, 3, null], unit: "count", mode: "weekly" }, W, fmt), "No trend yet over the last 12 weeks.");
const cards = src("features/tabs/sparklines.tsx");
assert.match(cards, /<StatStrip quad items=\{items\} \/>/, "the cards are the console's headline numbers (StatStrip), four across or two by two");
assert.match(cards, /\/api\/sparklines\//, "numbers from the server, for this workspace and role");
assert.match(tab, /summary=\{<TabSparklines tab=\{tab\} \/>\}/, "an area tab's table: its cards as the table's summary");
assert.match(tab, /!table && <TabSparklines tab=\{tab\} \/>/, "a board or a timeline: above it");
assert.match(tab, /<RunsTable tab=\{tab\} reports=\{tab\.kind === 'reports'\} summary=\{<TabSparklines tab=\{tab\} \/>\} \/>/, "a runs or reports tab");
assert.match(tab, /<SchedulesBody key=\{current\.id\} summary=\{<TabSparklines tab=\{current\} \/>\} action=\{current\.action\} \/>/, "a schedules section");
for (const file of ["features/records/record-pages.tsx", "features/tabs/runs.tsx", "features/schedules/schedules-page.tsx"]) assert.match(src(file), /summary=\{summary\}/, `${file}: passes the cards to the table`);
// mold_v0-208: the shared table draws its summary first, then the search row (the toolbar), then the table.
{
  const rv = src("components/layout/record-view.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const at = (re: RegExp) => { const m = re.exec(rv); assert.ok(m, `record-view.tsx has ${re}`); return m.index; };
  const order = [at(/\{summary && <div className='flex shrink-0 flex-col'>\{summary\}<\/div>\}/), at(/<Input type='search'/), at(/<Table[ >]/)];
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `the cards, then the search row, then the table: ${order}`);
  assert.equal(rv.match(/\{summary &&/g)?.length, 1, "the summary is drawn once");
  const area = /function AreaTab[\s\S]*?\n}\n/.exec(tab)![0];
  assert.doesNotMatch(area, /ChartGrid/, "an area tab draws no charts: its cards, its search row, its table");
}
ok("a list tab's cards: a number and its trend in words (running total or week by week, rising, falling or steady, minutes under an hour); every list a tab draws shows them first, then its search row, then its table (a board or timeline: above it); an area tab draws no charts");

// 6. The Access log on the records table (mold_v0-205).
{
  const log = src("features/audit/access-log.tsx");
  const code = log.replace(/\/\/.*$/gm, "");
  assert.match(code, /<RecordTableView /, "the access log draws the records pages' table");
  assert.doesNotMatch(code, /<RecordView[<\s]|<Table[\s>]/, "no table of its own");
  assert.match(code, /summary=\{<Sparklines url=\{cards\}/, "its four cards, above the search row (the table's summary)");
  assert.match(code, /primary: <CsvLink href=\{csv\} \/>/, "Download CSV: the server's file of every entry");
  assert.match(code, /title: \{ label: 'When', type: 'date'/, "the entry's time: sorted and filtered by date range");
  for (const [name, type] of [["actor", "enum"], ["action", "enum"], ["area", "enum"], ["channel", "enum"]]) assert.match(code, new RegExp(`f\\('${name}', '[^']+', '${type}'`), `a ${name} filter`);
  assert.match(code, /\/api\/audit\/data\/sparklines/); assert.match(code, /\/api\/admin\/audit\/platform\/sparklines/);
  const rp = src("features/records/record-pages.tsx");
  assert.match(rp, /source \? source\.load\(\) : loadAll\(url, rows\)/, "the table reads a data adapter's rows in place of a records route");
  assert.match(rp, /export interface RecordSource/);
  ok("the Access log is the records table over a read-only system area: search, four cards, filters on who, action, area, door and date, column picker, Download CSV, a row drawer");
}

// 7. The Access log as Billing's tab (mold_v0-209).
{
  const billing = src("features/portal/billing.tsx").replace(/\/\/.*$/gm, "");
  const triggers = [...billing.matchAll(/<TabsTrigger value='([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(triggers, ["people", "teams", "rules", "access-log"], "Billing's tabs: People, Teams, Budget rules, then Access log");
  assert.match(billing, /const logTab = dataTrailOn\(\) && role === 'owner';/, "the Access log tab: audit.data on, owners only");
  assert.match(billing, /\{logTab && <TabsTrigger value='access-log'[^>]*>Access log<\/TabsTrigger>\}/);
  assert.match(billing, /<TabsContent value='access-log'><WorkspaceAccessLog \/><\/TabsContent>/, "the tab draws the same records table page");
  assert.match(billing, /const BILLING_TABS = \['people', 'teams', 'rules', 'access-log'\];/, "?tab= opens each tab");
  assert.match(billing, /q\.set\('tab', tab\)/, "the open tab is kept in the address");
  const log = src("features/audit/access-log.tsx").replace(/\/\/.*$/gm, "");
  const body = log.slice(log.indexOf("export function WorkspaceAccessLog("), log.indexOf("export function OperatorAccessLogPage("));
  assert.ok(body.length > 0 && !/PageContainer|pageTitle/.test(body), "no title above the tab strip: the tab has no page title of its own");
  assert.match(body, /<TrailTable /);
  // Action and Actor (mold_v0-209): both trails' tables have the two columns where the platform trail had Kind.
  assert.equal((log.match(/f\('action', 'Action', 'enum'/g) ?? []).length, 2, "an Action column on both trails, filtered by its values");
  assert.equal((log.match(/f\('actor', 'Actor', 'enum'\)/g) ?? []).length, 2, "an Actor column on both trails, filtered by its values");
  assert.doesNotMatch(log, /'Kind'|'Who'/, "no Kind or Who column left");
  assert.match(log, /\['action', 'actor', 'area'/); assert.match(log, /'action', 'actor', 'request'/);
  assert.match(log, /action: e\.action, actor: e\.actor/, "the row's Action and Actor are the server's words (the drawer shows both)");
  const { existsSync: exists } = await import("node:fs");
  assert.ok(!exists(path.join(WEB, "app", "app", "access-log")), "no /app/access-log page");
  assert.ok(exists(path.join(WEB, "app", "admin", "access-log", "page.tsx")), "the staff /admin/access-log stays");
  const routes = JSON.parse(src("config/console-routes.generated.json")) as { routes: string[] };
  assert.ok(!routes.routes.includes("/app/access-log") && routes.routes.includes("/admin/access-log"), "the route list: /admin/access-log only");
  assert.doesNotMatch(src("lib/console-routes.ts"), /'\/app\/access-log'/);
  assert.doesNotMatch(src("components/layout/portal-frame.tsx"), /withAuditNav|access-log/, "no Access log sidebar entry in the customer portal");
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const linking = walk(WEB).filter((f) => /\.(tsx?|json|md)$/.test(f) && readFileSync(f, "utf8").includes("/app/access-log"));
  assert.deepEqual(linking, [], "nothing in the console links to /app/access-log");
  ok("the Access log is Billing's 4th tab (?tab=access-log; audit.data on, owners only, no title of its own); /app/access-log is gone, /admin/access-log stays");
}

// 8. The staff record pages (mold_v0-212).
{
  const st = src("features/records/staff-records.tsx").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(st, /pageTitle|pageDescription/, "no title or description above a staff record page");
  assert.match(st, /<RecordTableView key=\{round\} area=\{area\} base='admin'/, "the list is the records' table");
  assert.doesNotMatch(st, /<RecordView[<\s]|<Table[\s>]/, "no table of its own");
  assert.match(st, /summary=\{<Sparklines url=\{consoleUrl\(area\.name, 'sparklines'\)\}/, "its four cards above the search row, from the staff route");
  // mold_v0-221: New <noun> the primary action, Import beside it, on every shared area (a repository's too).
  assert.match(st, /\{form\.create && <ToolbarAction label=\{`New \$\{noun\}`\}/, "New <noun>: the primary action at the search row's right end, only when the server offers create");
  assert.match(st, /\{form\.import && \([\s\S]{0,80}<Button type='button' variant='outline' onClick=\{\(\) => setImporting\(true\)\}/, "Import: the search row's secondary action, before New, only when the server offers import");
  assert.match(st, /<ImportRecordsForm area=\{area\}/, "the import card");
  assert.doesNotMatch(st, /\bFab\b|fab=/, "no floating action");
  assert.match(st, /rowAction=\{form\?\.edit \|\| form\?\.remove \?/, "Edit (Override) and Remove on an open record, only when the server offers them");
  assert.match(st, /fromRepository \? 'Override' : 'Edit'/, "a repository's row: Override");
  assert.match(st, /Overridden by staff/, "an override marked in the details card");
  assert.match(st, /detailNote=\{\(r\) => <ProvenanceFields/, "the open record says where it comes from");
  assert.doesNotMatch(st, /!a\.repo|form\.repository \?/, "no area hidden from staff writes for having a repository");
  assert.match(st, /<CreateRecordForm area=/, "the create form is the tab action's (features/tabs/tab-action.tsx)");
  assert.match(st, /adminDataApi\('POST'/); assert.match(st, /adminDataApi\('PUT'/);
  assert.match(st, /<Card [^>]*data-record-card/, "the record's page: one details card");
  assert.match(src("app/admin/records/[area]/page.tsx"), /<StaffRecordListPage area=\{spec\} \/>/);
  assert.match(src("app/admin/records/[area]/[key]/page.tsx"), /<StaffRecordDetailPage area=\{spec\}/);
  ok("the staff record pages: no title above the list, its cards, search row and table, New <noun> and Import in the search row and Edit (Override on a repository's row) where staff may write, provenance and overrides marked, the record's page one details card");
}

// 9. Settings: Credentials and Email as one page's in-page tabs (mold_v0-218).
{
  const { existsSync: exists } = await import("node:fs");
  const page = src("features/settings/settings-page.tsx").replace(/\/\/.*$/gm, "");
  // Since mold_v0-219 its tabs are the features registry's (web/src/config/settings.ts, gen-packs settingsTabs): each kind drawn.
  assert.match(page, /tabs\.map\(\(t\) => <TabsTrigger key=\{t\.id\} value=\{t\.id\}/, "Settings' tabs: the build's, in order");
  for (const k of ["credentials", "email", "api_keys", "allowed_origins", "webhooks", "integrations", "alerts", "signing", "area"]) assert.match(page, new RegExp(`case '${k}'`), `Settings draws its ${k} tab`);
  assert.match(page, /useQueryState\('tab'/, "the open tab is kept in the address (?tab=)");
  assert.doesNotMatch(page, /pageTitle|pageDescription/, "no title above the tab strip");
  assert.match(page, /tabs\.length < 2 \?/, "one tab alone: its table, with no strip");
  for (const [file, cards] of [["features/credentials/credentials-tab.tsx", ["Set", "Missing", "Required missing", "Changed in the last 7 days"]],
    ["features/email/email-tab.tsx", ["Mailboxes", "Messages taken in", "With an error", "Sender"]]] as const) {
    const code = src(file).replace(/\/\/.*$/gm, "");
    assert.match(code, /summary=\{<StatStrip quad items=\{\[/, `${file}: four cards above the search row`);
    assert.deepEqual([...code.matchAll(/\{ label: '([^']+)', value:/g)].map((m) => m[1]), cards, `${file}: its four cards`);
    assert.match(code, /detail=\{\(r\) =>/, `${file}: a row opens its details card`);
    assert.doesNotMatch(code, /PageContainer|<Badge/, `${file}: no page title of its own, no badges in the table`);
  }
  const email = src("features/email/email-tab.tsx");
  assert.match(email, /<ToolbarAction label='Add mailbox'[^\n]*setAdding\('mailbox'\)/, "Add mailbox: the search row's primary action (mold_v0-217 ToolbarAction)");
  assert.match(email, /data\.offer\.sender && !s && <ToolbarAction label='Set sender'[^\n]*setAdding\('sender'\)/, "Set sender, until one is set");
  assert.match(email, /toolbarAction=\{actions\}/, "in the search row");
  assert.match(email, /<ActionCard open onOpenChange=\{close\} title='Add mailbox'/, "it opens the shell's full card in the list's place (mold_v0-217 ActionCard)");
  assert.match(email, /<CardForm onSubmit=\{save\} submit=\{<Button type='submit' disabled=\{busy\}>Connect<\/Button>\}>/, "the card's form: the fields, then Connect and Cancel");
  assert.match(email, /\/inboxes\/\$\{b\.id\}\/test/, "Test in a mailbox's card");
  for (const gone of ["credentials", path.join("settings", "email")]) assert.ok(!exists(path.join(WEB, "app", "app", gone)), `no /app/${gone} page`);
  assert.ok(exists(path.join(WEB, "app", "app", "settings", "page.tsx")), "the /app/settings page");
  const routes = JSON.parse(src("config/console-routes.generated.json")) as { routes: string[] };
  assert.ok(routes.routes.includes("/app/settings") && !routes.routes.includes("/app/credentials") && !routes.routes.includes("/app/settings/email"), "the route list: /app/settings only");
  assert.match(src("lib/console-routes.ts"), /'\/app\/settings': \(\) => settingsLayout\(\) !== 'none'/, "Settings is a page only with a tab");
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const linking = walk(WEB).filter((f) => /\.(tsx?|json|md)$/.test(f) && /\/app\/credentials\b|\/app\/settings\/email/.test(readFileSync(f, "utf8")));
  assert.deepEqual(linking, [], "nothing in the console links to /app/credentials or /app/settings/email");
  for (const f of ["oauth-routes.ts", "github-app-routes.ts", "mcp-tools.ts"]) assert.doesNotMatch(readFileSync(path.join(WEB, "..", "..", "src", f), "utf8"), /\/app\/credentials\b|\/credentials"\)/, `src/${f}: leads to Settings › Credentials`);
  ok("Settings: its registry's tabs (Credentials | Email and the rest) as in-page tabs (?tab=, no title, one alone without a strip), each its four cards, search row and table, a row's details card, Add mailbox and Set sender; /app/credentials and /app/settings/email gone");
}

// 10. No title or description above a list (mold_v0-231; mold_v0-217's rule on every list page of both consoles).
{
  const { existsSync: exists, readdirSync, statSync } = await import("node:fs");
  // Comments out (JSX ones, doc comments and whole-line ones), and a guard's one-line early return (a status line).
  const code = (rel: string) => src(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*if \(.*\) return .*;$/gm, "");
  // One top-level function of a module: from its line to the first closing brace at column 0.
  const fn = (rel: string, name: string) => {
    const s = code(rel);
    const m = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\n\\}\\n`).exec(`\n${s}\n`);
    assert.ok(m, `${rel} has a function ${name}`);
    return m[0];
  };
  // What a list starts with: its cards (a summary, StatStrip, the sparklines), its table (RecordView and the components
  // that draw one), or the in-page tab strip it sits under.
  const LIST = /summary=|<(?:RecordView|RecordTableView|TrailTable|RunsTable|SchedulesBody|AreaTab|SectionsTab|CredentialsTab|EmailTab|UrlTabs|HealthTabs|HealthTab|Tabs|TabsList|StatStrip|Sparklines|TabSparklines|AdminAccounts|AdminAdmins|ComputeOrchestrators|ComputeFailures|ComputeDecisions|ComputeJobs|ComputeSessions|AdminEmails|PackRunKinds|RevenueTab|SpendTab|ComputeTab|StorageTab|ChargesTab|ExperimentsTab|RunsTab|ScheduledTab|DeliveriesTab|WebhooksTab|StatusTab|FailedRuns|KindsTable|SpendAccounts|SpendProviders)\b|\{body\}/;
  // A title or a description: a heading, the shell's Heading, a titled Section, a muted paragraph.
  const TITLE = /<h1\b|<h2\b|<Heading\b|<Section\b[^>]*\btitle=|<p className='text-muted-foreground(?: text-sm)?'>/;
  const before = (body: string) => {
    // From where the list is put together (a body of JSX, else the function's last return) to its first part.
    const start = Math.max(body.indexOf("const body = ("), body.lastIndexOf("\n  return"));
    const rest = body.slice(Math.max(0, start));
    const at = rest.search(LIST);
    return at < 0 ? null : rest.slice(0, at);
  };
  // The one titled frame a tab page has: an overview tab's (a dashboard, not a list).
  const overviewOnly = (body: string) =>
    body.replace(/pageTitle=\{tab\.kind === 'overview' \? tab\.label : undefined\}\s*pageDescription=\{tab\.kind === 'overview' \? tab\.description \?\? undefined : undefined\}/, "");
  // Every list route of both consoles: its page, the component the page draws, and each component (file, function)
  // between the page frame and the list.
  type Hop = [file: string, name: string];
  const ROUTES: [route: string, page: string, draws: string, hops: Hop[]][] = [
    ["/app/<tab> (area, runs, reports, schedules, sections tabs)", "app/app/[page]/page.tsx", "TabPage",
      [["features/tabs/tab-page.tsx", "TabPage"], ["features/tabs/tab-page.tsx", "AreaTab"], ["features/tabs/tab-page.tsx", "SectionsTab"], ["features/tabs/runs.tsx", "RunsTable"], ["features/schedules/schedules-page.tsx", "SchedulesBody"]]],
    ["/app/records/<area>", "app/app/records/[area]/page.tsx", "RecordListPage", [["features/records/record-pages.tsx", "RecordListPage"], ["features/records/record-pages.tsx", "RecordTableView"]]],
    ["/app/schedules", "app/app/schedules/page.tsx", "SchedulesPage", [["features/schedules/schedules-page.tsx", "SchedulesPage"], ["features/schedules/schedules-page.tsx", "SchedulesBody"]]],
    ["/app/settings (Credentials, Email)", "app/app/settings/page.tsx", "SettingsPage",
      [["features/settings/settings-page.tsx", "SettingsPage"], ["features/credentials/credentials-tab.tsx", "CredentialsTab"], ["features/email/email-tab.tsx", "EmailTab"]]],
    ["/app/notices", "app/app/notices/page.tsx", "NoticesPage", [["features/schedules/notices-page.tsx", "NoticesPage"]]],
    ["/app/billing?tab=access-log", "app/app/billing/page.tsx", "BillingPage", [["features/audit/access-log.tsx", "WorkspaceAccessLog"]]],
    ["/admin/records/<area>", "app/admin/records/[area]/page.tsx", "StaffRecordListPage", [["features/records/staff-records.tsx", "StaffRecordListPage"]]],
    ["/admin/compute (and its Emails tab)", "app/admin/compute/page.tsx", "AdminCompute", [["features/admin/compute.tsx", "ComputePage"], ["features/admin/emails.tsx", "AdminEmails"]]],
    ["/admin/finops", "app/admin/finops/page.tsx", "AdminFinOps",
      [["features/admin/spend.tsx", "SpendPage"], ["features/admin/spend.tsx", "SpendTab"], ["features/admin/spend.tsx", "SpendAccounts"], ["features/admin/spend.tsx", "SpendProviders"],
        ["features/admin/spend.tsx", "ComputeTab"], ["features/admin/spend.tsx", "StorageTab"], ["features/admin/spend.tsx", "ChargesTab"], ["features/admin/spend.tsx", "RevenueTab"]]],
    ["/admin/access-log", "app/admin/access-log/page.tsx", "OperatorAccessLogPage", [["features/audit/access-log.tsx", "OperatorAccessLogPage"]]],
    ["/admin/health (its tabs)", "app/admin/health/page.tsx", "AdminAnalytics",
      [["features/admin/analytics.tsx", "ErrorsReport"], ["features/admin/health-tabs.tsx", "HealthTab"], ["features/admin/health-tabs.tsx", "RunsTab"], ["features/admin/health-tabs.tsx", "ScheduledTab"],
        ["features/admin/health-tabs.tsx", "DeliveriesTab"], ["features/admin/health-tabs.tsx", "WebhooksTab"]]],
    ["/admin/requests", "app/admin/requests/page.tsx", "AdminRequests", [["features/admin/requests.tsx", "AdminRequests"]]],
    ["/admin/accounts (Accounts, Admins)", "app/admin/accounts/page.tsx", "AccountsPage",
      [["features/admin/accounts-tabs.tsx", "AccountsPage"], ["features/admin/accounts.tsx", "AdminAccounts"], ["features/admin/admins.tsx", "AdminAdmins"]]],
    ["/admin/configuration", "app/admin/configuration/page.tsx", "AdminConfiguration", [["features/admin/configuration.tsx", "AdminConfiguration"]]],
    ["/admin/keys", "app/admin/keys/page.tsx", "AdminKeyVault", [["features/admin/keyvault.tsx", "AdminKeyVault"]]],
    ["/admin/journeys", "app/admin/journeys/page.tsx", "AdminJourneys", [["features/journeys/admin.tsx", "AdminJourneys"]]],
  ];
  const walked: string[] = [];
  for (const [route, page, draws, hops] of ROUTES) {
    assert.ok(exists(path.join(WEB, page)), `${route}: its page ${page}`);
    assert.match(src(page), new RegExp(`<${draws}\\b`), `${route}: ${page} draws ${draws}`);
    for (const [file, name] of hops) {
      const body = fn(file, name);
      const props = overviewOnly(body);
      assert.doesNotMatch(props, /pageTitle|pageDescription|pageHeaderAction/, `${route}: ${file} ${name} puts no title, description or header row above the list (an overview tab alone has its title)`);
      const head = before(body);
      assert.ok(head !== null, `${route}: ${file} ${name} draws a list (its cards, its table or its tab strip)`);
      const t = TITLE.exec(head!);
      assert.equal(t, null, `${route}: ${file} ${name}: no title or description above the list's cards (${t?.[0]})`);
    }
    walked.push(route);
  }
  // And every other page of the console: a component in a page frame (PageContainer) that draws a list of records or
  // rows (the table, a trail, its cards) gives that frame no title or description.
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const titled: string[] = [];
  for (const f of walk(path.join(WEB, "features")).filter((x) => x.endsWith(".tsx"))) {
    const rel = path.relative(WEB, f);
    for (const m of `\n${code(rel)}\n`.matchAll(/\n(?:export )?function ([A-Z]\w*)\b[\s\S]*?\n\}\n/g)) {
      const body = overviewOnly(m[0]);
      if (/<PageContainer\b[^>]*\bpage(?:Title|Description)=/.test(body) && /<(?:RecordView|RecordTableView|TrailTable)\b|summary=/.test(body)) titled.push(`${rel} ${m[1]}`);
    }
  }
  assert.deepEqual(titled, [], "no list page (the database table, a trail, its cards) in a titled page frame");
  ok(`no title or description above a list (mold_v0-231): ${walked.join(", ")}; and no titled page frame around any other list`);
}
