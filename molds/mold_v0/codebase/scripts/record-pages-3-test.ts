// A record's page, part 3 (mold_v0-256, flag record_pages; with it the flag side_panel_forms), offline: run by
// `npm run test:record-pages` after scripts/record-pages-test.ts (parts 1 and 2), before the API's
// scripts/record-page-actions-test.ts.
//   a. Declared and refused (src/pack-api.ts): a log, history, code, table and files section and what each may name; a
//      fact computed from related records; an Add <related record> action (create_record, input "$key" | "$field:<name>");
//      an area whose Key follows its Title; a tab column computed from related records. In the area alone and across the
//      build (detailBuildProblems, src/metric-spec.ts checkViews: gen-packs and the server's install alike).
//   b. What the console decides (pure): the log's lines (level, time, source), its filters, search and highlight, its
//      virtualised window; JSON and YAML as highlighted lines, a manifest from a value; a json list as a table; a long
//      text's line diff, folded; a record's files as a tree; units on numbers (a duration in seconds in words), link
//      pieces, computed facts in words, Add <related record>'s address, a form filled from the address, a Key from a
//      Title; a run's page (its tabs, its timeline's lines, its cost against its budget, how long).
//   c. How it draws (source): no count beside a section's title, a number column's unit, a link wrapping at its slashes;
//      the side panel (FormHost: the same card kept mounted when it expands; a dialog with a focus trap, Esc, a question
//      before unsaved changes are dropped, the full screen on a phone); every control the shared outlined Button.
//   d. The build: off, the console's files as before (no flag, no related columns, no key_from_title); on, both flags and
//      the computed columns in the registry; a broken part 3 declaration refused by gen-packs, on or off.
//   e. Drawn in a headless browser (when the machine has one): a build's live log (filtered by search), a hundred thousand
//      lines virtualised, its code and table views, its history with a diff, a release's history redacting its encrypted
//      field, a project's computed facts, a build's file browser, the side panel (typed values kept when it expands; Esc
//      with unsaved changes asks; Tab wraps inside it) and the record picker, a run's page on each tab, live and finished.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);
const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const areaOf = (j: any, n: string) => j.record_areas.find((a: { name: string }) => a.name === n);
const has = (got: string[], re: RegExp, what: string) => assert.ok(got.some((x) => re.test(x)), `${what}: ${JSON.stringify(got)}`);

/** The headless browser's page: a record, a log, a form or a run, from the input; then the input's steps; then ready. */
const RENDER_ENTRY = `import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { recordAreas } from '@/config/pack-nav.generated';
import { layoutOf } from '@/features/records/detail-layout';
import { LaidOutRecord } from '@/features/records/detail-page';
import { LogViewer } from '@/features/records/log-viewer';
import { linesOf } from '@/features/records/log-lines';
import { ActionCard, CreateRecordForm, FormHost } from '@/features/tabs/tab-action';
import { RunPage } from '@/features/runs/run-page';
const I = (window as unknown as { __INPUT__: any }).__INPUT__;
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/api/records/_page/_pick/')) return json({ records: [{ key: 'checkout', title: 'Checkout' }, { key: 'search', title: 'Search' }].filter((r) => { const q = new URL(u, location.href).searchParams.get('q') ?? ''; return !q || r.key.includes(q) || r.title.toLowerCase().includes(q); }), more: false });
  if (u.includes('/api/records/_page/')) return json(I.page ?? { actions: [], sections: {}, facts: {} });
  if (/\\/files$/.test(u)) return json({ files: I.files ?? [] });
  if (u.includes('/events?after=')) return json(I.since ?? { run: I.run.run, events: [], tools: [], more: false, last: I.run.timeline.last });
  if (u.includes('/api/runs/')) return json(I.run);
  return realFetch(url, init);
};
function View() {
  if (I.view === 'log') return <LogViewer lines={linesOf(I.lines)} live={!!I.live} name={['big']} label='A long log' />;
  if (I.view === 'run') return <RunPage id={I.run.run.id} />;
  if (I.view === 'form') {
    history.replaceState(null, '', location.pathname + '?new=1&project=checkout');
    const fields = [{ name: 'project', label: 'Project', type: 'reference', to: 'projects', help: null, required: true, options: null, multiple: false, min: null, max: null, max_length: null },
      { name: 'branch', label: 'Branch', type: 'text', help: null, required: false, options: null, multiple: false, min: null, max: null, max_length: 200 }];
    return <FormHost panel card={<ActionCard open onOpenChange={() => {}} title='Add build' description='A new record in Builds.'>
      <CreateRecordForm area={{ name: 'builds', label: 'Builds', fields: fields as never, key_from_title: true }} onDone={() => {}} initial={{ project: 'checkout' }} /></ActionCard>}>
      <p data-list=''>the list</p></FormHost>;
  }
  const area = recordAreas.find((a) => a.name === I.area)!;
  const declared = layoutOf(area);
  const layout = declared && I.noActions ? { ...declared, actions: undefined } : declared;
  return layout ? <LaidOutRecord area={area} base='app' layout={layout} record={I.record} links={I.links} provenance={I.provenance} where="This workspace's own" credentials={null} /> : <p data-no-layout=''>no layout</p>;
}
createRoot(document.getElementById('root')!).render(<NuqsAdapter><div style={{ width: 1200 }}><View /></div></NuqsAdapter>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const note = (id: string, text: string) => { const p = document.createElement('pre'); p.id = id; p.textContent = text; document.body.appendChild(p); };
(async () => {
  try {
    await sleep(1500);
    for (const s of I.steps ?? []) {
      if (s.type) { const el = q(s.type[0]) as HTMLInputElement; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, s.type[1]); el.dispatchEvent(new Event('input', { bubbles: true })); }
      // The test page has no stylesheet: a box that scrolls in the console is given its overflow here.
      if (s.style) q(s.style[0])!.setAttribute('style', (q(s.style[0])!.getAttribute('style') ?? '') + ';' + s.style[1]);
      if (s.click) q(s.click)!.click();
      if (s.focus) q(s.focus)!.focus();
      if (s.key) (s.key[0] ? q(s.key[0]) : document.activeElement as HTMLElement)!.dispatchEvent(new KeyboardEvent('keydown', { key: s.key[1], bubbles: true, cancelable: true }));
      if (s.scroll) { const el = q(s.scroll[0])!; el.scrollTop = s.scroll[1] === 'bottom' ? el.scrollHeight : Number(s.scroll[1]); el.dispatchEvent(new Event('scroll')); }
      if (s.values) note('values-' + s.values, JSON.stringify(Object.fromEntries([...document.querySelectorAll('input, textarea')].filter((i) => i.id).map((i) => [i.id, (i as HTMLInputElement).value]))));
      if (s.active) note('active-' + s.active, (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 300) ?? '');
      if (s.html) note('html-' + s.html[0], q(s.html[1])?.outerHTML ?? 'none');
      await sleep(s.wait ?? 350);
    }
  } catch (e) { document.body.setAttribute('data-render-error', String(e).slice(0, 200)); }
  document.body.setAttribute('data-ready', '1');
})();
`;

// ---------------------------------------------------------------- a. declared and refused
{
  const api = await import("../src/pack-api.js");
  const { viewsOf, checkViews } = await import("../src/metric-spec.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const refusals = (a: unknown) => { const r = api.RecordAreaSchema.safeParse(a); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
  const edited = (n: string, edit: (d: any, a: any) => void) => { const a = clone(areaOf(FIXTURE, n)); edit(a.detail, a); return refusals(a); };
  for (const a of FIXTURE.record_areas) assert.deepEqual(refusals(a), [], `fixture area ${a.name}: its part 3 sections, facts and actions take`);
  for (const t of FIXTURE.tabs) assert.ok(api.TabSchema.safeParse(t).success, `fixture tab ${t.id} takes`);
  const logs = (d: any) => d.tabs[1].sections[2], conf = (d: any) => d.tabs[2].sections;
  has(edited("builds", (d) => { logs(d).log.field = "duration"; }), /duration is a number field: a log shows a text or json field/, "a log of a number field");
  has(edited("builds", (d) => { logs(d).log.field = "attachments"; }), /attachments is a file field: a log shows its value/, "a log of a file field");
  has(edited("builds", (d) => { logs(d).log.live_when = { field: "status", equals: "exploded" }; }), /exploded is not one of status's options/, "a live_when on a value the field lacks");
  has(edited("builds", (d) => { logs(d).fields = ["log"]; }), /section Build log shows a log: it has no fields/, "a log section with fields");
  has(edited("builds", (d) => { logs(d).code = { field: "config" }; }), /section Build log is one kind of section: log or code, not both/, "two kinds in one section");
  has(edited("builds", (d) => { conf(d)[2].code.field = "attachments"; }), /attachments is a file field/, "a code view of a file field");
  has(edited("builds", (d) => { conf(d)[2].code.language = "toml"; }), /code\.language/, "a language it does not highlight");
  has(edited("builds", (d) => { conf(d)[4].table.field = "summary"; }), /summary is a text field: a table view shows a json field/, "a table of a text field");
  has(edited("builds", (d) => { conf(d)[4].table.columns = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]; }), /table\.columns/, "nine table columns");
  has(edited("builds", (d) => { d.tabs[4].sections[0].history.fields = ["ghost"]; }), /ghost is not one of the area's fields/, "history of a field the area lacks");
  has(edited("builds", (d) => { d.tabs[4].sections[0].history.limit = 101; }), /history\.limit/, "a history past 100");
  has(edited("builds", (d) => { d.tabs[3].sections[0].files = { fields: ["commit"] }; }), /commit is not a file field or a field with preview "document"/, "a file browser of a text field");
  has(edited("projects", (d) => { d.tabs[0].sections.push({ title: "Files", files: {} }); }), /the area has no file field and no field with preview "document"/, "a file browser on an area without files");
  const facts = (d: any) => d.header.facts;
  has(edited("projects", (d) => { facts(d)[3].field = "owner"; }), /a computed fact has no field of its own/, "a computed fact with a field");
  has(edited("projects", (d) => { delete facts(d)[4].label; }), /a computed fact names itself \(label\)/, "a computed fact without its label");
  has(edited("projects", (d) => { delete facts(d)[3].computed.field; }), /a latest fact names the field it shows/, "a latest fact without its field");
  has(edited("projects", (d) => { facts(d)[4].computed.field = "status"; }), /a count fact counts records: it names no field/, "a count with a field");
  has(edited("projects", (d) => { facts(d).push({ label: "Odd" }); }), /a fact names a field of the record, or is computed from related records/, "a fact with neither");
  has(edited("projects", (d) => { facts(d).push({ label: "A" }, { label: "B" }); }), /at most 8 facts/, "a ninth fact (computed ones count)");
  const add = (d: any) => d.actions.find((x: any) => x.kind === "create_record");
  has(edited("projects", (d) => { delete add(d).area; }), /a create_record action names the area it adds a record to/, "Add without its area");
  has(edited("projects", (d) => { d.actions[0].area = "builds"; }), /area is for a create_record action, not start_run/, "an area on a run");
  has(edited("projects", (d) => { add(d).input.summary = "$field:ghost"; }), /ghost is not one of the area's fields/, "an input from a field the record lacks");
  has(edited("projects", (d) => { add(d).input.summary = "$fields:summary"; }), /input/, "a source that is not a field, \$key or \$title");
  has(edited("projects", (d) => { add(d).roles = ["viewer"]; }), /a create_record action cannot be a viewer's/, "a viewer's Add");
  assert.ok(!api.RecordAreaSchema.safeParse({ ...clone(areaOf(FIXTURE, "projects")), key_from_title: "yes" }).success, "key_from_title is true or false");
  const tab = (edit: (t: any) => void) => { const t = clone(FIXTURE.tabs.find((x: any) => x.id === "projects")); edit(t); const r = api.TabSchema.safeParse(t); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
  has(tab((t) => { t.columns[2].show = "sum"; }), /show is "count" or "latest:<a field of the related area>"/, "a related column showing a sum");
  has(tab((t) => { t.columns.push(clone(t.columns[2])); }), /a column is listed twice/, "a related column twice");
  has(tab((t) => { t.areas = [{ area: "projects" }, { area: "releases" }]; delete t.area; }), /a merged tab's columns are fields/, "a related column on a merged tab");
  // The second batch: notice conditions (dates, a clock, all and any, a success tone), a run on a linked record, a
  // related list matched on a field with its own column headings.
  const rel = (d: any) => d;
  has(edited("releases", (d) => { d.notices[2].when.all[1].field = "owner"; }), /within_days is for a date field \(owner is text\)/, "a date test on a text field");
  has(edited("releases", (d) => { d.notices[1].when.all[1] = { field: "release_on", before: "today", after: "today" }; }), /a condition is one test[^(]*\(it has before and after\)/, "two date tests");
  has(edited("releases", (d) => { d.notices[3].when.clock = "approval"; }), /approval is not one of the area's clocks \(signoff\)/, "a clock the area lacks");
  has(edited("releases", (d) => { d.notices[3].when.field = "stage"; }), /a clock's test is alone: it has no field/, "a clock's test with a field");
  has(edited("releases", (d) => { d.notices[0].when.all = [{ field: "owner", empty: true }]; }), /a condition with all has its tests inside it: no field or equals beside it/, "all beside a test");
  has(edited("releases", (d) => { d.notices[1].when.any = [{ field: "owner", empty: true }]; }), /a condition is all of its tests or any of them, not both/, "all and any");
  has(edited("releases", (d) => { d.notices[0].tone = "crimson"; }), /a notice's tone is one of info, success, warning, danger/, "a tone outside the four");
  has(edited("releases", (d) => { d.actions[1].target = { via: "subject" }; }), /target is for a start_run action, not link/, "a target on a link");
  has(edited("releases", (d) => { d.actions[0].target.via = "owner"; }), /owner is not a link or reference field of the area: a run's target is the record one names/, "a target through a text field");
  void rel;
  ok("the second batch, in the area (mold_v0-256): refused: a date test on a text field, two date tests, a clock the area lacks, a clock's test with a field, all beside a test, all and any together, a tone outside info, success, warning and danger, a target on a link action, a target through a text field");
  ok("in the area and the tab (mold_v0-256): the fixture takes; refused: a log of a number or file field or with fields, two kinds in one section, a code view of a file field or in another language, a table of a text field or of nine columns, history of a field the area lacks or past 100, a file browser of a text field or on an area without files, a computed fact with a field or without its label, a latest without its field, a count with one, a where of two tests, a fact with neither, a ninth fact, Add without its area, an area on a run, an input from a field the record lacks or not a field, a viewer's Add, a related column showing a sum, twice or on a merged tab");

  const build = (edit?: (j: any) => void) => { const j = clone(FIXTURE); edit?.(j); return checkViews(viewsOf([{ id: "fixture_pages", definition: compileDeclarations(j) as never }])); };
  assert.deepEqual(build(), [], "the fixture's build: no problem");
  const pf = (j: any) => areaOf(j, "projects").detail.header.facts;
  const across: [string, (j: any) => void, RegExp][] = [
    ["a computed fact's area", (j) => { pf(j)[3].computed.area = "deployments"; }, /record area projects's page: fact 4 \(Last build\): deployments is not a record area of this build/],
    ["no link back", (j) => { pf(j)[4].computed.area = "environments"; }, /fact 5 \(Builds\): environments has no link back to projects/],
    ["via elsewhere", (j) => { pf(j)[4].computed.via = "environment"; }, /builds's field environment does not point at projects/],
    ["a field it lacks", (j) => { pf(j)[3].computed.field = "ghost"; }, /field ghost is not one of builds's fields/],
    ["a json field", (j) => { pf(j)[3].computed.field = "config"; }, /field config is a json field: a computed fact shows one plain value/],
    ["a unit on text", (j) => { pf(j)[3].unit = "pts"; }, /a unit is for a count or a number field \(status is enum\)/],
    ["a where with two tests", (j) => { pf(j)[5].computed.where = { field: "status", equals: "failed", in: ["passed"] }; }, /where: a condition is one test/],
    ["a where value", (j) => { pf(j)[5].computed.where.equals = "exploded"; }, /where: exploded is not one of status's options/],
    ["Add's area", (j) => { areaOf(j, "projects").detail.actions[1].area = "deployments"; }, /action create_record\.deployments: deployments is not a record area of this build/],
    ["Add's input", (j) => { areaOf(j, "projects").detail.actions[1].input.ghost = "$key"; }, /input ghost is not one of builds's fields/],
    ["Add a file", (j) => { areaOf(j, "projects").detail.actions[1].input.attachments = "$key"; }, /input attachments is a file field/],
    ["a column's area", (j) => { j.tabs.find((t: any) => t.id === "projects").columns[2].related.area = "environments"; }, /column rel_environments_count: environments has no link back to projects/],
    ["a column's field", (j) => { j.tabs.find((t: any) => t.id === "projects").columns[3].show = "latest:ghost"; }, /column rel_builds_latest_ghost: ghost is not one of builds's fields/],
    ["a column's json", (j) => { j.tabs.find((t: any) => t.id === "projects").columns[3].show = "latest:config"; }, /config is a json field: a cell shows one plain value/],
    ["a run on a record that is not an asset", (j) => { const r = areaOf(j, "releases"); r.detail.actions[0].target.via = "project"; }, /target via project: projects is not an asset area/],
    ["a match without via", (j) => { delete areaOf(j, "releases").detail.tabs[0].sections[2].related.via; }, /a related list matched on a field names the field of theirs it matches \(via\)/],
    ["a match on an encrypted field", (j) => { areaOf(j, "releases").detail.tabs[0].sections[2].related.match_field = "signing_secret"; }, /match_field signing_secret is encrypted/],
    ["a match on a field they lack", (j) => { areaOf(j, "releases").detail.tabs[0].sections[2].related.via = "ghost"; }, /via ghost is not one of builds's fields/],
    ["a column twice (one with a heading)", (j) => { areaOf(j, "releases").detail.tabs[0].sections[2].related.columns.push("status"); }, /a column is listed twice/],
  ];
  for (const [what, edit, re] of across) has(build(edit), re, what);
  ok(`across the build (mold_v0-256, gen-packs and the server's install alike): ${across.map((x) => x[0]).join(", ")}`);
}

// ---------------------------------------------------------------- b. what the console decides
{
  const LL = await web("features/records/log-lines.ts");
  const p = LL.parseLine("2026-11-06T09:30:02.120Z [compile] ERROR: cannot find module 'payments'", 7);
  assert.deepEqual(p, { n: 7, at: "2026-11-06T09:30:02.120Z", level: "error", source: "compile", text: "ERROR: cannot find module 'payments'" }, "a line: its time, [source], level");
  assert.deepEqual(["WARN slow test", "warning: deprecated API", "FAIL payments/refund.spec", "INFO started", "debug: cache key", "12 passed"].map(LL.levelOf), ["warning", "warning", "error", "info", "debug", "info"]);
  const lines = LL.linesOf("a\n[db] retrying the connection\n[api] error: 500\n");
  assert.deepEqual(lines.map((l: any) => [l.n, l.level, l.source]), [[1, "info", null], [2, "warning", "db"], [3, "error", "api"]], "a text log: one line per line, its last break dropped");
  assert.deepEqual(LL.linesOf([{ at: "2026-11-06T09:00:00Z", level: "warn", source: "x", message: "m" }, "plain"]).map((l: any) => [l.level, l.source, l.text]), [["warning", "x", "m"], ["info", null, "plain"]], "a json log's entries");
  assert.deepEqual(LL.filterLines(lines, { levels: ["error", "warning"], source: null, search: "" }).map((l: any) => l.n), [2, 3], "levels");
  assert.deepEqual(LL.filterLines(lines, { levels: LL.LOG_LEVELS, source: "db", search: "" }).map((l: any) => l.n), [2], "a source");
  assert.deepEqual(LL.filterLines(lines, { levels: LL.LOG_LEVELS, source: null, search: "ERROR 500" }).map((l: any) => l.n), [3], "search: every word, any case");
  assert.deepEqual(LL.matchRanges("error: 500 error", "error 50"), [[0, 5], [7, 9], [11, 16]], "search's matches, merged and in order");
  assert.equal(LL.logText(lines), "a\nWARNING [db] retrying the connection\nERROR [api] error: 500\n", "the download: one line each");
  assert.equal(LL.logFileName("run_AbC", "Timeline"), "run_abc-timeline.log");
  // Virtualised: a hundred thousand lines, only the window (and its margin) drawn.
  const heights = new Array(100_000).fill(22), offsets = LL.offsetsOf(heights);
  const [a1, b1] = LL.visibleRange(offsets, heights, 0, 480), [a2, b2] = LL.visibleRange(offsets, heights, 22 * 50_000, 480), [a3, b3] = LL.visibleRange(offsets, heights, 22 * 99_980, 480);
  assert.ok(a1 === 0 && b1 < 60 && a2 > 49_970 && b2 < 50_060 && b3 === 99_999 && b3 - a3 < 60, `the window: [${a1}, ${b1}], [${a2}, ${b2}], [${a3}, ${b3}]`);
  assert.equal(LL.estimateHeight("x".repeat(300), true, 100, 22), 66, "a wrapped line's height before it is measured");

  const C = await web("features/records/code-text.ts");
  const cfg = { runner: "large", cache: true, retries: 2, steps: ["test", "build"], env: { NODE_ENV: "test" }, note: null };
  assert.equal(C.toYaml(cfg), "runner: large\ncache: true\nretries: 2\nsteps:\n  - test\n  - build\nenv:\n  NODE_ENV: test\nnote: null", "a value as YAML");
  assert.equal(C.toYaml({ a: "yes", b: "1.5", c: "x: y", d: "" }), 'a: "yes"\nb: "1.5"\nc: "x: y"\nd: ""', "strings quoted only when they must be");
  assert.deepEqual(C.jsonTokens('  "runner": "large", "n": 2, "ok": true').filter((t: any) => t.kind !== "plain").map((t: any) => t.kind), ["key", "punct", "string", "punct", "key", "punct", "number", "punct", "key", "punct", "literal"]);
  assert.deepEqual(C.yamlTokens("  - name: unit # fast").map((t: any) => [t.kind, t.text]), [["plain", "  "], ["punct", "- "], ["key", "name"], ["punct", ":"], ["plain", " "], ["string", "unit"], ["plain", " "], ["comment", "# fast"]]);
  assert.equal(C.languageOf({ a: 1 }), "json"); assert.equal(C.languageOf("kind: Build\nspec:\n  x: 1"), "yaml"); assert.equal(C.languageOf("plain words"), "text"); assert.equal(C.languageOf("{}", "yaml"), "yaml");
  assert.equal(C.codeText('{"a":1}', "json"), '{\n  "a": 1\n}', "a text holding JSON, pretty-printed");
  const rows = C.tableRows([{ suite: "payments", passed: 412, failed: 3 }, { suite: "search", passed: 220, failed: 0, flaky: true }]);
  assert.deepEqual(C.tableColumns(rows), ["suite", "passed", "failed", "flaky"], "a table's columns: its items' keys in order");
  assert.deepEqual([C.cellText(1234.5), C.cellText(true), C.cellText(null), C.cellText({ a: 1 }), C.columnWords("tests_failed")], ["1,234.5", "Yes", "—", "a: 1", "Tests failed"]);
  assert.equal(C.numericColumn(rows, "passed"), true); assert.equal(C.tableRows("not json"), null);
  const d = C.lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(d.map((l: any) => `${l.kind[0]}${l.text}`), ["sa", "rb", "aB", "sc", "sd", "ae"], "a line diff");
  assert.deepEqual(C.diffCounts(d), { added: 2, removed: 1 });
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const folded = C.foldDiff(C.lineDiff(long, long.replace("line 20", "line twenty")), 2);
  assert.ok(folded.some((x: any) => x.skip === 18) && folded.filter((x: any) => !x.skip).length === 6, "unchanged runs folded around the change");
  assert.equal(C.isLongText("short", "short too"), false); assert.equal(C.isLongText("a\nb", "a"), true);
  const tree = C.fileTree([{ path: "Attachments/report.pdf", item: 1 }, { path: "Attachments/logs/build.log", item: 2 }, { path: "notes.txt", item: 3 }]);
  assert.deepEqual(C.treeRows(tree, new Set(C.folderPaths(tree))).map((r: any) => `${r.depth}:${r.node.name}`), ["0:Attachments", "1:logs", "2:build.log", "1:report.pdf", "0:notes.txt"], "a tree: folders first");
  assert.deepEqual(C.treeRows(tree, new Set()).map((r: any) => r.node.name), ["Attachments", "notes.txt"], "a closed folder hides what is in it");
  assert.equal(C.sizeWords(2048), "2 KB");

  const L = await web("features/records/detail-layout.ts");
  assert.deepEqual([L.numberWords(1312, "s"), L.numberWords(45, "s"), L.numberWords(90, "min"), L.numberWords(400, "ms"), L.numberWords(200000, "s"), L.numberWords(87.4, "%"), L.numberWords(1312)],
    ["21m 52s", "45s", "1h 30m", "0.4s", "2d 7h", "87.4%", "1,312"], "a number with a unit of time reads as a duration");
  const builds = { name: "builds", fields: [], detail: areaOf(FIXTURE, "builds").detail };
  assert.deepEqual([L.columnUnit(builds, "duration"), L.columnUnit(builds, "coverage"), L.columnUnit(builds, "tests_passed")], ["s", "%", undefined], "a related list's column takes the unit its area's page gives it");
  assert.deepEqual(L.linkPieces("https://artifacts.example.com/builds/1042/output.tar.gz?sig=abc&exp=1"), ["https://artifacts.example.com/", "builds/", "1042/", "output.tar.gz?", "sig=", "abc&", "exp=", "1"], "an address cut after its slashes, never inside a word");
  assert.equal(L.linkPieces("https://x.example.com/a").join(""), "https://x.example.com/a", "and whole again");
  const proj = { fields: areaOf(FIXTURE, "builds").fields, list_columns: [] };
  const rest = L.unplacedFields(proj, areaOf(FIXTURE, "builds").detail).map((f: { name: string }) => f.name);
  assert.ok(!["log", "manifest", "test_suites", "attachments", "config"].some((n) => rest.includes(n)), `a log, code, table or file section places its field: ${rest.join(", ")}`);
  assert.deepEqual([L.countWords(12, false), L.countWords(1000, true), L.countWords(3, false, "builds")], ["12", "1,000+", "3 builds"]);
  assert.equal(L.createHref({ create: { area: "builds", label: "Builds", values: { project: "checkout", tags: ["a", "b"] } } }), "/app/records/builds?new=1&project=checkout&tags=a%2Cb", "Add <related record>'s address: the fields filled in");
  assert.equal(L.declaresCreate(areaOf(FIXTURE, "projects").detail), true);
  assert.equal(L.logLive({ log: { field: "log", live_when: { field: "status", in: ["running"] } } }, { status: "running" }), true);
  assert.equal(L.logLive({ log: { field: "log", live_when: { field: "status", in: ["running"] } } }, { status: "passed" }), false);
  assert.equal(L.durationWords(3725), "1h 2m");

  // mold_v0-256: conditions on dates, clocks, all and any, the same on both sides.
  const api = await import("../src/pack-api.js");
  const NOW = Date.parse("2026-11-06T12:00:00Z");
  const cases: [string, Record<string, unknown>, Record<string, unknown>, Record<string, { status: string }> | null, boolean][] = [
    ["before today", { field: "d", before: "today" }, { d: "2026-11-05" }, null, true], ["not before today", { field: "d", before: "today" }, { d: "2026-11-06" }, null, false],
    ["after today", { field: "d", after: "today" }, { d: "2026-11-07" }, null, true], ["within 7 days", { field: "d", within_days: 7 }, { d: "2026-11-13" }, null, true],
    ["past 7 days", { field: "d", within_days: 7 }, { d: "2026-11-14" }, null, false], ["within: not the past", { field: "d", within_days: 7 }, { d: "2026-11-01" }, null, false],
    ["a time today is today", { field: "d", before: "today" }, { d: "2026-11-06T01:00:00Z" }, null, false], ["no date", { field: "d", before: "today" }, {}, null, false],
    ["a clock overdue", { clock: "c", is: "overdue" }, {}, { c: { status: "overdue" } }, true], ["a clock on track", { clock: "c", is: "overdue" }, {}, { c: { status: "on_track" } }, false],
    ["a clock due soon", { clock: "c", is: "due_soon" }, {}, { c: { status: "due_soon" } }, true], ["no clocks", { clock: "c", is: "due_soon" }, {}, null, false],
    ["all", { all: [{ field: "s", equals: "critical" }, { field: "t", not_in: ["resolved"] }] }, { s: "critical", t: "open" }, null, true],
    ["all, one fails", { all: [{ field: "s", equals: "critical" }, { field: "t", not_in: ["resolved"] }] }, { s: "critical", t: "resolved" }, null, false],
    ["any", { any: [{ field: "s", equals: "critical" }, { clock: "c", is: "overdue" }] }, { s: "low" }, { c: { status: "overdue" } }, true],
  ];
  for (const [what, when, data, clocks, want] of cases) {
    assert.equal(L.conditionHolds(when, data, clocks, NOW), want, `the console: ${what}`);
    assert.equal(api.conditionHolds(when as never, data, clocks, NOW), want, `the server: ${what}`);
  }
  assert.equal(L.NOTICE_CLASS.success.includes("emerald"), true, "a success notice is green");
  assert.deepEqual(L.relatedColumns({ fields: [{ name: "status" }, { name: "started" }], list_columns: [] }, { columns: [{ field: "status", label: "Build status" }, "started", "ghost"] }),
    [{ field: "status", label: "Build status" }, { field: "started", label: null }], "a related list's columns, each with its own heading when it has one");
  const seed = await import("../../testing/console/seed.mts");
  assert.equal(seed.valueOf({ name: "endpoint", type: "url", required: true }, 2, 0, () => [], () => null, "services"), "https://example.com/services/3", "the lane's seed: a required url field filled");
  assert.equal(seed.valueOf({ name: "homepage", type: "url" }, 2, 0, () => [], () => null, "services"), undefined, "an optional one left empty");
  const F = await web("features/tabs/form-prefill.ts");
  // The flag decides (the console's generated flags, off in the mold itself): off, nothing is filled.
  assert.deepEqual(F.prefill([{ name: "project", type: "reference", multiple: false }], "?new=1&project=checkout"), {}, "off: the address fills nothing");
  assert.deepEqual([F.keyFromTitle("Checkout & Payments: Q3 (EU)"), F.keyFromTitle("  Café crème  "), F.keyFromTitle("x".repeat(80)).length], ["checkout-payments-q3-eu", "cafe-creme", 64], "a Key from a Title");
  const RV = await web("features/runs/run-view.ts");
  const empty = { timeline: { events: [], more: false, last: 0 }, agent: null, tools: [], results: null, files: null, related: [] };
  assert.deepEqual(RV.runTabs(empty), [], "a run with nothing: no tab");
  assert.deepEqual(RV.runTabs({ ...empty, timeline: { events: [{ id: 1 }], more: false, last: 1 }, tools: [{ id: 2 }], files: { files: [], version: 3 }, related: [{ area: "builds", key: "b" }] }),
    ["timeline", "tools", "files", "related"], "each tab only when it has something");
  assert.deepEqual(RV.runTabs({ ...empty, results: { outputs: [], counts: {}, checks: [] } }), [], "results with neither outputs nor checks: no tab");
  assert.equal(RV.costWords(0.4213, 2), "$0.42 of $2.00");
  assert.equal(RV.ranFor({ started_at: "2026-11-06T10:00:00Z", ended_at: null, status: "running" }, Date.parse("2026-11-06T10:21:52Z")), 1312, "how long so far, while it runs");
  assert.equal(RV.ranFor({ started_at: null, ended_at: null, status: "queued" }), null);
  assert.deepEqual(RV.eventLines([{ id: 9, at: "t", level: "warning", source: "engine", message: "Retried" }]), [{ n: 1, id: 9, at: "t", level: "warning", source: "engine", text: "Retried" }]);
  ok("the console decides (mold_v0-256): a log line's time, source and level, levels, a source and search (every word, highlighted), the download, a window of a hundred thousand lines; JSON and YAML tokens, a manifest from a value, a language by its value, a table's columns and cells, a line diff folded around its changes, a tree of files; a duration in words, a column's unit, an address cut at its slashes, unplaced fields, a count in words, Add's address, the form filled from the address only with the flag, a Key from a Title; a run's tabs, its cost against its budget and how long it ran");
}

// ---------------------------------------------------------------- c. how it draws (source)
{
  const dp = strip(src("features/records/detail-page.tsx")), ta = strip(src("features/tabs/tab-action.tsx")), lv = strip(src("features/records/log-viewer.tsx"));
  const rp = strip(src("features/runs/run-page.tsx")), cv = strip(src("features/records/code-view.tsx")), hs = strip(src("features/records/history-section.tsx")), fb = strip(src("features/records/file-browser.tsx"));
  assert.doesNotMatch(dp, /data-section-count|relatedCountWords|runsCountWords|First \$\{|Latest \$\{/, "no count beside a section's title");
  assert.match(dp, /const unit = f\.type === 'number' \? columnUnit\(target, f\.name\) : undefined;/, "a related list's number with its unit");
  assert.match(dp, /if \(relative && f\.type === 'url' && typeof v === 'string'\) return <LinkText href=\{v\} \/>;/, "a fact's address through LinkText");
  assert.match(dp, /linkPieces\(href\)\.map\(\(p, i\) => <span key=\{i\} className='inline-block max-w-full truncate align-bottom'>/, "each piece whole, a long one truncated");
  assert.match(dp, /\[overflow-wrap:normal\] \[word-break:normal\]/, "never broken inside a word");
  assert.doesNotMatch((/export function LinkText\b[\s\S]*?\n\}\n/.exec(dp)?.[0] ?? "").replace(/<TooltipContent[^>]*>/, ""), /break-all|break-words/, "no breaking inside a word on a fact's address (its tooltip shows it whole)");
  assert.match(dp, /const runHref = \(_pack: string, id: string\) => `\/app\/runs\/\$\{encodeURIComponent\(id\)\}`;/, "a record's runs link to the run's own page");
  assert.match(strip(src("features/tabs/runs.tsx")), /featureOn\('record_pages'\) && <Button variant='outline' size='sm' render=\{<Link href=\{`\/app\/runs\/\$\{encodeURIComponent\(r\.id\)\}`\} \/>\} data-open-run/, "a runs list's open run: Open run, only with the flag");
  // The side panel.
  const host = /export function FormHost\b[\s\S]*?\n\}\n/.exec(ta)?.[0] ?? "";
  assert.match(host, /const inPanel = open && panel && featureOn\('side_panel_forms'\) && !expanded;/, "a panel only with the flag, for a create or edit form, until expanded");
  assert.match(host, /\{card\}\s*\{!open \|\| inPanel \? children : null\}/, "the card first, always in one place (expanding keeps it mounted: the typed values stay); the list stays beneath the panel");
  const panel = /function SidePanelForm\b[\s\S]*?\n\}\n/.exec(ta)?.[0] ?? "";
  assert.match(panel, /role='dialog' aria-modal='true' aria-labelledby='side-panel-title'/, "a modal dialog, named by its title");
  assert.match(panel, /if \(e\.key === 'Escape' && !asking\) \{[^}]*close\(\);/, "Esc closes it");
  assert.match(panel, /const close = \(\) => \(dirty \? setAsking\(true\) : c\.cancel\(\)\);/, "closing with unsaved changes asks first");
  assert.match(panel, /onInput=\{\(\) => setDirty\(true\)\} onChange=\{\(\) => setDirty\(true\)\}/, "what is typed makes it unsaved");
  assert.match(panel, /title='Discard your changes\?'/, "the question");
  assert.match(panel, /if \(e\.shiftKey && [\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/, "Tab and Shift+Tab wrap inside it (a focus trap)");
  assert.match(panel, /absolute inset-y-0 right-0 flex w-full flex-col[^']*min-\[641px\]:w-\[min\(42rem,calc\(100vw-3rem\)\)\]/, "the full screen on a phone (640 px or narrower), a panel at the right above it");
  assert.match(panel, /data-panel-expand=''[^>]*>\s*<Icons\.maximize[^>]*\/>Open full page/, "Open full page");
  assert.match(panel, /document\.body\.style\.overflow = 'hidden'[\s\S]*?before\.focus\(\)/, "the page beneath does not scroll; focus returns where it was");
  assert.match(ta, /if \(c && inPanel\) return <SidePanelForm/, "CardForm draws the panel in its place");
  assert.match(ta, /<Card className='w-full max-w-4xl gap-0 py-0' data-action-card=''>/, "and the full card as before");
  assert.match(strip(src("features/records/record-pages.tsx")), /<FormHost card=\{card\} panel=\{panel\}>\s*<RecordTableView key=\{round\} area=\{area\} base='app'/, "an area's Add in the panel beside its list");
  assert.match(strip(src("features/records/staff-records.tsx")), /<FormHost card=\{card\} panel=\{!\(form\?\.import && importing\)\}>[\s\S]*<FormHost panel card=\{form\?\.edit && editing \?/, "staff's New and Edit too (Import stays a full card)");
  assert.match(dp, /<FormHost card=\{withActions && card \? [\s\S]{0,160}? : null\} panel=\{panel\}>/, "a record page's Edit and Add <related record>");
  assert.match(strip(src("features/records/page-actions.tsx")), /export const panelForm = \(a: PageAction \| null\) => !!a && \(a\.kind === 'edit' \|\| a\.kind === 'create_record'\);/, "only create and edit forms take the panel");
  // The record picker.
  const picker = /function RecordPicker\b[\s\S]*?\n\}\n/.exec(ta)?.[0] ?? "";
  assert.match(picker, /role=\{off \? undefined : 'combobox'\} aria-expanded=\{off \? undefined : open\} aria-controls=\{off \? undefined : list\}/, "a combobox");
  assert.match(picker, /\/api\/records\/_page\/_pick\/\$\{encodeURIComponent\(f\.to!\)\}\?q=/, "its choices from the server, as the person");
  assert.match(picker, /role='option' aria-selected=\{i === active\}/, "options");
  assert.match(ta, /\(f\.type === 'reference' \|\| \(f\.type === 'link' && f\.to\)\) && f\.to && featureOn\('record_pages'\) \?\s*\(\s*<RecordPicker/, "a reference field's input, with the flag");
  assert.match(ta, /if \(area\.key_from_title && !keyTyped\) setKey\(keyFromTitle\(e\.target\.value\)\)/, "the Key follows the Title until typed");
  // Controls: the shared outlined Button everywhere, nothing that acts as a button without one.
  for (const [name, t] of [["log-viewer", lv], ["code-view", cv], ["history-section", hs], ["file-browser", fb], ["run-page", rp]] as const) {
    assert.doesNotMatch(t, /<button\b/, `${name}: no raw button`);
    const variants = [...t.matchAll(/<Button\b[^>]*?variant=['"]([a-z]+)['"]/g)].map((m) => m[1]);
    assert.ok(variants.every((v) => ["outline", "link"].includes(v!)), `${name}: outlined Buttons (${variants.join(", ")})`);
  }
  assert.match(lv, /aria-pressed=\{wrap\}/); assert.match(lv, /aria-pressed=\{follow\}/); assert.match(lv, /data-log-copy=\{l\.n\}/);
  assert.match(fb, /role='tree'/); assert.match(fb, /role='treeitem'/);
  assert.match(hs, /Changed · encrypted, so its values are not shown/, "an encrypted field's change: never its values");
  const routes = strip(readFileSync(path.join(ROOT, "src", "record-page-routes.ts"), "utf8"));
  assert.match(routes, /const found = await linkedRecord\(opts\.org \?\? null, area, x\.field!, record, actor\);/, "a link action opens the area its value belongs to");
  assert.match(routes, /if \(declared\.target\) \{[\s\S]*?input\.target_asset = \{ area: a\.run\.target\.area, key: a\.run\.target\.key \};/, "a run on a linked record: its target from the record, never from the browser");
  assert.match(dp, /role=\{n\.tone === 'info' \|\| n\.tone === 'success' \? 'status' : 'alert'\}/, "a success notice is a status, not an alert");
  const { scanOutlines } = await import("./console-outlines.js");
  const found = scanOutlines(WEB);
  assert.deepEqual(found, [], `every button has an outline:\n${found.join("\n")}`);
  ok("drawn (mold_v0-256): no count beside a section's title, a column's unit, an address wrapping at its slashes and truncated with the whole on hover, runs linked to their own page; the side panel (only with the flag, for create and edit forms: an area's Add, staff's New and Edit, a record page's Edit and Add; the card mounted in one place so its values stay when it expands; a modal dialog, Esc, a question before unsaved changes are dropped, a focus trap, the full screen on a phone, Open full page); the record picker a combobox over the server's choices; the Key from the Title; every control the shared outlined Button (the outline scan clean)");
}

// ---------------------------------------------------------------- d. the build, and e. drawn in a headless browser
{
  const TMP = mkdtempSync(path.join(tmpdir(), "record-pages-3-"));
  const copyOf = (name: string, edit?: (j: any) => void, features?: Record<string, boolean> | null) => {
    const copy = path.join(TMP, name);
    const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
    cpSync(ROOT, copy, { recursive: true, filter: (s) => !skip.has(path.basename(s)) && s !== path.join(ROOT, "packs") && !s.startsWith(path.join(ROOT, "build")) });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    mkdirSync(path.join(copy, "packs", "fixture_pages"), { recursive: true });
    cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
    const j = clone(FIXTURE); edit?.(j);
    writeFileSync(path.join(copy, "packs", "fixture_pages", "pack.json"), JSON.stringify(j, null, 2));
    if (features) writeFileSync(path.join(copy, "profile.json"), JSON.stringify({ features }, null, 2));
    const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
    const read = (rel: string) => (existsSync(path.join(copy, rel)) ? readFileSync(path.join(copy, rel), "utf8") : "");
    return { copy, status: g.status, out: `${g.stdout}\n${g.stderr}`, nav: read("web/src/config/pack-nav.generated.ts"), features: read("web/src/config/features.generated.ts") };
  };
  try {
    const off = copyOf("off");
    assert.equal(off.status, 0, off.out.slice(-1500));
    assert.doesNotMatch(off.nav, /related_columns|key_from_title|rel_builds_count/, "off: no computed column, no Key from Title in the console's registry");
    assert.doesNotMatch(off.features, /record_pages|side_panel_forms/, "off: neither flag in the console's flags (quiet_off)");
    const on = copyOf("on", undefined, { record_pages: true, side_panel_forms: true });
    assert.equal(on.status, 0, on.out.slice(-1500));
    assert.match(on.features, /"record_pages": true,\s*"side_panel_forms": true/, "on: both flags");
    assert.match(on.nav, /"related_columns": \[\s*\{\s*"id": "rel_builds_count",\s*"at": 2,\s*"area": "builds",\s*"show": "count",\s*"label": "Builds"\s*\},\s*\{\s*"id": "rel_builds_latest_status",\s*"at": 3,\s*"area": "builds",\s*"show": "latest:status",\s*"label": "Last build"/, "the projects tab's computed columns, their places and headings");
    assert.match(on.nav, /"columns": \[\s*"health",\s*"owner"\s*\]/, "its own columns: the fields alone");
    const panelOnly = copyOf("panel-only", undefined, { side_panel_forms: true });
    assert.match(panelOnly.features, /"side_panel_forms": true/, "side_panel_forms on by the profile alone");
    for (const [name, edit, re, features] of [
      ["a log of a number", (j: any) => { areaOf(j, "builds").detail.tabs[1].sections[2].log.field = "duration"; }, /duration is a number field: a log shows a text or json field/, { record_pages: true }],
      ["a computed fact's area", (j: any) => { areaOf(j, "projects").detail.header.facts[3].computed.area = "environments"; }, /fact 4 \(Last build\): environments has no link back to projects/, null],
      ["a related column's field", (j: any) => { j.tabs.find((t: any) => t.id === "projects").columns[3].show = "latest:ghost"; }, /ghost is not one of builds's fields/, null],
    ] as const) {
      const b = copyOf(`refused-${name.replace(/\W+/g, "-")}`, edit, features);
      assert.notEqual(b.status, 0, `${name}: refused at build`);
      assert.match(b.out, re, `${name}: said why (${b.out.slice(-600)})`);
    }
    ok("the build (mold_v0-256): off, no flag, no computed column and no Key from Title in the console's files; on, both flags and the projects tab's computed columns with their places and headings (its own columns the fields alone); side_panel_forms on by the profile alone; refused at build, on or off: a log of a number, a computed fact over an area with no link back, a related column of a field its area lacks");

    // e. Drawn in a headless browser.
    const findChrome = () => {
      if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
      const cache = path.join(homedir(), ".cache", "ms-playwright");
      if (!existsSync(cache)) return null;
      for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
        for (const sub of existsSync(path.join(cache, d)) ? readdirSync(path.join(cache, d)) : []) { const bin = path.join(cache, d, sub, "chrome-headless-shell"); if (existsSync(bin)) return bin; }
      return null;
    };
    const chrome = findChrome();
    if (!chrome) { console.log("✓ (no headless browser on this machine: the rendered checks skipped)"); }
    else {
      const w = path.join(on.copy, "web");
      const { build } = await import("esbuild");
      writeFileSync(path.join(w, "render-entry.tsx"), RENDER_ENTRY);
      writeFileSync(path.join(w, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
      writeFileSync(path.join(w, "render-nav.ts"), "const r = { push: (h: string) => { (window as any).__PUSHED__ = h; document.body.setAttribute('data-pushed', h); }, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };\nexport const useRouter = () => r;\nexport const usePathname = () => location.pathname;\nexport const useSearchParams = () => new URLSearchParams(location.search);\nexport const notFound = () => { throw new Error('not found'); };\nexport const redirect = (h: string) => { throw new Error(h); };\n");
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
        const r = spawnSync(chrome, ["--no-sandbox", "--disable-gpu", "--virtual-time-budget=15000", "--window-size=1280,2400", "--dump-dom", `file://${f}${query}`], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
        assert.equal(r.status, 0, `the browser ran: ${r.stderr.slice(0, 600)}`);
        if (process.env.DRAW_DUMP) writeFileSync(path.join(process.env.DRAW_DUMP, `${name}.html`), r.stdout);
        assert.match(r.stdout, /data-ready="1"/, `${name}: drawn (${r.stdout.slice(0, 600)})`);
        assert.doesNotMatch(r.stdout, /data-render-error/, `${name}: no error (${/data-render-error="([^"]*)"/.exec(r.stdout)?.[1]})`);
        return r.stdout;
      };
      // Every drawn check is gathered, then all said at once (one browser run shows every problem).
      const failures: string[] = [];
      const softly = (f: () => void) => { try { f(); } catch (e) { failures.push((e as Error).message.split("\n")[0]!.slice(0, 300)); } };
      const soft = {
        match: (s: string, re: RegExp, m?: string) => softly(() => assert.match(s, re, m)),
        doesNotMatch: (s: string, re: RegExp, m?: string) => softly(() => assert.doesNotMatch(s, re, m)),
        ok: (v: unknown, m?: string) => softly(() => assert.ok(v, m)),
        equal: (x: unknown, y: unknown, m?: string) => softly(() => assert.equal(x, y, m)),
      };
      const record = (key: string, title: string, data: Record<string, unknown>) => ({ key, title, data, version: null, updated_at: "2026-11-06T09:30:00.000Z" });
      const logText = ["2026-11-06T09:30:00Z [checkout] INFO cloning main at 9f4c2e1a", "2026-11-06T09:30:04Z [install] WARN 3 packages are deprecated",
        "2026-11-06T09:31:10Z [test] FAIL payments/refund.spec: expected 200, got 500", "2026-11-06T09:31:11Z [test] ERROR 4 tests failed", "2026-11-06T09:31:12Z [report] wrote coverage.xml"].join("\n");
      const running = record("build-1043", "Build 1043", { status: "running", project: "checkout", branch: "main", approver: "R. Lee", log: logText,
        config: { runner: "large", cache: true, steps: ["install", "test", "build"] }, manifest: "kind: Build\nspec:\n  runner: large  # the big one\n  retries: 2\n  steps:\n    - install\n    - test\n",
        test_suites: [{ suite: "payments", passed: 412, failed: 3, seconds: 81.2 }, { suite: "search", passed: 220, failed: 0, seconds: 40 }] });
      // A live log: following, a search filtering it, its matches marked.
      const logs = draw("log-live", { view: "record", area: "builds", record: running, links: [], provenance: { by: "run" }, noActions: true,
        steps: [{ type: ["[data-log-search]", "refund 500"] }] }, "?tab=logs");
      const lv = /data-section-kind="log"[\s\S]*?<\/section>|data-section-kind="log"[\s\S]*$/.exec(logs)?.[0] ?? "";
      soft.match(lv, /data-log-follow="on"/, "a running build's log: Follow on");
      soft.match(lv, /1 of 5 lines match “refund 500”/, "search keeps the lines with every word, says how many");
      soft.match(lv, /data-log-line="3" data-level="error"[\s\S]*?\[test\][\s\S]*?<mark[^>]*>refund<\/mark>[\s\S]*?<mark[^>]*>500<\/mark>/, "the line kept, its level and source, its matches marked");
      soft.doesNotMatch(lv, /data-log-line="1"/, "the others not drawn");
      soft.match(lv, /aria-label="Copy line 3"/, "Copy line");
      // A hundred thousand lines: only the window drawn; scrolled to the end, the last ones.
      const big = Array.from({ length: 100_000 }, (_, i) => `[step${i % 7}] ${i % 50 === 0 ? "ERROR" : "INFO"} line ${i + 1} of the run`).join("\n");
      const bigDom = draw("log-big", { view: "log", lines: big, live: false, steps: [{ style: ["[data-log-lines]", "overflow: auto"] }, { scroll: ["[data-log-lines]", "bottom"] }, { wait: 600 }] });
      const drawn = (bigDom.match(/data-log-line="/g) ?? []).length;
      soft.ok(drawn > 10 && drawn < 200, `virtualised: ${drawn} of 100,000 lines drawn`);
      soft.match(bigDom, /data-log-line="100000"/, "scrolled to the end, the last line drawn");
      // Code and table.
      const conf = draw("config", { view: "record", area: "builds", record: running, links: [], provenance: { by: "run" }, noActions: true }, "?tab=configuration");
      soft.match(conf, /data-code-view="json"[\s\S]*?data-code-line="1"[\s\S]*?data-token="key">"runner"<[\s\S]*?data-token="string">"large"</, "JSON highlighted, each line numbered");
      soft.match(conf, /data-code-view="yaml"[\s\S]*?data-token="key">kind<[\s\S]*?data-token="comment"># the big one</, "a manifest as YAML, its comment marked");
      soft.match(conf, /data-code-download="config\.json"/); soft.match(conf, /data-code-download="manifest\.yaml"/);
      soft.match(conf, /data-json-table=""[\s\S]*?<th[^>]*>Suite<\/th><th[^>]*>Passed<\/th><th[^>]*>Failed<\/th><th[^>]*>Seconds<\/th>[\s\S]*?payments[\s\S]*?412/, "a json list as a table, its declared columns in words");
      // History with a diff, and a release's encrypted field redacted.
      const hist = (changes: unknown[], more = false) => ({ actions: [], sections: { "4-0": { changes, more } }, facts: {} });
      const change = (id: number, action: string, by: string, changes: unknown[], title: unknown = null) => ({ id, at: "2026-11-06T08:00:00.000Z", action, by, title, changes });
      const historyDom = draw("history", { view: "record", area: "builds", record: running, links: [], provenance: { by: "run" },
        page: hist([change(3, "updated", "r.lee@example.com", [{ field: "log", before: "a\nb\nc", after: "a\nB\nc\nd" }, { field: "duration", before: 1200, after: 1312 }]),
          change(2, "moved", "Run run_abc", [{ field: "status", before: "queued", after: "running" }]), change(1, "created", "You", [{ field: "branch", after: "main" }])], true) }, "?tab=history");
      soft.match(historyDom, /data-history-change="updated"[\s\S]*?r\.lee@example\.com[\s\S]*?changed 2 fields/, "who, and what");
      soft.match(historyDom, /data-history-diff=""[\s\S]*?\+2[\s\S]*?−1[\s\S]*?data-diff="removed"[\s\S]*?b[\s\S]*?data-diff="added"[\s\S]*?B/, "a long text as a line diff");
      soft.match(historyDom, /data-history-field="duration"[\s\S]*?data-history-before=""[\s\S]*?20m 0s|data-history-field="duration"[\s\S]*?1,200[\s\S]*?1,312|data-history-field="duration"[\s\S]*?1200[\s\S]*?1312/, "a short value before and after");
      soft.match(historyDom, /data-history-change="moved"[\s\S]*?Queued[\s\S]*?Running/, "a move: its states in words");
      soft.match(historyDom, /data-history-more=""/, "Show older changes");
      soft.doesNotMatch(historyDom, /data-section-count/);
      const rel = draw("history-redacted", { view: "record", area: "releases", record: record("rel-4-13", "Release 4.13", { project: "checkout", version: "4.13.0", stage: "candidate", signing_secret: "[encrypted]" }), links: [], provenance: { by: "people" },
        page: { actions: [], sections: { "1-0": { changes: [change(5, "updated", "You", [{ field: "signing_secret", redacted: true }, { field: "stage", before: "draft", after: "candidate" }])], more: false } }, facts: {} } }, "?tab=history");
      soft.match(rel, /data-history-field="signing_secret" data-redacted=""[\s\S]*?Changed · encrypted, so its values are not shown/, "an encrypted field: that it changed, never a value");
      // A release: its notices (a success, a date within a week with all, a clock), its builds matched on its project, with headings.
      const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const relRec = { ...record("rel-4-14", "Release 4.14", { project: "checkout", version: "4.14.0", stage: "candidate", owner: "Payments team", release_on: soon, service: "svc-pay", subject: "staging-eu" }),
        clocks: { signoff: { name: "signoff", label: "Sign-off", status: "overdue", overdue: true, started_at: null, due_at: null, due_on: null, overdue_days: 1, paused_ms: 0, stopped_at: null } } };
      const relRow = (key: string, status: string) => ({ key, title: key.replace("build-", "Build "), data: { status, branch: "main", started: "2026-11-05", duration: 1312 }, updated_at: "2026-11-05T09:00:00.000Z", actions: [] });
      const relDom = draw("release", { view: "record", area: "releases", record: relRec, links: [], provenance: { by: "people" },
        page: { actions: [], facts: {}, sections: { "0-2": { area: "builds", via: "project", match: "checkout", more: true, records: [relRow("build-1042", "failed"), relRow("build-1041", "passed")] } } } });
      soft.match(relDom, /data-record-notice="warning"[\s\S]*?Ships within a week/, "all of: a candidate due within a week");
      soft.match(relDom, /data-record-notice="danger"[\s\S]*?Sign-off overdue/, "a clock's state: overdue");
      soft.doesNotMatch(relDom, /Past its release date|data-record-notice="success"/, "the others do not hold");
      soft.match(relDom, /<th[^>]*>Build<\/th><th[^>]*>Build status<\/th><th[^>]*>Branch<\/th><th[^>]*>Built on<\/th><th[^>]*>Took<\/th>/, "the related list's own headings");
      soft.match(relDom, /href="\/app\/records\/builds\?linked=project%3Acheckout"[^>]*>Show all/, "Show all: matched on the project");
      const released = draw("release-released", { view: "record", area: "releases", record: { ...relRec, data: { ...relRec.data, stage: "released", release_on: "2026-01-01" }, clocks: {} }, links: [], provenance: { by: "people" },
        page: { actions: [], facts: {}, sections: { "0-2": { area: "builds", via: "project", match: "checkout", more: false, records: [] } } } });
      soft.match(released, /data-record-notice="success"[^>]*role="status"|role="status"[^>]*data-record-notice="success"/, "released: the success notice, green, a status");
      soft.doesNotMatch(released, /Past its release date/, "released: not past its date, whatever the date");
      // A project's computed facts (and a fact the person may not read: not drawn), and polish: its address wraps.
      const projDom = draw("computed", { view: "record", area: "projects", record: record("checkout", "Checkout", { health: "at_risk", summary: "The payment pages", owner: "Payments team", started: "2026-01-12",
        repository: "https://git.example.com/acme/checkout-service-with-a-long-name/tree/main" }), links: [], provenance: { by: "people" },
        page: { actions: [], sections: { "0-1": { area: "builds", via: "project", more: false, records: [] }, "0-2": { total: 0, runs: [] } },
          facts: { 3: { op: "latest", value: "failed", area: "builds", field: "status", record: { key: "build-1042", title: "Build 1042" } }, 4: { op: "count", value: 7, capped: false, area: "builds", via: "project" },
            5: { hidden: true }, 6: { op: "latest", value: 87.4, area: "builds", field: "coverage", record: { key: "build-1041", title: "Build 1041" } } } } });
      const facts = /data-record-facts="">([\s\S]*?)<\/dl>/.exec(projDom)?.[1] ?? "";
      soft.match(facts, /Last build[\s\S]*?data-computed-fact="3"[\s\S]*?data-badge-color="danger"[\s\S]*?Failed[\s\S]*?data-computed-from="build-1042"/, "the last build's status as its badge, linked to it");
      soft.match(facts, /Builds[\s\S]*?href="\/app\/records\/builds\?linked=project%3Acheckout"[^>]*data-computed-count="7">7</, "a count, linked to that list narrowed to this project");
      soft.doesNotMatch(facts, /Failed builds/, "a fact this person may not read: not drawn");
      soft.match(facts, /Last coverage[\s\S]*?87\.4%/, "the latest value with its unit");
      soft.match(facts, /data-link-text=""[^>]*>(<span class="inline-block max-w-full truncate align-bottom">[^<]*<\/span>){4,}/, "the repository's address in whole pieces (it wraps at its slashes)");
      // The file browser (its cards from the record's files route).
      const card = (id: string, name: string, field: string, label: string, preview: string | null, type: string, size: number) => ({ id, field, label, n: 0, source: "file", name, size, content_type: type, preview, preview_url: preview ? `/x/${id}` : null, download_url: `/x/${id}?download=1` });
      const filesDom = draw("files", { view: "record", area: "builds", record: running, links: [], provenance: { by: "run" }, noActions: true,
        files: [card("f1", "report.pdf", "attachments", "Attachments", "pdf", "application/pdf", 248000), card("f2", "logs/test.log", "attachments", "Attachments", "text", "text/plain", 3100)],
        steps: [{ click: '[data-path="logs"]' }, { click: '[data-path="report.pdf"]' }] }, "?tab=files");
      soft.match(filesDom, /role="tree"[\s\S]*?data-file-node="folder"[^>]*data-path="logs"[\s\S]*?data-file-node="file"[^>]*data-path="report\.pdf"/, "the files as a tree, folders first");
      soft.match(filesDom, /aria-expanded="false"[^>]*data-file-node="folder"|data-file-node="folder"[^>]*aria-expanded="false"|aria-expanded="false"/, "a folder closed by a click");
      soft.match(filesDom, /aria-selected="true"[^>]*data-file-node="file"[^>]*data-path="report\.pdf"/, "the open file");
      soft.match(filesDom, /data-file-preview="f1"[\s\S]*?data-document-card="pdf"[\s\S]*?report\.pdf[\s\S]*?Download/, "previewed with its document card");
      // The side panel: typed values kept when it expands; Esc with unsaved changes asks; Tab wraps; the record picker.
      const panelDom = draw("panel", { view: "form", steps: [
        { type: ["#action-title", "Nightly build"] }, { values: "panel" }, { focus: "[data-side-panel] [data-card-footer] button:last-child" }, { key: ["[data-side-panel]", "Tab"] }, { active: "trap" },
        { key: ["[data-side-panel]", "Escape"] }, { wait: 400 }, { html: ["confirm", "[role=alertdialog]"] }, { click: "[role=alertdialog] button" }, { wait: 300 },
        { click: "[data-panel-expand]" }, { wait: 300 }, { values: "expanded" }] });
      soft.ok(/id="values-panel">[^<]*"action-title":"Nightly build"/.test(panelDom) && /id="values-panel">[^<]*"action-key":"nightly-build"/.test(panelDom), "the panel: the Key follows the Title");
      soft.match(panelDom, /id="values-panel">[^<]*"action-field-project":"checkout"/, "the project filled in from the address");
      soft.match(panelDom, /id="active-trap">[^<]*side-panel-title|id="active-trap">[^<]*data-panel-expand/, "Tab from the last control wraps to the first");
      soft.match(panelDom, /id="html-confirm">[\s\S]*?Discard your changes\?/, "Esc with unsaved changes asks first");
      soft.match(panelDom, /id="values-expanded">[^<]*"action-title":"Nightly build"/, "Open full page: the same form, its typed values kept");
      soft.match(panelDom, /data-action-card=""/, "now the full card");
      soft.doesNotMatch(panelDom, /data-list=""/, "the list gives way to the full card");
      const pickDom = draw("picker", { view: "form", steps: [{ focus: "#action-field-project" }, { type: ["#action-field-project", "sea"] }, { wait: 600 }, { html: ["list", "[data-picker-list]"] }] });
      soft.match(pickDom, /id="html-list">[\s\S]*?role="option"[\s\S]*?Search[\s\S]*?search/, "the picker: the records matching what was typed, title and key");
      // A run's page, live and finished, on each tab.
      const ev = (id: number, level: string, source: string, message: string) => ({ id, at: `2026-11-06T10:0${Math.min(9, id)}:00.000Z`, attempt: 1, type: "step_log", level, source, message });
      const runData = (status: string) => ({
        run: { id: "run_live1", pack: "fixture_pages", kind: "rebuild", label: "Re-run a build", status, attempt: 1, max_attempts: 2, error_kind: null, error: status === "failed" ? "4 tests failed" : null, cancel_requested: false,
          cost_usd: 0.42, budget_usd: 2, created_at: "2026-11-06T10:00:00.000Z", started_at: "2026-11-06T10:00:05.000Z", ended_at: status === "running" ? null : "2026-11-06T10:21:57.000Z", by: "You",
          record: { area: "builds", key: "build-1042", title: "Build 1042" }, target: null },
        can: { rerun: { disabled: null }, stop: status === "running" ? { disabled: null } : null },
        timeline: { events: [ev(1, "info", "engine", "Queued"), ev(2, "info", "engine", "Started"), ev(3, "error", "test", "FAIL payments/refund.spec")], more: false, last: 3 },
        agent: { harness: "node rebuild.mjs", models: ["model-large"], providers: ["anthropic"], turns: 14, usage: [{ model: "model-large", provider: "anthropic", requests: 22, input_tokens: 182000, output_tokens: 9100, cost_usd: 0.39 }, { model: "model-small", provider: "anthropic", requests: 5, input_tokens: 9000, output_tokens: 700, cost_usd: 0.03 }], tools_allowed: [] },
        tools: [{ id: 4, at: "2026-11-06T10:02:00.000Z", name: "read_file", input: { path: "src/refund.ts" }, output: { lines: 120 }, error: null, ms: 40 }, { id: 5, at: "2026-11-06T10:03:00.000Z", name: "run_tests", input: { suite: "payments" }, output: null, error: "4 failed", ms: 81000 }],
        results: { outputs: [{ pattern: "results/report.json", state: status === "running" ? "pending" : "written" }], counts: { pass: 1, fail: 1 }, checks: [{ check: { area: "builds", key: "build-1042" }, asset: null, status: "fail", evidence_ref: "results/report.json" }] },
        files: { files: [{ path: "results/report.json", size: 2100, sha256: "ab".repeat(32), kind: "output", preview: { failed: 4 } }], version: 12 },
        related: [{ area: "builds", key: "build-1042", title: "Build 1042", how: ["Ran on", "Checked"] }],
      });
      const live = draw("run-live", { view: "run", run: runData("running"), since: { run: { status: "running", ended_at: null, started_at: "2026-11-06T10:00:05.000Z", cost_usd: 0.5, cancel_requested: false, error: null },
        events: [ev(6, "info", "report", "wrote coverage.xml")], tools: [], more: false, last: 6 }, steps: [{ wait: 4500 }] });
      soft.match(live, /data-run-page="running"/); soft.match(live, /data-run-live=""/, "live: it says it is updating");
      soft.match(live, /data-run-action="rerun"[\s\S]*?data-run-action="stop"[\s\S]*?data-run-action="copy-link"/, "Re-run, Stop while it runs, Copy link");
      soft.match(live, /data-run-tab="timeline"[\s\S]*?data-run-tab="agent"[\s\S]*?data-run-tab="tools"[\s\S]*?data-run-tab="results"[\s\S]*?data-run-tab="files"[\s\S]*?data-run-tab="related"/, "its tabs, in order");
      soft.match(live, /data-run-record="build-1042"/, "the record it ran on");
      soft.match(live, /data-log-follow="on"/, "its timeline follows");
      soft.match(live, /data-log-line="4"[\s\S]*?wrote coverage\.xml/, "new events read while it runs (polled)");
      soft.match(live, /data-run-cost="">\$0\.50 of \$2\.00/, "its cost as it spends");
      const done = (tab: string) => draw(`run-done-${tab}`, { view: "run", run: runData("failed") }, tab === "timeline" ? "" : `?tab=${tab}`);
      const t0 = done("timeline");
      soft.doesNotMatch(t0, /data-run-action="stop"/, "finished: no Stop"); soft.doesNotMatch(t0, /data-log-follow/, "nor Follow");
      soft.match(t0, /data-run-error=""[\s\S]*?4 tests failed/, "its error");
      soft.match(t0, /data-run-duration="">21m 52s</, "how long it took");
      soft.match(done("agent"), /node rebuild\.mjs[\s\S]*?model-large[\s\S]*?14[\s\S]*?data-usage-model="model-large"[\s\S]*?182,000[\s\S]*?\$0\.39[\s\S]*?Total/, "the agent: harness, model, turns, tokens and cost by model");
      const tools = done("tools");
      soft.match(tools, /data-tool-call="read_file" data-open="false"[\s\S]*?data-tool-call="run_tests" data-open="false"[\s\S]*?Failed/, "each tool call, collapsed, a failed one marked");
      soft.match(done("results"), /data-output="written"[\s\S]*?results\/report\.json[\s\S]*?data-run-check-counts[\s\S]*?1 pass[\s\S]*?1 fail/, "its required outputs and the checks");
      soft.match(done("files"), /data-run-version="12"[\s\S]*?data-run-file="results"[\s\S]*?data-run-file="results\/report\.json"[\s\S]*?"failed"/, "the files it wrote, as a tree, with a preview");
      soft.match(done("related"), /data-related-record="build-1042"[\s\S]*?Ran on[\s\S]*?Checked/, "the records it touched");
      assert.deepEqual(failures, [], `drawn: ${failures.length} problem(s):\n${failures.join("\n")}`);
      ok("drawn in a headless browser (mold_v0-256): a running build's log following, filtered by search with its matches marked and Copy line; a hundred thousand lines virtualised (the end drawn when scrolled there); JSON and YAML highlighted with line numbers and their downloads; a json list as a table; history with a line diff, a move in words and Show older; a release's encrypted field redacted; a project's computed facts (a badge, a count linked to its list, a value with its unit; a hidden one not drawn) and its address in whole pieces; a build's file browser; the side panel (the Key from the Title, a field from the address, Tab wrapping, Esc asking before unsaved changes go, Open full page keeping the values) and the record picker; a run's page live (polled, following, Stop) and finished on each tab");
    }
  } finally { rmSync(TMP, { recursive: true, force: true }); }
}

