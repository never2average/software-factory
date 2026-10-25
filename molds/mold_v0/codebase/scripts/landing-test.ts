// The landing block (mold_v0-091, pick and place since mold_v0-122; src/landing.ts, scripts/gen-packs.mjs,
// web/src/features/site/landing.tsx), offline: no database, no server, no browser.
//   npm run test:landing
//
// 1. The schema: a block of sections passes, and so does an old-style block; every text is plain text on one line
//    (line breaks, control, bidirectional, zero-width and tag characters refused), every list and text has a ceiling,
//    unknown keys and section types are refused, and a link is a path of this site, an https:// address or a mailto:
//    address (javascript:, data:, vbscript:, http:, //host, a backslash, a user name or a password refused; the
//    console's own second check agrees). Pick and place: at most 10 sections, each type once but a cta up to 3 times,
//    the hero first, each anchor its own and none the page's own; old-style keys beside sections refused.
// 2. The old block converted, section for section (coverage the hero's strip, value points the concept's cards,
//    features proof's items, closing a cta), and merging: a profile's sections replace a pack's, its footer and seo one
//    by one; an old profile block replaces a pack's sections of the same kind; two old blocks merge as before.
// 3. gen-packs: with no block, no upstream and no source_offer it writes `landing = null`, the offered clients and no
//    offer; a pack's block is written as sections (an old one converted); the app's profile block comes over it; a
//    where_you_work client the install pages do not offer is refused, and install_clients narrows the logos; the welcome
//    email's pitch is the hero section's subheadline; two packs that both declare one, a bad profile block and a bad
//    pack block are refused with the path of the problem; the profile's block never reaches the profile modules.
// 4. The page, rendered on the server (react-dom/server, the console's own components bundled with esbuild): the neutral
//    page is the whole wireframe in order, in the build's words, with the header's navigation from its sections; a
//    pack's page shows only what it picked, in its order; an old block renders converted; text that looks like HTML or
//    script is text, a link that got past gen-packs is never a link; the footer carries the source offer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Meta = { title: { absolute: string }; description: string;
  openGraph: { title: string; description: string; siteName: string; images?: { url: string; width: number; height: number; alt: string }[] };
  twitter?: { card: string; images?: { url: string }[] } };
const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "landing-test-"));
const gen = (args: string[], cwd = ROOT) => spawnSync(process.execPath, [path.join(cwd, "scripts", "gen-packs.mjs"), ...args], { cwd, encoding: "utf8" });
const generated = (out: string) => readFileSync(path.join(out, "web", "src", "config", "landing.generated.ts"), "utf8");
const landingOf = (out: string) => JSON.parse(/export const landing: LandingBlock \| null = ([\s\S]*?);\n/.exec(generated(out))![1]!);
const clientsOf = (out: string) => JSON.parse(/export const landingClients: readonly LandingClient\[\] = ([\s\S]*?);\n/.exec(generated(out))![1]!) as { id: string; name: string; group: string }[];
const offerOf = (out: string) => JSON.parse(/export const sourceOfferItems: readonly OfferFooterItem\[\] = ([\s\S]*?);\n/.exec(generated(out))![1]!);
const pitchOf = (out: string) => JSON.parse(/export const GENERATED_EMAIL_PITCH: string \| null = (.*);\n/.exec(readFileSync(path.join(out, "src", "email-pitch.generated.ts"), "utf8"))![1]!);

/** A block of every section type, in a picked order that is not the wireframe's. */
const GOOD = {
  $comment: "a fixture",
  sections: [
    { type: "hero", eyebrow: "For teams", headline: "Ship audits", subheadline: "A sub-headline.", primary_cta: { label: "Start", href: "/auth/sign-up" }, secondary_cta: { label: "Install", href: "/install" }, note: "A note.", links: [{ label: "Open source on GitHub", href: "https://github.com/example-org/app" }], headline_highlight: "every day.", visual: { type: "decision_graph", label: "One ask, two answers.", root: "> ask", branches: [{ logo: "cursor", label: "cursor", outcome: "yes", tone: "good" }, { label: "other", outcome: "no", tone: "bad" }] }, strip: { title: "Covered", items: ["SEBI CSCRF 2024", "DPDP Rules 2025"], note: "Two catalogs." } },
    { type: "how_it_works", eyebrow: "Steps", title: "Four steps", visual: { type: "paths", count_label: "{n} steps to done", done_label: "Done at once", measure_label: "You track", items: [{ icon: "search", title: "Old", value: "slow", path: ["a", "b", "goal"], measure: "clicks" }, { icon: "bolt", title: "New", value: "fast", path: ["goal"], highlight: true, measure: "results" }] }, steps: [{ title: "Sign up", body: "Make an account." }, { title: "Connect", body: "Add a client." }], layout: "loop", loop_label: "Again" },
    { type: "problem", title: "The problem", lead: "Why.", points: [{ title: "One", body: "First.", icon: "eye-off" }, { title: "Two", body: "Second." }], visual: { type: "transcript", title: "a chat", lines: [{ text: "> ask", tone: "prompt" }, { text: "answer" }], highlight: "# so?", aside: { title: "Weighed", items: [{ label: "A", note: "picked", tone: "pick" }, { label: "B", tone: "alert" }] } } },
    { type: "concept", id: "idea", nav_label: "The idea", title: "The idea", visual: { type: "loop", label: "Try, check, fix.", steps: [{ label: "Try", sub: "a first go" }, { label: "Check", sub: "did it work" }], question: "Worked?", yes: { label: "Keep it", sub: "watch it" }, no: { label: "Fix", sub: "and try again" }, again: "again" }, items: [{ title: "Old way", chips: ["a", "b"] }, { title: "New way", chips: ["a"], highlight: true }], note: "A note." },
    { type: "proof", title: "Numbers", visual: { type: "scorecard", bars: { title: "By row", rows: [{ logo: "cursor", label: "cursor", value: 62 }] }, donut: { title: "Share", slices: [{ label: "A", value: 58 }, { label: "B", value: 30, tone: "alert" }, { label: "C", value: 12, tone: "muted" }] }, trend: { title: "After", delta: "+22 pts", points: [22, 25, 41, 48], marker_after: 1, marker_label: "fix" }, chips: [{ label: "Kept", tone: "primary" }], note: "Sample data." }, metrics: [{ value: "826", label: "controls", note: "in 7 catalogs" }], items: [{ title: "A", body: "a" }] },
    { type: "where_you_work", title: "Where", clients: ["claude", "cursor"], visual: { type: "chat", messages: [{ from: "person", text: "Hi?" }, { from: "tool", text: "x \u00b7 y" }, { from: "bars", rows: [{ label: "low", value: 22 }, { label: "high", value: 71 }] }, { from: "assistant", text: "Hello." }], note: "Illustrative" } },
    { type: "faq", items: [{ question: "Is it good?", answer: "Yes." }] },
    { type: "cta", title: "Go", body: "Now.", primary_cta: { label: "Start", href: "https://example.org/start?x=1#y" }, secondary_cta: { label: "Mail us", href: "mailto:team@example.org" } },
    { type: "cta", title: "Still here?" },
  ],
  footer: { note: "Footer note.", links: [{ label: "Docs", href: "https://example.org/docs" }] },
  seo: { title: "Ship audits", description: "Search description." },
};
/** The old block (mold_v0-091), every section. */
const LEGACY = {
  $comment: "the old shape",
  hero: { eyebrow: "For teams", headline: "Ship audits", subheadline: "A sub-headline.", primary_cta: { label: "Start", href: "/auth/sign-up" }, secondary_cta: { label: "Install", href: "/install" }, note: "A note." },
  coverage: { title: "Covered", items: ["SEBI CSCRF 2024", "DPDP Rules 2025"], note: "Two catalogs." },
  value_points: { title: "Why", items: [{ title: "One", body: "First." }, { title: "Two", body: "Second." }] },
  how_it_works: { steps: [{ title: "Sign up", body: "Make an account." }, { title: "Connect", body: "Add a client." }] },
  features: { title: "Features", intro: "All of it.", items: [{ title: "A", body: "a" }] },
  faq: { items: [{ question: "Is it good?", answer: "Yes." }] },
  closing: { title: "Go", body: "Now.", primary_cta: { label: "Start", href: "https://example.org/start?x=1#y" }, secondary_cta: { label: "Mail us", href: "mailto:team@example.org" } },
  footer: { note: "Footer note.", links: [{ label: "Docs", href: "https://example.org/docs" }] },
  seo: { title: "Ship audits", description: "Search description." },
};
/** LEGACY as sections (what gen-packs writes for it). */
const LEGACY_AS_SECTIONS = {
  sections: [
    { type: "hero", ...LEGACY.hero, strip: LEGACY.coverage },
    { type: "concept", title: "Why", items: LEGACY.value_points.items },
    { type: "how_it_works", ...LEGACY.how_it_works },
    { type: "proof", title: "Features", lead: "All of it.", items: LEGACY.features.items },
    { type: "faq", ...LEGACY.faq },
    { type: "cta", ...LEGACY.closing },
  ],
  footer: LEGACY.footer,
  seo: LEGACY.seo,
};

try {
  const L = await import("../src/landing.js");
  const { landingProblems, hrefProblem, mergeLanding, toSections, SECTION_TYPES, DEFAULT_IDS, sectionIds } = L;
  const web = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "site", "landing-types.ts")).href);
  const { compileDeclarations, PackJsonError } = await import("../src/pack-manifest.js");
  const sec = (s: object) => ({ sections: [s] });

  // ---------- 1. the schema ----------
  {
    assert.deepEqual(landingProblems(GOOD), [], "a block of every section type passes");
    assert.deepEqual(landingProblems(LEGACY), [], "an old-style block passes");
    assert.deepEqual(landingProblems({}), [], "an empty block passes (the whole wireframe, neutral)");
    assert.deepEqual(landingProblems({ seo: { title: "Only search" } }), [], "a block with no sections passes");
    for (const t of SECTION_TYPES) assert.deepEqual(landingProblems(sec(t === "how_it_works" ? { type: t, steps: [{ title: "a", body: "b" }] } : t === "faq" ? { type: t, items: [{ question: "q", answer: "a" }] } : t === "proof" ? { type: t, items: [{ title: "a", body: "b" }] } : { type: t })), [], `${t} alone, with its neutral defaults, passes`);
    const bad = (what: string, block: unknown, re: RegExp) => {
      const p = landingProblems(block);
      assert.ok(p.some((x) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(p)})`);
    };
    const withHref = (href: string) => sec({ type: "hero", primary_cta: { label: "Go", href } });
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)", "http://example.org", "//evil.example", "/\\evil.example", "https://user:pw@example.org/", "https://", "ftp://example.org",
      "/a b", "/a\"onmouseover=\"x", "/..//evil.example", "/x/../y", "/./x", "/%2F%2Fevil.example", "/%5cevil", "/caf\u00e9", "/a\u200bb", "mailto:", "https://example.org/\u202e", "#top", "install"])
      bad(`the address ${JSON.stringify(href)}`, withHref(href), /landing\.sections\[0\]\.primary_cta\.href: /);
    bad("a script address in a hero link", sec({ type: "hero", links: [{ label: "Code", href: "javascript:alert(1)" }] }), /landing\.sections\[0\]\.links\[0\]\.href: /);
    bad("four hero links", sec({ type: "hero", links: Array.from({ length: 4 }, () => ({ label: "x", href: "/x" })) }), /landing\.sections\[0\]\.links: /);
    bad("a script address in an old block", { closing: { title: "Go", primary_cta: { label: "x", href: "javascript:alert(1)" } } }, /landing\.closing\.primary_cta\.href: /);
    for (const href of ["/", "/install", "/auth/sign-up?from=landing#top", "https://example.org", "https://example.org/a?b=c#d", "mailto:team@example.org", "mailto:team@example.org?subject=Hi"])
      assert.equal(hrefProblem(href), null, `the address ${href} passes`);
    // The console's second check agrees with the build's on every address above, and refuses what the build would.
    for (const href of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "data:text/html,x", "http://example.org", "https://user:pw@example.org/", "/a b", "/a\u0001b", "mailto:x", "/..//evil.example", "/%2f%2fevil", "/a\u200bb", "https://a.example/\uff0f"])
      assert.equal(web.linkable(href), false, `the page never links ${JSON.stringify(href)}`);
    for (const href of ["/", "/install", "https://example.org/a?b=c#d", "mailto:team@example.org"]) assert.equal(web.linkable(href), true, `the page links ${href}`);
    bad("a line break", sec({ type: "hero", headline: "One\nTwo" }), /landing\.sections\[0\]\.headline: plain text on one line/);
    bad("a right-to-left override", sec({ type: "problem", title: "abc\u202edcb" }), /plain text on one line/);
    bad("a zero-width space", sec({ type: "faq", items: [{ question: "a\u200bb", answer: "x" }] }), /landing\.sections\[0\]\.items\[0\]\.question: plain text/);
    bad("a tag character", sec({ type: "hero", strip: { items: ["SEBI\u{E0041}"] } }), /landing\.sections\[0\]\.strip\.items\[0\]: plain text/);
    bad("a line break in a transcript line", sec({ type: "problem", visual: { type: "transcript", title: "t", lines: [{ text: "a\nb" }] } }), /landing\.sections\[0\]\.visual\.lines\[0\]\.text: plain text/);
    bad("an unknown visual", sec({ type: "problem", visual: { type: "hologram" } }), /landing\.sections\[0\]\.visual\.type: /);
    bad("a scorecard with nothing to show", sec({ type: "proof", visual: { type: "scorecard", chips: [{ label: "x" }] } }), /a scorecard shows bars, a donut, a trend or more/);
    bad("a bar over 100", sec({ type: "proof", visual: { type: "scorecard", bars: { title: "t", rows: [{ label: "a", value: 101 }] } } }), /visual\.bars\.rows\[0\]\.value: /);
    bad("a decision graph with one branch", sec({ type: "hero", visual: { type: "decision_graph", label: "l", root: "r", branches: [{ label: "a", outcome: "b" }] } }), /visual\.branches: /);
    bad("an icon the shell does not draw", sec({ type: "problem", points: [{ title: "t", body: "b", icon: "skull" }] }), /points\[0\]\.icon: /);
    bad("a count label without {n}", sec({ type: "how_it_works", visual: { type: "paths", count_label: "steps", items: [{ title: "a", value: "b", path: ["x"] }] } }), /count_label: says \{n\}/);
    bad("a strip with badges and logos", sec({ type: "hero", strip: { items: ["a"], logos: [{ logo: "cursor", label: "Cursor" }] } }), /a strip shows text badges \(items\) or logos, not both/);
    bad("an unknown header account", { header: { account: "magic" } }, /landing\.header\.account: /);
    bad("an empty text", sec({ type: "hero", headline: "   " }), /text is required/);
    bad("a long headline", sec({ type: "hero", headline: "x".repeat(121) }), /at most 120 characters/);
    bad("a long badge", sec({ type: "hero", strip: { items: ["x".repeat(41)] } }), /at most 40 characters/);
    bad("a long metric", sec({ type: "proof", metrics: [{ value: "x".repeat(17), label: "y" }] }), /metrics\[0\]\.value: at most 16 characters/);
    bad("too many problem points", sec({ type: "problem", points: Array.from({ length: 5 }, () => ({ title: "t", body: "b" })) }), /landing\.sections\[0\]\.points: /);
    bad("too many FAQ items", sec({ type: "faq", items: Array.from({ length: 16 }, () => ({ question: "q", answer: "a" })) }), /landing\.sections\[0\]\.items: /);
    bad("too many steps", sec({ type: "how_it_works", steps: Array.from({ length: 7 }, () => ({ title: "t", body: "b" })) }), /landing\.sections\[0\]\.steps: /);
    bad("no badges", sec({ type: "hero", strip: { items: [] } }), /landing\.sections\[0\]\.strip\.items: /);
    bad("proof with nothing to show", sec({ type: "proof", title: "x" }), /proof shows metrics, items, a visual or more/);
    bad("an unknown layout", sec({ type: "how_it_works", steps: [{ title: "t", body: "b" }], layout: "spiral" }), /\.layout: /);
    bad("an unknown tone", sec({ type: "problem", visual: { type: "transcript", title: "t", lines: [{ text: "x" }], aside: { items: [{ label: "a", tone: "neon" }] } } }), /visual\.aside\.items\[0\]\.tone: /);
    bad("a client id that is not one", sec({ type: "where_you_work", clients: ["Claude Desktop"] }), /clients\[0\]: a client id/);
    bad("a client twice", sec({ type: "where_you_work", clients: ["claude", "claude"] }), /clients: each client once/);
    bad("an unknown section type", sec({ type: "testimonials", quotes: ["best ever"] }), /landing\.sections\[0\]\.type: one of hero, problem, concept/);
    bad("a section with no type", { sections: [{ title: "x" }] }, /landing\.sections\[0\]\.type: one of/);
    bad("an unknown field", sec({ type: "hero", headline: "x", html: "<b>x</b>" }), /landing\.sections\[0\]: .*html/i);
    bad("a nav label on the hero", sec({ type: "hero", nav_label: "Top" }), /landing\.sections\[0\]: .*nav_label/i);
    bad("an unknown top-level key", { testimonials: [{ quote: "best ever" }] }, /landing: .*testimonials/i);
    bad("HTML in a link's label is text, but a label must still be one line", sec({ type: "cta", primary_cta: { label: "a\nb", href: "/" } }), /primary_cta\.label: plain text/);
    assert.deepEqual(landingProblems(sec({ type: "hero", headline: "<script>alert(1)</script> & \"quotes\"" })), [], "text that looks like HTML is allowed: it is shown as text");
    // Pick and place.
    const faq = { type: "faq", items: [{ question: "q", answer: "a" }] };
    bad("no sections", { sections: [] }, /landing\.sections: at least one section/);
    bad("eleven sections", { sections: [{ type: "hero" }, { type: "problem" }, { type: "concept" }, faq, { type: "cta" }, { type: "cta" }, { type: "cta" }, { type: "where_you_work" }, { type: "proof", items: [{ title: "a", body: "b" }] }, { type: "how_it_works", steps: [{ title: "a", body: "b" }] }, { type: "cta" }] }, /landing\.sections: at most 10 sections/);
    bad("a type twice", { sections: [faq, { type: "problem" }, faq] }, /landing\.sections\[2\]: a page shows faq once/);
    bad("four calls to action", { sections: [{ type: "cta" }, { type: "cta" }, { type: "cta" }, { type: "cta" }] }, /landing\.sections\[3\]: at most 3 cta sections/);
    assert.deepEqual(landingProblems({ sections: [{ type: "cta" }, faq, { type: "cta" }, { type: "cta" }] }), [], "three calls to action pass");
    bad("the hero second", { sections: [faq, { type: "hero" }] }, /landing\.sections\[1\]: the hero is the first section/);
    bad("two sections with one anchor", { sections: [{ type: "problem", id: "faq" }, faq] }, /landing\.sections\[1\]\.id: the anchor faq is another section's/);
    bad("an anchor the page uses", sec({ type: "problem", id: "main" }), /\.id: not one the page uses itself/);
    bad("an anchor that is not a slug", sec({ type: "problem", id: "Why Now" }), /\.id: an anchor: lower-case/);
    bad("old-style keys beside sections", { sections: [faq], hero: { headline: "x" }, coverage: { items: ["a"] } }, /landing: hero, coverage beside sections: an old-style block .* cannot be mixed/);
    // The old block's own refusals stay.
    bad("old: too many value points", { value_points: { items: Array.from({ length: 7 }, () => ({ title: "t", body: "b" })) } }, /landing\.value_points\.items: /);
    bad("old: an unknown field", { hero: { headline: "x", html: "<b>x</b>" } }, /landing\.hero: .*html/i);
    bad("old: no coverage items", { coverage: { items: [] } }, /landing\.coverage\.items: /);
    // Anchors: the page's (web) and the build's agree.
    assert.deepEqual(web.DEFAULT_IDS, DEFAULT_IDS, "the console's default anchors are the build's");
    const many = [{ type: "hero" }, { type: "cta" }, { type: "problem", id: "why" }, { type: "cta" }, { type: "faq" }] as const;
    assert.deepEqual(web.sectionIds(many), sectionIds(many), "the console numbers anchors as the build does");
    assert.deepEqual(sectionIds(many), ["intro", "get-started", "why", "get-started-2", "faq"]);
    console.log("✓ the schema: sections or the old block, plain text, ceilings, known keys and types only, links to this site, https: or mailto: only; at most 10 sections, each type once (cta thrice), hero first, own anchors");
  }

  // ---------- 2. conversion and merging ----------
  {
    const { $comment: _c, ...legacy } = LEGACY;
    assert.deepEqual(toSections(legacy as never), LEGACY_AS_SECTIONS, "the old block as sections, section for section");
    assert.deepEqual(toSections({ faq: LEGACY.faq } as never).sections!.map((s: { type: string }) => s.type), ["hero", "faq"], "the old page always opened with a hero");
    assert.deepEqual(mergeLanding(LEGACY, null), LEGACY_AS_SECTIONS, "a pack's old block, converted");
    const { $comment: _g, ...good } = GOOD;
    assert.deepEqual(mergeLanding(GOOD, null), good, "a pack's sections, $comment dropped");
    assert.equal(mergeLanding(null, null), null, "neither: null");
    // A profile's sections replace the pack's; footer and seo one by one.
    const mine = { sections: [{ type: "faq", items: [{ question: "Mine?", answer: "Yes." }] }], seo: { title: "Mine" } };
    assert.deepEqual(mergeLanding(GOOD, mine), { sections: mine.sections, footer: GOOD.footer, seo: mine.seo }, "the profile's sections and seo; the pack's footer");
    assert.deepEqual(mergeLanding(GOOD, { seo: { title: "Mine" } })!.sections, good.sections, "a profile with no sections keeps the pack's");
    assert.deepEqual(mergeLanding(LEGACY, mine)!.sections, mine.sections, "new over old: the profile's sections");
    // An old profile block over a pack's sections: each of its sections replaces the pack's of its kind, in place.
    const over = mergeLanding(GOOD, { faq: { items: [{ question: "Old-style?", answer: "Yes." }] }, closing: { title: "Old close" } })!;
    assert.deepEqual(over.sections!.map((s: { type: string }) => s.type), good.sections.map((s) => s.type), "old over new: the pack's order, no hero invented");
    assert.equal((over.sections![6] as { items: { question: string }[] }).items[0]!.question, "Old-style?", "its faq replaces the pack's");
    assert.equal((over.sections![7] as { title: string }).title, "Old close", "its closing replaces the pack's first cta");
    const joined = mergeLanding({ sections: [{ type: "hero" }, { type: "cta" }] }, { faq: { items: [{ question: "q", answer: "a" }] } })!;
    assert.deepEqual(joined.sections!.map((s: { type: string }) => s.type), ["hero", "faq", "cta"], "a kind the pack did not pick joins in wireframe order");
    // Two old blocks: merged as before (section by section), then converted.
    const both = mergeLanding(LEGACY, { faq: { items: [{ question: "Mine?", answer: "Yes." }] }, hero: { headline: "Mine" } })!;
    assert.deepEqual(both.sections![0], { type: "hero", headline: "Mine", strip: LEGACY.coverage }, "the profile's hero replaces the pack's; the pack's coverage stays its strip");
    assert.deepEqual((both.sections!.find((s: { type: string }) => s.type === "faq") as { items: unknown[] }).items, [{ question: "Mine?", answer: "Yes." }]);
    // pack.json carries it (src/pack-manifest.ts), checked with the rest of the manifest, at its path.
    const pack = { id: "lp", name: "LP", version: "1.0.0" };
    compileDeclarations({ ...pack, landing: GOOD });
    compileDeclarations({ ...pack, landing: LEGACY });
    assert.throws(() => compileDeclarations({ ...pack, landing: withHrefBlock("javascript:alert(1)") }), (e: unknown) => e instanceof PackJsonError && e.problems.some((p) => p.startsWith("landing.sections[0].primary_cta.href:")));
    assert.throws(() => compileDeclarations({ ...pack, landing: { sections: [{ type: "faq", items: [{ question: "q", answer: "a" }] }, { type: "faq", items: [{ question: "q", answer: "a" }] }] } }), (e: unknown) => e instanceof PackJsonError && e.problems.some((p) => p.startsWith("landing.sections[1]: a page shows faq once")));
    console.log("✓ the old block converts section for section; a profile's sections replace a pack's, its footer and seo one by one; an old profile block replaces by kind; pack.json `landing` is checked with the manifest");
  }

  // ---------- 3. gen-packs ----------
  const packsDir = (name: string, packs: Record<string, object>) => {
    const d = path.join(TMP, name);
    for (const [id, extra] of Object.entries(packs)) { mkdirSync(path.join(d, id), { recursive: true }); writeFileSync(path.join(d, id, "pack.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", ...extra })); }
    mkdirSync(d, { recursive: true });
    return d;
  };
  const profile = (name: string, v: object) => { const f = path.join(TMP, `${name}.json`); writeFileSync(f, JSON.stringify(v)); return f; };
  const up = { repo: "https://github.com/example-org/agent", commit: "0123456789abcdef0123456789abcdef01234567", license: "AGPL-3.0-only" };
  {
    const none = packsDir("none", {});

    // Nothing declared, nothing offered: the neutral page, and gen-packs reads nothing through tsx.
    const z = gen(["--packs", none, "--profile", profile("empty", {}), "--out", path.join(TMP, "z")]);
    assert.equal(z.status, 0, z.stderr);
    assert.equal(landingOf(path.join(TMP, "z")), null, "no block: landing = null");
    assert.deepEqual(offerOf(path.join(TMP, "z")), [], "nothing offered");
    const all = clientsOf(path.join(TMP, "z"));
    assert.ok(all.length >= 10 && !all.some((c) => c.id === "header"), "every client of the install pages (not the header entry)");
    assert.deepEqual(all.slice(0, 3), [{ id: "claude", name: "Claude", group: "chat" }, { id: "chatgpt", name: "ChatGPT", group: "chat" }, { id: "claude-code", name: "Claude Code", group: "agent" }], "in the catalog's order, short names");
    // The mold's own generated file is exactly that (the shell names no product and offers nothing).
    assert.equal(generated(ROOT), generated(path.join(TMP, "z")), "the mold's web/src/config/landing.generated.ts is the neutral one");
    assert.equal(pitchOf(path.join(TMP, "z")), null, "no block: no pitch");

    // install_clients narrows the logos.
    const nz = gen(["--packs", none, "--profile", profile("narrow", { install_clients: ["cursor", "claude"] }), "--out", path.join(TMP, "nz")]);
    assert.equal(nz.status, 0, nz.stderr);
    assert.deepEqual(clientsOf(path.join(TMP, "nz")).map((c) => c.id), ["claude", "cursor"], "install_clients narrows the clients, catalog order");

    // A pack's block, with the app's profile over it; the profile modules unchanged by it.
    const one = packsDir("one", { lp: { landing: GOOD } });
    const a = gen(["--packs", one, "--profile", profile("plain", { name: "Acme" }), "--out", path.join(TMP, "a")]);
    assert.equal(a.status, 0, a.stderr);
    const { $comment: _c, ...goodBlock } = GOOD;
    assert.deepEqual(landingOf(path.join(TMP, "a")), goodBlock, "the pack's block, $comment dropped");
    assert.equal(pitchOf(path.join(TMP, "a")), "A sub-headline.", "the welcome email's pitch: the hero section's subheadline");
    const over = { sections: [{ type: "hero", headline: "The app's own headline" }, { type: "faq", items: [{ question: "q", answer: "a" }] }], seo: { title: "App title" } };
    const b = gen(["--packs", one, "--profile", profile("over", { name: "Acme", landing: over }), "--out", path.join(TMP, "b")]);
    assert.equal(b.status, 0, b.stderr);
    const lb = landingOf(path.join(TMP, "b"));
    assert.deepEqual([lb.sections, lb.seo, lb.footer], [over.sections, over.seo, GOOD.footer], "the profile picks its own sections and seo; the footer stays the pack's");
    for (const f of [["src", "profile.generated.ts"], ["web", "src", "config", "profile.generated.ts"]])
      assert.equal(readFileSync(path.join(TMP, "b", ...f), "utf8"), readFileSync(path.join(TMP, "a", ...f), "utf8"), `${f.join("/")}: the landing block never reaches the profile (the MCP surface and the console's names are unchanged)`);
    // An old pack block: converted, so the build still builds.
    const old = gen(["--packs", packsDir("old", { lo: { landing: LEGACY } }), "--profile", profile("plain2", { name: "Acme" }), "--out", path.join(TMP, "old")]);
    assert.equal(old.status, 0, old.stderr);
    assert.deepEqual(landingOf(path.join(TMP, "old")), LEGACY_AS_SECTIONS, "an old pack block is written as sections");
    assert.equal(pitchOf(path.join(TMP, "old")), "A sub-headline.", "and its hero's subheadline is still the pitch");
    // Only a profile (no pack declares one): the profile's block alone.
    const c = gen(["--packs", none, "--profile", profile("only", { landing: { sections: [{ type: "hero", headline: "Just mine" }] } }), "--out", path.join(TMP, "c")]);
    assert.equal(c.status, 0, c.stderr);
    assert.deepEqual(landingOf(path.join(TMP, "c")), { sections: [{ type: "hero", headline: "Just mine" }] });

    // Refused: two packs with a block, a bad profile block (with its path), a bad pack block, a client not offered.
    const refused = (what: string, r: ReturnType<typeof gen>, re: RegExp) => { assert.notEqual(r.status, 0, `${what}: refused`); assert.match(r.stderr, re, `${what}: ${r.stderr}`); };
    refused("two packs with a landing block", gen(["--packs", packsDir("two", { lp: { landing: GOOD }, lq: { landing: { sections: [{ type: "hero" }] } } }), "--profile", profile("e2", {}), "--out", path.join(TMP, "x")]), /packs lp and lq both declare a landing block/);
    refused("a profile block with a script address", gen(["--packs", none, "--profile", profile("bad", { landing: { sections: [{ type: "cta", primary_cta: { label: "x", href: "javascript:alert(document.cookie)" } }] } }), "--out", path.join(TMP, "x")]),
      /\.json: landing\.sections\[0\]\.primary_cta\.href: a path of this site/);
    refused("a profile block that is not an object", gen(["--packs", none, "--profile", profile("bad2", { landing: "hello" }), "--out", path.join(TMP, "x")]), /\.json: landing: /);
    refused("a profile block with a section twice", gen(["--packs", none, "--profile", profile("bad3", { landing: { sections: [{ type: "problem" }, { type: "problem" }] } }), "--out", path.join(TMP, "x")]), /\.json: landing\.sections\[1\]: a page shows problem once/);
    refused("a pack block with a line break", gen(["--packs", packsDir("badpack", { lp: { landing: sec({ type: "hero", headline: "a\nb" }) } }), "--profile", profile("e3", {}), "--out", path.join(TMP, "x")]),
      /packs\/lp\/pack\.json: landing\.sections\[0\]\.headline: plain text on one line/);
    refused("a client the install pages do not offer", gen(["--packs", packsDir("cl", { lp: { landing: sec({ type: "where_you_work", clients: ["claude", "zed"] }) } }), "--profile", profile("e4", { install_clients: ["claude", "cursor"] }), "--out", path.join(TMP, "x")]),
      /landing: sections\[0\] \(where_you_work\)\.clients: zed is not offered by this build's install pages \(claude, cursor;/);
    refused("a client that does not exist", gen(["--packs", packsDir("cl2", { lp: { landing: sec({ type: "where_you_work", clients: ["netscape"] }) } }), "--profile", profile("e5", {}), "--out", path.join(TMP, "x")]), /netscape is not offered/);
    assert.ok(!existsSync(path.join(TMP, "x", "web", "src", "config", "landing.generated.ts")), "a refused build writes nothing");

    // The source offer: written when something is offered (the app's own, or a pack's copyleft upstream).
    const d2 = gen(["--packs", none, "--profile", profile("own", { source_offer: { app: { url: "https://git.example.org/acme/desk", license: "AGPL-3.0-or-later" } } }), "--out", path.join(TMP, "d2")]);
    assert.equal(d2.status, 0, d2.stderr);
    assert.deepEqual(offerOf(path.join(TMP, "d2")), [{ text: "This service, licensed AGPL-3.0-or-later", link: { href: "https://git.example.org/acme/desk", label: "its source" } }], "the app's own source, offered");
    assert.equal(landingOf(path.join(TMP, "d2")), null, "and still the neutral page");
    const { offerFooterItems, sourceOffer } = await import("../src/source-offer.js");
    const e = gen(["--packs", packsDir("up", { lu: { upstream: up } }), "--profile", profile("e6", {}), "--out", path.join(TMP, "e")]);
    assert.equal(e.status, 0, e.stderr);
    assert.deepEqual(offerOf(path.join(TMP, "e")), offerFooterItems(sourceOffer([{ id: "lu", manifest: { name: "LU", upstream: up }, definition: {} }], undefined)), "a copyleft upstream: its project, licence, commit and link");
    console.log("✓ gen-packs: neutral by default with the offered clients (install_clients narrows them), a pack's block as sections (an old one converted), the profile's over it, the hero's pitch, refusals with their path, a client not offered refused, the source offer; the profile modules untouched");
  }

  // ---------- 4. the page, rendered on the server ----------
  {
    const copy = path.join(TMP, "copy");
    const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
    cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    mkdirSync(path.join(copy, "packs"), { recursive: true });
    const webDir = path.join(copy, "web");
    const { build } = await import("esbuild");
    const LINK = "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n";
    const bundle = async (entry: string, out: string) => {
      writeFileSync(path.join(webDir, "render-entry.tsx"), entry);
      writeFileSync(path.join(webDir, "render-link.tsx"), LINK);
      try {
        await build({ entryPoints: [path.join(webDir, "render-entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: out, absWorkingDir: webDir,
          tsconfig: path.join(webDir, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(webDir, "render-link.tsx") }, logLevel: "error" });
      } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(webDir, f), { force: true }); }
      const r = spawnSync(process.execPath, [out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      assert.equal(r.status, 0, `render: ${r.stderr.slice(0, 2000)}`);
      return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
    };
    const render = async (label: string, prof: object, packs: Record<string, object> = {}) => {
      rmSync(path.join(copy, "packs"), { recursive: true, force: true });
      cpSync(packsDir(`render-${label}`, packs), path.join(copy, "packs"), { recursive: true });
      writeFileSync(path.join(copy, "profile.json"), JSON.stringify(prof));
      const g = gen([], copy);
      assert.equal(g.status, 0, `gen-packs (${label}): ${g.stderr}`);
      return await bundle(`import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections, SiteHeader, SiteFooter, landingMetadata } from '@/features/site/landing';
import { legalMetadata } from '@/features/site/legal';
const page = (access?: 'invite_only' | 'self_serve') => renderToStaticMarkup(<><SiteHeader access={access} /><main><LandingSections access={access} /></main><SiteFooter access={access} /></>);
process.stdout.write('\\u0001' + JSON.stringify({ html: page(), invite: page('invite_only'), meta: landingMetadata(), privacy: legalMetadata('privacy') }));
`, path.join(TMP, `render-${label}.cjs`)) as { html: string; invite: string; meta: Meta; privacy: Meta };
    };
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    const order = (html: string, ids: string[]) => ids.map((id) => html.indexOf(`<section id="${id}"`));
    const inOrder = (at: number[]) => at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]!));
    const text = (html: string) => html.replace(/<[^>]*>/g, " ");

    // The neutral page: the whole wireframe, in order, in the build's words.
    const n = await render("neutral", { name: "Acme", words: { workspace: "company", run: "audit", member: "analyst" } });
    assert.equal(count(n.html, /<h1[ >]/g), 1, "one h1");
    const WIRE = ["intro", "problem", "overview", "how-it-works", "what-you-get", "where-you-work", "faq", "get-started"];
    assert.ok(inOrder(order(n.html, WIRE)), `every section of the wireframe, in order (${order(n.html, WIRE)})`);
    for (const id of WIRE) assert.match(n.html, new RegExp(`<section id="${id}" aria-labelledby="${id}-title"`), `${id}: a labelled region`);
    assert.match(n.html, /<nav aria-label="Sections"[^>]*>(?:(?!<\/nav>)[\s\S])*href="\/#problem"[^>]*>Why<(?:(?!<\/nav>)[\s\S])*href="\/#faq"[^>]*>FAQ</, "the header's navigation: the page's sections, in order");
    assert.ok(!/href="\/#intro"|href="\/#get-started"/.test(n.html), "the hero and the calls to action are not in the navigation");
    assert.match(n.html, /aria-label="Open menu"/, "a menu on small screens");
    assert.match(n.html, /aria-labelledby="intro-strip"[\s\S]*?aria-label="Claude"/, "the hero's strip: the offered clients' logos");
    assert.match(n.html, /aria-label="AI clients"[\s\S]*?Claude Code/, "where you work: the offered clients");
    assert.match(n.html, /Ask again<!-- -->: back to step 1|Ask again: back to step 1/, "how it works: a loop back to step 1, in words");
    assert.match(n.html, /href="\/auth\/sign-up"/, "a call to sign up");
    assert.match(n.html, /href="\/install"/, "a call to connect a client");
    assert.match(n.html, /href="\/app"[^>]*>Sign in</, "a way to sign in");
    const words = text(n.html);
    assert.ok(words.includes("Acme") && /\bcompany\b/.test(words) && /\baudits?\b/.test(words) && /\banalysts\b/.test(words), "in the build's words (company, audit, analyst)");
    assert.ok(!/\{(product|workspace|runs?|members?|account|keys?)\}/i.test(words), "no placeholder left");
    assert.ok(!/\bworkspaces?\b/i.test(words.replace(/Open your company/g, "")), "never the neutral word where the build has its own");
    assert.ok(!n.html.includes("Source code"), "nothing offered: no source-code section");
    assert.equal(n.meta.openGraph.siteName, "Acme");
    // mold_v0-148: a page with its own openGraph names the share image itself (it replaces the one the image route adds).
    for (const [what, m] of [["the landing page", n.meta], ["a legal page", n.privacy]] as const) {
      assert.deepEqual(m.openGraph.images?.map((i) => [i.url, i.width, i.height, typeof i.alt]), [["/opengraph-image", 1200, 630, "string"]], `${what}: its preview carries the share image`);
      assert.equal(m.twitter?.card, "summary_large_image", `${what}: the large image card on X`);
      assert.deepEqual(m.twitter?.images?.map((i) => i.url), ["/twitter-image"], `${what}: with the share image`);
    }
    assert.match(n.invite, /href="\/request-access"[^>]*>Request access</, "invite-only (mold_v0-098): the start call is a request for access");
    assert.ok(!n.invite.includes('href="/auth/sign-up"'), "invite-only: no call leads to sign-up");

    // A pack's page: only what it picked, in its order; anchors and navigation from it.
    const p = await render("pack", { name: "Acme", source_offer: { app: "licensor_exception" } }, { lp: { landing: GOOD, upstream: up } });
    const PICKED = ["intro", "how-it-works", "problem", "idea", "what-you-get", "where-you-work", "faq", "get-started", "get-started-2"];
    assert.ok(inOrder(order(p.html, PICKED)), `the picked sections in the picked order (${order(p.html, PICKED)})`);
    assert.equal(count(p.html, /<section id="/g), PICKED.length + 1, "nothing it did not pick (plus the footer's source offer)");
    assert.match(p.html, /href="\/#how-it-works"[^>]*>How it works<[\s\S]*href="\/#problem"[^>]*>Why<[\s\S]*href="\/#idea"[^>]*>The idea</, "the navigation follows the picked order and a nav_label");
    assert.match(p.html, /<ol[^>]*>[\s\S]*Step 1: <\/span>Sign up/, "steps are an ordered list, numbered for a screen reader");
    assert.match(p.html, /Again<!-- -->: back to step 1|Again: back to step 1/, "its loop label");
    assert.match(p.html, /data-slot="accordion"[\s\S]*Is it good\?/, "the FAQ: an accordion of its questions");
    assert.match(p.html, /<ul aria-labelledby="intro-strip" class="[^"]*font-mono[^"]*"><li>SEBI CSCRF 2024<\/li><li>DPDP Rules 2025<\/li><\/ul>/, "the hero's strip of names, set in the logo row's type: a row of names, not pills");
    assert.match(p.html, /<ul aria-label="More links"[^>]*><li><a href="https:\/\/github\.com\/example-org\/app"[^>]* rel="noopener noreferrer">Open source on GitHub<\/a>/, "the hero's own links: an outside link, no opener");
    assert.match(p.html, /<dd[^>]*>826<\/dd>/, "a metric");
    assert.ok(/aria-label="AI clients"[\s\S]*?Claude<\/span>[\s\S]*?Cursor<\/span>/.test(p.html) && !/aria-label="AI clients"[^]*?ChatGPT<\/span>/.test(p.html.split('id="faq"')[0]!), "where you work: the clients it named, in its order");
    assert.match(p.html, /<span class="sr-only">You: <\/span>Hi\?/, "the sample chat says who speaks");
    // The visual templates, drawn from the block's data.
    assert.match(p.html, /<svg viewBox="0 0 560 400"[^>]*role="img" aria-label="One ask, two answers\."/, "a decision graph, labelled");
    assert.match(p.html, /<svg viewBox="0 0 340 200"[^>]*aria-label="One ask, two answers\."/, "and its phone drawing, sized to its branches");
    assert.match(p.html, /<svg viewBox="0 0 380 \d+"[^>]*role="img" aria-label="Try, check, fix\."/, "a loop, labelled");
    assert.match(p.html, />03<\/tspan><tspan dx="8">Fix</, "the loop's fix box numbered after its steps");
    assert.ok(p.html.includes("2 steps to done") && p.html.includes("Done at once") && p.html.includes("\u2713 goal"), "paths: the count, the done label and the reached goal");
    assert.match(p.html, /style="width:62%"/, "a scorecard bar at its value");
    assert.match(p.html, /stroke-dasharray="30 100" stroke-dashoffset="-58"/, "a donut slice after the first");
    assert.match(p.html, /<span class="text-primary">every day\.<\/span>/, "the headline's highlight");
    assert.match(p.html, /class="block h-full rounded-full bg-destructive\/70" style="width:22%"/, "a low bar in the chat drawn as low");
    assert.match(p.html, /aria-label="Old way: a, then b"/, "a concept card's path, in words");
    assert.match(p.html, /href="mailto:team@example.org"/, "a mailto: call to action");
    assert.ok(p.html.includes(`<code class="break-all">${up.commit}</code>`) && p.html.includes(`href="${up.repo}/tree/${up.commit}"`), "the footer offers the upstream at its commit");
    assert.ok(p.html.includes("additional permission to the AGPL-3.0"), "and says why the app's own source is not offered");
    assert.equal(p.meta.title.absolute, "Ship audits");
    assert.equal(p.meta.openGraph.description, "Search description.");
    assert.match(p.invite, /href="\/request-access"[^>]*>Start</, "invite-only: a block's sign-up call keeps its label and leads to the request form");

    // An old block, rendered converted.
    const o = await render("old", { name: "Acme" }, { lo: { landing: LEGACY } });
    assert.ok(inOrder(order(o.html, ["intro", "overview", "how-it-works", "what-you-get", "faq", "get-started"])), "the old page's sections, converted, in its order");
    assert.ok(o.html.includes("SEBI CSCRF 2024") && o.html.includes("All of it.") && o.html.includes("Second."), "coverage, features and value points all still shown");

    // A hostile block that got past nothing (every text plain, so all of it is allowed): it is text, never markup.
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const h = await render("hostile", { name: "Acme", landing: { sections: [{ type: "hero", headline: evil, subheadline: evil, primary_cta: { label: evil.slice(0, 40), href: "/start" }, strip: { items: [evil.slice(0, 40)] } },
      { type: "problem", title: evil.slice(0, 120), visual: { type: "transcript", title: evil.slice(0, 60), lines: [{ text: evil }], aside: { items: [{ label: evil.slice(0, 30) }] } } }, { type: "faq", items: [{ question: evil, answer: evil }] }],
      footer: { note: evil, links: [{ label: evil.slice(0, 40), href: "https://example.org/a?b=1&c=2" }] }, seo: { title: evil.slice(0, 70), description: evil } } });
    assert.ok(!/<script/i.test(h.html) && !/<img src="?x/i.test(h.html) && !/onerror=/i.test(h.html.replace(/&lt;img src=x onerror=alert\(2\)&gt;/g, "")), "no tag or handler from the block's text reached the markup");
    assert.ok(h.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the text is shown, escaped");
    assert.match(h.html, /href="https:\/\/example\.org\/a\?b=1&amp;c=2"[^>]* rel="noopener noreferrer"/, "an outside link: escaped, and no opener");
    assert.equal(h.meta.title.absolute, evil.slice(0, 70), "the page title is the block's text as it is (Next escapes it in the head)");
    // A link that got past gen-packs anyway (a block written into the generated file by hand) is shown as text.
    const gf = path.join(webDir, "src", "config", "landing.generated.ts");
    writeFileSync(gf, readFileSync(gf, "utf8").replace('"href": "/start"', '"href": "javascript:alert(3)"'));
    const js = await bundle(`import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections } from '@/features/site/landing';
process.stdout.write('\\u0001' + JSON.stringify({ html: renderToStaticMarkup(<LandingSections />) }));
`, path.join(TMP, "render-js.cjs")) as { html: string };
    assert.ok(js.html.includes("alert(3)") === false || !/href="javascript:/i.test(js.html), "a script address is never a link, even past gen-packs");
    assert.ok(!/javascript:/i.test(js.html), "and never in the markup");
    console.log("✓ the page: the neutral one is the whole wireframe in the build's words, with navigation from its sections; a pack's shows what it picked, in its order; an old block renders converted; text is text, a bad link never a link; invite-only leads to the request form; the footer's source offer");

    // ---------- 5. the request page (mold_v0-138) and the account button's words ----------
    const RP = {
      path: "/ask", eyebrow: "Early", title: "Get your", title_highlight: "first audit.", lead: "Tell us who you are.",
      benefits: [{ icon: "file-search", title: "One", body: "First." }, { title: "Two", body: "Second." }],
      seo: { title: "Ask", description: "Ask for access." },
      form: { submit: "Ask now", more: "More about you", message_label: "Anything else?", done: { title: "Thanks", steps: ["We read {company}.", "We write to {email}."] } },
    };
    assert.deepEqual(landingProblems({ request_page: RP }), [], "a request page passes");
    assert.deepEqual(landingProblems({ request_page: { path: "/ask", title: "Ask" } }), [], "a path and a title are enough");
    for (const [what, page, re] of [
      ["a console path", { ...RP, path: "/app" }, /request_page\.path: not one of the console's own/],
      ["the shell's request form's path", { ...RP, path: "/request-access" }, /request_page\.path: not one of the console's own/],
      ["two segments", { ...RP, path: "/a/b" }, /request_page\.path: a path of one segment/],
      ["no slash", { ...RP, path: "ask" }, /request_page\.path: a path of one segment/],
      ["an unknown placeholder", { ...RP, form: { done: { title: "T", steps: ["We read {product}."] } } }, /request_page\.form\.done\.steps\[0\]: plain text; \{company\} and \{email\}/],
      ["an icon the shell does not draw", { ...RP, benefits: [{ icon: "rocket", title: "a", body: "b" }] }, /request_page\.benefits\[0\]\.icon/],
      ["no title", { path: "/ask" }, /request_page\.title/],
      ["an unknown key", { ...RP, colour: "red" }, /request_page: .*colour|Unrecognized key/],
    ] as const) {
      const got = landingProblems({ request_page: page });
      assert.ok(got.some((x: string) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(got)})`);
    }
    assert.ok(landingProblems({ header: { sign_in: { label: "Log in", href: "javascript:x" } } }).some((x: string) => /header\.sign_in\.href/.test(x)), "the account button's address is a safe link");
    assert.deepEqual(mergeLanding({ request_page: RP }, { request_page: { path: "/join", title: "Join" } })?.request_page, { path: "/join", title: "Join" }, "the profile's request page replaces the pack's");
    assert.deepEqual(mergeLanding({ request_page: RP }, { seo: { title: "S" } })?.request_page, RP, "and the pack's stays when the profile names none");

    const FIELDS = { fields: [
      { key: "site", label: "Website", type: "url", placeholder: "https://example.org" },
      { key: "team", label: "Team size", type: "select", options: [{ value: "1-10", label: "1-10" }], more: true },
      { key: "tools", label: "Tools", type: "multi_select", options: [{ value: "a", label: "Tool A" }, { value: "b", label: "Tool B" }], more: true },
      { key: "legacy", label: "Old question", type: "text", ask: false },
    ] };
    rmSync(path.join(copy, "packs"), { recursive: true, force: true });
    cpSync(packsDir("render-rp", { rp: { landing: { header: { account: "account", sign_in: { label: "Log in", href: "/auth/sign-in" }, open: { label: "Go to the console", href: "/app" } }, request_page: RP }, access_request: FIELDS } }), path.join(copy, "packs"), { recursive: true });
    writeFileSync(path.join(copy, "profile.json"), JSON.stringify({ name: "Acme" }));
    const g = gen([], copy);
    assert.equal(g.status, 0, `gen-packs (request page): ${g.stderr}`);
    const routes = JSON.parse(readFileSync(path.join(webDir, "src", "config", "pack-routes.generated.json"), "utf8"));
    assert.ok(routes.rewrites.some((r: { source: string; destination: string }) => r.source === "/ask" && r.destination === "/declared/request"), "its path is rewritten to the shell's route for it");
    assert.deepEqual(routes.declared, [{ path: "/ask", page: "request", pack: "rp" }], "and recorded for the lanes, under the pack that declared it");
    const rp = await bundle(`import { renderToStaticMarkup } from 'react-dom/server';
import { landing } from '@/config/landing.generated';
import { SiteHeader } from '@/features/site/landing';
import { RequestAccessForm } from '@/features/site/request-access-form';
import { RequestPageView, requestPageMetadata } from '@/features/site/request-page';
const page = landing!.request_page!;
process.stdout.write('\\u0001' + JSON.stringify({ html: renderToStaticMarkup(<RequestPageView page={page} />), meta: requestPageMetadata(page),
  header: renderToStaticMarkup(<SiteHeader />), shell: renderToStaticMarkup(<RequestAccessForm from='/request-access' />) }));
`, path.join(TMP, "render-rp.cjs")) as { html: string; meta: { title: string; description: string }; header: string; shell: string };
    const at = (needle: string) => rp.html.indexOf(needle);
    assert.match(rp.html, /<p[^>]*>Early<\/p><h1[^>]*>Get your <span class="text-primary">first audit\.<\/span><\/h1>/, "the eyebrow, and the title with its highlighted end");
    assert.ok(at(">One<") > 0 && at(">Two<") > at(">One<") && /<svg[^>]*tabler-icon-file-search/.test(rp.html), "the benefits, in order, with the icon named");
    assert.ok(at(">Work email<") > 0 && at(">Company<") > at(">Work email<") && at(">Website<") > at(">Company<") && at("<details") > at(">Website<"), "first the email, the company and the fields not marked more");
    assert.match(rp.html, /<summary[^>]*><span>More about you<\/span>/, "then the fold, under the block's words");
    for (const t of [">Your name<", ">Team size<", ">Tools<", ">Anything else?<"]) assert.ok(at(t) > at("<details"), `${t} is in the fold`);
    assert.match(rp.html, /aria-pressed="false"[^>]*>Tool A<\/button>/, "several choices are chips");
    assert.ok(!rp.html.includes("Old question") && !rp.shell.includes("Old question"), "a field marked ask: false is on no form");
    assert.ok(rp.shell.includes("Website") && rp.shell.includes("Team size"), "the shell's own form asks the others");
    assert.match(rp.html, /type="submit"[^>]*>Ask now/, "the submit button's words");
    assert.deepEqual(rp.meta, { title: "Ask", description: "Ask for access." }, "its title and description: the block's seo");
    assert.match(rp.header, /href="\/auth\/sign-in"[^>]*>Log in/, "the account button signed out: the block's sign_in");
    console.log("✓ the request page: checked (its path, its words, its placeholders), merged, rewritten to the shell's route and listed; its words, the fields in the form's order (fold, chips, ask: false left out); the account button's words");
  }
  console.log("landing: all checks passed");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

function withHrefBlock(href: string) { return { sections: [{ type: "hero", primary_cta: { label: "Go", href } }] }; }
