// Tests for diff.mts (and the masks snapshot.mts applies, mask.mts). No lane world, no browser: snapshots are written
// by hand into a temporary folder.
//   <codebase>/node_modules/.bin/tsx --test molds/mold_v0/testing/parity/diff.test.mts      (parity.py --self-test runs it)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { compare, globKey, jsonDiff, lineDiff, render, unified, type AllowEntry } from "./diff.mts";
import { maskJson, maskText } from "./mask.mts";
import { fileFor, promptMatrix } from "./snapshot.mts";

const ROOT = mkdtempSync(path.join(tmpdir(), "parity-diff-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

type Snap = {
  packs?: unknown[]; customer?: Record<string, unknown>; admin?: Record<string, unknown>; generated?: Record<string, string>;
  routes?: string[]; api?: Record<string, unknown>; pages?: Record<string, unknown>[]; shots?: Record<string, Buffer>; smoke?: unknown;
};
const base = (): Snap => ({
  packs: [{ id: "octillion", name: "octillion", kind: "host" }],
  customer: {
    initialize: { server: { name: "x", version: "1" }, instructions: "Use the tools.\nCall get_started first." },
    tools: { tools: [
      { name: "get_started", description: "Start here", inputSchema: { type: "object" } },
      { name: "list_products", description: "Every product", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ] },
    prompts: { prompts: [{ name: "review", arguments: [{ name: "product" }] }] },
    prompt_get: { review: [{ args: {}, answer: { messages: [{ content: { text: "Review it" } }] } }, { args: { product: "parity-product" }, answer: { messages: [{ content: { text: "Review parity-product" } }] } }] },
    resources: { resources: [{ uri: "ui://widget/dashboard.html", name: "dashboard" }] },
    resource_read: { "ui://widget/dashboard.html": { contents: [{ text: "<html>\n<body>a</body>\n</html>" }] } },
  },
  generated: { "web/src/config/landing.generated.ts": "export const landing = {\n  title: 'A',\n  lead: 'B',\n};\n", "web/src/content/mcp-tools.generated.json": JSON.stringify({ tools: [{ name: "a" }] }) },
  routes: ["GET /api/app/setup", "GET /healthz"],
  api: { "api_app_setup.json": { path: "/api/app/setup", as: "owner", status: 200, body: { steps: [{ id: "connect", done: false }] } } },
  pages: [{ pack: "shell", path: "/app", label: "/app", signed_in: true, status: 200, at: "/app", title: "App", text: ["Welcome", "Your workspace"], links: [{ href: "/app/team", text: "Team" }] }],
  smoke: { octillion: { pass: true } },
});

function write(s: Snap): string {
  const d = path.join(ROOT, `s${n++}`);
  const w = (rel: string, body: string | Buffer) => { const f = path.join(d, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body); };
  w("meta.json", JSON.stringify({ packs: s.packs ?? [], seconds: { mcp: Math.random() } }));
  if (s.customer) w("mcp/customer.json", JSON.stringify(s.customer));
  if (s.admin) w("mcp/admin.json", JSON.stringify(s.admin));
  for (const [f, body] of Object.entries(s.generated ?? {})) w(`generated/${f}`, body);
  if (s.routes) w("api/routes.json", JSON.stringify(s.routes));
  for (const [f, body] of Object.entries(s.api ?? {})) w(`api/${f}`, JSON.stringify(body));
  for (const p of s.pages ?? []) w(`pages/${fileFor(String(p.path))}.json`, JSON.stringify(p));
  for (const [sha, png] of Object.entries(s.shots ?? {})) w(`shots/${sha}.png`, png);
  if (s.smoke) w("smoke.json", JSON.stringify(s.smoke));
  return d;
}
const keys = (a: Snap, b: Snap, allow: AllowEntry[] = []) => compare(write(a), write(b), { allow }).differences.map((d) => `${d.kind} ${d.key}`);

test("lineDiff: the script rebuilds both sides, on random edits", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 300; i++) {
    const a = Array.from({ length: Math.floor(rnd() * 12) }, () => "abcde"[Math.floor(rnd() * 5)]!);
    const b = Array.from({ length: Math.floor(rnd() * 12) }, () => "abcde"[Math.floor(rnd() * 5)]!);
    const ops = lineDiff(a, b);
    assert.deepEqual(ops.filter(([o]) => o !== "+").map(([, l]) => l), a, `a from ${JSON.stringify([a, b])}`);
    assert.deepEqual(ops.filter(([o]) => o !== "-").map(([, l]) => l), b, `b from ${JSON.stringify([a, b])}`);
  }
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), [[" ", "a"], ["-", "b"], ["+", "x"], [" ", "c"]]);
});

test("unified: changed lines with context, capped", () => {
  const a = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const b = [...a]; b[10] = "changed"; b[40] = "also";
  const u = unified(a.join("\n"), b.join("\n"));
  assert.ok(u.includes("- line 10") && u.includes("+ changed") && u.includes("  ...") && u.includes("+ also"));
  assert.ok(!u.includes("  line 20"));
  assert.equal(unified(a.join("\n"), b.join("\n"), 3).at(-1), "  ... (10 more lines of diff)");
});

test("jsonDiff: named arrays match by name; order is its own difference", () => {
  const d = jsonDiff([{ name: "a", v: 1 }, { name: "b", v: 2 }], [{ name: "b", v: 3 }, { name: "a", v: 1 }]);
  assert.deepEqual(d.map((x) => [x.at.join("/"), x.kind]), [["b/v", "changed"], ["(order)", "changed"]]);
  assert.deepEqual(jsonDiff({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(jsonDiff({ a: 1 }, { b: 1 }).map((x) => x.kind), ["removed", "added"]);
});

test("the same snapshot twice: no difference (timings in meta are ignored)", () => {
  const r = compare(write(base()), write(base()));
  assert.deepEqual(r.differences, []);
  assert.match(render(r), /parity: no difference/);
});

test("MCP: a tool's description, a new tool, a prompt's text, the instructions, a widget", () => {
  const b = base();
  const c = structuredClone(b.customer!) as any;
  c.tools.tools[1].description = "Every product you own";
  c.tools.tools.push({ name: "get_product", description: "One", inputSchema: { type: "object" } });
  c.prompt_get.review[1].answer.messages[0].content.text = "Review parity-product now";
  c.initialize.instructions = "Use the tools.\nCall get_started first, always.";
  c.resource_read["ui://widget/dashboard.html"].contents[0].text = "<html>\n<body>b</body>\n</html>";
  const got = keys(b, { ...b, customer: c });
  assert.deepEqual(got.sort(), [
    "added mcp.customer::tools::get_product",
    "changed mcp.customer::initialize::instructions",
    "changed mcp.customer::prompt_get::review::product::messages::[0]::content::text",
    "changed mcp.customer::resource_read::ui://widget/dashboard.html::contents::[0]::text",
    "changed mcp.customer::tools::list_products::description",
  ]);
  const r = compare(write(b), write({ ...b, customer: c }));
  const text = render(r);
  assert.match(text, /## mcp\.customer \(5\)/);
  assert.match(text, /- <body>a<\/body>\n\s+\+ <body>b<\/body>/);
  assert.match(text, /"Every product" -> "Every product you own"/);
});

test("MCP: a tool removed and the order changed", () => {
  const b = base();
  const c = structuredClone(b.customer!) as any;
  c.tools.tools = [c.tools.tools[1], { name: "z", description: "" }];
  assert.deepEqual(keys(b, { ...b, customer: c }).sort(), ["added mcp.customer::tools::z", "removed mcp.customer::tools::get_started"]);
  const d = structuredClone(b.customer!) as any;
  d.tools.tools.reverse();
  assert.deepEqual(keys(b, { ...b, customer: d }), ["changed mcp.customer::tools::(order)"]);
});

test("generated files: lines of a file, JSON by field, a file added", () => {
  const b = base();
  const g = { ...b.generated!, "web/src/config/landing.generated.ts": b.generated!["web/src/config/landing.generated.ts"]!.replace("'B'", "'C'"),
    "web/src/content/mcp-tools.generated.json": JSON.stringify({ tools: [{ name: "a" }, { name: "b" }] }), "src/new.generated.ts": "x" };
  const r = compare(write(b), write({ ...b, generated: g }));
  assert.deepEqual(r.differences.map((d) => `${d.kind} ${d.key}`).sort(), [
    "added generated::src/new.generated.ts",
    "added generated::web/src/content/mcp-tools.generated.json::tools::b",
    "changed generated::web/src/config/landing.generated.ts",
  ]);
  const landing = r.differences.find((d) => d.key.endsWith("landing.generated.ts"))!;
  assert.deepEqual(landing.detail.filter((l) => /^[+-]/.test(l)), ["-   lead: 'B',", "+   lead: 'C',"]);
});

test("API: a route gone, an answer's field changed", () => {
  const b = base();
  const api = { "api_app_setup.json": { path: "/api/app/setup", as: "owner", status: 200, body: { steps: [{ id: "connect", done: true }] } } };
  assert.deepEqual(keys(b, { ...b, routes: ["GET /api/app/setup"], api }).sort(), [
    "changed api::/api/app/setup::body::steps::connect::done",
    "removed api::routes::GET /healthz",
  ]);
});

test("pages: text lines, a link, a status, a page added", () => {
  const b = base();
  const p = { ...b.pages![0]!, text: ["Welcome back", "Your workspace"], links: [{ href: "/app/team", text: "Team" }, { href: "/app/billing", text: "Billing" }], status: 500 };
  const q = { pack: "octillion", path: "/app/products", label: "Products", signed_in: true, status: 200, text: [], links: [] };
  const r = compare(write(b), write({ ...b, pages: [p, q] }));
  assert.deepEqual(r.differences.map((d) => `${d.kind} ${d.key}`).sort(), [
    "added pages::/app/products",
    "changed pages::/app::links",
    "changed pages::/app::status",
    "changed pages::/app::text",
  ]);
  assert.deepEqual(r.differences.find((d) => d.key === "pages::/app::links")!.detail.filter((l) => l.startsWith("+")), ["+ Billing -> /app/billing"]);
});

test("allow list: globs, the allowed section, stale entries, exit status by what is left", () => {
  const b = base();
  const c = structuredClone(b.customer!) as any;
  c.tools.tools[0].description = "Begin";
  c.tools.tools[1].description = "All";
  const allow = [{ key: "mcp.customer::tools::*::description", reason: "P1 rewords the tools" }, { key: "pages::**", reason: "nothing here" }];
  const r = compare(write(b), write({ ...b, customer: c }), { allow });
  assert.equal(r.differences.length, 0);
  assert.equal(r.allowed.length, 2);
  assert.deepEqual(r.stale.map((e) => e.key), ["pages::**"]);
  const text = render(r, "P1");
  assert.match(text, /# 2 allowed difference\(s\) \(P1\)/);
  assert.match(text, /allowed: P1 rewords the tools/);
  assert.match(text, /1 allow-list entry matched nothing/);
  assert.match(text, /parity: no difference outside the allow list \(2 allowed\)/);
  // `*` stops at "::"; `**` does not.
  assert.ok(globKey("mcp.customer::tools::*").test("mcp.customer::tools::get_started"));
  assert.ok(!globKey("mcp.customer::tools::*").test("mcp.customer::tools::get_started::description"));
  assert.ok(globKey("mcp.customer::**").test("mcp.customer::tools::get_started::description"));
  assert.ok(globKey("pages::/app?x=1::text").test("pages::/app?x=1::text"), "regex characters in a key are literal");
});

test("smoke: a pass that turns into a failure is a difference", () => {
  const b = base();
  assert.deepEqual(keys(b, { ...b, smoke: { octillion: { pass: false } } }), ["changed smoke::octillion::pass"]);
});

test("screenshots: same hash, a few pixels, past the threshold, a missing shot", (t) => {
  let PNG: any;
  try {
    const req = createRequire("/usr/lib/node_modules/playwright/");
    PNG = req(path.join(path.dirname(req.resolve("playwright-core/package.json")), "lib", "utilsBundle.js")).PNG;
  } catch { /* below */ }
  if (!PNG) return t.skip("no PNG encoder (the VM-wide Playwright) on this machine");
  const img = (w: number, h: number, dots: number) => {
    const p = new PNG({ width: w, height: h });
    p.data.fill(255);
    for (let i = 0; i < dots; i++) { p.data[i * 4] = 0; p.data[i * 4 + 1] = 0; p.data[i * 4 + 2] = 0; }
    return PNG.sync.write(p) as Buffer;
  };
  const b = base();
  const page = (shots: Record<string, string>) => [{ ...b.pages![0]!, shots }];
  const A = { ...b, pages: page({ "390-dark": "a", "1440-dark": "a" }), shots: { a: img(100, 100, 0) } };
  assert.deepEqual(keys(A, A), []);
  // 5 pixels of 10 000 (0.05%) is under the 0.1% default; 50 (0.5%) is over it.
  assert.deepEqual(keys(A, { ...b, pages: page({ "390-dark": "b", "1440-dark": "a" }), shots: { a: img(100, 100, 0), b: img(100, 100, 5) } }), []);
  const r = compare(write(A), write({ ...b, pages: page({ "390-dark": "c" }), shots: { c: img(100, 100, 50) } }));
  assert.deepEqual(r.differences.map((d) => `${d.kind} ${d.key}`), ["changed shots::/app::390-dark", "removed shots::/app::1440-dark"]);
  assert.match(r.differences[0]!.summary, /0\.50% of pixels differ/);
  // A taller page: the extra area counts.
  const tall = compare(write(A), write({ ...b, pages: page({ "390-dark": "d", "1440-dark": "a" }), shots: { a: img(100, 100, 0), d: img(100, 110, 0) } }));
  assert.match(tall.differences[0]!.summary, /100x100 -> 100x110/);
});

test("a folder that is not a snapshot is refused", () => {
  assert.throws(() => compare(ROOT, write(base())), /not a parity snapshot/);
});

test("masks: times, ports, minted ids and keys go; the build's own words stay", () => {
  assert.equal(maskText("at 2026-10-24T14:17:49.123Z on 127.0.0.1:43123"), "at <date> on 127.0.0.1:<port>");
  assert.equal(maskText("Created Oct 24, 2026, 2:17 PM by user_2x9Lk3mQpR"), "Created <date>, <clock> by user_<id>");
  assert.equal(maskText("key oct_AbC123dEf456GhI789jKl0 shown once"), "key oct_<key> shown once");
  assert.equal(maskText("5 minutes ago; just now"), "<ago>; <ago>");
  assert.equal(maskText("default oct_79_3IT… Never"), "default oct_<key>… Never");
  const link = `cursor://x/install?config=${Buffer.from(JSON.stringify({ url: "http://127.0.0.1:42889/mcp" })).toString("base64")}`;
  assert.equal(maskText(link), 'cursor://x/install?config=b64({"url":"http://127.0.0.1:<port>/mcp"})');
  // Words that look like ids but are the build's: kept.
  assert.equal(maskText("list_developer_profiles org_settings Keys expire after 30 days"), "list_developer_profiles org_settings Keys expire after 30 days");
  assert.deepEqual(maskJson({ created_at: "2026-10-24", updatedAt: 1761315469000, count: 3, format: "pdf", items: 2, name: "x" }),
    { count: 3, created_at: "<time>", format: "pdf", items: 2, name: "x", updatedAt: "<time>" });
  assert.deepEqual(maskJson({ list: [{ last_seen: null }] }), { list: [{ last_seen: null }] });
  assert.deepEqual(maskJson({ key_prefix: "oct_GY4Mf7", elapsed_days: 23.66, prefix: "none" }), { elapsed_days: "<time>", key_prefix: "oct_<key>", prefix: "none" });
});

test("snapshot helpers: file names, the prompt argument matrix", () => {
  assert.equal(fileFor("/"), "root");
  assert.equal(fileFor("/app?lane=no-account#no_account"), "app_lane_no-account_no_account");
  assert.equal(fileFor("/admin/packs/maxwell/coverage"), "admin_packs_maxwell_coverage");
  assert.deepEqual(promptMatrix([]), [{}]);
  assert.deepEqual(promptMatrix([{ name: "a" }]), [{}, { a: "parity-a" }]);
  assert.deepEqual(promptMatrix([{ name: "a" }, { name: "b" }]), [{}, { a: "parity-a" }, { b: "parity-b" }, { a: "parity-a", b: "parity-b" }]);
});
