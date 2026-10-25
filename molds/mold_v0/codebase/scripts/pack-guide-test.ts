// The customer guide from the packs (mold_v0-106; src/pack-guide.ts, scripts/gen-packs.mjs packGuideData,
// web/src/content/pack-guide.ts, web/src/content/customer-guide.ts, scripts/sync-docs-corpus.ts), offline: no database,
// no server, no browser. Each build is a throwaway copy of this codebase (its node_modules linked) with its own packs.
//   npm run test:pack-guide
//
// 1. pack.json `guide`, checked (src/pack-guide.ts): markdown only. Raw HTML, a script, an image, a # title inside a page,
//    control and invisible characters, a link that is not a path of this site, an #anchor, https:// or mailto: (javascript:,
//    data:, vbscript:, http:, //host, a user name in the address, bare http:// and www.), text before the first ## page,
//    two pages at one address, a page taking a generated page's title, groups naming a missing page or one page twice
//    are refused, each with where it is; code spans and fenced blocks are free text. guide.dir is gone (mold_v0-124):
//    refused, saying to write the pages inline.
// 2. Zero packs: gen-packs writes PACK_GUIDE null, and the guide and the docs corpus are the shell's, byte for byte.
// 3. A declarative pack with no guide gets a real one, written from its declarations in its words: what it does, its
//    onboarding steps with get_started and the prompts to type, its record areas (fields, lifecycle, due dates, tools),
//    its job kinds with their credentials and schedules, and the MCP tools grouped by what they reach. A kind whose start
//    tool the pack withholds is left out, with the credentials only it uses; an area whose list tool is withheld too.
//    The docs answers' corpus carries the same pages.
// 4. A declarative pack with an inline guide: its pages come first, in their groups, with the generated pages after
//    them (generated: false keeps only connecting, the tools and the account); the corpus cites them at
//    /app/docs/<slug>. gen-packs refuses a bad guide (an unsafe link, raw HTML, a generated page's title, guide.dir)
//    with the pack and the page, and any file beside a declarative pack's pack.json (mold_v0-124: a page file, code).
// 5. A host pack's guide is its pack.json guide (mold_v0-139): the whole guide (HOST_GUIDE; PACK_GUIDE null): its pages in
//    its groups, no generated page and no reserved title, its MCP tools page followed by the tools in its tool_groups
//    (each in the order listed, a missing one left out), "More tools" and the slash commands. Refused: guide.generated on a
//    host pack, its old web/src/packs/<id>/guide.ts and packs/<id>/docs/*.md, and a declarative pack's guide beside it.
//    tool_groups in a declarative pack groups those tools first on its generated MCP tools page.
// 6. Staff docs (mold_v0-139, src/staff-docs.ts): pack.json staff_docs join the shell's docs/ on /admin/docs
//    (web/scripts/sync-docs.mjs) and in the docs corpus, in one folder's order, each its `# title` then its markdown; a
//    relative link between docs and HTML (shown as text) pass, an unsafe link, an image or a # heading do not; a path the
//    shell's docs/ or another pack has, or a bad path, is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const { StaffDocSchema, staffDocProblems } = await import("../src/staff-docs.js");

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

    const g = compileGuide({ markdown: "## One\n\nFirst page.\n\n### Part\n\nA part.\n\n```\n## not a page\n```\n\n## Two\n\nSecond.", groups: [{ title: "Start", pages: ["Two"] }] }, ["Getting started"]);
    assert.deepEqual(g.problems, []);
    assert.deepEqual(g.pages.map((p: { title: string; group: string; slug: string }) => [p.title, p.group, p.slug]), [["One", "Guide", "one"], ["Two", "Start", "two"]], "pages cut at ## (not inside a fence), each in its group or Guide");
    assert.match(g.pages[0]!.body, /^First page\.\n\n## Part\n\nA part\.\n\n```\n## not a page\n```$/, "### becomes ##; a fence's text stays");
    assert.deepEqual(g.groups, ["Guide", "Start"], "ungrouped pages first, then the declared groups in order");
    const refusedGuide = (what: string, json: unknown, re: RegExp) => {
      const r = compileGuide(json, ["Getting started", "MCP tools"]);
      assert.ok(r.problems.some((x: string) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(r.problems)})`);
    };
    refusedGuide("text before the first page", { markdown: "Intro.\n\n## One\n\nx" }, /text before the first ## heading/);
    refusedGuide("two pages at one address", { markdown: "## One\n\nx\n\n## one!\n\ny" }, /the same page address as "One" \(\/app\/docs\/one\)/);
    refusedGuide("a generated page's title", { markdown: "## Getting Started\n\nx" }, /"Getting started" is a page the console writes/);
    refusedGuide("a group naming a missing page", { markdown: "## One\n\nx", groups: [{ title: "G", pages: ["Two"] }] }, /page "Two" is not a page of the guide/);
    refusedGuide("a page in two groups", { markdown: "## One\n\nx", groups: [{ title: "G", pages: ["One"] }, { title: "H", pages: ["One"] }] }, /page "One" is in two groups/);
    refusedGuide("guide.dir (mold_v0-124)", { dir: "docs" }, /guide\.dir: not taken any more: a pack is its pack\.json alone .*inline in guide\.markdown/);
    refusedGuide("guide.dir beside markdown", { markdown: "## One\n\nx", dir: "docs" }, /guide\.dir: not taken any more/);
    refusedGuide("nothing and generated false", { generated: false }, /generated cannot be false/);
    refusedGuide("a markdown title", { markdown: "## One [x](/a)\n\nx" }, /its title: plain text/);
    refusedGuide("an unknown key", { markdown: "## One\n\nx", html: "<b>" }, /guide: .*html/i);
    refusedGuide("a page with raw HTML", { markdown: "## One\n\n<iframe src=x>" }, /guide page "One": line 1: raw HTML/);
    const crlf = compileGuide({ markdown: "\r\n## Ay\r\n\r\nFirst.\r\n\r\n### Part\r\n\r\nx" }, []);
    assert.deepEqual(crlf.pages.map((p: { title: string; body: string }) => [p.title, p.body]), [["Ay", "First.\n\n## Part\n\nx"]], "line endings normalised");
    // tool_groups (mold_v0-139): kept in order; a tool in two groups, a group twice, "More tools" or a bad name refused.
    const tg = compileGuide({ markdown: "## One\n\nx", tool_groups: [{ title: "Start", tools: ["get_started", "b_tool"] }, { title: "Rest", tools: ["a_tool"] }] }, []);
    assert.deepEqual(tg.problems, []);
    assert.deepEqual(tg.tool_groups, [["Start", ["get_started", "b_tool"]], ["Rest", ["a_tool"]]], "tool groups as declared");
    refusedGuide("a tool in two groups", { markdown: "## One\n\nx", tool_groups: [{ title: "A", tools: ["t"] }, { title: "B", tools: ["t"] }] }, /tool t is in two groups \(A and B\)/);
    refusedGuide("a tool group twice", { markdown: "## One\n\nx", tool_groups: [{ title: "A", tools: ["t"] }, { title: "A", tools: ["u"] }] }, /a group is listed twice/);
    refusedGuide("a tool group named More tools", { markdown: "## One\n\nx", tool_groups: [{ title: "More tools", tools: ["t"] }] }, /"More tools" is where the tools no group names go/);
    refusedGuide("a prompts_intro on two lines", { markdown: "## One\n\nx", prompts_intro: "One\ntwo" }, /prompts_intro: one line/);
    refusedGuide("an unsafe link in prompts_intro", { markdown: "## One\n\nx", prompts_intro: "See [x](javascript:alert(1))." }, /guide\.prompts_intro: line 1: the link/);
    assert.equal(compileGuide({ markdown: "## One\n\nx", prompts_intro: "Ready-made chains:" }, []).prompts_intro, "Ready-made chains:");
    refusedGuide("a tool name that is not one", { markdown: "## One\n\nx", tool_groups: [{ title: "A", tools: ["Not A Tool"] }] }, /a tool's name/);
    console.log("✓ pack.json guide: markdown only (no raw HTML, scripts, images or # titles), safe links only, pages, groups and tool groups checked; guide.dir refused (inline only)");

    // Staff docs (mold_v0-139): the page rules, with HTML shown as text and relative links between docs allowed.
    const doc = (path: string, markdown: string, title = "A doc") => ({ path, title, markdown });
    assert.deepEqual(staffDocProblems([doc("guide.md", "Type **\"Onboard <name>, <website>\"**. See [journeys](journeys.md), [the study](../case-studies/resend.md#results), [home](/app) and [x](https://example.org).\n")]), [],
      "HTML-looking placeholders and links between docs pass");
    for (const [what, md, re] of [["an unsafe link", "A [x](javascript:alert(1)).", /the link "javascript:alert\(1\)"/], ["an image", "![x](https://example.org/x.png)", /an image/],
      ["a # heading", "Intro\n\n# Another", /a # heading inside a page/], ["an http link", "[x](http://example.org)", /the link "http:\/\/example\.org"/]] as const)
      assert.ok(staffDocProblems([doc("a.md", md)]).some((x: string) => re.test(x) && x.startsWith("staff_docs[a.md]")), `a staff doc with ${what}: refused`);
    assert.ok(staffDocProblems([doc("a.md", "x"), doc("a.md", "y")]).some((x: string) => /two docs at one path/.test(x)), "two docs at one path");
    for (const bad of ["../x.md", "/abs.md", "x.txt", "A/B.md", "a/.hidden.md", "a/b/c/d/e.md"]) assert.equal(StaffDocSchema.safeParse(doc(bad, "x")).success, false, `the path ${bad}: refused`);
    assert.equal(StaffDocSchema.safeParse(doc("case-studies/resend.md", "x")).success, true);
    assert.equal(StaffDocSchema.safeParse({ ...doc("a.md", "x"), dir: "docs" }).success, false, "inline only: no other key");
    console.log("✓ staff docs: markdown with HTML as text and links between docs; unsafe links, images, # headings, bad or repeated paths refused");
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

    const onlyOwn = tracker({ guide: { markdown: "## First page\n\nOne.\n\n### A part\n\nx\n\n## Second page\n\nTwo.", generated: false } });
    const w2 = world({ fixture_tracker: { "pack.json": JSON.stringify(onlyOwn) } });
    assert.equal(w2.gen.status, 0, w2.out);
    const g2 = guideOf(w2.dir);
    assert.deepEqual(g2.pages.map((p) => p.title), ["First page", "Second page", "Getting started", "MCP tools", "Your account"], "generated false keeps connecting, the tools and the account");

    const refusedBuild = (what: string, files: Record<string, Record<string, string>>, re: RegExp, profile: Record<string, unknown> = {}, web: Record<string, string> = {}) => {
      const r = world(files, profile, web);
      assert.equal(r.gen.status, 1, `${what}: refused (${r.out})`);
      assert.match(r.out, re, `${what}: refused with ${re}`);
    };
    refusedBuild("an unsafe link", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## One\n\nA [x](javascript:alert(1))." } })) } },
      /packs\/fixture_tracker\/pack\.json: guide page "One": line 1: the link "javascript:alert\(1\)"/);
    refusedBuild("raw HTML in a page", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## A\n\n<script>x</script>" } })) } }, /guide page "A": line 1: raw HTML/);
    refusedBuild("a generated page's title in the pack's words", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ words: { run: "scan" }, guide: { markdown: "## Scans\n\nx" } })) } },
      /"Scans" is a page the console writes/);
    // mold_v0-124: guide.dir is gone, and a declarative pack holds nothing but its pack.json.
    refusedBuild("guide.dir", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { dir: "guide" } })) } },
      /packs\/fixture_tracker\/pack\.json: guide\.dir: not taken any more: a pack is its pack\.json alone/);
    refusedBuild("a page file beside a declarative pack's pack.json", { fixture_tracker: { "pack.json": JSON.stringify(inline), "guide/a.md": "# A\n\nx" } },
      /packs\/fixture_tracker\/pack\.json: guide\/a\.md: a declarative pack \(no entry, migrations or runner\) is its pack\.json alone, so this file is never read; the customer guide's pages are pack\.json guide\.markdown/);
    refusedBuild("code beside a declarative pack's pack.json", { fixture_tracker: { "pack.json": JSON.stringify({ ...inline, entry: undefined }), "lib/rows.ts": "export const x = 1;\n" } },
      /lib\/rows\.ts: a declarative pack \(no entry, migrations or runner\) is its pack\.json alone, so this file is never read; code: rows from the workspace's files or an upstream are repositories\.<name>\.map/);
    refusedBuild("any other file beside a declarative pack's pack.json", { fixture_tracker: { "pack.json": JSON.stringify(inline), "notes.txt": "x" } },
      /notes\.txt: a declarative pack .* everything a declarative pack says is in its pack\.json/);
    console.log("✓ a pack's own guide comes first in its groups, the generated pages after; a bad guide (guide.dir included) is refused with its pack and page, and so is any file beside a declarative pack's pack.json");

    // ---------- 5. a host pack's guide is its pack.json guide (mold_v0-139): the whole guide ----------
    const hostPack = (extra: Record<string, unknown> = {}, files: Record<string, string> = {}) => ({ "pack.json": JSON.stringify({ id: "hosty", name: "Hosty", version: "1", host: { entry: "host.ts" }, ...extra }),
      "host.ts": `import { defineHost } from "../../src/pack-host.js";\nexport default defineHost({ id: "hosty" });\n`, ...files });
    const hostWeb = { "web/src/packs/hosty/index.ts": "export default {};\n" };
    // The tools a host guide groups: the declarative tracker's, beside it (a host pack's own tools are its code's).
    const first = world({ hosty: hostPack(), fixture_tracker: { "pack.json": JSON.stringify(tracker()) } }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(first.gen.status, 0, first.out);
    guideOf(first.dir);
    const catalog = JSON.parse(readFileSync(path.join(first.dir, "web/src/content/mcp-tools.generated.json"), "utf8")) as { tools: { name: string }[]; prompts: { name: string }[] };
    const names = catalog.tools.map((t) => t.name);
    assert.ok(names.length >= 3, `the tracker brings tools (${names.join(", ")})`);
    const hostGuide = { markdown: "## What Hosty does\n\nIt hosts.\n\n## MCP tools\n\nYour client calls these.\n\n## Billing\n\nPay.\n\n### Plans\n\nSome.",
      groups: [{ title: "Getting started", pages: ["What Hosty does"] }, { title: "Reference", pages: ["MCP tools"] }, { title: "Account", pages: ["Billing"] }],
      tool_groups: [{ title: "First of all", tools: [names[1]!, "not_in_this_build", names[0]!] }], prompts_intro: "Hosty's own chains:" };
    const h = world({ hosty: hostPack({ guide: hostGuide }), fixture_tracker: { "pack.json": JSON.stringify(tracker()) } }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(h.gen.status, 0, h.out);
    const hg = guideOf(h.dir);
    assert.equal(hg.data, null, "a host pack's guide: PACK_GUIDE null");
    assert.deepEqual(hg.groups, [["Getting started", ["What Hosty does"]], ["Reference", ["MCP tools"]], ["Account", ["Billing"]]], "the host's pages in its groups, nothing generated (no reserved title either)");
    assert.equal(page(hg, "Billing").body, "Pay.\n\n## Plans\n\nSome.");
    const tools = page(hg, "MCP tools").body;
    const rest = names.slice(2);
    assert.ok(tools.startsWith(`Your client calls these.\n\n## First of all\n\n| Tool | What it does |\n|---|---|\n| \`${names[1]}\` | `), `its own text, then its first tool group in the order listed (${tools.slice(0, 300)})`);
    assert.ok(tools.indexOf(`\`${names[0]}\``) > tools.indexOf(`\`${names[1]}\``) && !tools.includes("not_in_this_build"), "listed order; a tool the build lacks is left out");
    assert.ok(tools.includes("## More tools") && rest.every((n) => tools.indexOf(`\`${n}\``) > tools.indexOf("## More tools")), "the rest under More tools");
    assert.equal(/## Slash commands\n\nHosty's own chains:\n\n- /.test(tools), catalog.prompts.length > 0, "the slash commands when there are any, after the guide's own line");
    assert.ok(hg.corpus.some((c) => c.href === "/app/docs/billing#plans" && /Some\./.test(c.text)), "the corpus cites the host guide's pages");
    assert.match(readFileSync(path.join(h.dir, "web/src/config/pack-guides.generated.ts"), "utf8"), /export const HOST_GUIDE: unknown = \{\n {2}"pack": "hosty"/, "HOST_GUIDE carries the host's guide");
    // No MCP tools page of its own: the console adds one in Reference.
    const hn = world({ hosty: hostPack({ guide: { markdown: "## Only page\n\nx" } }) }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(hn.gen.status, 0, hn.out);
    assert.deepEqual(guideOf(hn.dir).groups, [["Guide", ["Only page"]], ["Reference", ["MCP tools"]]], "an MCP tools page in Reference when the host wrote none");
    // A host pack with no guide: the packs' guide beside it, as before.
    const hp = world({ hosty: hostPack(), fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## Tracker\n\nx" } })) } }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(hp.gen.status, 0, hp.out);
    assert.ok(guideOf(hp.dir).pages.some((p) => p.title === "Tracker"), "no host guide: the packs' guide");
    refusedBuild("guide.generated in a host pack", { hosty: hostPack({ guide: { markdown: "## X\n\ny", generated: true } }) }, /guide\.generated: a host pack's guide is the whole guide/, { host_packs: ["hosty"] }, hostWeb);
    refusedBuild("a host pack's guide.ts", { hosty: hostPack() }, /web\/src\/packs\/hosty\/guide\.ts: the customer guide is pack\.json guide \(mold_v0-139\)/, { host_packs: ["hosty"] },
      { ...hostWeb, "web/src/packs/hosty/guide.ts": "export const PAGE_GROUPS = [];\n" });
    refusedBuild("a host pack's docs/*.md", { hosty: hostPack({}, { "docs/notes.md": "# Notes\n\nx" }) }, /packs\/hosty\/pack\.json: docs\/notes\.md: staff docs are pack\.json staff_docs/, { host_packs: ["hosty"] }, hostWeb);
    refusedBuild("a declarative pack's guide beside a host guide", { hosty: hostPack({ guide: { markdown: "## X\n\ny" } }), fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { markdown: "## Tracker\n\nx" } })) } },
      /packs\/fixture_tracker\/pack\.json: guide: host pack hosty's guide is the whole customer guide/, { host_packs: ["hosty"] }, hostWeb);
    console.log("✓ a host pack's guide is pack.json guide: the whole guide (its pages in its groups, its MCP tools page grouped by tool_groups, More tools, slash commands), in the corpus; guide.generated, guide.ts, docs/*.md and a second guide refused");

    // tool_groups in a declarative pack: its groups first on the generated MCP tools page (after Start here).
    const dt = world({ fixture_tracker: { "pack.json": JSON.stringify(tracker({ guide: { tool_groups: [{ title: "Mine", tools: [names.at(-1)!] }] } })) } });
    assert.equal(dt.gen.status, 0, dt.out);
    const dtg = guideOf(dt.dir);
    const heads = [...page(dtg, "MCP tools").body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.equal(heads.filter((x) => x !== "Start here")[0], "Mine", `the pack's own tool group first (${heads.join(", ")})`);
    assert.match(page(dtg, "MCP tools").body, new RegExp(`## Mine\\n\\n\\| Tool \\| What it does \\|\\n\\|---\\|---\\|\\n\\| \`${names.at(-1)}\` \\|`));
    console.log("✓ a declarative pack's tool_groups lead its generated MCP tools page");

    // ---------- 6. staff docs (mold_v0-139) ----------
    const staffHost = [{ path: "onboarding.md", title: "Onboarding", markdown: "How to <name> it. See [the study](case-studies/one.md#why).\n\n## Steps\n\nOne.\n" },
      { path: "case-studies/one.md", title: "Case study: one", markdown: "Why.\n\n## Why\n\nBecause; back to [onboarding](../onboarding.md).\n" }];
    const sd = world({ hosty: hostPack({ staff_docs: staffHost }), fixture_tracker: { "pack.json": JSON.stringify(tracker({ staff_docs: [{ path: "tracker.md", title: "Tracker notes", markdown: "Notes.\n" }] })) } }, { host_packs: ["hosty"] }, hostWeb);
    assert.equal(sd.gen.status, 0, sd.out);
    const sync = spawnSync(process.execPath, [path.join(sd.dir, "web", "scripts", "sync-docs.mjs")], { cwd: path.join(sd.dir, "web"), encoding: "utf8" });
    assert.equal(sync.status, 0, sync.stderr);
    const admin = JSON.parse(/export const ADMIN_DOCS: AdminDoc\[\] = ([\s\S]*);\n$/.exec(readFileSync(path.join(sd.dir, "web/src/content/admin-docs.generated.ts"), "utf8"))![1]!) as { slug: string; path: string; group: string; title: string; body: string }[];
    const shell = readdirSync(path.join(sd.dir, "docs")).filter((f) => f.endsWith(".md"));
    assert.deepEqual(admin.map((d) => d.path), [...shell, "onboarding.md", "tracker.md", "case-studies/one.md"].sort((a, b) => { const x = a.split("/"), y = b.split("/"); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1; return x.length - y.length; }),
      "the shell's docs and every pack's staff docs, as one folder");
    const one = admin.find((d) => d.path === "case-studies/one.md")!;
    assert.deepEqual([one.slug, one.group, one.title, one.body], ["case-studies-one", "case-studies", "Case study: one", `# Case study: one\n\n${staffHost[1]!.markdown}`], "a doc as a file at its path would be");
    const sdc = guideOf(sd.dir).corpus;
    assert.ok(sdc.some((c) => c.area === "admin" && c.href === "/admin/docs/onboarding#steps" && c.title === "Onboarding"), "the corpus cites a staff doc's section");
    assert.ok(sdc.some((c) => c.area === "admin" && c.href === "/admin/docs/tracker"), "a declarative pack's staff docs too");
    refusedBuild("a staff doc at a shell doc's path", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ staff_docs: [{ path: shell[0]!, title: "X", markdown: "x" }] })) } },
      new RegExp(`staff_docs\\[${shell[0]!.replace(".", "\\.")}\\]: the shell's docs/ has a doc at that path`));
    refusedBuild("two packs' staff docs at one path", { hosty: hostPack({ staff_docs: [{ path: "x.md", title: "X", markdown: "x" }] }), fixture_tracker: { "pack.json": JSON.stringify(tracker({ staff_docs: [{ path: "x.md", title: "Y", markdown: "y" }] })) } },
      /staff_docs\[x\.md\]: pack (hosty|fixture_tracker) has a doc at that path/, { host_packs: ["hosty"] }, hostWeb);
    refusedBuild("an unsafe link in a staff doc", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ staff_docs: [{ path: "x.md", title: "X", markdown: "[a](javascript:alert(1))" }] })) } },
      /packs\/fixture_tracker\/pack\.json: staff_docs\[x\.md\]: line 1: the link "javascript:alert\(1\)"/);
    refusedBuild("a bad staff doc path", { fixture_tracker: { "pack.json": JSON.stringify(tracker({ staff_docs: [{ path: "../x.md", title: "X", markdown: "x" }] })) } }, /staff_docs/);
    console.log("✓ staff docs: every pack's pack.json staff_docs on /admin/docs and in the corpus, beside the shell's docs as one folder; a taken path, an unsafe link or a bad path refused");
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
