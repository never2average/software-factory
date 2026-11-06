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
//  12. The customer credential vault in its places (mold_v0-239): Settings › Credentials reads only the workspace's
//      credentials (?scope=workspace) with no caption beside its search row and no "Bound to" column; a record's own
//      page draws its Credentials card (the record's, then one group per environment) and, while one is open, the set
//      card in the page's place; Set, Replace and Clear are full cards (never a dialog or a side sheet) whose value
//      inputs are hidden; an environment is picked (a select of the record's), never typed; no internal word
//      (bound_to, deliver_as, asset, a variable's or a pack's name, a record area's id) reaches the screen; no count
//      line under the Credentials card's heading (mold_v0-240). mold_v0-241: Settings › Credentials also lists one row
//      per record (one request per area, after the workspace's rows, its status in words, searched by name), opening the
//      record's page at its Credentials card (#credentials).
//  13. A record's json field in words (mold_v0-240; web/src/features/records/json-text.ts): a list of objects one line per
//      item (its name, then its meaningful fields), an object one line per field, nested objects flattened, bookkeeping
//      and a value repeating the record's own key hidden, common short values in words (the credentials card's
//      mapping); one line in a list's cell and a board's card; drawn by a record's page, an open row's card and a staff
//      record's page, never as raw JSON.
//  14. A record's page, laid out (mold_v0-253, flag record_pages): the area's `detail` declared and refused (a field the
//      area lacks, a ninth fact, an empty tab, a badge colour outside the theme's tokens, ...), its badges, facts by
//      type, notices, tabs and sections, copy (id, link, copyable fields; toasts), the build over the fixture
//      scripts/fixtures/packs/fixture_pages (off: the generated files as before the flag; on: the layouts), and the page
//      drawn in a headless browser.
//  15. A record's page, part 2 (mold_v0-254, flag record_pages): related lists, a record's runs and the header's actions
//      declared and refused (in the area and across the build: a related list whose area has no link back here, an action
//      naming a job kind or a transition that does not exist, two primary actions, ...), what the console decides (the
//      actions by place, Show all's address, the counts), how it draws them (the shared Button's variants, the console's
//      confirm, forms as full cards, a disabled action's reason on hover and focus), gen-packs refusing the same, and the
//      page drawn in a headless browser (the header's actions, a related list, the runs). The API, by role and workspace:
//      scripts/record-page-actions-test.ts, run after this one.
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
  const LIST = /summary=|<(?:RecordView|RecordTableView|AreaRecordList|TrailTable|RunsTable|SchedulesBody|AreaTab|SectionsTab|CredentialsTab|EmailTab|UrlTabs|HealthTabs|HealthTab|Tabs|TabsList|StatStrip|Sparklines|TabSparklines|AdminAccounts|AdminAdmins|ComputeOrchestrators|ComputeFailures|ComputeDecisions|ComputeJobs|ComputeSessions|AdminEmails|PackRunKinds|RevenueTab|SpendTab|ComputeTab|StorageTab|ChargesTab|ExperimentsTab|RunsTab|ScheduledTab|DeliveriesTab|WebhooksTab|StatusTab|FailedRuns|KindsTable|SpendAccounts|SpendProviders)\b|\{body\}/;
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
    ["/app/records/<area>", "app/app/records/[area]/page.tsx", "RecordListPage", [["features/records/record-pages.tsx", "RecordListPage"], ["features/records/record-pages.tsx", "AreaRecordList"], ["features/records/record-pages.tsx", "RecordTableView"]]],
    ["/app/schedules", "app/app/schedules/page.tsx", "SchedulesPage", [["features/schedules/schedules-page.tsx", "SchedulesPage"], ["features/schedules/schedules-page.tsx", "SchedulesBody"]]],
    ["/app/settings (Credentials, Email)", "app/app/settings/page.tsx", "SettingsPage",
      [["features/settings/settings-page.tsx", "SettingsPage"], ["features/credentials/credentials-tab.tsx", "CredentialsTab"], ["features/email/email-tab.tsx", "EmailTab"], ["features/records/record-pages.tsx", "AreaRecordList"]]],
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

// 11. An area's own lists (mold_v0-237): the Records page and a Settings area tab are the standard list, as an area
//     tab's: the area's four cards, the search row with Export CSV and the area's primary action (the registry's action,
//     the server's /api/tab-actions/_areas/<area>), the table; the action's form a full card in the list's place. And
//     the create form's file fields (mold_v0-238): Choose files, each file's progress bar, then Uploaded; never a dialog.
{
  const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pages = strip(src("features/records/record-pages.tsx")), settings = strip(src("features/settings/settings-page.tsx")), ta = strip(src("features/tabs/tab-action.tsx"));
  const list = /export function AreaRecordList\b[\s\S]*?\n\}\n/.exec(pages)?.[0] ?? "";
  assert.match(list, /useAreaAction\(area, /, "AreaRecordList: the area's own action");
  // mold_v0-256: through FormHost (the full card in the list's place; with side_panel_forms on, a panel beside the list).
  assert.match(list, /<FormHost card=\{card\} panel=\{panel\}>\s*<RecordTableView /, "its form a full card in the list's place");
  assert.match(list, /<RecordTableView [\s\S]*summary=\{<Sparklines url=\{`\$\{recordsApi\('app'\)\}\/_console\/\$\{encodeURIComponent\(area\.name\)\}\/sparklines`\}[\s\S]*toolbarAction=\{button \?\? undefined\}/,
    "its cards above the search row, the action the search row's last control (Export beside it, RecordTableView)");
  assert.match(pages, /export function RecordListPage[\s\S]*?base === 'app' \? <AreaRecordList area=\{area\} /, "the Records page is that list");
  assert.match(settings, /case 'area': \{[\s\S]*?<AreaRecordList area=\{area\} id=\{`settings-\$\{area\.name\}`\} \/>/, "a Settings area tab is that list");
  assert.doesNotMatch(settings, /RecordTableView/, "Settings draws no bare table (Export alone) any more");
  assert.match(ta, /export function useAreaAction\([\s\S]*?`\/api\/tab-actions\/_areas\/\$\{encodeURIComponent\(area\.name\)\}`/, "the action from the server's area route");
  // The create form's uploads (mold_v0-238).
  assert.match(ta, /<FileUploads key=\{f\.name\} field=\{f\} /, "a file field of an area that takes uploads: FileUploads");
  assert.match(ta, /role='progressbar' aria-label=\{`Uploading \$\{it\.file\.name\}`\} aria-valuemin=\{0\} aria-valuemax=\{100\} aria-valuenow=\{pct\}/, "each file's progress, said");
  assert.match(ta, /it\.state === 'done' \? 'Uploaded'/, "then Uploaded");
  assert.match(ta, /x\.upload\.onprogress = /, "the bytes sent so far, as they go");
  assert.match(ta, /'content-type', 'application\/octet-stream'/, "the bytes as application/octet-stream");
  assert.match(ta, /type=\{f\.type === 'number' \? 'number' : f\.type === 'date' \? 'date' : f\.type === 'url' \? 'url' : 'text'\}/, "a url field: an address input");
  for (const [name, t] of [["tab-action.tsx", ta], ["record-pages.tsx", pages], ["settings-page.tsx", settings]] as const)
    assert.doesNotMatch(t, /<(?:Dialog|Sheet|AlertDialog|Drawer)\b|from '@\/components\/ui\/(?:dialog|sheet|drawer|alert-dialog)'/, `${name}: forms are full cards, never a dialog or a side sheet`);
  ok("an area's own lists (mold_v0-237): the Records page and a Settings area tab draw the area's cards, the search row with Export and its primary action, the table, the form a full card; the create form uploads its file fields' files with each one's progress, then Uploaded, and takes a url field as an address (mold_v0-238); no dialog or side sheet");
}

// 12. The customer credential vault in its places (mold_v0-239).
{
  const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tab = strip(src("features/credentials/credentials-tab.tsx")), card = strip(src("features/credentials/credential-card.tsx"));
  const rc = strip(src("features/credentials/record-credentials.tsx")), pages = strip(src("features/records/record-pages.tsx"));
  const oauth = strip(src("features/credentials/oauth-connections.tsx")), gh = strip(src("features/credentials/github-app-section.tsx"));
  assert.match(tab, /credentialsCall<Vault>\('GET', undefined, '\?scope=workspace'\)/, "Settings › Credentials reads the workspace's own credentials only");
  assert.match(tab, /const creds = forSettings\(credentialsOf\(data\.fields\)\);/, "and lists only those (a group as one row)");
  assert.doesNotMatch(tab, /filters=|Open a credential to set, replace or clear it/, "no caption beside the search row");
  assert.doesNotMatch(tab, /label: 'Bound to'/, "no Bound to column");
  assert.match(tab, /if \(opened && data\.can_manage\) return <CredentialCard /, "Set, Replace and Clear: the full card in the list's place");
  const detail = /export function RecordDetailPage\b[\s\S]*?\n\}\n/.exec(pages)?.[0] ?? "";
  assert.match(detail, /const credentials = useRecordCredentials\(area, recordKey, base === 'app' && area\.role === 'asset'\);/, "a record's page reads its credentials (a workspace's page only)");
  assert.match(detail, /if \(credentials\.card\) return <PageContainer>\{credentials\.card\}<\/PageContainer>;/, "the set card takes the page's place");
  assert.match(detail, /<\/Card>\s*\{credentials\.section\}/, "its Credentials card below the details card");
  assert.match(rc, /'\?area=\$\{encodeURIComponent\(area\.name\)\}&key=\$\{encodeURIComponent\(recordKey\)\}'|`\?area=\$\{encodeURIComponent\(area\.name\)\}&key=\$\{encodeURIComponent\(recordKey\)\}`/, "the record's own credentials");
  assert.match(rc, /<CardTitle className='text-base'>Credentials<\/CardTitle>/, "titled Credentials");
  assert.doesNotMatch(rc, /<CardDescription\b|of \{[\w.]+\} set|setCount/, "no count line under the heading (mold_v0-240)");
  assert.match(rc, /For this \{noun\}/, "the record's own first, in its area's words");
  assert.match(rc, /sections\.environments\.map\(\(g\) => \([\s\S]*?<h3 className='text-sm font-medium'>\{g\.label\}<\/h3>/, "then one group per environment, named in words");
  assert.match(card, /<NativeSelect id='credential-environment'[\s\S]*?environments\.map\(\(x\) => <NativeSelectOption key=\{x\} value=\{x\}>\{envWord\(x\)\}<\/NativeSelectOption>\)/, "an environment is picked from the record's");
  assert.doesNotMatch(card, /placeholder='environment'|aria-label='Environment' \/>/, "never typed");
  assert.match(card, /type='password' autoComplete='new-password'/, "a value is hidden as you type");
  assert.match(card, /\[-webkit-text-security:disc\]/, "a file's text too");
  assert.match(card, /<Card className='w-full max-w-4xl gap-0 py-0' data-action-card='' data-credential-card=\{mode\}>/, "the card: the console's full card");
  assert.match(card, /if \(c\.group\) await credentialsCall\('PUT', \{ \.\.\.slot, group: c\.group, values \}\)/, "a pair set in one request");
  assert.match(card, /c\.group \? \{ \.\.\.slot, group: c\.group \}/, "and cleared as one");
  for (const [name, t] of [["credentials-tab.tsx", tab], ["credential-card.tsx", card], ["record-credentials.tsx", rc], ["oauth-connections.tsx", oauth], ["github-app-section.tsx", gh]] as const) {
    assert.doesNotMatch(t, /<(?:Dialog|Sheet|AlertDialog|Drawer)\b|from '@\/components\/ui\/(?:dialog|sheet|drawer|alert-dialog)'/, `${name}: never a dialog or a side sheet`);
    // What a person reads: JSX text and the words in quotes a component shows. None of the internal words.
    const shown = [...t.matchAll(/>([^<>{}]+)</g), ...t.matchAll(/(?:placeholder|aria-label|label|title|back|forWhat)=(?:'([^']*)'|\{`([^`]*)`\})/g)].map((m) => m.slice(1).join(" "));
    for (const w of ["bound_to", "deliver_as", "asset", "environments_from", "path_env", "group_label"]) assert.ok(!shown.some((x) => new RegExp(`\\b${w}\\b`, "i").test(x)), `${name}: "${w}" is never shown`);
    assert.doesNotMatch(t, /(?<!\$)\{(?:f|c|v|r)\.(?:pack|area|asset|bound_to)\}|deliver_as\.(?:env|file)\b|\{f\.deliver_as/, `${name}: no pack id, area id, record key column, binding or variable name drawn`);
  }
  const model = await web("features/credentials/model.ts");
  assert.deepEqual(["prod", "staging", "qa", "eu-west"].map(model.envWord), ["Production", "Staging", "QA", "Eu west"], "environments named in words");
  // mold_v0-241: Settings › Credentials also lists one row per record whose credentials are its own, after the workspace's.
  assert.match(tab, /areas\.split\(','\)\.filter\(Boolean\)\.map\(\(area\) =>\s*credentialsCall<AreaVault>\('GET', undefined, `\?records=\$\{encodeURIComponent\(area\)\}`\)/, "one request per area (?records=), for the areas the workspace's answer names");
  assert.doesNotMatch(tab, /\?area=|useRecordCredentials|RecordCredentials/, "never one request per record, and the record's Credentials card is not drawn here");
  assert.match(tab, /const rows = \[\.\.\.rowsOf\(creds, data, oauth, github, runners\), \.\.\.recordRowsOf\(records\)\];/, "the workspace's own rows first, then one per record");
  assert.match(tab, /const n = settingsCounts\(rows\.flatMap\(\(r\) => r\.units \?\? /, "the cards count each record's credentials one by one");
  assert.match(tab, /if \(href\) router\.push\(href\)/, "a record's row opens its page");
  assert.match(tab, /\{r\.words \?\? r\.status\}/, "its status in words, plain text");
  assert.match(tab, /searchText=\{\(r\) => `\$\{r\.name\} /, "searched by its name");
  assert.match(rc, /<Card id=\{CREDENTIALS_ANCHOR\} ref=\{anchor\}/, "the record page's Credentials card is the #credentials anchor");
  assert.equal(model.CREDENTIALS_ANCHOR, "credentials");
  assert.match(model.recordCredentialsHref("apps", "a-1"), /^\/app\/records\/apps\/a-1#credentials$/, "a row links to the record's page at its Credentials card");
  ok("the credential vault in its places (mold_v0-239): Settings › Credentials the workspace's only, no caption, no Bound to; a record's page its Credentials card (the record's, then per environment) and the set card in the page's place; full cards, hidden values, environments picked; no internal word shown");
}

// 13. A record's json field in words (mold_v0-240).
{
  const { jsonView, jsonLine, isDocument, keyLabel } = await web("features/records/json-text.ts");
  const words = await web("lib/value-words.ts");
  const model = await web("features/credentials/model.ts");
  assert.equal(model.envWord, words.envWord, "the credentials card's environment names and a json field's words: one mapping");
  // An application's environments as a pack's index writes them (each its own small document).
  const KEY = "example-service";
  const env = (envId: string, tier: string) => ({ schemaVersion: "1", kind: "example.app.environment", appId: KEY, envId, tier, hosting: { provider: "aws", region: "ap-south-1" } });
  const envs = [env("prod", "prod"), env("staging", "staging")];
  assert.ok(isDocument(envs) && isDocument({ a: 1 }) && !isDocument(["a", "b"]) && !isDocument("x") && !isDocument(null), "a document: an object, or a list holding one");
  assert.deepEqual(jsonView(envs, KEY), { kind: "items", items: [
    { name: "Production", parts: [{ label: "Hosting", text: "AWS, ap-south-1" }] },
    { name: "Staging", parts: [{ label: "Hosting", text: "AWS, ap-south-1" }] }
  ] }, "a list of objects: one item each, its name in words, its nested hosting flattened; schemaVersion, kind, the record's own key and a tier repeating the name hidden");
  assert.equal(jsonLine(envs, KEY), "Production (AWS, ap-south-1); Staging (AWS, ap-south-1)", "the same on one line (a list's cell)");
  // A tier that is not the name is said; another key's id is kept, labelled.
  assert.deepEqual(jsonView([{ envId: "eu-1", tier: "prod", hosting: { provider: "gcp" } }], KEY).items[0],
    { name: "eu-1", parts: [{ label: "Tier", text: "Production" }, { label: "Hosting", text: "GCP" }] }, "a tier other than the name: Tier: Production");
  assert.deepEqual(jsonView([{ name: "Billing", id: "b-7", owner: { team: "Payments", oncall: true } }]).items[0],
    { name: "Billing", parts: [{ label: "ID", text: "b-7" }, { label: "Owner", text: "Payments, Yes" }] }, "a name key first; an id kept; Yes for true");
  assert.deepEqual(jsonView({ $schema: "x", _rev: 3, schema_version: 2, region: "eu-west-1", stage: "dev", contacts: [{ name: "Ops", email: "ops@example.com" }] }),
    { kind: "fields", parts: [{ label: "Region", text: "eu-west-1" }, { label: "Stage", text: "Development" }, { label: "Contacts", text: "Ops (ops@example.com)" }] },
    "an object: one line per field, bookkeeping ($, _, schema_version) hidden, nested lists of objects flattened");
  assert.equal(jsonLine({ region: "eu-west-1", stage: "dev" }), "Region: eu-west-1; Stage: Development", "an object on one line");
  assert.deepEqual(["envId", "hosting_region", "apiUrl", "tier"].map(keyLabel), ["Env ID", "Hosting region", "API URL", "Tier"], "keys in words");
  assert.equal(jsonView([], KEY).kind, "text", "an empty list: nothing to say");
  for (const v of [envs, envs[0], { a: { b: { c: "d" } } }]) assert.doesNotMatch(jsonLine(v, KEY), /[{}[\]"]|schemaVersion|example\.app\.environment/, "never raw JSON or bookkeeping");

  // Where the console shows a record's json field: fieldText (a list's cell, its search, the peek's one line), FieldValue
  // (a record's page, an open row's card, a staff record's page) and a board's card.
  const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pages = strip(src("features/records/record-pages.tsx")), staff = strip(src("features/records/staff-records.tsx"));
  const board = strip(src("features/tabs/board.tsx")), jv = strip(src("features/records/json-value.tsx"));
  const ft = /export function fieldText\b[\s\S]*?\n\}\n/.exec(pages)?.[0] ?? "";
  assert.match(ft, /if \(isDocument\(v\)\) return jsonLine\(v, recordKey\);/, "fieldText: a json value one readable line");
  assert.doesNotMatch(pages, /JSON\.stringify/, "record-pages.tsx never prints raw JSON");
  const fv = /export function FieldValue\b[\s\S]*?\n\}\n/.exec(pages)?.[0] ?? "";
  assert.match(fv, /isDocument\(v\)\) return <JsonValue v=\{v\} recordKey=\{recordKey\} empty=\{dash\} \/>/, "FieldValue: a json value drawn readable");
  assert.equal((pages.match(/<FieldValue [^>]*recordKey=\{(?:r|data\.record)\.key\} \/>/g) ?? []).length, 2, "a record's page and an open row's card pass the record's key");
  assert.match(staff, /<FieldValue area=\{area\} base='admin' f=\{f\} v=\{data\.record\.data\[f\.name\]\} recordKey=\{data\.record\.key\} \/>/, "a staff record's page too");
  assert.match(pages, /fieldText\(f, r\.data\[name\], r\.key\)/, "a list's cell: one line");
  assert.match(board, /isDocument\(v\)\) return jsonLine\(v, recordKey\);/, "a board's card: one line");
  assert.doesNotMatch(board, /JSON\.stringify/, "board.tsx never prints raw JSON");
  assert.match(jv, /jsonView\(v, recordKey\)/, "JsonValue draws jsonView");
  assert.doesNotMatch(jv, /JSON\.stringify/, "nor does JsonValue");
  ok("a record's json field in words (mold_v0-240): a list of objects one line per item (its name, its meaningful fields), an object one line per field, nested objects flattened, bookkeeping and the record's own key hidden, short values in the credentials card's words; one line in a list's cell and a board's card; drawn readable on a record's page, an open row's card and a staff record's page");
}

// 14. A record's page, laid out (mold_v0-253; flag record_pages, off by default): the area's `detail` declared and refused
//     (src/pack-api.ts RecordDetailSchema, detailProblems), what the page decides (web/src/features/records/detail-layout.ts:
//     badges, facts by type, notices, tabs, sections, copy), the build (gen-packs over scripts/fixtures/packs/fixture_pages:
//     off, the generated files as before the flag; on, the layouts and copyable; a broken layout refused), and the page
//     drawn in a headless browser (when the machine has one) for a failed and a running build and a one-tab project.
{
  const { RecordAreaSchema: Area, BADGE_COLORS: SERVER_COLORS, NOTICE_TONES, DETAIL_FACTS_MAX, detailTabId } = await import("../src/pack-api.js");
  const L = await web("features/records/detail-layout.ts");
  const { readFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir, homedir } = await import("node:os");
  const ROOT = path.resolve(import.meta.dirname, "..");
  const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
  const builds = FIXTURE.record_areas.find((a: { name: string }) => a.name === "builds");
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const refusals = (a: unknown) => { const r = Area.safeParse(a); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
  const withDetail = (edit: (d: any, a: any) => void) => { const a = clone(builds); edit(a.detail, a); return refusals(a); };

  // a. Declared: the fixture's three areas take; each broken layout is refused, said where and why.
  for (const a of FIXTURE.record_areas) assert.deepEqual(refusals(a), [], `fixture area ${a.name}: a layout the build takes`);
  const has = (got: string[], re: RegExp, what: string) => assert.ok(got.some((x) => re.test(x)), `${what}: ${JSON.stringify(got)}`);
  has(withDetail((d) => { d.tabs[0].sections[0].fields.push("ghost"); }), /^detail\.tabs\.0\.sections\.0\.fields\.6: ghost is not one of the area's fields$/, "a section naming a field the area lacks");
  has(withDetail((d) => { d.header.facts[0].field = "ghost"; }), /^detail\.header\.facts\.0\.field: ghost is not one of the area's fields$/, "a fact naming one");
  has(withDetail((d) => { d.header.subtitle = "ghost"; }), /^detail\.header\.subtitle: ghost is not one/, "the subtitle naming one");
  has(withDetail((d) => { d.notices[0].when.field = "ghost"; }), /^detail\.notices\.0\.when\.field: ghost is not one/, "a notice testing one");
  has(withDetail((d) => { d.header.facts.push({ field: "tests_passed" }); }), new RegExp(`^detail\\.header\\.facts: at most ${DETAIL_FACTS_MAX} facts`), "a ninth fact");
  has(withDetail((d) => { d.tabs[1].sections = []; }), /^detail\.tabs\.1\.sections: tab Logs is empty: a tab has at least one section$/, "an empty tab");
  has(withDetail((d) => { d.tabs = []; }), /^detail\.tabs: a layout has at least one tab$/, "no tab at all");
  has(withDetail((d) => { d.tabs[0].sections[0].fields = []; }), /^detail\.tabs\.0\.sections\.0: section Source lists no fields$/, "a section without fields");
  has(withDetail((d) => { d.header.badges[0].colors.failed = "red"; }), /^detail\.header\.badges\.0\.colors\.failed: red is not a badge colour: one of the theme's tokens neutral, info, success/, "a badge colour outside the tokens");
  has(withDetail((d) => { d.header.badges[0].colors.failed = "#ff0000"; }), /#ff0000 is not a badge colour/, "a raw colour");
  has(withDetail((d) => { d.header.badges[0].colors.exploded = "danger"; }), /^detail\.header\.badges\.0\.colors\.exploded: exploded is not one of status's options$/, "a badge colour for a value the field lacks");
  has(withDetail((d) => { d.header.badges.push({ field: "branch" }); }), /branch is not a single-choice enum field/, "a badge on a text field");
  has(withDetail((d) => { d.header.facts[2].unit = "chars"; }), /^detail\.header\.facts\.2\.unit: a unit is for a number field \(branch is text\)$/, "a unit on a text field");
  has(withDetail((d) => { d.notices[0].when = { field: "status", equals: "failed", empty: true }; }), /a condition is one test: equals, in, not_in, empty, before, after, within_days, or a clock's state \(it has equals and empty\)/, "a notice with two tests");
  has(withDetail((d) => { d.notices[0].when.equals = "exploded"; }), /exploded is not one of status's options/, "a notice testing a value the field lacks");
  has(withDetail((d) => { d.notices[0].tone = "crimson"; }), /a notice's tone is one of info, success, warning, danger/, "a notice's tone outside its four (mold_v0-256: success)");
  has(withDetail((d) => { d.tabs[2].label = "logs"; }), /tab logs has the same address as another \(\?tab=logs\)/, "two tabs with one address");
  has(withDetail((d) => { d.tabs[0].sections[1].fields = ["branch"]; }), /section Results gives fields or groups, not both/, "fields and groups together");
  has(withDetail((d) => { d.tabs[0].sections[0].fields.push("branch"); }), /branch is in section Source twice/, "a field twice in one section");
  has(withDetail((d, a) => { a.fields.find((f: any) => f.name === "notes").encrypted = true; d.header.facts[0].field = "notes"; }), /notes is encrypted: a fact shows a value/, "a fact on an encrypted field");
  has(withDetail((d) => { d.tabs[0].sections[0].columns = 4; }), /^detail\.tabs\.0\.sections\.0\.columns/, "four columns");
  has(withDetail((_d, a) => { a.fields.find((f: any) => f.name === "config").copyable = true; }), /^fields\.18\.copyable: copyable is for a value the page shows in full/, "copyable on a json field");
  assert.deepEqual([...NOTICE_TONES], ["info", "success", "warning", "danger"]);
  ok("a record page's layout (mold_v0-253): the fixture's projects, environments and builds take; refused: a field the area lacks (a section, a fact, the subtitle, a notice), a ninth fact, an empty tab or none, a section without fields, a badge colour outside the theme's tokens or for a value the field lacks, a badge on a text field, a unit on a text field, a notice with two tests or an unknown value or tone, two tabs with one address, fields with groups, a field twice, a fact on an encrypted field, four columns, copyable on a json field");

  // b. Badges: the console's tokens are the schema's, each a class of theme variables (no raw colour).
  assert.deepEqual([...L.BADGE_COLORS], [...SERVER_COLORS], "one list of badge tokens, server and console");
  for (const c of L.BADGE_COLORS) {
    assert.ok(L.BADGE_CLASS[c], `${c}: drawn`);
    assert.doesNotMatch(L.BADGE_CLASS[c], /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i, `${c}: theme tokens only`);
    if (c.startsWith("viz-")) assert.match(L.BADGE_CLASS[c], new RegExp(`var\\(--${c}\\)[\\s\\S]*var\\(--foreground\\)`), `${c}: the chart colour, its text mixed toward the foreground (legible in light and dark)`);
  }
  const layout = builds.detail;
  assert.equal(L.badgeColor(layout, "status", "failed"), "danger");
  assert.equal(L.badgeColor(layout, "tier", "production"), "viz-7");
  assert.equal(L.badgeColor(layout, "branch", "main"), "neutral", "a field without a badge: neutral");
  assert.equal(L.badgeColor({ ...layout, header: { badges: [{ field: "status" }] } }, "status", "failed"), "neutral", "a value its badge leaves out: neutral");
  const statusField = builds.fields.find((f: { name: string }) => f.name === "status");
  assert.equal(L.optionWords(statusField, "failed"), "Failed", "an enum's badge reads its option's label");
  ok(`badges: ${L.BADGE_COLORS.length} theme tokens (the five tones and the eight chart colours), the same list on both sides, each drawn from theme variables; a value without a colour neutral; the option's label`);

  // c. Facts by type: a date relative (the exact date beside it), a number with its unit.
  const NOW = Date.parse("2026-11-06T12:00:00Z");
  assert.deepEqual(L.dateWords("2026-11-06", NOW), { relative: "today", absolute: "6 Nov 2026", iso: "2026-11-06" });
  assert.equal(L.dateWords("2026-11-07", NOW).relative, "tomorrow");
  assert.equal(L.dateWords("2026-11-05", NOW).relative, "yesterday");
  assert.equal(L.dateWords("2026-11-09", NOW).relative, "in 3 days");
  assert.equal(L.dateWords("2026-10-23", NOW).relative, "2 weeks ago");
  assert.equal(L.dateWords("2026-08-01", NOW).relative, "3 months ago");
  assert.equal(L.dateWords("2023-11-01", NOW).relative, "3 years ago");
  assert.deepEqual(L.dateWords("2026-11-06T11:15:00Z", NOW), { relative: "45 minutes ago", absolute: "6 Nov 2026, 11:15 UTC", iso: "2026-11-06T11:15:00.000Z" });
  assert.equal(L.dateWords("2026-11-06T09:00:00Z", NOW).relative, "3 hours ago");
  assert.equal(L.dateWords("not a date", NOW), null);
  assert.deepEqual([L.numberWords(1234.5, "s"), L.numberWords(87.25, "%"), L.numberWords(12), L.numberWords("3", "GB"), L.numberWords(1, "×")], ["20m 35s", "87.25%", "12", "3 GB", "1×"], "mold_v0-256: seconds read as a duration");
  ok("facts by type: dates relative (today, tomorrow, in 3 days, 2 weeks ago, 45 minutes ago) with the exact date on hover, numbers grouped with their unit (a % or × closed up)");

  // d. Notices: their condition on the record's fields, in declared order.
  const failed = { status: "failed", approver: "", tier: "production" }, running = { status: "running", approver: "R. Lee" }, passed = { status: "passed", approver: "R. Lee" };
  assert.deepEqual(L.shownNotices(layout, failed).map((n: { tone: string }) => n.tone), ["danger", "warning"], "a failed build not approved: danger, then warning");
  assert.deepEqual(L.shownNotices(layout, running).map((n: { tone: string }) => n.tone), ["info"], "a running build: info");
  assert.deepEqual(L.shownNotices(layout, passed), [], "a passed and approved build: none");
  assert.equal(L.conditionHolds({ field: "tags", equals: "x" }, { tags: ["y", "x"] }), true, "a list: any of its values");
  assert.equal(L.conditionHolds({ field: "status", not_in: ["passed"] }, { status: "failed" }), true);
  assert.equal(L.conditionHolds({ field: "status", not_in: ["passed"] }, {}), false, "not_in never holds on an empty field");
  assert.equal(L.conditionHolds({ field: "n", equals: 3 }, { n: "3" }), true, "a number compared as written");
  assert.equal(L.conditionHolds({ field: "approver", empty: false }, passed), true);
  ok("notices: shown while their condition holds (equals, in, not_in, empty; a list field by any value), in declared order");

  // e. Tabs and sections.
  assert.deepEqual(layout.tabs.map((t: { label: string }) => L.tabId(t.label)), ["overview", "logs", "configuration", "files", "history"], "mold_v0-256: the fixture's builds also have Files and History");
  for (const l of ["Overview", "Run & logs", "  Spaced  out ", "Ünïcode"]) assert.equal(L.tabId(l), detailTabId(l), `${l}: one address on both sides`);
  assert.equal(L.openTab(layout, "logs").label, "Logs");
  assert.equal(L.openTab(layout, "nope").label, "Overview", "an unknown ?tab: the first");
  assert.equal(L.openTab(layout, null).label, "Overview");
  const approval = layout.tabs[0].sections[2];
  assert.equal(L.sectionEmpty(approval, failed), true, "every field empty: the section's empty state");
  assert.equal(L.sectionEmpty(approval, passed), false);
  assert.deepEqual(L.sectionFields(layout.tabs[0].sections[1]), ["tests_passed", "tests_failed", "coverage", "started", "duration"], "a section's groups, in order");
  assert.deepEqual([L.columnsClass(1), L.columnsClass(2), L.columnsClass(3), L.columnsClass(undefined)],
    ["grid-cols-1", "grid-cols-1 sm:grid-cols-2", "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3", "grid-cols-1 sm:grid-cols-2"], "one column on a phone, up to the section's on wider screens");
  assert.deepEqual(L.unplacedFields(builds, layout).map((f: { name: string }) => f.name), [], "the fixture places every field");
  assert.deepEqual(L.unplacedFields(builds, { tabs: [{ label: "A", sections: [{ title: "S", fields: ["status"] }] }] }).length, builds.fields.length - 1, "the rest: Other details");
  assert.deepEqual(L.unplacedFields(builds, { tabs: [{ label: "A", sections: [{ title: "S", fields: ["status"] }] }], unplaced: "hide" }), [], "or hidden");
  assert.equal(L.isEmptyValue([]), true); assert.equal(L.isEmptyValue({}), true); assert.equal(L.isEmptyValue(0), false); assert.equal(L.isEmptyValue(false), false);
  ok("tabs and sections: each tab's address (?tab=, the same on both sides; an unknown one opens the first), a section's groups in order, its empty state when every field is empty, 1, 2 or 3 columns (one on a phone), the fields no part names as Other details or hidden");

  // f. Copy, and how the page draws (outlined buttons, full-width cards, no dialog; the page without a layout unchanged).
  assert.deepEqual([L.copyText("a1b2c3"), L.copyText(["x", "y"]), L.copyText(42), L.copyText(null)], ["a1b2c3", "x, y", "42", ""]);
  const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const dp = strip(src("features/records/detail-page.tsx")), rp = strip(src("features/records/record-pages.tsx"));
  assert.match(dp, /navigator\.clipboard && window\.isSecureContext\) await navigator\.clipboard\.writeText\(text\)/, "the clipboard where the browser has it");
  assert.match(dp, /document\.execCommand\('copy'\)/, "else a selection copied (an older phone)");
  assert.match(dp, /toast\.success\(done\)/, "a toast once copied");
  assert.match(dp, /toast\.error\('Could not copy/, "and one when the browser refuses");
  assert.match(dp, /copyWithToast\(record\.key, 'Record ID copied'\)[\s\S]*?Copy ID/, "Copy ID");
  assert.match(dp, /copyWithToast\(window\.location\.href, 'Link copied'\)[\s\S]*?Copy link/, "Copy link: the page's address, its tab with it");
  assert.match(dp, /aria-label=\{`Copy \$\{what\}`\}[\s\S]*?copyWithToast\(text, `\$\{what\} copied`\)/, "a copyable field's button: named, its toast names the field");
  const buttons = [...dp.matchAll(/<Button\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 3 && buttons.every((b) => /variant='outline'/.test(b)), `every button outlined (the shared variant): ${buttons.join(" ")}`);
  assert.doesNotMatch(dp, /<(?:Dialog|Sheet|AlertDialog|Drawer)\b|max-w-4xl|max-w-3xl/, "full-width cards, no dialog or side sheet");
  assert.ok(((dp.match(/<Card className='w-full /g) ?? []).length) >= 4, "each part a full-width card");
  assert.match(rp, /const layout = featureOn\('record_pages'\) \? layoutOf\(area\) : null;\s*if \(layout\) return \(/, "the layout only with the flag on and a layout declared");
  const detail = /export function RecordDetailPage\b[\s\S]*?\n\}\n/.exec(rp)?.[0] ?? "";
  assert.match(detail.slice(detail.indexOf("if (layout) return")), /\);\s*return \(\s*<PageContainer>\s*\{error \? <ErrorState error=\{error\} \/> : !data \? <LoadingCards count=\{2\} \/> : \(<div className='flex w-full flex-col gap-6'>\s*<Card className='w-full max-w-4xl gap-0 py-0' data-record-card=''>/,
    "else the one details card, as before");
  ok("copy: the record's id, the page's link and each copyable field, each confirmed by a toast (the clipboard, else a selection: phones); outlined buttons, full-width cards, no dialog; the details card as before without a layout or the flag");

  // g. The build: off, the generated files as before the flag; on, the layouts reach the console; a broken one refused.
  const TMP = mkdtempSync(path.join(tmpdir(), "record-pages-"));
  const copyOf = (name: string, edit?: (j: any) => void, features?: Record<string, boolean> | null, withFixture = true) => {
    const copy = path.join(TMP, name);
    const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
    cpSync(ROOT, copy, { recursive: true, filter: (s) => !skip.has(path.basename(s)) && s !== path.join(ROOT, "packs") });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    mkdirSync(path.join(copy, "packs"), { recursive: true });
    cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
    if (withFixture) {
      const j = clone(FIXTURE); edit?.(j);
      mkdirSync(path.join(copy, "packs", "fixture_pages"), { recursive: true });
      writeFileSync(path.join(copy, "packs", "fixture_pages", "pack.json"), JSON.stringify(j, null, 2));
    }
    if (features) writeFileSync(path.join(copy, "profile.json"), JSON.stringify({ features }, null, 2));
    const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
    const read = (rel: string) => (existsSync(path.join(copy, rel)) ? readFileSync(path.join(copy, rel), "utf8") : "");
    return { copy, status: g.status, out: `${g.stdout}\n${g.stderr}`, nav: read("web/src/config/pack-nav.generated.ts"), features: read("web/src/config/features.generated.ts") };
  };
  try {
    const off = copyOf("off");
    assert.equal(off.status, 0, off.out.slice(-1500));
    assert.doesNotMatch(off.nav, /"detail"|"copyable"|detail\?:|copyable\?:|detail-layout/, "off: no layout, no copyable, no type for them in the console's registry");
    assert.doesNotMatch(off.features, /record_pages/, "off: the flag left out of the console's flags (quiet_off)");
    // The same pack with its layouts and copyable taken out: the generated files are byte for byte the same (as before the flag).
    const bare = copyOf("bare", (j) => { for (const a of j.record_areas) { delete a.detail; delete a.key_from_title; for (const f of a.fields) delete f.copyable; }
      // mold_v0-256: a tab's columns computed from related records are left out too.
      for (const t of j.tabs) if (t.columns) t.columns = t.columns.filter((c: unknown) => typeof c === "string"); });
    assert.equal(bare.status, 0, bare.out.slice(-1500));
    const genFiles = (copy: string) => { const dir = path.join(copy, "web", "src", "config"); return readdirSync(dir).filter((f) => f.includes(".generated.")).sort().map((f) => `${f}\n${readFileSync(path.join(dir, f), "utf8")}`).join("\n"); };
    assert.equal(genFiles(off.copy), genFiles(bare.copy), "off: the console's generated files are those of the same pack without its layouts");
    const on = copyOf("on", undefined, { record_pages: true });
    assert.equal(on.status, 0, on.out.slice(-1500));
    const areas = JSON.parse(/export const recordAreas: RecordAreaSpec\[\] = ([\s\S]*?);\n/.exec(on.nav)![1]!) as { name: string; detail?: { tabs: unknown[] }; fields: { name: string; copyable?: boolean }[] }[];
    const byName = Object.fromEntries(areas.map((a) => [a.name, a]));
    assert.equal(byName.builds!.detail!.tabs.length, 5, "on: the builds' layout in the console's registry (mold_v0-256: with its Files and History tabs)");
    assert.equal(byName.projects!.detail!.tabs.length, 1, "and the projects'");
    assert.ok(!("detail" in byName.environments!), "an area without a layout: none (its page as before)");
    assert.deepEqual(byName.builds!.fields.filter((f) => f.copyable).map((f) => f.name), ["branch", "commit", "artifact"], "copyable fields");
    assert.match(on.nav, /detail\?: import\('@\/features\/records\/detail-layout'\)\.DetailLayout;/, "the type names the layout only while on");
    assert.match(on.features, /"record_pages": true/);
    const flagOnNoLayout = copyOf("on-zero", undefined, { record_pages: true }, false);
    assert.equal(flagOnNoLayout.status, 0);
    assert.doesNotMatch(flagOnNoLayout.features, /record_pages/, "the flag on with nothing asking for it: off (no area declares a layout)");
    for (const [name, edit, re] of [
      ["ghost", (j: any) => { j.record_areas[2].detail.tabs[0].sections[0].fields.push("ghost"); }, /packs\/fixture_pages\/pack\.json: record_areas\[2\]\.detail\.tabs\[0\]\.sections\[0\]\.fields\[6\]: ghost is not one of the area's fields/],
      // mold_v0-254: a related list whose area has no link back here, an action naming a job kind or a transition that
      // does not exist, two primary actions.
      ["no-link-back", (j: any) => { j.record_areas[0].detail.tabs[0].sections[1].related.area = "environments"; }, /pack fixture_pages: record area projects's page: section Builds: environments has no link back to projects/],
      ["no-kind", (j: any) => { j.record_areas[2].detail.actions[0].job_kind = "deploy"; }, /record area builds's page: action start_run\.deploy: deploy is not a job kind of pack fixture_pages/],
      ["no-transition", (j: any) => { j.record_areas[2].detail.actions.push({ kind: "move", to: "archived" }); }, /detail\.actions\[6\]\.to: no transition of the lifecycle goes to archived/],
      ["two-primaries", (j: any) => { j.record_areas[2].detail.actions[1].place = "primary"; }, /detail\.actions\[1\]\.place: 2 actions are primary: a record's page has one primary action/],
      ["facts", (j: any) => { j.record_areas[2].detail.header.facts.push({ field: "tests_passed" }); }, /at most 8 facts/],
      ["empty-tab", (j: any) => { j.record_areas[2].detail.tabs[1].sections = []; }, /tab Logs is empty/],
      ["colour", (j: any) => { j.record_areas[2].detail.header.badges[0].colors.failed = "crimson"; }, /crimson is not a badge colour/],
    ] as const) {
      const b = copyOf(`refused-${name}`, edit, { record_pages: true });
      assert.notEqual(b.status, 0, `${name}: refused at build`);
      assert.match(b.out, re, `${name}: said why (${b.out.slice(-600)})`);
    }
    const offBroken = copyOf("refused-off", (j) => { j.record_areas[2].detail.header.badges[0].colors.failed = "crimson"; });
    assert.notEqual(offBroken.status, 0, "a broken layout is refused with the flag off too (declared and checked either way)");
    ok("the build: off, no layout, copyable or flag in the console's files, which are those of the same pack without its layouts; on, the layouts and copyable fields reach the registry (an area without one has none); refused at build, on or off: a field the area lacks, a ninth fact, an empty tab, a colour outside the tokens; mold_v0-254: a related list whose area has no link back, an action naming a job kind or a transition that does not exist, two primary actions");

    // h. Drawn in a headless browser (the console's own components, bundled): a failed build, a running one on its Logs tab, a project.
    const findChrome = () => {
      if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
      const cache = path.join(homedir(), ".cache", "ms-playwright");
      if (!existsSync(cache)) return null;
      for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
        for (const sub of existsSync(path.join(cache, d)) ? readdirSync(path.join(cache, d)) : []) { const bin = path.join(cache, d, sub, "chrome-headless-shell"); if (existsSync(bin)) return bin; }
      return null;
    };
    const chrome = findChrome();
    if (!chrome) console.log("✓ (no headless browser on this machine: the page's rendered check skipped)");
    else {
      const w = path.join(on.copy, "web");
      const { build } = await import("esbuild");
      writeFileSync(path.join(w, "render-entry.tsx"), `import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { recordAreas } from '@/config/pack-nav.generated';
import { featureOn } from '@/config/features';
import { layoutOf } from '@/features/records/detail-layout';
import { LaidOutRecord } from '@/features/records/detail-page';
const I = (window as unknown as { __INPUT__: any }).__INPUT__;
const area = recordAreas.find((a) => a.name === I.area)!;
const declared = featureOn('record_pages') ? layoutOf(area) : null;
// mold_v0-254: part 1's draws leave the actions out (the header's Copy ID and Copy link); part 2's answer the page's own
// route (/api/records/_page) with the input's page data.
const layout = declared && I.noActions ? { ...declared, actions: undefined } : declared;
const realFetch = window.fetch.bind(window);
window.fetch = async (url: RequestInfo | URL, init?: RequestInit) => (String(url).includes('/api/records/_page/')
  ? new Response(JSON.stringify(I.page ?? { actions: [], sections: {} }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init));
createRoot(document.getElementById('root')!).render(<NuqsAdapter><div style={{ width: 1200 }}>{layout
  ? <LaidOutRecord area={area} base='app' layout={layout} record={I.record} links={I.links} provenance={I.provenance} where="This workspace's own" credentials={null} />
  : <p data-no-layout=''>no layout</p>}</div></NuqsAdapter>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 1500);
`);
      writeFileSync(path.join(w, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
      // mold_v0-254: the page's actions use the router (outside Next's app router here: a stand-in that records where it went).
      writeFileSync(path.join(w, "render-nav.ts"), "const r = { push: (h: string) => { (window as any).__PUSHED__ = h; }, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };\nexport const useRouter = () => r;\nexport const usePathname = () => location.pathname;\nexport const useSearchParams = () => new URLSearchParams(location.search);\nexport const notFound = () => { throw new Error('not found'); };\nexport const redirect = (h: string) => { throw new Error(h); };\n");
      writeFileSync(path.join(w, "render-auth.ts"), "export * from './src/lib/auth/builtin-client';\nexport const CLERK = false;\nexport const AUTH_PROVIDER = 'builtin';\n");
      const dir = path.join(TMP, "render"); mkdirSync(dir, { recursive: true });
      try {
        await build({ entryPoints: [path.join(w, "render-entry.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(dir, "bundle.js"), absWorkingDir: w,
          tsconfig: path.join(w, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_AUTH_PROVIDER": '"builtin"' },
          alias: { "next/link": path.join(w, "render-link.tsx"), "next/navigation": path.join(w, "render-nav.ts") }, logLevel: "error",
          plugins: [{ name: "auth", setup(b) { b.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({ path: path.join(w, "render-auth.ts") })); } }] });
      } finally { for (const f of ["render-entry.tsx", "render-link.tsx", "render-auth.ts", "render-nav.ts"]) rmSync(path.join(w, f), { force: true }); }
      const draw = (name: string, input: unknown, query = "") => {
        const f = path.join(dir, `${name}.html`);
        writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.__INPUT__ = ${JSON.stringify(input).replace(/</g, "\\u003c")};</script><script src="bundle.js"></script></body></html>`);
        const r = spawnSync(chrome, ["--no-sandbox", "--disable-gpu", "--virtual-time-budget=6000", "--window-size=1280,2400", "--dump-dom", `file://${f}${query}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        assert.equal(r.status, 0, `the browser ran: ${r.stderr.slice(0, 600)}`);
        assert.match(r.stdout, /data-ready="1"/, `${name}: drawn (${r.stdout.slice(0, 300)})`);
        return r.stdout;
      };
      const record = (key: string, title: string, data: Record<string, unknown>) => ({ key, title, data, version: null, updated_at: "2026-11-06T09:30:00.000Z" });
      const failedBuild = record("build-1042", "Build 1042", { status: "failed", summary: "Nightly build of the main branch", project: "checkout", environment: "staging-eu", tier: "production", branch: "main",
        commit: "9f4c2e1a7b3d", triggered_by: "Schedule", started: "2026-11-05", duration: 1312, tests_passed: 1180, tests_failed: 4, coverage: 87.4, artifact: "https://artifacts.example.com/builds/1042.tar.gz",
        failure: "4 tests failed in the payments suite.", log_excerpt: "step 7/9: test\nFAIL payments/refund.spec\n", config: { runner: "large", cache: true } });
      const dom = draw("failed", { area: "builds", record: failedBuild, links: [], provenance: { by: "run" }, noActions: true });
      const count = (re: RegExp) => (dom.match(re) ?? []).length;
      assert.match(dom, /<h1[^>]*>Build 1042<\/h1>/, "the title");
      assert.match(dom, /data-record-subtitle="">Nightly build of the main branch</, "the summary under it");
      assert.match(dom, /data-badge-color="danger"[\s\S]*?Failed[\s\S]*?data-badge-color="viz-7"[\s\S]*?Production/, "its status and tier badges in their colours");
      assert.equal(count(/data-detail-field=""/g) >= 8, true);
      const facts = /data-record-facts="">([\s\S]*?)<\/dl>/.exec(dom)?.[1] ?? "";
      assert.equal((facts.match(/data-detail-field=""/g) ?? []).length, 8, "eight facts");
      assert.match(facts, /title="1,312 s"[^>]*>21m 52s</, "a number with its unit (mold_v0-256: seconds as a duration in words, the exact number on hover)"); assert.match(facts, /87\.4%/, "a percentage closed up");
      assert.match(facts, /<time datetime="2026-11-05"[^>]*>[^<]*(ago|yesterday|today)<\/time>/, "a date in relative words, its exact date on hover");
      assert.match(facts, /href="https:\/\/artifacts\.example\.com\/builds\/1042\.tar\.gz"/, "an address as a link");
      assert.match(facts, /aria-label="Copy Commit"/, "a copyable fact: its copy button");
      assert.match(dom, /data-record-creator="">Added by <span[^>]*>The app's own automation<\/span>/, "who added it");
      assert.match(dom, /data-copy-id=""[^>]*>[\s\S]*?Copy ID/); assert.match(dom, /data-copy-link=""[^>]*>[\s\S]*?Copy link/);
      assert.match(dom, /data-record-notice="danger"[\s\S]*?This build failed[\s\S]*?data-record-notice="warning"[\s\S]*?Not approved yet/, "the danger notice, then the warning");
      assert.doesNotMatch(dom, /data-record-notice="info"/, "the running notice does not hold");
      assert.match(dom, /data-record-tabs=""[\s\S]*?>Overview<[\s\S]*?>Logs<[\s\S]*?>Configuration</, "the tab strip");
      assert.match(dom, /data-detail-section="detail-overview-0"[\s\S]*?>Source</, "the open tab's sections");
      assert.match(dom, /data-detail-section="detail-overview-2"[\s\S]*?data-section-empty=""[\s\S]*?No one has approved this build yet\./, "an empty section: its own words");
      assert.doesNotMatch(dom, /data-detail-section="detail-logs-/, "another tab's sections not drawn");
      const logs = draw("running-logs", { area: "builds", record: record("build-1043", "Build 1043", { status: "running", approver: "R. Lee", branch: "main" }), links: [], provenance: { by: "people" }, noActions: true }, "?tab=logs");
      assert.match(logs, /data-record-notice="info"/); assert.doesNotMatch(logs, /data-record-notice="(danger|warning)"/, "a running, approved build: the info notice alone");
      assert.match(logs, /data-detail-section="detail-logs-0"[\s\S]*?Nothing failed in this build\.[\s\S]*?data-detail-section="detail-logs-1"[\s\S]*?No log lines were kept for this build\./, "?tab=logs: its sections, both empty");
      const project = draw("project", { area: "projects", record: record("checkout", "Checkout", { health: "blocked", summary: "The payment pages", owner: "Payments team", started: "2026-01-12", repository: "https://git.example.com/checkout" }), links: [], provenance: { by: "people" }, noActions: true });
      assert.doesNotMatch(project, /data-record-tabs=""/, "one tab: no strip");
      assert.match(project, /data-badge-color="danger"[\s\S]*?Blocked/); assert.match(project, /data-record-notice="danger"/);
      const env = draw("environment", { area: "environments", record: record("staging-eu", "Staging EU", { tier: "staging" }), links: [], provenance: null });
      assert.match(env, /data-no-layout=""/, "an area without a layout: none (the page as before)");
      ok("drawn in a headless browser: a failed build (title, summary, its status and tier badges in their colours, eight facts by type with a copy button, Added by, Copy ID and Copy link, the danger then the warning notice, the tab strip, an empty section in its own words), a running one on ?tab=logs (the info notice, its empty sections), a one-tab project (no strip), an area without a layout (none)");
      // mold_v0-254: the header's actions, a related list and the runs, from the page's own answer (as the API gives it).
      const act = (id: string, kind: string, place: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind, place, label, disabled: null, confirm: null, ...extra });
      const memberActions = (going: boolean) => [
        act("start_run.rebuild", "start_run", "primary", "Re-run", { disabled: going ? "A build that is still going can't be re-run: cancel it first, or wait for it to end." : null,
          run: { kind: "rebuild", label: "Re-run a build", description: null, args: [], values: {}, environments: null } }),
        act("link.project", "link", "secondary", "Open project", { target: { area: "projects", key: "checkout" } }), act("edit", "edit", "secondary", "Edit", { fields: [] }),
        act("move", "move", "more", "Move", { moves: [{ to: "passed", label: "Mark passed", disabled: null }] }), act("copy_link", "copy_link", "more", "Copy link")];
      const run = (id: string, status: string, by: string, cost: number) => ({ id, pack: "fixture_pages", kind: "rebuild", status, error: status === "failed" ? "4 tests failed" : null, cost_usd: cost,
        created_at: "2026-11-05T10:00:00.000Z", started_at: "2026-11-05T10:00:05.000Z", ended_at: status === "running" ? null : "2026-11-05T10:21:57.000Z", by });
      const withActions = draw("actions", { area: "builds", record: failedBuild, links: [], provenance: { by: "run" },
        page: { actions: memberActions(false), sections: { "0-3": { total: 3, runs: [run("run_b", "failed", "You", 0.42), run("run_a", "succeeded", "r.lee@example.com", 0.39)] } } } });
      const header = /data-record-header=""[\s\S]*?data-record-facts=""/.exec(withActions)?.[0] ?? "";
      assert.match(header, /data-page-action="start_run\.rebuild"[^>]*data-primary=""[^>]*>[\s\S]*?Re-run</, "the primary action: Re-run, first");
      assert.match(header, /data-page-action="link\.project"[^>]*>[\s\S]*?Open project<[\s\S]*?data-page-action="edit"[^>]*>[\s\S]*?Edit</, "the secondary actions, in order");
      assert.match(header, /data-page-more=""[^>]*aria-label="More actions"[^>]*>[\s\S]*?More</, "More, for the rest");
      assert.doesNotMatch(header, /data-copy-id=""|data-page-action="move"/, "Copy ID and Move are in More, not the header");
      const runs = /data-section-kind="runs"[\s\S]*?<\/table>/.exec(withActions)?.[0] ?? "";
      assert.doesNotMatch(runs, /data-section-count|Latest 2 of 3 runs|\b\d+ runs?\b</, "mold_v0-256: no count beside the section's title");
      assert.match(runs, /href="\/app\/runs\/run_b"[^>]*>Re-run a build</, "each run links to it (mold_v0-256: the run's own page)");
      assert.match(runs, /data-badge-color="danger"[\s\S]*?Failed[\s\S]*?data-badge-color="success"[\s\S]*?Succeeded/, "its status as a badge");
      assert.match(runs, /21m 52s[\s\S]*?\$0\.42[\s\S]*?You[\s\S]*?r\.lee@example\.com/, "how long it took, its cost, who started it");
      assert.match(runs, /href="\/app\/build-runs"[^>]*>All runs/, "All runs, when there are more");
      const going = draw("going", { area: "builds", record: record("build-1043", "Build 1043", { status: "running", project: "checkout", branch: "main" }), links: [], provenance: { by: "run" },
        page: { actions: memberActions(true), sections: { "0-3": { total: 0, runs: [] } } } });
      assert.match(going, /data-page-action="start_run\.rebuild"[^>]*aria-disabled="true"[^>]*aria-describedby="why-start_run\.rebuild"/, "a disabled action keeps its place and focus (aria-disabled), described by its reason");
      assert.match(going, /id="why-start_run\.rebuild"[^>]*>A build that is still going can't be re-run/, "its reason, read with it (and shown on hover and focus)");
      assert.match(going, /data-section-kind="runs"[\s\S]*?data-section-empty=""[\s\S]*?This build has not been re-run\./, "no runs: the section's own empty words");
      const relRow = (key: string, status: string, started: string) => ({ key, title: key.replace("build-", "Build "), data: { status, branch: "main", environment: "staging-eu", started, duration: 1312 }, updated_at: "2026-11-05T09:00:00.000Z",
        actions: [act("start_run.rebuild", "start_run", "primary", "Re-run"), act("copy_link", "copy_link", "more", "Copy link")] });
      const proj = draw("project-related", { area: "projects", record: record("checkout", "Checkout", { health: "healthy", summary: "The payment pages" }), links: [], provenance: { by: "people" },
        page: { actions: [act("start_run.build", "start_run", "primary", "Start a build", { run: { kind: "build", label: "Build a project", description: null, args: [], values: {}, environments: null } })],
          sections: { "0-1": { area: "builds", via: "project", more: true, records: [relRow("build-1044", "failed", "2026-11-05"), relRow("build-1043", "running", "2026-11-04")] }, "0-2": { total: 0, runs: [] } } } });
      const rel = /data-section-kind="related"[\s\S]*?<\/table>/.exec(proj)?.[0] ?? "";
      assert.match(rel, />Builds<\/div>/, "the related list: its title");
      assert.doesNotMatch(rel, /First 2 shown|data-section-count/, "mold_v0-256: no count beside it (Show all stays a button)");
      assert.match(rel, /href="\/app\/records\/builds\?linked=project%3Acheckout"[^>]*>Show all/, "Show all: the builds' list narrowed to this project");
      assert.match(rel, /<th[^>]*>Build<\/th><th[^>]*>Status<\/th><th[^>]*>Branch<\/th><th[^>]*>Environment<\/th><th[^>]*>Started<\/th><th[^>]*>Duration<\/th>/, "its declared columns, in order, after the record");
      assert.match(rel, /href="\/app\/records\/builds\/build-1044"[^>]*>Build 1044<[\s\S]*?data-badge-color="danger"[\s\S]*?Failed[\s\S]*?main[\s\S]*?staging-eu[\s\S]*?2026-11-05[\s\S]*?data-unit="s">21m 52s</, "each row as the builds' list shows it (its status coloured as its own page's badge; mold_v0-256: a duration with its unit, in words)");
      assert.equal((rel.match(/data-row-actions=""/g) ?? []).length, 2, "each row its own actions' menu");
      assert.match(proj, /data-section-kind="runs"[\s\S]*?No runs on this project yet\./);
      const hidden = draw("project-hidden", { area: "projects", record: record("checkout", "Checkout", { health: "healthy" }), links: [], provenance: null, page: { actions: [], sections: { "0-1": { hidden: true }, "0-2": { total: 0, runs: [] } } } });
      assert.doesNotMatch(hidden, /data-section-kind="related"/, "a related list the role may not read: not drawn at all");
      ok("drawn with actions (mold_v0-254): Re-run first and filled, Open project and Edit outlined, More with the rest (Copy ID and Move there); a disabled Re-run keeps its place with its reason read with it; the runs (each linked, its status a badge, how long, its cost, who), All runs past the limit, the empty words; a project's builds (its columns, each row as the builds' list shows it with its own actions' menu, Show all narrowed to the project); a list the role may not read not drawn");
    }
  } finally { rmSync(TMP, { recursive: true, force: true }); }
}

// 15. A record's page, part 2 (mold_v0-254; flag record_pages): related lists, a record's runs and the header's actions,
//     declared and refused in the area (src/pack-api.ts detailProblems) and across the build (detailBuildProblems, run by
//     src/metric-spec.ts checkViews: gen-packs and the server's install), what the console decides (./detail-layout.ts)
//     and how it draws them (./page-actions.tsx, ./detail-page.tsx). The API by role and workspace:
//     scripts/record-page-actions-test.ts.
{
  const api = await import("../src/pack-api.js");
  const { viewsOf, checkViews } = await import("../src/metric-spec.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const L = await web("features/records/detail-layout.ts");
  const { readFileSync } = await import("node:fs");
  const ROOT = path.resolve(import.meta.dirname, "..");
  const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const areaOf = (j: any, n: string) => j.record_areas.find((a: { name: string }) => a.name === n);
  const refusals = (a: unknown) => { const r = api.RecordAreaSchema.safeParse(a); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
  const has = (got: string[], re: RegExp, what: string) => assert.ok(got.some((x) => re.test(x)), `${what}: ${JSON.stringify(got)}`);
  const edited = (n: string, edit: (d: any, a: any) => void) => { const a = clone(areaOf(FIXTURE, n)); edit(a.detail, a); return refusals(a); };

  // a. In the area: each part 2 mistake refused, said where and why.
  for (const a of FIXTURE.record_areas) assert.deepEqual(refusals(a), [], `fixture area ${a.name}: its related lists, runs and actions take`);
  has(edited("builds", (d) => { d.actions[1].place = "primary"; }), /^detail\.actions\.1\.place: 2 actions are primary: a record's page has one primary action/, "two primary actions");
  has(edited("builds", (d) => { for (const x of d.actions) x.place = x.place === "primary" ? "primary" : "secondary"; }), /actions are secondary: at most 3 sit beside the primary/, "four secondary actions");
  has(edited("builds", (d) => { d.actions.push({ kind: "move", to: "archived" }); }), /^detail\.actions\.6\.to: no transition of the lifecycle goes to archived: a move action names a state a transition reaches \(running, passed, failed, cancelled, queued\)$/, "a move to a state no transition reaches");
  has(edited("projects", (d) => { d.actions.push({ kind: "move" }); }), /a move action is for an area with a lifecycle/, "a move on an area without a lifecycle");
  has(edited("builds", (d) => { d.actions[0].job_kind = undefined; }), /a start_run action names its job_kind/, "a start_run without its kind");
  has(edited("builds", (d) => { d.actions[3].job_kind = "rebuild"; }), /^detail\.actions\.3\.job_kind: job_kind is for a start_run action, not move$/, "a job kind on a move");
  has(edited("builds", (d) => { d.actions[1].field = "branch"; }), /branch is not a link or reference field of the area/, "a link on a text field");
  has(edited("builds", (d) => { d.actions[0].input.commit = "ghost"; }), /ghost is not one of the area's fields \(input commit takes a field, \$key or \$title\)/, "an input from a field the area lacks");
  has(edited("builds", (d) => { d.actions[5].roles = ["viewer"]; }), /viewer is read-only in the platform: a delete action cannot be a viewer's/, "a viewer's delete");
  has(edited("builds", (d) => { d.actions[3].roles = ["member"]; d.actions[3].to = "queued"; }), /member makes none of the moves this action offers/, "roles that make none of the move's transitions");
  has(edited("builds", (d) => { d.actions[0].unavailable[0].when.in = ["exploded"]; }), /exploded is not one of status's options/, "an unavailable condition on a value the field lacks");
  has(edited("builds", (d) => { d.actions.push({ kind: "edit", label: "Edit again" }); }), /two actions are edit/, "two actions with one id");
  has(edited("builds", (d) => { d.actions.push({ kind: "archive" }); }), /an action's kind is one of start_run, move, edit, delete, link, copy_link/, "an unknown kind");
  has(edited("builds", (d) => { d.actions[0].confirm = "Sure?"; }), /^detail\.actions\.0\.confirm: confirm is for a move or a delete \(a start_run opens its form first\)$/, "a confirm on a run (its form is the question)");
  has(edited("projects", (d) => { d.tabs[0].sections[1].fields = ["owner"]; }), /section Builds lists related records: it has no fields/, "a related list with fields");
  has(edited("projects", (d) => { d.tabs[0].sections[1].runs = {}; }), /section Builds is a related list or the record's runs, not both/, "a related list and runs");
  has(edited("projects", (d) => { d.tabs[0].sections[1].related.columns = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]; }), /at most 8 columns/, "nine columns");
  has(edited("projects", (d) => { d.tabs[0].sections[1].related.limit = 51; }), /tabs\.0\.sections\.1\.related\.limit/, "a limit past 50");
  const shared = { name: "library", label: "Library", role: "source", scope: "platform", fields: [{ name: "code", label: "Code" }], detail: { tabs: [{ label: "A", sections: [{ title: "S", fields: ["code"] }] }], actions: [{ kind: "edit" }] } };
  has(refusals(shared), /a shared \(platform\) area's records are written by platform staff, never from a workspace's page: no edit action/, "an edit on a shared area");
  const secret = clone(areaOf(FIXTURE, "builds")); secret.fields.find((f: any) => f.name === "notes").encrypted = true;
  has(refusals(secret), /an area with an encrypted field has no edit action/, "an edit on an area with an encrypted field");
  ok("in the area (mold_v0-254): the fixture's related lists, runs and actions take; refused: two primary actions, four secondary, a move to a state no transition reaches or on an area without a lifecycle, a start_run without its kind, a kind's or a state's or a field's word on another kind of action, a link on a text field, an input from a field the area lacks, a viewer's write, roles that make none of a move's transitions, an unavailable test on a value the field lacks, two actions with one id, an unknown kind, a confirm on a run, a related list with fields or with runs, nine columns, a limit past 50, an edit on a shared area or one with an encrypted field");

  // b. Across the build: what a related list, a runs section and a start_run name elsewhere.
  const build = (edit?: (j: any) => void) => { const j = clone(FIXTURE); edit?.(j); return checkViews(viewsOf([{ id: "fixture_pages", definition: compileDeclarations(j) as never }])); };
  assert.deepEqual(build(), [], "the fixture's build: no problem");
  const across: [string, (j: any) => void, RegExp][] = [
    ["no link back", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.area = "environments"; }, /record area projects's page: section Builds: environments has no link back to projects: a related list shows the records that point here/],
    ["no such area", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.area = "deployments"; }, /deployments is not a record area of this build/],
    ["via elsewhere", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.via = "environment"; }, /builds.s field environment does not point at projects: .*its fields that do: project/],
    ["via not a field", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.via = "ghost"; }, /via ghost is not one of builds's fields/],
    ["two ways back", (j) => { areaOf(j, "builds").fields.push({ name: "parent", label: "Parent", type: "reference", to: "projects" }); }, /builds points at projects through project and parent: say which with via/],
    ["a column it lacks", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.columns.push("ghost"); }, /column ghost is not one of builds's fields/],
    ["a json sort", (j) => { areaOf(j, "projects").detail.tabs[0].sections[1].related.sort.field = "config"; }, /sort config is a json field: sort by a field with one plain value/],
    ["a runs kind", (j) => { areaOf(j, "projects").detail.tabs[0].sections[2].runs.kinds.push("deploy"); }, /section Runs: deploy is not a job kind of pack fixture_pages/],
    ["a start kind", (j) => { areaOf(j, "builds").detail.actions[0].job_kind = "deploy"; }, /action start_run\.deploy: deploy is not a job kind of pack fixture_pages/],
    ["an input arg", (j) => { areaOf(j, "builds").detail.actions[0].input.target = "branch"; }, /input target is not an argument of rebuild \(build, branch, commit\)/],
  ];
  for (const [what, edit, re] of across) has(build(edit), re, what);
  ok(`across the build (mold_v0-254, gen-packs and the server's install alike): ${across.map((x) => x[0]).join(", ")}`);

  // c. What the console decides: the actions by place, Show all's address, the counts.
  const A = (id: string, place: string, kind = "edit") => ({ id, kind, place, label: id, disabled: null, confirm: null });
  const p = L.placed([A("a", "more"), A("b", "secondary"), A("c", "primary"), A("d", "secondary"), A("e", "more")]);
  assert.deepEqual([p.primary.id, p.secondary.map((x: { id: string }) => x.id), p.more.map((x: { id: string }) => x.id)], ["c", ["b", "d"], ["a", "e"]], "one primary, the secondary in order, the rest in More");
  assert.equal(L.placed([A("x", "more")]).primary, null, "no primary: none drawn");
  assert.equal(L.showAllHref("app", "builds", "project", "check out/1"), "/app/records/builds?linked=project%3Acheck%20out%2F1");
  const buildsSpec = { fields: [{ name: "project" }, { name: "status" }], list_columns: ["status", "project"] };
  assert.deepEqual(L.parseLinked("project:check out/1", buildsSpec), { field: "project", key: "check out/1" }, "read back");
  assert.equal(L.parseLinked("ghost:x", buildsSpec), null, "a field the area lacks: no filter");
  assert.equal(L.parseLinked("project:", buildsSpec), null);
  // mold_v0-256: each column with its own heading, when it has one (null: its field's label).
  assert.deepEqual(L.relatedColumns(buildsSpec, {}).map((c: { field: string }) => c.field), ["status", "project"], "no columns of its own: the area's list columns");
  assert.deepEqual(L.relatedColumns(buildsSpec, { columns: ["project", "ghost"] }), [{ field: "project", label: null }]);
  // mold_v0-256: no counts beside a list section's title (the operator's call): their words are gone.
  assert.equal(L.runsCountWords, undefined); assert.equal(L.relatedCountWords, undefined);
  assert.deepEqual([api.pageActionId({ kind: "start_run", job_kind: "rebuild" }), api.pageActionId({ kind: "move", to: "In review" }), api.pageActionId({ kind: "delete" })], ["start_run.rebuild", "move.In-review", "delete"]);
  assert.equal(L.RUN_STATUS_COLOR.failed, "danger"); assert.equal(L.RUN_STATUS_COLOR.succeeded, "success");
  ok("the console's part 2 (mold_v0-254): one primary, the secondary in order, the rest in More; Show all's address and its filter read back (an unknown field none); a related list's columns; the counts' words; an action's id; a run's status colour");

  // d. How it draws: the shared Button (each variant outlined), the console's confirm, forms as full cards, a disabled
  //    action's reason on hover and focus; Show all and a run's link only with the flag (the lists as before without it).
  const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pa = strip(src("features/records/page-actions.tsx")), dp = strip(src("features/records/detail-page.tsx"));
  assert.doesNotMatch(pa, /<button\b|<(?:Dialog|Sheet|Drawer|AlertDialog)\b/, "no raw button, no dialog, sheet or drawer of its own");
  assert.match(pa, /<ConfirmDialog\b/, "confirmations are the console's ConfirmDialog (ConfirmButton's question)");
  assert.match(src("features/admin/ui.tsx"), /export function ConfirmButton[\s\S]*?<ConfirmDialog /, "the same one ConfirmButton asks");
  assert.match(pa, /<ActionCard\b[\s\S]*?<EditRecordForm\b/, "edit: the existing edit form, a full card");
  assert.match(pa, /<ActionCard\b[\s\S]*?<RecordRunForm\b/, "a run: a full card");
  const variants = [...pa.matchAll(/<Button\b[^>]*?variant=\{?['"]?(primary \? 'default' : 'outline'|[a-z]+)/g)].map((m) => m[1]);
  assert.ok(variants.length >= 5 && variants.every((v) => ["outline", "ghost", "default", "primary ? 'default' : 'outline'"].includes(v!)), `the shared Button's variants: ${variants.join(", ")}`);
  assert.match(pa, /aria-disabled=\{a\.disabled \|\| busy \? true : undefined\} aria-describedby=\{a\.disabled \? why : undefined\}/, "a disabled button keeps focus, described by its reason");
  assert.match(pa, /<TooltipTrigger render=\{button\} \/>\s*<TooltipContent[^>]*>\{a\.disabled\}<\/TooltipContent>/, "its reason on hover and focus");
  assert.match(pa, /<ItemWhy reason=\{a\.disabled\} \/>/, "a disabled menu item: its reason under its label");
  assert.match(dp, /\{withActions \? bar : \(/, "declared actions replace part 1's Copy ID and Copy link (which move into More)");
  assert.match(dp, /if \(\(s\.related \|\| s\.runs\) && base !== 'app'\) return null;/, "staff pages draw no workspace's lists or runs");
  const rp = strip(src("features/records/record-pages.tsx")), runsTsx = strip(src("features/tabs/runs.tsx"));
  assert.match(rp, /const linked = featureOn\('record_pages'\) && !source \? parseLinked\(linkedParam, area\) : null;/, "?linked= only with the flag");
  assert.match(runsTsx, /const deep = featureOn\('record_pages'\) \? \{ openKey: runParam/, "?run= only with the flag");
  ok("drawn with the shared Button (filled primary, outlined secondary, More and a row's menu), the console's confirm (ConfirmButton's), the edit and run forms as full cards, a disabled action focusable with its reason on hover and focus (a menu item: under its label); Show all's filter and a run's link only with the flag; staff pages draw no workspace's lists or runs");
}
