// mold_v0-331: a record's details in the rail style (a layout's `style: "rail"`), generic, no database:
//   1. the new layout keys (style, header.status, header.context, a section's display and steps) parse, and each wrong
//      use is refused at build with its path; a layout without them is exactly as before (cards)
//   2. the pure decisions: the status dot's tone, the header's "status · context" line, the badges left as facts, a
//      lifecycle's steps (done / now / to do, a state off the path), a related list's one-line words
//   3. the blocks drawn (server-rendered React): label and value rows with Copy, a link row, numbers, steps, a notice line,
//      the header row with its dot
//   4. the wiring: the record panel's header slots (a rail body claims the title and the ⋯), the rail actions' one ⋯
//      (the record's actions, the copies, the panel's own items), flat sections, and the fixture pack still building
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detailProblems, RecordAreaSchema } from "../src/pack-api.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);
const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const area = (n: string) => JSON.parse(JSON.stringify(FIXTURE.record_areas.find((a: { name: string }) => a.name === n)));
const builds = area("builds"), projects = area("projects");
const L = await web("features/records/detail-layout.ts");

const issues = (a: unknown) => {
  const r = RecordAreaSchema.safeParse(a);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

// 1. The keys, in the schema and at build.
{
  const rail = { ...builds, detail: { ...builds.detail, style: "rail", header: { ...builds.detail.header, status: "status", context: ["tier", "branch"] },
    tabs: [...builds.detail.tabs, { label: "Progress", sections: [
      { title: "Steps", steps: { field: "status", states: ["queued", "running", "passed"] } },
      { title: "Tests", display: "numbers", fields: ["tests_passed", "tests_failed"] },
    ] }] } };
  const parsed = RecordAreaSchema.parse(rail);
  assert.deepEqual(detailProblems(parsed as never), [], "style rail, a status, a context line, a steps section and a numbers section are a layout");
  assert.equal(parsed.detail!.style, "rail");
  const rows = { ...projects, detail: { ...projects.detail, tabs: projects.detail.tabs.map((t: { sections: { related?: unknown }[] }) => ({ ...t, sections: t.sections.map((s) => (s.related ? { ...s, display: "rows" } : s)) })) } };
  assert.deepEqual(issues(rows), [], "a related list may be one link row (display rows)");
  assert.deepEqual(issues(builds), [], "the fixture's layout without any of the new keys parses as before");
  assert.equal(RecordAreaSchema.parse(builds).detail!.style, undefined, "no style: the default (cards), nothing written for it");

  const refused: [string, unknown, RegExp][] = [
    ["detail.style", { ...builds, detail: { ...builds.detail, style: "tiles" } }, /cards|rail/],
    ["detail.header.status", { ...builds, detail: { ...builds.detail, header: { status: "summary" } } }, /not a single-choice enum field/],
    ["detail.header.status", { ...builds, detail: { ...builds.detail, header: { status: "nope" } } }, /nope is not one of the area's fields/],
    ["detail.header.context.0", { ...builds, detail: { ...builds.detail, header: { context: ["nope"] } } }, /not one of the area's fields/],
    ["detail.header.context.1", { ...builds, detail: { ...builds.detail, header: { context: ["tier", "tier"] } } }, /twice/],
    ["detail.header.context", { ...builds, detail: { ...builds.detail, header: { context: ["tier", "branch", "commit", "summary"] } } }, /3/],
    ["detail.tabs.0.sections.0.display", { ...builds, detail: { ...builds.detail, tabs: [{ label: "A", sections: [{ title: "X", display: "rows", fields: ["branch"] }] }] } }, /display rows is for a related list/],
    ["detail.tabs.0.sections.1.display", { ...rows, detail: { ...rows.detail, tabs: rows.detail.tabs.map((t: { sections: { related?: unknown }[] }) => ({ ...t, sections: t.sections.map((s) => (s.related ? { ...s, display: "numbers" } : s)) })) } }, /display numbers is for a section of fields/],
    ["detail.tabs.0.sections.0.steps.field", { ...builds, detail: { ...builds.detail, tabs: [{ label: "A", sections: [{ title: "S", steps: { field: "summary" } }] }] } }, /a steps section shows a enum field/],
    ["detail.tabs.0.sections.0.steps.states.1", { ...builds, detail: { ...builds.detail, tabs: [{ label: "A", sections: [{ title: "S", steps: { field: "status", states: ["queued", "shipped"] } }] }] } }, /shipped is not one of status's options/],
    ["detail.tabs.0.sections.0.fields", { ...builds, detail: { ...builds.detail, tabs: [{ label: "A", sections: [{ title: "S", steps: { field: "status" }, fields: ["branch"] }] }] } }, /it has no fields/],
  ];
  for (const [at, a, re] of refused) {
    const got = issues(a);
    assert.ok(got.some((m) => m.startsWith(`${at}:`) && re.test(m)), `refused at ${at} (${re}): ${JSON.stringify(got)}`);
  }
  ok(`the keys: style, header.status and header.context, display rows / numbers and steps parse; ${refused.length} wrong uses refused at build with their path`);
}

// 2. The pure decisions.
{
  assert.deepEqual(["success", "warning", "danger", "info", "neutral", "viz-3"].map(L.dotTone), ["good", "warn", "bad", "info", "neutral", "neutral"], "the dot takes the badge colour's tone");
  assert.equal(L.headerContext("Failed", ["Staging", null, " ", "main"]), "Failed · Staging · main", "status first, blanks left out");
  assert.equal(L.headerContext(null, []), "");
  const layout = { header: { status: "status", context: ["kind"], badges: [{ field: "status" }, { field: "tier" }, { field: "kind" }] }, tabs: [] };
  assert.deepEqual(L.railBadges(layout).map((b: { field: string }) => b.field), ["tier"], "the status and the context line are not repeated as badges");
  assert.deepEqual([...L.railHeaderFields(layout)], ["status", "kind"]);
  assert.equal(L.isRail(layout), false);
  assert.equal(L.isRail({ ...layout, style: "rail" }), true);
  const path = ["queued", "running", "passed"];
  assert.deepEqual(L.stepRows(path, "running"), { steps: [{ value: "queued", state: "done" }, { value: "running", state: "now" }, { value: "passed", state: "todo" }], off: null });
  assert.deepEqual(L.stepRows(path, "passed").steps.map((x: { state: string }) => x.state), ["done", "done", "now"]);
  assert.deepEqual(L.stepRows(path, "failed"), { steps: path.map((value) => ({ value, state: "todo" })), off: "failed" }, "a state off the path: every step to do, the state said apart");
  assert.deepEqual(L.stepRows(path, null).off, null, "no state yet: all to do, nothing apart");
  assert.deepEqual([L.stepMark("done", 0), L.stepMark("now", 1), L.stepMark("todo", 2)], ["✓", "2", "3"]);
  assert.deepEqual([L.relatedRowWords(0, false, "Builds"), L.relatedRowWords(1, false, "Builds"), L.relatedRowWords(3, false, "Repositories"), L.relatedRowWords(5, true, "Builds")],
    ["None yet", "1 build", "3 repositories", "More than 5 builds"]);
  ok("decisions: the dot's tone, the status · context line, the badges left as facts, steps done / now / to do with a state off the path, a related row's words");
}

// 3. The blocks, drawn.
{
  // Bundled as the console builds them (its tsconfig paths, its React), rendered to markup in a child process.
  const { build } = await import("esbuild");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const webDir = path.join(ROOT, "web");
  const tmp = mkdtempSync(path.join(tmpdir(), "rail-331-"));
  let out: Record<string, string>;
  try {
    writeFileSync(path.join(tmp, "link.tsx"), "export default function Link({ href, children, ...p }: any) { return <a href={href} {...p}>{children}</a>; }\n");
    writeFileSync(path.join(tmp, "entry.tsx"), `import { renderToStaticMarkup as r } from 'react-dom/server';
import { RailFields, LinkRow, RailNumbers, RailSteps, NoticeLine, RailHeading } from '@/features/records/record-kit';
process.stdout.write('\\u0001' + JSON.stringify({
  fields: r(<RailFields rows={[{ key: 'a', label: 'Branch', value: 'main' }, null, { key: 'b', label: 'Brief', value: 'long', wide: true }, { key: 'c', label: 'Empty', value: null }]} />),
  row: r(<LinkRow id='r' title='Builds' detail='3 builds' action='View' href='/app/records/builds?linked=x' />),
  nums: r(<RailNumbers items={[{ key: 'p', label: 'Passed', value: '412' }]} />),
  steps: r(<RailSteps label='Progress' steps={[{ key: 'a', label: 'Queued', state: 'done' }, { key: 'b', label: 'Running', state: 'now' }, { key: 'c', label: 'Passed', state: 'todo' }]} />),
  notice: r(<NoticeLine tone='danger' title='Build failed' text='Fix it, then build again.' />),
  head: r(<RailHeading title='Vendor onboarding' tone='bad' status='Failed' context='Failed · Staging' level='h2' />),
}));
`);
    await build({ entryPoints: [path.join(tmp, "entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(tmp, "out.cjs"), absWorkingDir: webDir,
      tsconfig: path.join(webDir, "tsconfig.json"), nodePaths: [path.join(webDir, "node_modules")], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      alias: { "next/link": path.join(tmp, "link.tsx") }, logLevel: "error" });
    const r = spawnSync(process.execPath, [path.join(tmp, "out.cjs")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.status, 0, `render: ${r.stderr.slice(0, 2000)}`);
    out = JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const fields = out.fields;
  assert.match(fields, /grid-cols-\[minmax\(0,130px\)_minmax\(0,1fr\)\]/, "one label width");
  assert.equal((fields.match(/<dt/g) ?? []).length, 3, "a falsy row is left out");
  assert.match(fields, /col-span-2[^>]*>Brief/, "a wide value goes under its label");
  assert.match(fields, />—</, "an empty value reads —");
  const row = out.row;
  assert.match(row, /data-link-row/);
  assert.match(row, /3 builds/);
  assert.match(row, /href="\/app\/records\/builds\?linked=x"[^>]*>View →</, "the text link, no box");
  assert.doesNotMatch(row, /<button/, "a link row has no button");
  const nums = out.nums;
  assert.match(nums, /text-right font-semibold tabular-nums">412<\/dd><dt[^>]*>Passed/, "the number right-aligned, its label beside it");
  const steps = out.steps;
  assert.match(steps, /aria-label="Progress"/);
  assert.match(steps, /aria-current="step"/, "the current step is announced");
  assert.ok(steps.includes("✓") && steps.includes(">Done<") && steps.includes(">Now<") && steps.includes(">To do<"));
  const notice = out.notice;
  assert.match(notice, /role="alert"/);
  assert.match(notice, /▲/);
  assert.doesNotMatch(notice, /border|rounded/, "one line, no box");
  const head = out.head;
  assert.match(head, /data-status-dot="bad"/);
  assert.match(head, /<h2[^>]*data-testid="detail-panel-title"[^>]*>Vendor onboarding<\/h2>/, "in a panel the title is the panel's");
  assert.match(head, /data-rail-context="">Failed · Staging</);
  ok("blocks: label and value rows (one label width, a wide value under its label, — when empty), a link row, numbers, steps, a notice line, the header row");
}

// 4. The wiring.
{
  const panel = src("components/layout/detail-panel.tsx");
  assert.match(panel, /export function usePanelHeaderSlots/);
  assert.match(panel, /claimed <= 0 && \(menu \?\? <PanelMenu/, "a claimed header drops the panel's own ⋯ (the body's one ⋯ carries its items)");
  assert.match(panel, /claimed <= 0 && \(\s*<div className='min-w-0 flex-1 max-lg:order-last max-lg:basis-full' data-slot='detail-panel-heading'>/, "and its plain title");
  for (const kept of ["data-testid='detail-panel-expand'", "data-testid='detail-panel-close'", "data-testid='detail-panel-back'", "PanelSplitter"])
    assert.ok(panel.includes(kept), `the panel keeps ${kept}`);
  const page = src("features/records/detail-page.tsx");
  assert.match(page, /if \(isRail\(layout\)\) return \(\s*<RailBody/, "a rail layout draws the rail body");
  assert.match(page, /useLayoutEffect\(\(\) => claim\?\.\(true\), \[claim\]\)/, "the rail body claims the panel header");
  assert.match(page, /createPortal\(heading, slots\.heading\)/);
  assert.match(page, /createPortal\(menu, slots\.menu\)/);
  assert.match(page, /key: 'id', label: 'ID'/, "the ID appears once, as a field with Copy");
  assert.match(page, /facts\.filter\(\(x\) => x\.computed \|\| !said\.has\(x\.field!\)\)/, "the status and context are not repeated as facts");
  const acts = src("features/records/page-actions.tsx");
  assert.match(acts, /function RailMenu/);
  assert.match(acts, /data-testid='panel-actions'/);
  assert.match(acts, /Copy ID[\s\S]*ownSafe[\s\S]*destructive\.map/, "the record's actions, the copies, the panel's own items, then the deletes last");
  ok("wiring: the panel header's slots (title and ⋯ claimed; Expand, ✕, Back and the splitter kept), the rail body, the one ⋯");
}
