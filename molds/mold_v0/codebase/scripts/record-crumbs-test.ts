// A record's breadcrumb through the record it belongs to (mold_v0-318), offline:
//   npm run test:record-crumbs
//
// The fixture scripts/fixtures/packs/fixture_pages, in memory, with no tab for builds or releases (reached only from a
// project's page) and a checks area whose records each belong to a build.
//   1. Declared and refused (src/record-crumbs.ts crumbParentProblems, run by src/metric-spec.ts checkViews): an area's
//      detail.parent is a single reference field of the area to another workspace area; a field the area lacks, a text
//      field, a list of references, a reference to the area itself or to a shared (platform) area are refused.
//   2. The parent chosen (crumbChain): declared wins; left out, an area no tab shows takes its first required single
//      reference to an area a tab shows, else one whose target has a way there (checks › builds › projects); an area a tab
//      shows has none; never a cycle, never more than three hops.
//   3. The record page's parents (GET /api/records/<area>/<key>, src/record-areas.ts detailFor): nearest first, each with
//      its key and title, as the person reads them; a person who may not read a parent's area, a parent that is not
//      there (another workspace's key) and an area a tab shows: none (the page crumbs as before). The MCP tools' detail
//      is as before (no parents).
//   4. The trail (web/src/lib/crumb-trail.ts parentTrail, pure): the farthest parent's area as its list is crumbed, each
//      parent record linking to its page, then the record; the console wires it (the record page names its parents, the
//      top bar's trail and the sidebar's lit entry read them).
//   5. A list's search row narrowed by a side panel (source): the row is a container; below 48rem (from sm up) it stays
//      one line, the search box 10rem at least, the primary action its icon alone, named by its words (Actions ▾ keeps its
//      word, as at every width).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const ok = (m: string) => console.log(`✓ ${m}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const BASE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const areaOf = (j: any, n: string) => j.record_areas.find((a: any) => a.name === n);
/** The fixture as this test reads it: builds and releases reached only from a project; checks belong to a build. */
function fixture(edit: (j: any) => void = () => {}) {
  const j = clone(BASE);
  j.tabs = j.tabs.filter((t: any) => t.id !== "builds" && t.id !== "releases");
  areaOf(j, "builds").fields.find((f: any) => f.name === "project").required = true;
  j.record_areas.push({ name: "checks", label: "Checks", role: "source", scope: "workspace", fields: [{ name: "build", label: "Build", type: "reference", to: "builds", required: true }, { name: "result", label: "Result", type: "text" }] });
  edit(j);
  return j;
}

try {
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { RecordAreaSchema } = await import("../src/pack-api.js");
  const { checkViews } = await import("../src/metric-spec.js");
  const C = await import("../src/record-crumbs.js");
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(j) } as never]);
  const views = (j: any) => checkViews({ areas: j.record_areas.map((a: any) => ({ ...RecordAreaSchema.parse(a), pack: "fixture_pages" })), metrics: [], charts: [], tabs: [], jobKinds: 0, credentials: 0, dueAreas: 0 } as never);

  // ---------- 1. declared and refused ----------
  {
    const parentIs = (p: string, more: (j: any) => void = () => {}) => fixture((j) => { areaOf(j, "releases").detail.parent = p; more(j); });
    assert.ok(RecordAreaSchema.safeParse(areaOf(parentIs("service"), "releases")).success, "detail.parent declares on a laid-out area");
    assert.deepEqual(views(parentIs("service")).filter((m) => /parent/.test(m)), [], "a single reference to a workspace area: accepted");
    const refused = (j: any, re: RegExp, what: string) => {
      const ps = views(j).filter((m) => /parent/.test(m));
      assert.ok(ps.some((m) => re.test(m)), `${what}: ${JSON.stringify(ps)}`);
      assert.ok(ps.every((m) => m.startsWith("pack fixture_pages: record area releases's page: parent ")), `each names its pack and area: ${JSON.stringify(ps)}`);
    };
    refused(parentIs("nope"), /parent nope: not one of the area's fields/, "a field the area lacks");
    refused(parentIs("subject"), /parent subject: a text field: the breadcrumb's parent is a reference field/, "a text field");
    refused(parentIs("service", (j) => { areaOf(j, "releases").fields.find((f: any) => f.name === "service").multiple = true; }), /a list of references/, "a list of references");
    refused(parentIs("previous", (j) => { areaOf(j, "releases").fields.push({ name: "previous", label: "Previous", type: "reference", to: "releases" }); }), /refers to releases itself/, "the area itself");
    refused(parentIs("service", (j) => { const sv = areaOf(j, "services"); sv.scope = "platform"; sv.role = "source"; }), /services is a shared \(platform\) area/, "a shared area");
    assert.ok(!RecordAreaSchema.safeParse({ ...areaOf(parentIs("service"), "releases"), detail: { ...areaOf(BASE, "releases").detail, parent: "Not A Name" } }).success, "a field's name, as every name");
    ok("declared and refused: detail.parent a single reference to another workspace area (not missing, text, a list, the area itself or a shared area)");
  }

  // ---------- 2. the parent chosen ----------
  {
    const areasOf = (j: any) => j.record_areas.map((a: any) => RecordAreaSchema.parse(a));
    const shown = (j: any) => C.tabShownAreas(j.tabs);
    const chain = (j: any, n: string) => C.crumbChain(n, areasOf(j), shown(j));
    const j = fixture();
    assert.deepEqual([...shown(j)].sort(), ["environments", "projects", "services"], "the areas a tab shows");
    assert.deepEqual(chain(j, "builds"), [{ field: "project", area: "projects" }], "builds: its required project (its environment is optional)");
    assert.deepEqual(chain(j, "releases"), [{ field: "project", area: "projects" }], "releases: its required project");
    assert.deepEqual(chain(j, "checks"), [{ field: "build", area: "builds" }, { field: "project", area: "projects" }], "checks: through the build to its project (two hops)");
    assert.deepEqual(chain(j, "projects"), [], "an area a tab shows: none");
    assert.deepEqual(chain(fixture((x) => { areaOf(x, "releases").detail.parent = "service"; }), "releases"), [{ field: "service", area: "services" }], "declared wins (an optional reference too)");
    // A required reference to an area no tab shows and with no way on: none (the page crumbs as before).
    assert.deepEqual(chain(fixture((x) => { areaOf(x, "builds").fields.find((f: any) => f.name === "project").required = false; }), "builds"), [], "no required reference to a shown area: none");
    // A required environment (shown) after the project: the first in field order that a tab shows.
    assert.deepEqual(chain(fixture((x) => { areaOf(x, "builds").fields.find((f: any) => f.name === "environment").required = true; }), "builds"), [{ field: "project", area: "projects" }], "the first in field order");
    // A cycle (a › b › a) with nothing shown: none; a chain longer than three hops stops at three.
    const ref = (name: string, to: string) => ({ name, label: name, type: "reference", to, required: true });
    const synth = [
      { name: "ca", label: "A", fields: [ref("cb", "cb")] }, { name: "cb", label: "B", fields: [ref("ca", "ca")] },
      { name: "h1", label: "H1", fields: [ref("up", "h2")] }, { name: "h2", label: "H2", fields: [ref("up", "h3")] }, { name: "h3", label: "H3", fields: [ref("up", "h4")] },
      { name: "h4", label: "H4", fields: [ref("up", "top")] }, { name: "top", label: "Top", fields: [{ name: "note", label: "Note", type: "text" }] },
    ].map((a) => RecordAreaSchema.parse({ role: "source", scope: "workspace", ...a }));
    assert.deepEqual(C.crumbChain("ca", synth, new Set(["top"])), [], "a cycle: none");
    assert.deepEqual(C.crumbChain("h2", synth, new Set(["top"])).map((h) => h.area), ["h3", "h4", "top"], "three hops reach the shown area");
    assert.deepEqual(C.crumbChain("h1", synth, new Set(["top"])), [], "four hops: none (never more than three)");
    assert.equal(C.CRUMB_HOPS, 3);
    ok("the parent chosen: declared first; else the first required single reference to a shown area, else through a parent with a way there (at most 3 hops, no cycles); a shown area has none");
  }

  // ---------- 3. the record page's parents ----------
  install(fixture());
  const A = (await createOrg(`Crumbs A ${STAMP}`)).org, B = (await createOrg(`Crumbs B ${STAMP}`)).org;
  const http = await startHttp();
  const member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  await ra.asWriter({ by: "people", id: "seed" }, async () => {
    const rec = ra.workspaceRecords("fixture_pages", A.orgId);
    await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages" } });
    await rec.put("builds", "build-01", { title: "Build 01", data: { status: "queued", project: "checkout" } });
    await rec.put("projects", "gone", { title: "Gone", data: {} });
    await rec.put("builds", "build-02", { title: "Build 02", data: { status: "queued", project: "gone" } });
    await rec.put("checks", "check-01", { title: "Check 01", data: { build: "build-01", result: "pass" } });
    await rec.put("checks", "check-02", { title: "Check 02", data: { build: "build-02" } });
    // A parent removed after: its key stays in the build (the record store keeps it as written).
    await rec.delete("projects", "gone");
  });
  // Another workspace's record by the same key is never this one's parent.
  await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", B.orgId).put("projects", "gone", { title: "B's project", data: {} }));
  {
    const build = await get(member, "/api/records/builds/build-01");
    assert.equal(build.status, 200, JSON.stringify(build.body));
    assert.deepEqual(build.body.parents, [{ area: "projects", key: "checkout", title: "Checkout" }], "a build: its project");
    assert.deepEqual((await get(member, "/api/records/checks/check-01")).body.parents,
      [{ area: "builds", key: "build-01", title: "Build 01" }, { area: "projects", key: "checkout", title: "Checkout" }], "a check: its build, then the build's project (nearest first)");
    assert.equal((await get(member, "/api/records/projects/checkout")).body.parents, undefined, "a shown area's record: none");
    assert.equal((await get(member, "/api/records/builds/build-02")).body.parents, undefined, "a parent not there (removed; B has one by that key): none");
    assert.equal((await get(member, "/api/records/checks/check-02")).body.parents, undefined, "a hop not there: none at all (never half a trail)");
    const mcp = await ra.detailFor(A.orgId, "builds", "build-01", { role: "member", userId: "u" } as never);
    assert.ok(mcp && !("parents" in mcp), "the MCP tools' detail: as before");
    // A person who may not read the parent's area: the record's page crumbs as before.
    install(fixture((j) => { areaOf(j, "projects").permissions = { read: ["owner", "member"] }; }));
    assert.equal((await get(viewer, "/api/records/builds/build-01")).status, 200, "the viewer reads the build");
    assert.equal((await get(viewer, "/api/records/builds/build-01")).body.parents, undefined, "but not its project: no parents");
    assert.deepEqual((await get(member, "/api/records/builds/build-01")).body.parents?.map((p: any) => p.key), ["checkout"], "a member still has them");
    // Declared: a build crumbs through its environment.
    install(fixture((j) => { areaOf(j, "builds").detail.parent = "environment"; }));
    await ra.asWriter({ by: "people", id: "seed" }, async () => {
      const rec = ra.workspaceRecords("fixture_pages", A.orgId);
      await rec.put("environments", "staging-eu", { title: "Staging (EU)", data: { tier: "staging" } });
      await rec.put("builds", "build-03", { title: "Build 03", data: { status: "queued", project: "checkout", environment: "staging-eu" } });
    });
    assert.deepEqual((await get(member, "/api/records/builds/build-03")).body.parents, [{ area: "environments", key: "staging-eu", title: "Staging (EU)" }], "declared: its environment");
    assert.equal((await get(member, "/api/records/builds/build-01")).body.parents, undefined, "declared and left empty: none");
    ok("the record page's parents: nearest first with key and title, read as the person (an unreadable area, a missing or another workspace's record: none, never half); MCP detail as before");
  }

  // ---------- 4. the trail ----------
  {
    const T = await import(pathToFileURL(path.join(WEB, "lib", "crumb-trail.ts")).href);
    const areaCrumbs = (list: string, area: string) => list === "/app/records/applications"
      ? [{ title: "Applications", link: "/app/applications" }, { title: "My applications", link: "/app/applications-list" }] : [{ title: area, link: list }];
    assert.deepEqual(T.parentTrail([{ area: "environments", key: "prod", title: "Production" }, { area: "applications", key: "shop", title: null }], { title: "Tenant A", link: "/app/records/tenants/a" }, areaCrumbs), [
      { title: "Applications", link: "/app/applications" }, { title: "My applications", link: "/app/applications-list" },
      { title: "shop", link: "/app/records/applications/shop" }, { title: "Production", link: "/app/records/environments/prod" },
      { title: "Tenant A", link: "/app/records/tenants/a" },
    ], "entry › sub-tab › farthest parent (its key when untitled) › nearer parent › the record");
    assert.deepEqual(T.parentTrail([], { title: "X", link: "/x" }, areaCrumbs), [{ title: "X", link: "/x" }]);
    const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
    assert.match(src("features/records/record-pages.tsx"), /useBreadcrumbParents\(!inPanel && base === 'app' \? data\?\.parents \?\? null : null\)/, "the record's page names its parents (not from a list's panel)");
    assert.match(src("hooks/use-breadcrumbs.tsx"), /if \(rec && parents\.length\) return withGroup\(parentTrail\(parents,/, "the top bar's trail reads them, under the lit entry's group");
    assert.match(src("hooks/use-active-nav-entry.tsx"), /const page = root \? `\/app\/records\/\$\{encodeURIComponent\(root\.area\)\}`/, "the sidebar lights the farthest parent's entry");
    // The top bar's trail is one line: middle crumbs cut at 11rem (whole words in their title), folded into a "…" menu
    // when the trail still does not fit (measured on an unseen copy), the page's own crumb cut last; a phone as before.
    const bc = src("components/breadcrumbs.tsx");
    assert.match(bc, /<BreadcrumbList className='min-w-0 flex-nowrap whitespace-nowrap'>/, "never wraps");
    assert.match(bc, /const MIDDLE = 'block max-w-44 truncate';/, "a middle crumb: cut at 11rem with an ellipsis");
    assert.match(bc, /<BreadcrumbLink href=\{item\.link\} title=\{item\.title\}/, "its whole words on hover (and in the page, for a screen reader)");
    assert.match(bc, /if \(n <= 2 \|\| w\.reduce\(\(a, b\) => a \+ b, 0\) <= room\) return setFolded\(0\);/, "nothing folded while the whole trail fits its room");
    assert.match(bc, /while \(k < middle\.length && w\[0\]! \+ FOLD_WIDTH \+ middle\.slice\(k\)\.reduce\(\(a, b\) => a \+ b, 0\) \+ w\[n - 1\]! > room\) k\+\+;/, "else the fewest middle crumbs, from the first, before the page's own is cut");
    assert.match(bc, /<DropdownMenuTrigger render=\{<Button variant='outline' size='icon-xs' aria-label=\{`\$\{hidden\.length\} more/, "the fold is a named button opening a menu of the folded crumbs (keyboard: the menu's own)");
    assert.match(bc, /<div ref=\{probeRef\} aria-hidden className='pointer-events-none invisible absolute/, "the measured copy is never seen or read out");
    assert.match(bc, /className='min-w-0 shrink md:min-w-32'/, "the page's own crumb keeps 8rem from tablet width up, cut last");
    assert.match(bc, /item\.keep \? 'inline-flex' : 'hidden md:inline-flex'/, "a phone: the page's own crumb (and a kept one) only, as before");
    assert.match(src("components/layout/header.tsx"), /<div className='flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-4'>/, "the trail has the top bar's room left of its controls");
    ok("the trail: <entry> › <sub-tab> › <parent records> › <record>, each parent linking to its page; wired to the record page, the trail and the lit entry; one line (middle cut, then folded into a menu, the page's crumb last)");
  }

  // ---------- 5. the search row narrowed by a side panel ----------
  {
    const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
    const rv = src("components/layout/record-view.tsx");
    assert.match(rv, /<div className='@container\/toolbar'>\s*<div className='flex flex-wrap items-center gap-2 sm:@max-\[48rem\]\/toolbar:flex-nowrap'>/, "the search row is a container, one line when narrow (from sm up)");
    assert.match(rv, /relative min-w-48 flex-1 sm:@max-\[48rem\]\/toolbar:min-w-40/, "the search box: 12rem at full width, 10rem narrowed");
    const ta = src("features/tabs/tab-action.tsx");
    assert.match(ta, /const ACTION_CLASS = 'ml-auto shrink-0 sm:@max-\[48rem\]\/toolbar:w-8 sm:@max-\[48rem\]\/toolbar:px-0';/, "the primary action: square when narrowed");
    assert.match(ta, /const LABEL_CLASS = 'hidden sm:inline sm:@max-\[48rem\]\/toolbar:hidden';/, "its words hidden when narrowed (a phone's first word as before)");
    assert.equal((ta.match(/aria-label=\{label\} title=\{label\}/g) ?? []).length, 2, "named and titled by its label, button and link alike");
    // Actions ▾ keeps its word at every width (console-tabs: the label at every width); the row fits beside it.
    assert.match(src("components/layout/actions-menu.tsx"), /data-testid='list-actions'[\s\S]*?Actions\s*<Icons\.chevronDown/, "Actions ▾ keeps its word");
    ok("the search row narrowed by a side panel: one line, the search 10rem at least, the primary action its icon named by its words (Actions ▾ keeps its word); full width and phones as before");
  }
  await http.close();
  console.log("\nrecord crumbs (mold_v0-318): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
