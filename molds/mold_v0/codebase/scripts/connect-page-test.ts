// The connect guide (mold_v0-171; src/connect-page-config.ts, src/install-pages.ts), offline.
//   npm run test:connect-page
//
// 1. The rules: what a `connect_page` block may say (its own address, never one of the shell's; one-line texts; links
//    to a path, an anchor or https; only the {product} and {skill_file} placeholders; colours), each refusal named.
// 2. The texts as HTML: escaped first, then **bold**, `code` and [links](/path) drawn; an address that is not one stays
//    text; the placeholders filled.
// 3. What gen-packs writes: a pack's block (checked, without its $comment) in PACK_CONFIG; none without one; two packs
//    declaring one, or a broken block, refuse the build.
// 4. Served (the install pages' router on its own): the page at its address with the connector's address, the sign-in
//    and key sentences, the skill's download and the config's words; the page's headers; no page at all without one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "connect-page-"));
let n = 0, checks = 0;
const ok = (what: string) => { checks++; console.log(`✓ ${what}`); };

const GOOD = {
  $comment: "a fixture",
  path: "/connect.html",
  title: "Connect {product}",
  description: "How to connect {product}.",
  heading: "Connect {product}",
  lead: "Add it as a connector, sign in, and ask it something.",
  accent: "#d9400f",
  header_link: { label: "Request access", href: "/early-access" },
  clients: [{ name: "Claude (web & desktop)", steps: ["Open **Settings → Connectors**.", "Name it `{product}` and see [the skill](#skill)."] }],
  skill: { heading: "The skill", lead: "It teaches the workflow.", steps: ["Select `{skill_file}`."] },
  first_run: { heading: "Your first run", cards: [{ title: "1. Ask", text: "“Onboard my product: <one paragraph>.”" }], note: "It takes a few minutes." },
  footer: { tagline: "A tagline", links: [{ label: "Home", href: "/" }, { label: "FAQ", href: "/#faq" }] },
};

/** A throwaway copy of this codebase (its node_modules linked) with these packs; gen-packs run in it. */
function world(packs: Record<string, unknown>) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules")
      && !/[\\/](web[\\/]src|orchestrator)[\\/]packs[\\/][^\\/]+$/.test(path.relative(ROOT, f) ? `/${path.relative(ROOT, f)}` : "") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, json] of Object.entries(packs)) {
    mkdirSync(path.join(dir, "packs", id), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, "pack.json"), JSON.stringify(json, null, 2));
  }
  writeFileSync(path.join(dir, "profile.json"), "{}");
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
/** The PACK_CONFIG list a world's gen-packs wrote, or null when it wrote none. */
const packConfigOf = (dir: string) => {
  const m = /export const PACK_CONFIG: readonly unknown\[\] = ([\s\S]*?);\n/.exec(readFileSync(path.join(dir, "src", "hosts.generated.ts"), "utf8"));
  return m ? JSON.parse(m[1]!) as { pack: string; connect_page?: unknown }[] : null;
};

try {
  const { connectPageProblems, inlineHtml } = await import("../src/connect-page-config.js");

  // ---------- 1. the rules ----------
  {
    assert.deepEqual(connectPageProblems(GOOD), [], "the fixture is well formed");
    const { skill: _s, first_run: _f, footer: _o, header_link: _h, description: _d, accent: _a, ...least } = GOOD;
    assert.deepEqual(connectPageProblems(least), [], "skill, first run, footer, header link, description and colours are optional");
    const bad: [string, unknown, RegExp][] = [
      ["not an object", [], /connect_page: an object/],
      ["the shell's own address", { ...GOOD, path: "/install/connect" }, /path: \/install\/connect is the shell's own address/],
      ["the API", { ...GOOD, path: "/api/connect" }, /is the shell's own address \(\/api\)/],
      ["the home page", { ...GOOD, path: "/" }, /path: a path of its own|is the shell's own address/],
      ["a path that climbs", { ...GOOD, path: "/../x" }, /path: a path of its own/],
      ["an unknown field", { ...GOOD, intro: "x" }, /connect_page\.intro: unknown field/],
      ["a step over two lines", { ...GOOD, clients: [{ name: "A", steps: ["one\ntwo"] }] }, /clients\[0\]\.steps\[0\]: plain text on one line/],
      ["no clients", { ...GOOD, clients: [] }, /clients: a list of 1 to 8/],
      ["an unknown placeholder", { ...GOOD, lead: "Hello {name}" }, /lead: no braces but the placeholders/],
      ["a javascript link", { ...GOOD, lead: "See [this](javascript:alert(1))" }, /lead: a link's address is a path/],
      ["an http link in the footer", { ...GOOD, footer: { links: [{ label: "x", href: "http://x.example" }] } }, /footer\.links\[0\]\.href/],
      ["a colour that is not one", { ...GOOD, accent: "orange" }, /accent: a colour as #rrggbb/],
      ["a card without its text", { ...GOOD, first_run: { heading: "H", cards: [{ title: "T" }] } }, /first_run\.cards\[0\]\.text: text is required/],
    ];
    for (const [what, v, re] of bad) assert.match(connectPageProblems(v).join("\n"), re, `${what}: ${connectPageProblems(v).join("; ")}`);
    ok(`the rules: a full block and the least one pass; ${bad.length} malformed ones refused, each naming the field (${bad.map((b) => b[0]).join(", ")})`);
  }

  // ---------- 2. the texts as HTML ----------
  {
    const fill = { product: "Acme", skill_file: "acme-skill.zip" };
    assert.equal(inlineHtml("Open **Settings → Connectors**, name it `{product}`.", fill), "Open <strong>Settings → Connectors</strong>, name it <code>Acme</code>.");
    assert.equal(inlineHtml("“Onboard: <one paragraph>” & go", fill), "“Onboard: &lt;one paragraph&gt;” &amp; go", "escaped first");
    assert.equal(inlineHtml("See [the skill](#skill) or [docs](/install?x=1&y=2).", fill), 'See <a href="#skill">the skill</a> or [docs](/install?x=1&amp;y=2).', "a link to an anchor; a query is no address of HREF and stays text");
    assert.equal(inlineHtml("[x](javascript:alert(1))", fill), "[x](javascript:alert(1))", "a script address is never a link");
    assert.equal(inlineHtml("`**not bold** <b>`", fill), "<code>**not bold** &lt;b&gt;</code>", "code is never read for the rest");
    assert.equal(inlineHtml("Select `{skill_file}`.", fill), "Select <code>acme-skill.zip</code>.");
    ok("the texts: escaped, then bold, code and links drawn (an address that is not one stays text), the placeholders filled");
  }

  // ---------- 3. gen-packs ----------
  {
    const base = { name: "Fixture", version: "1.0.0" };
    const on = world({ fixture_connect: { id: "fixture_connect", ...base, connect_page: GOOD } });
    assert.equal(on.status, 0, on.out.slice(-1200));
    const { $comment: _c, ...want } = GOOD;
    assert.deepEqual(packConfigOf(on.dir)?.find((c) => c.pack === "fixture_connect")?.connect_page, want, "the block, without its $comment, in PACK_CONFIG");
    const off = world({ fixture_plain: { id: "fixture_plain", ...base } });
    assert.equal(off.status, 0, off.out.slice(-1200));
    assert.ok(!(packConfigOf(off.dir) ?? []).some((c) => c.connect_page), "no connect page without one");
    const two = world({ fixture_connect: { id: "fixture_connect", ...base, connect_page: GOOD }, fixture_other: { id: "fixture_other", ...base, connect_page: { ...GOOD, path: "/other.html" } } });
    assert.ok(two.status !== 0 && /declares the connect guide too: one pack's/.test(two.out), two.out.slice(-800));
    const broken = world({ fixture_connect: { id: "fixture_connect", ...base, connect_page: { ...GOOD, path: "/mcp" } } });
    assert.ok(broken.status !== 0 && /connect_page\.path: \/mcp is the shell's own address/.test(broken.out), broken.out.slice(-800));
    ok("gen-packs: a pack's block (without its $comment) in PACK_CONFIG, nothing without one; two packs declaring one, or a broken block, refuse the build");
  }

  // ---------- 4. served ----------
  {
    const express = (await import("express")).default;
    const { setPackConfigsForTest } = await import("../src/host.js");
    const { mountInstallPages } = await import("../src/install-pages.js");
    const { clientSkillFile } = await import("../src/client-skill.js");
    const { PROFILE } = await import("../src/profile.js");
    const { $comment: _c, ...cfg } = GOOD;
    const serve = async (configs: unknown[]) => {
      setPackConfigsForTest(configs as never);
      const app = express();
      mountInstallPages(app, "https://front.example");
      const server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      return { get: (p: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`), close: () => new Promise((r) => server.close(r)) };
    };
    const s = await serve([{ pack: "fixture_connect", connect_page: cfg }]);
    const r = await s.get("/connect.html");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await r.text();
    const file = clientSkillFile();
    for (const want of [`<title>Connect ${PROFILE.name}</title>`, `<h1>Connect ${PROFILE.name}</h1>`, "<pre>https://front.example/mcp</pre>", 'href="/early-access">Request access</a>',
      "<h2>Claude (web &amp; desktop)</h2>", "<li>Open <strong>Settings → Connectors</strong>.</li>", `<a class="btn" href="/downloads/${file}" download>Download ${file}</a>`,
      `Select <code>${file}</code>.`, "<strong>1. Ask</strong>", "&lt;one paragraph&gt;", "Per-client setup is on <a href=\"/app\">your setup page</a>.", " · A tagline · <a href=\"/\">Home</a> · <a href=\"/#faq\">FAQ</a>", "--accent:#d9400f"])
      assert.ok(html.includes(want), `the page has ${want}`);
    await s.close();
    const { connectPageHtml } = await import("../src/install-pages.js");
    const withKeys = connectPageHtml(cfg as never, "https://front.example", { year: 2026, signIn: true, keys: true });
    assert.ok(withKeys.includes("you sign in with your work email") && withKeys.includes("Authorization: Bearer &lt;key&gt;") && withKeys.includes("© 2026 "), "sign-in and key sentences, the year");
    const noKeys = connectPageHtml(cfg as never, "https://front.example", { signIn: true, keys: false });
    assert.ok(!noKeys.includes("Authorization: Bearer") && noKeys.includes("you sign in with your work email"), "member keys off: no key sentence");
    const keysOnly = connectPageHtml(cfg as never, "https://front.example", { signIn: false, keys: true });
    assert.ok(keysOnly.includes("Connect with an API key") && !keysOnly.includes("cannot send a header"), "no sign-in: the key is the way in");
    const none = await serve([]);
    assert.equal((await none.get("/connect.html")).status, 404, "no page without a connect_page");
    await none.close();
    setPackConfigsForTest([]);
    ok("served: the page at its own address (the connector's address, sign-in and key sentences, the skill's download, the config's words, its headers); no page without one");
  }
  console.log(`\n${checks} checks passed`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
