// The landing block (mold_v0-091; src/landing.ts, scripts/gen-packs.mjs, web/src/features/site/landing.tsx), offline: no
// database, no server, no browser.
//   npm run test:landing
//
// 1. The schema: a whole block passes; every text is plain text on one line (line breaks, control, bidirectional,
//    zero-width and tag characters refused), every list and text has a ceiling, unknown keys are refused, and a link is a
//    path of this site, an https:// address or a mailto: address: javascript:, data:, vbscript:, http:, //host, a
//    backslash, a user name or a password in the address are refused (and the console's own second check agrees).
// 2. gen-packs: with no block, no upstream and no source_offer it writes `landing = null` and no offer (and starts no
//    tsx); a pack's block is written; the app's profile.json block comes over it section by section; two packs that
//    both declare one, a bad profile block and a bad pack block are refused with the path of the problem; the profile's
//    block never reaches the profile modules (the server's and the console's names, so the MCP surface is unchanged);
//    the source offer's footer items are written when the build offers something.
// 3. The page, rendered on the server (react-dom/server, the console's own components bundled with esbuild): the
//    neutral page has a heading, calls to action, value points and steps; a block's text that looks like HTML or script
//    is shown as text and never becomes markup; a link that got past gen-packs is shown as text, never as a link; the
//    footer carries the source offer and its commit; with invite-only accounts (mold_v0-098) every call to sign up leads to
//    the request form (/request-access), a block's label kept.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "landing-test-"));
const gen = (args: string[], cwd = ROOT) => spawnSync(process.execPath, [path.join(cwd, "scripts", "gen-packs.mjs"), ...args], { cwd, encoding: "utf8" });
const generated = (out: string) => readFileSync(path.join(out, "web", "src", "config", "landing.generated.ts"), "utf8");
const landingOf = (out: string) => JSON.parse(/export const landing: LandingBlock \| null = ([\s\S]*?);\n/.exec(generated(out))![1]!);
const offerOf = (out: string) => JSON.parse(/export const sourceOfferItems: readonly OfferFooterItem\[\] = ([\s\S]*?);\n/.exec(generated(out))![1]!);

const GOOD = {
  $comment: "a fixture",
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

try {
  const { landingProblems, hrefProblem, mergeLanding, LANDING_SECTIONS } = await import("../src/landing.js");
  const { linkable } = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "site", "landing-types.ts")).href);
  const { compileDeclarations, PackJsonError } = await import("../src/pack-manifest.js");

  // ---------- 1. the schema ----------
  {
    assert.deepEqual(landingProblems(GOOD), [], "a whole block passes");
    assert.deepEqual(landingProblems({}), [], "an empty block passes (every section is optional)");
    const bad = (what: string, block: unknown, re: RegExp) => {
      const p = landingProblems(block);
      assert.ok(p.some((x) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(p)})`);
    };
    const withHref = (href: string) => ({ hero: { primary_cta: { label: "Go", href } } });
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)", "http://example.org", "//evil.example", "/\\evil.example", "https://user:pw@example.org/", "https://", "ftp://example.org",
      "/a b", "/a\"onmouseover=\"x", "/..//evil.example", "/x/../y", "/./x", "/%2F%2Fevil.example", "/%5cevil", "/caf\u00e9", "/a\u200bb", "mailto:", "https://example.org/\u202e", "#top", "install"])
      bad(`the address ${JSON.stringify(href)}`, withHref(href), /landing\.hero\.primary_cta\.href: /);
    for (const href of ["/", "/install", "/auth/sign-up?from=landing#top", "https://example.org", "https://example.org/a?b=c#d", "mailto:team@example.org", "mailto:team@example.org?subject=Hi"])
      assert.equal(hrefProblem(href), null, `the address ${href} passes`);
    // The console's second check agrees with the build's on every address above, and refuses what the build would.
    for (const href of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "data:text/html,x", "http://example.org", "https://user:pw@example.org/", "/a b", "/a\u0001b", "mailto:x", "/..//evil.example", "/%2f%2fevil", "/a\u200bb", "https://a.example/\uff0f"])
      assert.equal(linkable(href), false, `the page never links ${JSON.stringify(href)}`);
    for (const href of ["/", "/install", "https://example.org/a?b=c#d", "mailto:team@example.org"]) assert.equal(linkable(href), true, `the page links ${href}`);
    bad("a line break", { hero: { headline: "One\nTwo" } }, /landing\.hero\.headline: plain text on one line/);
    bad("a right-to-left override", { hero: { headline: "abc\u202edcb" } }, /plain text on one line/);
    bad("a zero-width space", { faq: { items: [{ question: "a\u200bb", answer: "x" }] } }, /landing\.faq\.items\[0\]\.question: plain text/);
    bad("a tag character", { coverage: { items: ["SEBI\u{E0041}"] } }, /landing\.coverage\.items\[0\]: plain text/);
    bad("an empty text", { hero: { headline: "   " } }, /text is required/);
    bad("a long headline", { hero: { headline: "x".repeat(121) } }, /at most 120 characters/);
    bad("a long badge", { coverage: { items: ["x".repeat(41)] } }, /at most 40 characters/);
    bad("too many value points", { value_points: { items: Array.from({ length: 7 }, () => ({ title: "t", body: "b" })) } }, /landing\.value_points\.items: /);
    bad("too many FAQ items", { faq: { items: Array.from({ length: 16 }, () => ({ question: "q", answer: "a" })) } }, /landing\.faq\.items: /);
    bad("no coverage items", { coverage: { items: [] } }, /landing\.coverage\.items: /);
    bad("an unknown section", { testimonials: [{ quote: "best ever" }] }, /landing: .*testimonials/i);
    bad("an unknown field", { hero: { headline: "x", html: "<b>x</b>" } }, /landing\.hero: .*html/i);
    bad("HTML in a link's label is text, but a label must still be one line", { hero: { primary_cta: { label: "a\nb", href: "/" } } }, /primary_cta\.label: plain text/);
    assert.deepEqual(landingProblems({ hero: { headline: "<script>alert(1)</script> & \"quotes\"" } }), [], "text that looks like HTML is allowed: it is shown as text");
    console.log("✓ the schema: plain text, ceilings, known keys only; links to this site, https: or mailto: only (the page's own check agrees)");

    // Merging: the profile's sections over the pack's, one by one; $comment dropped.
    const m = mergeLanding(GOOD as never, { faq: { items: [{ question: "Mine?", answer: "Yes." }] } } as never)!;
    assert.deepEqual(m.faq, { items: [{ question: "Mine?", answer: "Yes." }] }, "the profile's section replaces the pack's");
    assert.deepEqual(m.hero, GOOD.hero, "a section the profile leaves out stays the pack's");
    assert.ok(!("$comment" in m) && Object.keys(m).every((k) => (LANDING_SECTIONS as readonly string[]).includes(k)), "only sections, in page order");
    assert.equal(mergeLanding(null, null), null, "neither: null");
    // pack.json carries it (src/pack-manifest.ts), checked with the rest of the manifest.
    const pack = { id: "lp", name: "LP", version: "1.0.0" };
    compileDeclarations({ ...pack, landing: GOOD });
    assert.throws(() => compileDeclarations({ ...pack, landing: withHref("javascript:alert(1)") }), (e: unknown) => e instanceof PackJsonError && e.problems.some((p) => p.startsWith("landing.hero.primary_cta.href:")));
    console.log("✓ the profile's sections come over a pack's one by one; pack.json `landing` is checked with the manifest");
  }

  // ---------- 2. gen-packs ----------
  {
    const packsDir = (name: string, packs: Record<string, object>) => {
      const d = path.join(TMP, name);
      for (const [id, extra] of Object.entries(packs)) { mkdirSync(path.join(d, id), { recursive: true }); writeFileSync(path.join(d, id, "pack.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", ...extra })); }
      mkdirSync(d, { recursive: true });
      return d;
    };
    const profile = (name: string, v: object) => { const f = path.join(TMP, `${name}.json`); writeFileSync(f, JSON.stringify(v)); return f; };
    const none = packsDir("none", {});

    // Nothing declared, nothing offered: the neutral page, and gen-packs reads nothing through tsx.
    const z = gen(["--packs", none, "--profile", profile("empty", {}), "--out", path.join(TMP, "z")]);
    assert.equal(z.status, 0, z.stderr);
    assert.equal(landingOf(path.join(TMP, "z")), null, "no block: landing = null");
    assert.deepEqual(offerOf(path.join(TMP, "z")), [], "nothing offered");
    // The mold's own generated file is exactly that (the shell names no product and offers nothing).
    assert.equal(generated(ROOT), generated(path.join(TMP, "z")), "the mold's web/src/config/landing.generated.ts is the neutral one");

    // A pack's block, with the app's profile over it; the profile modules unchanged by it.
    const one = packsDir("one", { lp: { landing: GOOD } });
    const a = gen(["--packs", one, "--profile", profile("plain", { name: "Acme" }), "--out", path.join(TMP, "a")]);
    assert.equal(a.status, 0, a.stderr);
    const { $comment: _c, ...goodSections } = GOOD;
    assert.deepEqual(landingOf(path.join(TMP, "a")), goodSections, "the pack's block, $comment dropped");
    const over = { hero: { headline: "The app's own headline" }, seo: { title: "App title" } };
    const b = gen(["--packs", one, "--profile", profile("over", { name: "Acme", landing: over }), "--out", path.join(TMP, "b")]);
    assert.equal(b.status, 0, b.stderr);
    const lb = landingOf(path.join(TMP, "b"));
    assert.deepEqual([lb.hero, lb.seo, lb.faq], [over.hero, over.seo, GOOD.faq], "the profile's hero and seo replace the pack's; its faq stays the pack's");
    for (const f of [["src", "profile.generated.ts"], ["web", "src", "config", "profile.generated.ts"]])
      assert.equal(readFileSync(path.join(TMP, "b", ...f), "utf8"), readFileSync(path.join(TMP, "a", ...f), "utf8"), `${f.join("/")}: the landing block never reaches the profile (the MCP surface and the console's names are unchanged)`);
    // Only a profile (no pack declares one): the profile's block alone.
    const c = gen(["--packs", none, "--profile", profile("only", { landing: { hero: { headline: "Just mine" } } }), "--out", path.join(TMP, "c")]);
    assert.equal(c.status, 0, c.stderr);
    assert.deepEqual(landingOf(path.join(TMP, "c")), { hero: { headline: "Just mine" } });

    // Refused: two packs with a block, a bad profile block (with its path), a bad pack block.
    const refused = (what: string, r: ReturnType<typeof gen>, re: RegExp) => { assert.notEqual(r.status, 0, `${what}: refused`); assert.match(r.stderr, re, `${what}: ${r.stderr}`); };
    refused("two packs with a landing block", gen(["--packs", packsDir("two", { lp: { landing: GOOD }, lq: { landing: { hero: { headline: "x" } } } }), "--profile", profile("e2", {}), "--out", path.join(TMP, "x")]), /packs lp and lq both declare a landing block/);
    refused("a profile block with a script address", gen(["--packs", none, "--profile", profile("bad", { landing: { closing: { title: "Go", primary_cta: { label: "x", href: "javascript:alert(document.cookie)" } } } }), "--out", path.join(TMP, "x")]),
      /\.json: landing\.closing\.primary_cta\.href: a path of this site/);
    refused("a profile block that is not an object", gen(["--packs", none, "--profile", profile("bad2", { landing: "hello" }), "--out", path.join(TMP, "x")]), /\.json: landing: /);
    refused("a pack block with a line break", gen(["--packs", packsDir("badpack", { lp: { landing: { hero: { headline: "a\nb" } } } }), "--profile", profile("e3", {}), "--out", path.join(TMP, "x")]),
      /packs\/lp\/pack\.json: landing\.hero\.headline: plain text on one line/);
    assert.ok(!existsSync(path.join(TMP, "x", "web", "src", "config", "landing.generated.ts")), "a refused build writes nothing");

    // The source offer: written when something is offered (the app's own, or a pack's copyleft upstream).
    const d = gen(["--packs", none, "--profile", profile("exc", { source_offer: { app: "licensor_exception" } }), "--out", path.join(TMP, "d")]);
    assert.equal(d.status, 0, d.stderr);
    const { LICENSOR_EXCEPTION_TEXT, offerFooterItems, sourceOffer, offerFooterHtml } = await import("../src/source-offer.js");
    assert.deepEqual(offerOf(path.join(TMP, "d")), [], "the licensor's exception alone offers nothing, as the install pages say nothing (src/source-offer.ts: offered only with a copyleft upstream or the app's own source)");
    const d2 = gen(["--packs", none, "--profile", profile("own", { source_offer: { app: { url: "https://git.example.org/acme/desk", license: "AGPL-3.0-or-later" } } }), "--out", path.join(TMP, "d2")]);
    assert.equal(d2.status, 0, d2.stderr);
    assert.deepEqual(offerOf(path.join(TMP, "d2")), [{ text: "This service, licensed AGPL-3.0-or-later", link: { href: "https://git.example.org/acme/desk", label: "its source" } }], "the app's own source, offered");
    assert.equal(landingOf(path.join(TMP, "d")), null, "and still the neutral page");
    const up = { repo: "https://github.com/example-org/agent", commit: "0123456789abcdef0123456789abcdef01234567", license: "AGPL-3.0-only" };
    const e = gen(["--packs", packsDir("up", { lu: { upstream: up } }), "--profile", profile("e4", {}), "--out", path.join(TMP, "e")]);
    assert.equal(e.status, 0, e.stderr);
    const items = offerOf(path.join(TMP, "e"));
    assert.deepEqual(items, offerFooterItems(sourceOffer([{ id: "lu", manifest: { name: "LU", upstream: up }, definition: {} }], undefined)), "a copyleft upstream: its project, licence, commit and link");
    assert.equal(items[0]!.link!.href, `${up.repo}/tree/${up.commit}`);
    // The install pages' footer says exactly these items.
    assert.equal(offerFooterHtml(sourceOffer([{ id: "lu", manifest: { name: "LU", upstream: up }, definition: {} }], { app: "licensor_exception" })),
      `<footer class="muted" id="source-code"><h2>Source code</h2><ul><li>LU uses agent, licensed AGPL-3.0-only, at commit <code>${up.commit}</code>: <a href="${up.repo}/tree/${up.commit}">its source at that commit</a></li><li>${LICENSOR_EXCEPTION_TEXT.replace(/'/g, "&#39;")}</li></ul></footer>`,
      "the install pages' footer is unchanged, built from the same items");
    console.log("✓ gen-packs: neutral by default, a pack's block with the profile's over it, refusals with their path, the source offer's items; the profile modules untouched");

    // ---------- 3. the page, rendered on the server ----------
    const copy = path.join(TMP, "copy");
    const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
    cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    mkdirSync(path.join(copy, "packs"), { recursive: true });
    const web = path.join(copy, "web");
    const { build } = await import("esbuild");
    const render = async (label: string, prof: object, packs: Record<string, object> = {}) => {
      rmSync(path.join(copy, "packs"), { recursive: true, force: true });
      cpSync(packsDir(`render-${label}`, packs), path.join(copy, "packs"), { recursive: true });
      writeFileSync(path.join(copy, "profile.json"), JSON.stringify(prof));
      const g = gen([], copy);
      assert.equal(g.status, 0, `gen-packs (${label}): ${g.stderr}`);
      writeFileSync(path.join(web, "render-entry.tsx"), `import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections, SiteHeader, SiteFooter, landingMetadata } from '@/features/site/landing';
process.stdout.write('\\u0001' + JSON.stringify({ html: renderToStaticMarkup(<><SiteHeader /><main><LandingSections /></main><SiteFooter /></>), meta: landingMetadata() }));
`);
      writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
      const out = path.join(TMP, `render-${label}.cjs`);
      try {
        await build({ entryPoints: [path.join(web, "render-entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: out, absWorkingDir: web,
          tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error" });
      } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(web, f), { force: true }); }
      const r = spawnSync(process.execPath, [out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      assert.equal(r.status, 0, `render (${label}): ${r.stderr.slice(0, 2000)}`);
      return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1)) as { html: string; meta: { title: { absolute: string }; description: string; openGraph: { title: string; description: string; siteName: string } } };
    };
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

    // The neutral page: a real page, not two links.
    const n = await render("neutral", {});
    assert.equal(count(n.html, /<h1[ >]/g), 1, "one h1");
    assert.ok(count(n.html, /<h2[ >]/g) >= 2 && count(n.html, /<h3[ >]/g) >= 6, "value points and steps, under their headings");
    assert.match(n.html, /href="\/auth\/sign-up"/, "a call to sign up");
    assert.match(n.html, /href="\/install"/, "a call to connect a client");
    assert.match(n.html, /href="\/app"[^>]*>Sign in</, "a way to sign in");
    assert.ok(n.html.includes("Workspace") && n.html.includes("Connect an MCP client, run agents and read their results."), "in the neutral profile's words");
    assert.ok(!n.html.includes("Source code"), "nothing offered: no source-code section");
    assert.equal(n.meta.openGraph.siteName, "Workspace");

    // A hostile block that got past nothing (every text plain, so all of it is allowed): it is text, never markup.
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const h = await render("hostile", { name: "Acme", landing: { hero: { headline: evil, subheadline: evil, primary_cta: { label: evil.slice(0, 40), href: "/start" } },
      coverage: { items: [evil.slice(0, 40)] }, faq: { items: [{ question: evil, answer: evil }] }, footer: { note: evil, links: [{ label: evil.slice(0, 40), href: "https://example.org/a?b=1&c=2" }] }, seo: { title: evil.slice(0, 70), description: evil } } });
    assert.ok(!/<script/i.test(h.html) && !/<img src="?x/i.test(h.html) && !/onerror=/i.test(h.html.replace(/&lt;img src=x onerror=alert\(2\)&gt;/g, "")), "no tag or handler from the block's text reached the markup");
    assert.ok(h.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the text is shown, escaped");
    assert.match(h.html, /href="https:\/\/example\.org\/a\?b=1&amp;c=2"[^>]* rel="noopener noreferrer"/, "an outside link: escaped, and no opener");
    assert.equal(h.meta.title.absolute, evil.slice(0, 70), "the page title is the block's text as it is (Next escapes it in the head)");
    // A link that got past gen-packs anyway (a block written into the generated file by hand) is shown as text.
    const gf = path.join(web, "src", "config", "landing.generated.ts");
    writeFileSync(gf, readFileSync(gf, "utf8").replace('"href": "/start"', '"href": "javascript:alert(3)"'));
    // (re-render without regenerating: the generated file is what the page reads)
    writeFileSync(path.join(web, "render-entry.tsx"), `import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections } from '@/features/site/landing';
process.stdout.write('\\u0001' + JSON.stringify({ html: renderToStaticMarkup(<LandingSections />) }));
`);
    writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
    try {
      await build({ entryPoints: [path.join(web, "render-entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(TMP, "render-js.cjs"), absWorkingDir: web,
        tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error" });
    } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(web, f), { force: true }); }
    const js = spawnSync(process.execPath, [path.join(TMP, "render-js.cjs")], { encoding: "utf8" });
    assert.equal(js.status, 0, js.stderr);
    assert.ok(!/javascript:/i.test(js.stdout), "a script address is never a link, even past gen-packs");

    // A pack's block with an upstream: the sections in order, and the footer's source offer with its commit and link.
    const p = await render("pack", { name: "Acme", source_offer: { app: "licensor_exception" } }, { lp: { landing: GOOD, upstream: up } });
    const order = ["landing-hero", "landing-coverage", "landing-value", "landing-how", "landing-features", "landing-faq", "landing-closing"].map((id) => p.html.indexOf(`id="${id}"`));
    assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]!)), `every section, in order (${order})`);
    assert.match(p.html, /<ol[^>]*>[\s\S]*Step 1: <\/span>Sign up/, "steps are an ordered list, numbered for a screen reader");
    assert.match(p.html, /<details[^>]*><summary[^>]*>[\s\S]*Is it good\?/, "the FAQ opens without script");
    assert.match(p.html, /href="mailto:team@example.org"/, "a mailto: call to action");
    assert.ok(p.html.includes(`<code class="break-all">${up.commit}</code>`) && p.html.includes(`href="${up.repo}/tree/${up.commit}"`), "the footer offers the upstream at its commit");
    assert.ok(p.html.includes("additional permission to the AGPL-3.0"), "and says why the app's own source is not offered");
    assert.equal(p.meta.title.absolute, "Ship audits");
    assert.equal(p.meta.openGraph.description, "Search description.");
    // Invite-only accounts (mold_v0-098): every call to sign up leads to the request form, a block's label kept.
    writeFileSync(path.join(web, "render-entry.tsx"), `import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections, SiteHeader, SiteFooter } from '@/features/site/landing';
const page = (access?: 'invite_only' | 'self_serve') => renderToStaticMarkup(<><SiteHeader access={access} /><main><LandingSections access={access} /></main><SiteFooter access={access} /></>);
process.stdout.write('\\u0001' + JSON.stringify({ invite: page('invite_only'), open: page('self_serve') }));
`);
    writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
    try {
      await build({ entryPoints: [path.join(web, "render-entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(TMP, "render-access.cjs"), absWorkingDir: web,
        tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error" });
    } finally { for (const f of ["render-entry.tsx", "render-link.tsx"]) rmSync(path.join(web, f), { force: true }); }
    const acc = spawnSync(process.execPath, [path.join(TMP, "render-access.cjs")], { encoding: "utf8" });
    assert.equal(acc.status, 0, acc.stderr);
    const both = JSON.parse(acc.stdout.slice(acc.stdout.indexOf("\u0001") + 1)) as { invite: string; open: string };
    assert.ok(!both.invite.includes('href="/auth/sign-up"'), "invite-only: no call leads to sign-up");
    assert.match(both.invite, /href="\/request-access"[^>]*>Start</, "the block's call keeps its label and leads to the request form");
    assert.match(both.invite, /href="\/request-access"[^>]*>Request access</, "the shell's own call says Request access");
    assert.match(both.open, /href="\/auth\/sign-up"[^>]*>Start</, "self-serve: the block's call is as declared");
    console.log("✓ the page: the neutral one is a real page; a block's text is text (never markup), a bad link is never a link; sections in order; the footer's source offer; invite-only calls lead to the request form");
  }
  console.log("landing: all checks passed");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
