// The customer guide from the packs (mold_v0-106; src/pack-guide.ts, scripts/gen-packs.mjs packGuideData,
// web/src/content/pack-guide.ts, web/src/content/customer-guide.ts, scripts/sync-docs-corpus.ts), offline: no database,
// no server, no browser. Each build is a throwaway copy of this codebase (its node_modules linked) with its own packs.
//   npm run test:pack-guide
//
// 1. pack.json `guide`, checked (src/pack-guide.ts): markdown only. Raw HTML, a script, an image, a # title inside a page,
//    control and invisible characters, a link that is not a path of this site, an #anchor, https:// or mailto: (javascript:,
//    data:, vbscript:, http:, //host, a user name in the address, bare http:// and www.), text before the first ## page,
//    two pages at one address, a page taking a generated page's title, groups naming a missing page or one page twice,
//    markdown and dir together are refused, each with where it is; code spans and fenced blocks are free text.
// 2. Zero packs: gen-packs writes PACK_GUIDE null, and the guide and the docs corpus are the shell's, byte for byte.
// 3. A declarative pack with no guide gets a real one, written from its declarations in its words: what it does, its
//    onboarding steps with get_started and the prompts to type, its record areas (fields, lifecycle, due dates, tools),
//    its job kinds with their credentials and schedules, and the MCP tools grouped by what they reach. A kind whose start
//    tool the pack withholds is left out, with the credentials only it uses; an area whose list tool is withheld too.
//    The docs answers' corpus carries the same pages.
// 4. A declarative pack with an inline guide and one with a directory guide: their pages come first, in their groups,
//    with the generated pages after them (generated: false keeps only connecting, the tools and the account); the
//    corpus cites them at /app/docs/<slug>. gen-packs refuses a bad guide (an unsafe link, raw HTML, a generated
//    page's title, a file that is not .md in the directory) with the pack and the page.
// 5. A host pack is untouched: with its guide code the build writes PACK_GUIDE null (its guide replaces the shell's as
//    before, beside a declarative pack too), and a host pack may not declare pack.json guide.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "pack-guide-test-"));
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_tracker", "pack.json"), "utf8"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

let n = 0;
/** A throwaway build: this codebase's sources (node_modules linked), the given packs and profile, gen-packs run in it. */
function world(packs: Record<string, Record<string, string>>, profile: Record<string, unknown> = {}, web: Record<string, string> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  rmSync(path.join(dir, "packs"), { recursive: true, force: true });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, files] of Object.entries(packs)) for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, "packs", id, f)), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, f), text);
  }
  for (const [f, text] of Object.entries(web)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, gen, out: `${gen.stdout}\n${gen.stderr}` };
}
/** Run the build's own generators after gen-packs: its tool list, then its docs corpus; the guide's pages as /app/docs renders them. */
function guideOf(dir: string) {
  for (const s of ["export-mcp-tools.ts", "sync-docs-corpus.ts"]) {
    const r = spawnSync(TSX, [path.join(dir, "scripts", s)], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `${s}: ${r.stdout}${r.stderr}`);
  }
  const script = path.join(dir, "render.mts");
  writeFileSync(script, `import { readFileSync } from "node:fs";
const { guidePages, PAGE_GROUPS } = await import(${JSON.stringify(pathToFileURL(path.join(dir, "web/src/content/customer-guide.ts")).href)});
const catalog = JSON.parse(readFileSync(${JSON.stringify(path.join(dir, "web/src/content/mcp-tools.generated.json"))}, "utf8"));
process.stdout.write(JSON.stringify({ groups: PAGE_GROUPS, pages: guidePages(catalog) }));`);
  const r = spawnSync(TSX, [script], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout) as { groups: [string, string[]][]; pages: { slug: string; title: string; group: string; body: string }[] };
  const corpus = JSON.parse(readFileSync(path.join(dir, "src", "docs-corpus.generated.json"), "utf8")).chunks as { area: string; title: string; href: string; text: string }[];
  const packGuide = /export const PACK_GUIDE: unknown = ([\s\S]*?);\n/.exec(readFileSync(path.join(dir, "web/src/config/pack-guides.generated.ts"), "utf8"))![1]!;
  return { ...g, corpus, data: JSON.parse(packGuide) };
}
const page = (g: ReturnType<typeof guideOf>, title: string) => { const p = g.pages.find((x) => x.title === title); assert.ok(p, `a page "${title}" (pages: ${g.pages.map((x) => x.title).join(", ")})`); return p!; };
const tracker = (extra: Record<string, unknown> = {}) => ({ ...structuredClone(FIXTURE), ...extra });

try {
  const { compileGuide, pageProblems } = await import("../src/pack-guide.js");

  // ---------- 1. the guide's checks ----------
  {
    const bad = (what: string, md: string, re: RegExp) => {
      const p = pageProblems(md, "page X");
      assert.ok(p.some((x: string) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(p)})`);
    };
    const good = (what: string, md: string) => assert.deepEqual(pageProblems(md, "page X"), [], what);
    good("plain markdown", "Some **bold** text, a [page](/app/records/apps), an [anchor](#steps), [mail](mailto:team@example.org) and [docs](https://example.org/a?b=c#d).\n\n## Steps\n\n1. One\n2. Two\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    good("HTML and links inside code", "Use `<script>alert(1)</script>` or `[x](javascript:alert(1))`.\n\n```html\n<div onclick=\"x\">[a](javascript:x) ![i](http://x)</div>\n# not a heading\n```\n\nAfter the fence.");
    good("a bare https:// address and an autolink", "See https://example.org/docs. Or <https://example.org>.");
    good("comparison signs", "Coverage < 50% is low; a > b.");
    bad("a script tag", "Hello <script>alert(1)</script>", /line 1: raw HTML \(<script/);
    bad("an HTML block", "Text\n\n<div class=\"x\">\nhi\n</div>", /line 3: raw HTML/);
    bad("an HTML comment", "Text <!-- hidden -->", /raw HTML/);
    bad("an inline event handler", "<img src=x onerror=alert(1)>", /raw HTML/);
    bad("an image", "![logo](https://example.org/x.png)", /an image/);
    bad("a # title inside a page", "Intro\n\n# Another title", /line 3: a # heading inside a page/);
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "http://example.org", "//evil.example", "/\\evil", "https://user:pw@example.org/", "ftp://x.example", "page.md", "../x"])
      bad(`the link ${href}`, `A [link](${href}).`, /the link .*: /);
    bad("a reference-style link", "A [link][x].\n\n[x]: javascript:alert(1)", /the link "javascript:alert\(1\)"/);
    bad("an autolink", "<javascript:alert(1)>", /the link "javascript:alert\(1\)"/);
    bad("a link with no address", "A [link]().", /a link with no address/);
    bad("a bare http:// address", "See http://example.org.", /bare http:\/\/ or www\./);
    bad("a bare www. address", "See www.example.org.", /bare http:\/\/ or www\./);
    bad("a right-to-left override", "abc\u202edcb", /control or invisible characters/);
    bad("a zero-width space", "a\u200bb", /control or invisible characters/);
    bad("a control character", "a\u0007b", /control or invisible characters/);
    bad("a tag character", "a\u{E0041}b", /control or invisible characters/);
    bad("a page over its ceiling", "x".repeat(30_001), /at most 30000 characters a page/);

    const g = compileGuide({ markdown: "## One\n\nFirst page.\n\n### Part\n\nA part.\n\n```\n## not a page\n```\n\n## Two\n\nSecond.", groups: [{ title: "Start", pages: ["Two"] }] }, null, ["Getting started"]);
    assert.deepEqual(g.problems, []);
    assert.deepEqual(g.pages.map((p: { title: string; group: string; slug: string }) => [p.title, p.group, p.slug]), [["One", "Guide", "one"], ["Two", "Start", "two"]], "pages cut at ## (not inside a fence), each in its group or Guide");
    assert.match(g.pages[0]!.body, /^First page\.\n\n## Part\n\nA part\.\n\n```\n## not a page\n```$/, "### becomes ##; a fence's text stays");
    assert.deepEqual(g.groups, ["Guide", "Start"], "ungrouped pages first, then the declared groups in order");
    const refusedGuide = (what: string, json: unknown, re: RegExp, files: { name: string; text: string }[] | null = null) => {
      const r = compileGuide(json, files, ["Getting started", "MCP tools"]);
      assert.ok(r.problems.some((x: string) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(r.problems)})`);
    };
    refusedGuide("text before the first page", { markdown: "Intro.\n\n## One\n\nx" }, /text before the first ## heading/);
    refusedGuide("two pages at one address", { markdown: "## One\n\nx\n\n## one!\n\ny" }, /the same page address as "One" \(\/app\/docs\/one\)/);
    refusedGuide("a generated page's title", { markdown: "## Getting Started\n\nx" }, /"Getting started" is a page the console writes/);
    refusedGuide("a group naming a missing page", { markdown: "## One\n\nx", groups: [{ title: "G", pages: ["Two"] }] }, /page "Two" is not a page of the guide/);
    refusedGuide("a page in two groups", { markdown: "## One\n\nx", groups: [{ title: "G", pages: ["One"] }, { title: "H", pages: ["One"] }] }, /page "One" is in two groups/);
    refusedGuide("markdown and dir together", { markdown: "## One\n\nx", dir: "docs" }, /inline \(markdown\) or a directory/);
    refusedGuide("nothing and generated false", { generated: false }, /generated cannot be false/);
    refusedGuide("a markdown title", { markdown: "## One [x](/a)\n\nx" }, /its title: plain text/);
    refusedGuide("an unknown key", { markdown: "## One\n\nx", html: "<b>" }, /guide: .*html/i);
    refusedGuide("a dir path outside the pack", { dir: "../x" }, /guide\.dir: dir: a directory inside the pack/);
    refusedGuide("a page with raw HTML", { markdown: "## One\n\n<iframe src=x>" }, /guide page "One": line 1: raw HTML/);
    refusedGuide("a directory file with no title", { dir: "docs" }, /docs\/a\.md: its first line is the page's title/, [{ name: "a.md", text: "No title" }]);
    const d = compileGuide({ dir: "docs" }, [{ name: "2-b.md", text: "# Bee\r\n\r\nSecond.\r\n\r\n## Part\r\n\r\nx" }, { name: "1-a.md", text: "\ufeff# Ay\n\nFirst." }], []);
    assert.deepEqual(d.problems, []);
    assert.deepEqual(d.pages.map((p: { title: string; body: string }) => [p.title, p.body]), [["Ay", "First."], ["Bee", "Second.\n\n## Part\n\nx"]], "a directory: one page per file, in file-name order, line endings and a byte-order mark normalised");
    console.log("✓ pack.json guide: markdown only (no raw HTML, scripts, images or # titles), safe links only, pages and groups checked");
  }

  // ---------- 2. zero packs: the shell's guide, unchanged ----------
  {
    const committed = readFileSync(path.join(ROOT, "src", "docs-corpus.generated.json"), "utf8");
    const w = world({});
    assert.equal(w.gen.status, 0, w.out);
    const g = guideOf(w.dir);
    assert.equal(g.data, null, "zero packs: PACK_GUIDE is null");
    assert.deepEqual(g.pages.map((p) => p.title), ["Getting started", "MCP tools", "Your account"], "zero packs: the shell's three pages");
    assert.equal(readFileSync(path.join(w.dir, "src", "docs-corpus.generated.json"), "utf8"), committed, "zero packs: the docs corpus is the committed one, byte for byte");
    assert.equal(readFileSync(path.join(w.dir, "web/src/config/pack-guides.generated.ts"), "utf8"), readFileSync(path.join(ROOT, "web/src/config/pack-guides.generated.ts"), "utf8"));
    console.log("✓ zero packs: PACK_GUIDE null, the shell's guide and docs corpus byte for byte");
  }

  // ---------- 3. a declarative pack with no guide ----------
  {
    const j = tracker({ words: { run: "audit", workspace: "company" } });
    const scan = j.job_kinds[0];
    j.job_kinds.push({ ...structuredClone(scan), name: "tracker_deep", label: "Deep scan", description: "A deeper scan, not offered.", credentials: ["tracker_secret"] });
    j.credentials.push({ name: "tracker_secret", label: "Deep secret", bound_to: "workspace", deliver_as: { env: "DEEP_SECRET" } });
    j.onboarding[1].prompt = "Scan my first application";
    j.onboarding[0].help = "Add it on Applications.";
    j.mcp = { exclude: ["fixture_tracker_start_tracker_deep", "fixture_tracker_list_tracker_policies", "fixture_tracker_get_tracker_policies"] };
    const w = world({ fixture_tracker: { "pack.json": JSON.stringify(j) } });
    assert.equal(w.gen.status, 0, w.out);
    const g = guideOf(w.dir);
    assert.deepEqual(g.data.titles, { start: "Getting started", console: "Your console", records: "Records", runs: "Audits", tools: "MCP tools", account: "Your account" }, "the generated pages' titles in the pack's words");
    assert.deepEqual(g.groups.map(([x]) => x), ["Getting started", "Reference", "Account"]);
    assert.deepEqual(g.pages.map((p) => p.title), ["What Workspace does", "Getting started", "Records", "Audits", "MCP tools", "Your account"], "a real guide from the declarations (no tabs: no console page)");
    assert.match(page(g, "What Workspace does").body, /A declarative test fixture/, "what it does: the pack's description");
    const start = page(g, "Getting started").body;
    assert.match(start, /Test my connection/, "connecting a client: the shell's text");
    assert.match(start, /## Your first steps/);
    assert.match(start, /`fixture_tracker_get_started`/, "the generated get_started tool");
    assert.match(start, /1\. \*\*Add a first application\*\*\. Add it on Applications\. You can type: \*"Help me with the next step: Add a first application\."\*/, "a step's help and its default prompt");
    assert.match(start, /2\. \*\*Run a first scan\*\*\. You can type: \*"Scan my first application"\*/, "a step's own prompt");
    const rec = page(g, "Records").body;
    assert.match(rec, /## Applications/);
    assert.match(rec, /## Findings/);
    assert.doesNotMatch(rec, /## Policies/, "an area whose list tool is withheld is left out");
    assert.match(rec, /\| Severity \(required\) \| One of: low, medium, high, critical\. \|/, "an enum field's options, a required field");
    assert.match(rec, /A record of Applications/, "a reference field names its area");
    assert.match(rec, /starts at \*/, "the lifecycle");
    assert.match(rec, /`fixture_tracker_list_tracker_findings`/, "the area's tools");
    assert.match(rec, /Encrypted at rest/, "an asset area is sealed");
    const runs = page(g, "Audits").body;
    assert.match(runs, /## Scan an application/);
    assert.match(runs, /`fixture_tracker_start_tracker_scan`/);
    assert.match(runs, /It uses: \*\*Application token\*\*/, "the kind's credentials");
    assert.match(runs, /every day at 03:00 UTC/, "its schedule in words");
    assert.match(runs, /\*\*Application token\*\* \(one for each record of Applications\)/, "a credential and what it is bound to");
    assert.doesNotMatch(runs, /Deep scan|Deep secret|DEEP/, "a withheld kind and the credential only it uses are left out");
    const tools = page(g, "MCP tools").body;
    assert.ok(tools.indexOf("## Start here") >= 0 && tools.indexOf("## Start here") < tools.indexOf("## Applications"), "the tools grouped, get_started first");
    assert.match(tools, /## Any record area\n\n\| Tool \| What it does \|\n\|---\|---\|\n\| `list_records` \|/);
    assert.doesNotMatch(tools, /tracker_deep|list_tracker_policies/, "no withheld tool");
    for (const p of g.pages) assert.ok(g.corpus.some((c) => c.area === "customer" && c.href.startsWith(`/app/docs/${p.slug}`)), `the docs corpus cites ${p.title}`);
    assert.ok(g.corpus.some((c) => c.href === "/app/docs/records#findings" && /Severity/.test(c.text)), "a corpus chunk per area, at its anchor");
    console.log("✓ a declarative pack with no guide gets one from its declarations (start steps and get_started, records, runs, credentials, schedules, grouped tools), withheld tools left out, in the docs corpus");
  }

  // ---------- 4. a declarative pack with its own guide ----------
  {
    const inline = tracker({ guide: { markdown: "## What the tracker does\n\nIt tracks [findings](/app/records/tracker_findings).\n\n## Your first scan\n\n1. Add an app.\n2. Scan it.\n\n### Then\n\nRead the [steps](#then).\n\n## Field notes\n\nMore.",
      groups: [{ title: "Getting started", pages: ["What the tracker does", "Your first scan"] }, { title: "Concepts", pages: ["Field notes"] }] } });
    const w = world({ fixture_tracker: { "pack.json": JSON.stringify(inline) } });
    assert.equal(w.gen.status, 0, w.out);
    const g = guideOf(w.dir);
    assert.deepEqual(g.groups, [["Getting started", ["What the tracker does", "Your first scan", "Getting started"]], ["Concepts", ["Field notes"]], ["Reference", ["Records", "Runs", "MCP tools"]], ["Account", ["Your account"]]],
      "the pack's pages first, in its groups (Getting started shared with the generated page), then the generated ones");
    assert.equal(g.pages[0]!.slug, "what-the-tracker-does", "/app/docs opens the pack's first page");
    assert.match(page(g, "Your first scan").body, /## Then/, "### became ##");
    assert.ok(g.corpus.some((c) => c.href === "/app/docs/your-first-scan#then" && /Read the steps/.test(c.text)), "the corpus cites the pack's page at its anchor, links as text");

    const dirGuide = tracker({ guide: { dir: "guide", generated: false } });
    const w2 = world({ fixture_tracker: { "pack.json": JSON.stringify(dirGuide), "guide/02-second.md": "# Second page\n\nTwo.", "guide/01-first.md": "# First page\n\nOne.\n\n## A part\n\nx" } });
    assert.equal(w2.gen.status, 0, w2.out);
    const g2 = guideOf(w2.dir);
    assert.deepEqual(g2.pages.map((p) => p.title), ["First page", "Second page", "Getting started", "MCP tools", "Your account"], "a directory guide, in file-name order; generated false keeps connecting, the tools and the account");

    const refusedBuild = (what: string, files: Record<string, Record<string, string>>, re: RegExp, profile: Record<string, unknown> = {}, web: Record<string, string> = {}) => {
      const r = world(files, profile, web);
      assert.equal(r.gen.status, 1, `${what}: refused (${r.out})`);
      assert.match(r.out, re, `${what}: refused with ${re}`);
    };
    refusedBuild("an unsafe link", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## One\n\nA [x](javascript:alert(1))." } })) } },
      /packs\/fixture_tracker\/pack\.json: guide page "One": line 1: the link "javascript:alert\(1\)"/);
    refusedBuild("raw HTML in a directory page", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { dir: "guide" } })), "guide/a.md": "# A\n\n<script>x</script>" } }, /guide page "A": line 1: raw HTML/);
    refusedBuild("a generated page's title in the pack's words", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ words: { run: "scan" }, guide: { markdown: "## Scans\n\nx" } })) } },
      /"Scans" is a page the console writes/);
    refusedBuild("a file that is not a page in the guide's directory", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { dir: "guide" } })), "guide/a.md": "# A\n\nx", "guide/b.txt": "x" } },
      /guide\/b\.txt: a guide directory holds \.md pages only/);
    refusedBuild("a guide directory that is not there", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { dir: "nope" } })) } }, /guide\.dir nope is not a directory of the pack/);
    console.log("✓ a pack's own guide (inline, or a directory of pages) comes first in its groups, the generated pages after; a bad guide is refused with its pack and page");

    // ---------- 5. a host pack, untouched ----------
    const hostPack = (guide?: unknown) => ({ "pack.json": JSON.stringify({ id: "hosty", name: "Hosty", version: "1", host: { entry: "host.ts" }, ...(guide === undefined ? {} : { guide }) }),
      "host.ts": `import { defineHost } from "../../src/pack-host.js";\nexport default defineHost({ id: "hosty" });\n` });
    const hostWeb = { "web/src/packs/hosty/index.ts": "export default {};\n", "web/src/packs/hosty/guide.ts": "export const PAGE_GROUPS: [string, string[]][] = [['Host', ['Host page']]];\nexport const guidePages = () => [{ slug: 'host-page', title: 'Host page', group: 'Host', body: 'The host guide.' }];\n" };
    const h = world({ hosty: hostPack() }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(h.gen.status, 0, h.out);
    const hg = guideOf(h.dir);
    assert.equal(hg.data, null, "a host pack's guide: PACK_GUIDE null");
    assert.deepEqual(hg.pages.map((p) => p.title), ["Host page"], "the host pack's guide replaces the shell's, as before");
    const hd = world({ hosty: hostPack(), fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## Tracker\n\nx" } })) } }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(hd.gen.status, 0, hd.out);
    const hdg = guideOf(hd.dir);
    assert.equal(hdg.data, null, "a host pack's guide beside a declarative pack: the host's");
    assert.deepEqual(hdg.pages.map((p) => p.title), ["Host page"]);
    refusedBuild("pack.json guide in a host pack", { hosty: hostPack({ markdown: "## X\n\ny" }) }, /guide: a host pack's customer guide is its console code/, { host_packs: ["hosty"] }, hostWeb);
    console.log("✓ a host pack is untouched: its guide code replaces the shell's (PACK_GUIDE null, beside a declarative pack too), and it may not declare pack.json guide");
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
