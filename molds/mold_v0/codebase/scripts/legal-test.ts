// The legal pages and the crawl files (mold_v0-109; src/legal.ts, scripts/gen-packs.mjs, web/src/features/site/legal.tsx,
// web/src/app/robots.ts and sitemap.ts), offline: no database, no server, no browser.
//   npm run test:legal
//
// 1. The rules: a whole `legal` block passes; the three facts are required; every text is plain text on one line with
//    no markup or brackets; the contact is one address; the date exists; an own page is an https:// address (javascript:,
//    data:, http:, //host, a user name or password refused); unknown keys refused. The console's links and sitemap paths
//    agree with the server's (src/legal.ts and web/src/features/site/legal-types.ts), and the install pages' footer
//    escapes what it shows.
// 2. gen-packs: without `legal` both generated modules say null (the mold's own are exactly that); with one, the checked
//    block is written to both and never reaches the profile modules (the MCP surface and the console's names are
//    unchanged); a bad block is refused with its path; a host pack's profile may not set it.
// 3. The pages, rendered on the server (react-dom/server, the console's own components bundled with esbuild), unset and
//    set: no /terms or /privacy page (404) and no link anywhere without `legal`; with it, both pages in the build's words
//    (no placeholder left, no concept word of another product), the facts as text, the contact a mailto: link, the
//    jurisdiction paragraph only when one is given; the landing page's footer and the sign-in page link both; an own
//    terms_url wins (the page redirects there, the links go there, the sitemap leaves /terms out). The install pages
//    (src/install-pages.ts) link them only when set. robots.txt keeps crawlers out of /app, /admin, /api and /auth and
//    names the sitemap on the console's own address; the sitemap lists the landing, install and own legal pages on it,
//    and every public page under web/src/app/(site) is listed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "legal-test-"));
const gen = (args: string[], cwd = ROOT) => spawnSync(process.execPath, [path.join(cwd, "scripts", "gen-packs.mjs"), ...args], { cwd, encoding: "utf8" });
const read = (out: string, ...f: string[]) => readFileSync(path.join(out, ...f), "utf8");
const serverLegal = (out: string) => JSON.parse(/export const GENERATED_LEGAL: Legal \| null = ([\s\S]*?);\n/.exec(read(out, "src", "legal.generated.ts"))![1]!);
const webLegal = (out: string) => JSON.parse(/export const legal: Legal \| null = ([\s\S]*?);\n/.exec(read(out, "web", "src", "config", "legal.generated.ts"))![1]!);

const GOOD = {
  $comment: "a fixture",
  company_name: "Acme & Sons \"Holdings\" Ltd",
  contact_email: "legal@acme.example",
  effective_date: "2026-10-23",
  jurisdiction: "England and Wales",
};

try {
  const { legalProblems, legalOf, legalLinks, ownLegalPaths, legalFooterHtml } = await import("../src/legal.js");
  const web = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "site", "legal-types.ts")).href);

  // ---------- 1. the rules ----------
  {
    assert.deepEqual(legalProblems(GOOD), [], "a whole block passes");
    assert.deepEqual(legalProblems({ company_name: "Acme Ltd", contact_email: "a@b.co", effective_date: "2024-02-29" }), [], "the three facts alone pass (29 February in a leap year)");
    const bad = (what: string, v: unknown, re: RegExp) => {
      const p = legalProblems(v);
      assert.ok(p.some((x: string) => re.test(x)), `${what}: refused with ${re} (got ${JSON.stringify(p)})`);
    };
    bad("not an object", "Acme", /^legal: an object/);
    bad("an array", [GOOD], /^legal: an object/);
    for (const k of ["company_name", "contact_email", "effective_date"]) { const { [k]: _x, ...rest } = GOOD as Record<string, string>; bad(`no ${k}`, rest, new RegExp(`^legal\\.${k}: required`)); }
    bad("an unknown field", { ...GOOD, html: "<b>x</b>" }, /^legal\.html: not a legal field/);
    bad("a line break in the name", { ...GOOD, company_name: "Acme\nLtd" }, /^legal\.company_name: plain text on one line/);
    bad("a right-to-left override", { ...GOOD, company_name: "Acme\u202eLtd" }, /^legal\.company_name: plain text/);
    bad("markup in the name", { ...GOOD, company_name: "<script>alert(1)</script>" }, /^legal\.company_name: plain text/);
    bad("a word placeholder in the name", { ...GOOD, company_name: "Acme {run}" }, /^legal\.company_name: plain text/);
    bad("a fact placeholder in the jurisdiction", { ...GOOD, jurisdiction: "[contact]" }, /^legal\.jurisdiction: plain text/);
    bad("an empty name", { ...GOOD, company_name: "  " }, /^legal\.company_name: text is required/);
    bad("a long name", { ...GOOD, company_name: "x".repeat(161) }, /^legal\.company_name: at most 160/);
    for (const e of ["not an address", "a@b", "a@b.co, c@d.co", "a@b.co?subject=x", "a@b.co\n", "<a@b.co>", "a@b.co\"onclick=x", "javascript:a@b.co"])
      bad(`the contact ${JSON.stringify(e)}`, { ...GOOD, contact_email: e }, /^legal\.contact_email: one email address/);
    for (const d of ["2026-02-30", "2025-02-29", "23/10/2026", "2026-10-23T00:00:00Z", "2026-1-1", ""]) bad(`the date ${JSON.stringify(d)}`, { ...GOOD, effective_date: d }, /^legal\.effective_date: a date/);
    for (const u of ["javascript:alert(1)", "data:text/html,x", "http://acme.example/terms", "//acme.example/terms", "/terms", "https://user:pw@acme.example/", "https://", "https://acme.example/a b", "https://acme.example/\"x", "ftp://acme.example"])
      bad(`the own page ${JSON.stringify(u)}`, { ...GOOD, terms_url: u }, /^legal\.terms_url: /);
    assert.deepEqual(legalProblems({ ...GOOD, terms_url: "https://acme.example/terms?x=1#y", privacy_url: "https://acme.example/privacy" }), [], "own https:// pages pass");
    const o = legalOf({ ...GOOD, company_name: "  Acme Ltd  " })!;
    assert.equal(o.company_name, "Acme Ltd", "texts trimmed");
    assert.ok(!("$comment" in o), "$comment dropped");
    assert.equal(legalOf({ ...GOOD, contact_email: "x" }), null, "a bad block gives nothing");
    // The links and the sitemap's paths: the same from the server's rules and the console's.
    for (const l of [null, legalOf(GOOD), legalOf({ ...GOOD, terms_url: "https://acme.example/terms" }), legalOf({ ...GOOD, privacy_url: "https://acme.example/privacy" })]) {
      assert.deepEqual(web.legalLinks(l).map(({ label, href }: { label: string; href: string }) => ({ label, href })), legalLinks(l), `the console's links agree with the server's for ${JSON.stringify(l)}`);
      assert.deepEqual(web.ownLegalPaths(l), ownLegalPaths(l), "and the sitemap's paths");
    }
    assert.deepEqual(legalLinks(null), [], "no legal: no links");
    assert.deepEqual(legalLinks(legalOf(GOOD)), [{ label: "Terms", href: "/terms" }, { label: "Privacy", href: "/privacy" }]);
    assert.deepEqual(ownLegalPaths(legalOf({ ...GOOD, terms_url: "https://acme.example/terms" })), ["/privacy"], "a page the company keeps itself is not the console's");
    assert.equal(web.ownUrl({ ...GOOD, terms_url: "javascript:alert(1)" }, "terms"), null, "the console never links a script address, even past gen-packs");
    assert.equal(web.legalDate("2026-10-23"), "23 October 2026");
    assert.equal(legalFooterHtml(null), "", "the install pages: nothing without legal");
    assert.equal(legalFooterHtml(legalOf({ ...GOOD, privacy_url: "https://acme.example/p?a=1&b=2" })),
      '<nav class="muted" aria-label="Legal"><p><a href="/terms">Terms</a> · <a href="https://acme.example/p?a=1&amp;b=2" rel="noopener noreferrer">Privacy</a></p></nav>', "the install pages' footer: escaped, no opener");
    console.log("✓ the rules: three facts required, plain text, one address, a real date, own pages https:// only; the console's links agree; the install footer escapes");
  }

  // ---------- 2. gen-packs ----------
  const packsDir = (name: string, packs: Record<string, object>) => {
    const d = path.join(TMP, name);
    mkdirSync(d, { recursive: true });
    for (const [id, extra] of Object.entries(packs)) { mkdirSync(path.join(d, id), { recursive: true }); writeFileSync(path.join(d, id, "pack.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", ...extra })); }
    return d;
  };
  const profileFile = (name: string, v: object) => { const f = path.join(TMP, `${name}.json`); writeFileSync(f, JSON.stringify(v)); return f; };
  {
    const none = packsDir("none", {});
    const z = gen(["--packs", none, "--profile", profileFile("empty", {}), "--out", path.join(TMP, "z")]);
    assert.equal(z.status, 0, z.stderr);
    assert.equal(serverLegal(path.join(TMP, "z")), null, "no legal: null for the server");
    assert.equal(webLegal(path.join(TMP, "z")), null, "and for the console");
    for (const f of [["src", "legal.generated.ts"], ["web", "src", "config", "legal.generated.ts"]])
      assert.equal(read(ROOT, ...f), read(path.join(TMP, "z"), ...f), `the mold's ${f.join("/")} is the one with no legal pages`);

    const a = gen(["--packs", none, "--profile", profileFile("plain", { name: "Acme" }), "--out", path.join(TMP, "a")]);
    const b = gen(["--packs", none, "--profile", profileFile("legal", { name: "Acme", legal: GOOD }), "--out", path.join(TMP, "b")]);
    assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
    const { $comment: _c, ...want } = GOOD;
    assert.deepEqual(serverLegal(path.join(TMP, "b")), want, "the checked block, $comment dropped, for the server");
    assert.deepEqual(webLegal(path.join(TMP, "b")), want, "and for the console");
    for (const f of [["src", "profile.generated.ts"], ["web", "src", "config", "profile.generated.ts"], ["src", "email-pitch.generated.ts"], ["web", "src", "config", "landing.generated.ts"]])
      assert.equal(read(path.join(TMP, "b"), ...f), read(path.join(TMP, "a"), ...f), `${f.join("/")}: legal never reaches it (the MCP surface and the console's names are unchanged)`);

    const refused = (what: string, r: ReturnType<typeof gen>, re: RegExp) => { assert.notEqual(r.status, 0, `${what}: refused`); assert.match(r.stderr, re, `${what}: ${r.stderr}`); };
    refused("a script address", gen(["--packs", none, "--profile", profileFile("bad", { legal: { ...GOOD, privacy_url: "javascript:alert(document.cookie)" } }), "--out", path.join(TMP, "x")]),
      /\.json: legal\.privacy_url: an https:\/\/ address/);
    refused("no contact", gen(["--packs", none, "--profile", profileFile("bad2", { legal: { company_name: "Acme", effective_date: "2026-10-23" } }), "--out", path.join(TMP, "x")]), /\.json: legal\.contact_email: required/);
    refused("not an object", gen(["--packs", none, "--profile", profileFile("bad3", { legal: "Acme Ltd" }), "--out", path.join(TMP, "x")]), /\.json: legal: an object/);
    refused("a host pack's profile", gen(["--packs", packsDir("host", { hp: { host: { profile: { legal: GOOD } } } }), "--profile", profileFile("hosts", { host_packs: ["hp"] }), "--out", path.join(TMP, "x")]),
      /host\.profile may not set legal/);
    assert.ok(!existsSync(path.join(TMP, "x", "src", "legal.generated.ts")), "a refused build writes nothing");
    console.log("✓ gen-packs: null without legal (the mold's own files), the checked block with it, never in the profile modules; refusals with their path; no host pack sets it");
  }

  // ---------- 3. the pages, rendered on the server ----------
  {
    const copy = path.join(TMP, "copy");
    const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
    cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
    for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
    mkdirSync(path.join(copy, "packs"), { recursive: true });
    const webDir = path.join(copy, "web");
    const { build } = await import("esbuild");
    writeFileSync(path.join(webDir, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
    // next/navigation as the pages use it: notFound and redirect throw, as Next's do, with what they were asked.
    writeFileSync(path.join(webDir, "render-nav.ts"), "export function notFound(): never { throw new Error('NOT_FOUND'); }\nexport function redirect(to: string): never { throw new Error('REDIRECT ' + to); }\n" +
      // The header's sign-in hooks (src/lib/auth) load Clerk's client, which imports the router; never called in a render.
      "export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }; }\nexport function usePathname() { return '/'; }\nexport function useSearchParams() { return new URLSearchParams(); }\n");
    writeFileSync(path.join(webDir, "render-entry.tsx"), `import { renderToStaticMarkup } from 'react-dom/server';
import { SiteFooter } from '@/features/site/landing';
import { AuthShell } from '@/features/auth/components/auth-shell';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import Terms, { generateMetadata as termsMeta } from '@/app/(site)/terms/page';
import Privacy from '@/app/(site)/privacy/page';
const page = (P: () => React.ReactNode) => { try { return { html: renderToStaticMarkup(<>{P()}</>) }; } catch (e) { return { thrown: String((e as Error).message) }; } };
process.stdout.write('\\u0001' + JSON.stringify({ footer: renderToStaticMarkup(<SiteFooter />), auth: renderToStaticMarkup(<AuthShell><p>form</p></AuthShell>),
  terms: page(Terms), privacy: page(Privacy), termsMeta: termsMeta(), robots: robots(), sitemap: sitemap() }));
`);
    // The install pages, as the server serves them (src/install-pages.ts), through a stand-in for express.
    writeFileSync(path.join(copy, "render-install.ts"), `import { mountInstallPages } from "./src/install-pages.js";
const routes: Record<string, (req: unknown, res: unknown) => void> = {};
mountInstallPages({ get: (p: string, h: (req: unknown, res: unknown) => void) => { routes[p] = h; } } as never, "https://app.example.org");
let body = "";
const res = { status() { return res; }, set() { return res; }, send(h: string) { body = h; return res; }, json() { return res; } };
routes["/install"]!({ params: {} }, res);
process.stdout.write("\\u0001" + JSON.stringify({ install: body }));
`);
    type Out = { footer: string; auth: string; terms: { html?: string; thrown?: string }; privacy: { html?: string; thrown?: string }; termsMeta: { title?: string; alternates?: { canonical: string } };
      robots: { rules: { userAgent: string; allow: string; disallow: string[] }[]; sitemap: string; host: string }; sitemap: { url: string; lastModified?: string }[]; install: string };
    const render = async (label: string, prof: object, env: Record<string, string> = {}): Promise<Out> => {
      writeFileSync(path.join(copy, "profile.json"), JSON.stringify(prof));
      const g = gen([], copy);
      assert.equal(g.status, 0, `gen-packs (${label}): ${g.stderr}`);
      const out = path.join(TMP, `render-${label}.cjs`);
      await build({ entryPoints: [path.join(webDir, "render-entry.tsx")], bundle: true, format: "cjs", platform: "node", outfile: out, absWorkingDir: webDir,
        tsconfig: path.join(webDir, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
        alias: { "next/link": path.join(webDir, "render-link.tsx"), "next/navigation": path.join(webDir, "render-nav.ts") }, logLevel: "error" });
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["APP_CONSOLE_URL", "NEXT_PUBLIC_APP_URL", "VERCEL_PROJECT_PRODUCTION_URL"].includes(k)));
      const r = spawnSync(process.execPath, [out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...clean, ...env } });
      assert.equal(r.status, 0, `render (${label}): ${r.stderr.slice(0, 2000)}`);
      const i = spawnSync(path.join(copy, "node_modules", ".bin", "tsx"), [path.join(copy, "render-install.ts")], { cwd: copy, encoding: "utf8", env: { ...clean, PGLITE_DIR: path.join(TMP, `pg-${label}`) } });
      assert.equal(i.status, 0, `install pages (${label}): ${i.stderr.slice(0, 2000)}`);
      return { ...JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1)), ...JSON.parse(i.stdout.slice(i.stdout.indexOf("\u0001") + 1)) };
    };

    // Unset: no pages, no links; robots and the sitemap on the console's own address.
    const n = await render("unset", { name: "Acme" }, { APP_CONSOLE_URL: "https://console.acme.example/ignored?x=1" });
    assert.equal(n.terms.thrown, "NOT_FOUND", "no legal: /terms is not found");
    assert.equal(n.privacy.thrown, "NOT_FOUND", "no legal: /privacy is not found");
    for (const [where, html] of [["the footer", n.footer], ["the sign-in page", n.auth], ["the install pages", n.install]] as const)
      assert.ok(!/\/terms|\/privacy|aria-label="Legal"/.test(html), `no legal: no legal link on ${where}`);
    assert.deepEqual(n.robots.rules, [{ userAgent: "*", allow: "/", disallow: ["/app", "/admin", "/api", "/auth"] }], "robots: public pages allowed, the console, API and sign-in not");
    assert.equal(n.robots.sitemap, "https://console.acme.example/sitemap.xml", "robots names the sitemap on the console's own address (APP_CONSOLE_URL, its origin only)");
    assert.deepEqual(n.sitemap.map((e) => e.url), ["https://console.acme.example/", "https://console.acme.example/install"], "the sitemap without legal: the landing and install pages");
    const v = await render("vercel", { name: "Acme" }, { VERCEL_PROJECT_PRODUCTION_URL: "acme.example.org" });
    assert.equal(v.robots.sitemap, "https://acme.example.org/sitemap.xml", "on Vercel: the project's production address");
    const loc = await render("local", { name: "Acme" }, { APP_CONSOLE_URL: "javascript:alert(1)", NEXT_PUBLIC_APP_URL: "https://pub.acme.example" });
    assert.equal(loc.robots.host, "https://pub.acme.example", "an address that is not http(s) is skipped");

    // Set: both pages in the build's words, the facts as text.
    const s = await render("set", { name: "Acme Desk", words: { run: "audit", workspace: "company", member: "analyst" }, legal: GOOD }, { APP_CONSOLE_URL: "https://desk.acme.example" });
    for (const [kind, r] of [["terms", s.terms], ["privacy", s.privacy]] as const) {
      const h = r.html!;
      assert.ok(h, `${kind}: rendered (${r.thrown})`);
      assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, `${kind}: one h1`);
      assert.ok((h.match(/<h2[ >]/g) ?? []).length >= 6, `${kind}: its sections under their headings`);
      assert.ok(h.includes("Acme &amp; Sons &quot;Holdings&quot; Ltd"), `${kind}: the company's name, as escaped text`);
      assert.ok(h.includes('href="mailto:legal@acme.example"'), `${kind}: the contact, a mailto: link`);
      assert.ok(h.includes('<time dateTime="2026-10-23">23 October 2026</time>'), `${kind}: the effective date`);
      assert.ok(h.includes("Acme Desk"), `${kind}: the product's name`);
      assert.ok(!/[{}]|\[(company|contact|jurisdiction|effective_date|terms|privacy)\]/.test(h.replace(/<[^>]*>/g, "")), `${kind}: no placeholder left`);
      assert.ok(!/\b(runs?|workspaces?|members?)\b/i.test(h.replace(/<[^>]*>/g, "")), `${kind}: the build's words (audit, company, analyst), never the neutral ones`);
      assert.ok(/\b(audits?|company|companies|analysts?)\b/.test(h), `${kind}: the build's words appear`);
    }
    assert.ok(s.terms.html!.replace(/<[^>]*>/g, "").includes("governed by the law of England and Wales, and the courts of England and Wales decide"), "the jurisdiction paragraph when one is given");
    assert.ok(/href="\/privacy"[^>]*>privacy notice</.test(s.terms.html!) && /href="\/terms"[^>]*>terms of use</.test(s.privacy.html!), "each page links the other");
    assert.deepEqual([s.termsMeta.title, s.termsMeta.alternates?.canonical], ["Terms of use", "/terms"], "the page's title and canonical address");
    for (const [where, html] of [["the footer", s.footer], ["the sign-in page", s.auth], ["the install pages", s.install]] as const)
      assert.ok(/href="\/terms"[^>]*>Terms</.test(html) && /href="\/privacy"[^>]*>Privacy</.test(html), `legal set: Terms and Privacy on ${where}`);
    assert.match(s.auth, /<nav aria-label="Legal"/, "the sign-in page's links are a labelled navigation");
    assert.deepEqual(s.sitemap.map((e) => e.url), ["https://desk.acme.example/", "https://desk.acme.example/install", "https://desk.acme.example/terms", "https://desk.acme.example/privacy"], "the sitemap with legal");
    assert.equal(s.sitemap[2]!.lastModified, "2026-10-23", "a legal page's last change is its effective date");
    const noJ = await render("nojur", { name: "Acme", legal: { company_name: "Acme Ltd", contact_email: "legal@acme.example", effective_date: "2026-10-23" } });
    assert.ok(!/governed by|Governing law/.test(noJ.terms.html!), "no jurisdiction: no governing-law section");

    // An own terms page wins: the console's redirects there, every link goes there, the sitemap leaves it out.
    const own = await render("own", { name: "Acme", legal: { ...GOOD, terms_url: "https://acme.example/legal/terms" } }, { APP_CONSOLE_URL: "https://desk.acme.example" });
    assert.equal(own.terms.thrown, "REDIRECT https://acme.example/legal/terms", "/terms redirects to the company's own terms");
    assert.ok(own.privacy.html, "/privacy is still the console's");
    for (const [where, html] of [["the footer", own.footer], ["the sign-in page", own.auth], ["the install pages", own.install]] as const)
      assert.ok(/href="https:\/\/acme\.example\/legal\/terms"[^>]* rel="noopener noreferrer"[^>]*>Terms<|href="https:\/\/acme\.example\/legal\/terms" rel="noopener noreferrer">Terms</.test(html) && /href="\/privacy"/.test(html), `the own terms on ${where}: ${html.slice(0, 0)}`);
    assert.ok(/href="https:\/\/acme\.example\/legal\/terms"[^>]*>terms of use</.test(own.privacy.html!), "the privacy page links the own terms");
    assert.deepEqual(own.sitemap.map((e) => e.url), ["https://desk.acme.example/", "https://desk.acme.example/install", "https://desk.acme.example/privacy"], "the sitemap leaves out a page the company keeps itself");
    for (const f of ["render-entry.tsx", "render-link.tsx", "render-nav.ts"]) rmSync(path.join(webDir, f), { force: true });
    console.log("✓ the pages: none and no links without legal; with it both pages in the build's words, the facts as text, links on the footer, sign-in and install pages; an own page wins; robots and the sitemap on the console's address");
  }

  // ---------- every public page is in the sitemap ----------
  {
    const site = path.join(ROOT, "web", "src", "app", "(site)");
    const pages: string[] = [];
    const walk = (dir: string, url: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) { if (e.name === "page.tsx") pages.push(url || "/"); continue; }
        if (/^\[/.test(e.name)) continue;                  // a host pack's own public pages (host/[pack]/...): its own routes
        if (dir === site && e.name === "host") continue;
        walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? url : `${url}/${e.name}`);
      }
    };
    walk(site, "");
    const { PUBLIC_PAGES } = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "site", "public-pages.ts")).href);
    const listed = new Set([...PUBLIC_PAGES, "/install", "/terms", "/privacy"]);
    const missing = pages.filter((p) => !listed.has(p));
    assert.deepEqual(missing, [], `every public page of web/src/app/(site) is in web/src/features/site/public-pages.ts PUBLIC_PAGES (missing: ${missing.join(", ")})`);
    console.log(`✓ the sitemap lists every public page (${pages.join(", ")})`);
  }
  console.log("legal: all checks passed");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
