// Export (mold_v0-108; src/record-export.ts, the generated export_<area> tools, web/src/features/tabs/export.tsx), offline:
// a build copy of the codebase with the fixture packs fixture_vulns (area tabs) and fixture_status (a merged tab), the API
// on an embedded database, and with --browser the console built in that copy.
//   npm run test:record-export
//   tsx scripts/record-export-test.ts [--browser] [--shots <dir>]
//
// 1. The CSV rules: quoting, lists, a file by its path, json, and text a spreadsheet would run as a formula defused.
// 2. gen-packs: every area gets <prefix>_export_<area>; a pack that excludes one keeps it off the MCP and lists the area
//    in exportWithheldAreas (the console offers no Export CSV there); zero packs: no export tool, nothing listed.
// 3. The API, two workspaces: an export holds the caller's own records and the shared ones, never another workspace's;
//    the area's read roles hold (a viewer is not offered an area it may not read, and is refused when it calls); filter
//    and sort are list_<area>'s; paging by next/after returns every record once, in order, when the rows or bytes run
//    out mid-page; a single record larger than an export is refused (413).
// 4. --browser: Export CSV on an area tab downloads the same file the MCP tool writes (with a byte-order mark for
//    spreadsheets), on a merged tab its Source column and every area's rows, on an area's records page too; never
//    another workspace's rows; axe finds no serious or critical violation on the tab, and it does not scroll sideways at
//    390 px.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INNER = process.argv.includes("--inner");
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const FIXTURES = ["fixture_vulns", "fixture_status"];

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

if (INNER) await inner();
else await outer();
process.exit(0);

async function outer() {
  // ---------- 1. the CSV rules ----------
  const { csvCell, exportHeader, exportRow } = await import("../src/record-export.js");
  assert.deepEqual([csvCell("plain"), csvCell("a,b"), csvCell('say "hi"'), csvCell("two\nlines"), csvCell(" padded"), csvCell(null), csvCell(3.5), csvCell(false)],
    ["plain", '"a,b"', '"say ""hi"""', '"two\nlines"', '" padded"', "", "3.5", "false"]);
  assert.deepEqual([csvCell("=SUM(1,2)"), csvCell("+1"), csvCell("-cmd"), csvCell("@x"), csvCell("\tx"), csvCell(-5)], ['"\'=SUM(1,2)"', "'+1", "'-cmd", "'@x", "'\tx", "-5"],
    "text a spreadsheet would run as a formula starts with an apostrophe; a number stays a number");
  assert.deepEqual([csvCell(["a", "b"]), csvCell([{ path: "docs/a.pdf", name: "A" }]), csvCell({ x: 1 })], ["a; b", "docs/a.pdf", '"{""x"":1}"']);
  const fields = [{ name: "a", label: "Alpha", type: "text" }, { name: "b", label: "Beta, two", type: "enum" }];
  assert.equal(exportHeader(fields), 'Key,Title,Alpha,"Beta, two",Updated\r\n');
  assert.equal(exportRow(fields, { key: "k1", title: null, data: { a: "x", b: "y" }, updated_at: "2026-10-25T00:00:00.000Z" }), "k1,,x,y,2026-10-25T00:00:00.000Z\r\n");
  ok("the CSV rules: RFC 4180 quoting, lists joined, a file by its path, json as text, formulas defused, numbers kept");

  // ---------- 2. gen-packs ----------
  const TMP = mkdtempSync(path.join(tmpdir(), "record-export-"));
  try {
    const copyOf = (name: string, edit: (id: string, j: any) => void = () => {}) => {
      const copy = path.join(TMP, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules", "orchestrator/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(realpathSync(path.join(ROOT, nm)), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      for (const p of FIXTURES) {
        cpSync(path.join(ROOT, "scripts", "fixtures", "packs", p), path.join(copy, "packs", p), { recursive: true });
        const f = path.join(copy, "packs", p, "pack.json");
        const j = JSON.parse(readFileSync(f, "utf8"));
        edit(p, j);
        writeFileSync(f, JSON.stringify(j, null, 2));
      }
      const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
      assert.equal(g.status, 0, `gen-packs (${name}): ${(g.stdout + g.stderr).slice(-1500)}`);
      return copy;
    };
    const withheld = (copy: string) => JSON.parse(/exportWithheldAreas: string\[\] = (\[[^\]]*\])/.exec(readFileSync(path.join(copy, "web", "src", "config", "pack-nav.generated.ts"), "utf8"))![1]!);
    assert.deepEqual(withheld(ROOT), [], "zero packs: nothing withheld");
    const one = copyOf("one");
    assert.deepEqual(withheld(one), []);
    const guide = readFileSync(path.join(one, "web", "src", "config", "pack-guides.generated.ts"), "utf8");
    for (const t of ["fixture_vulns_export_audit_findings", "fixture_vulns_export_audit_apps", "fixture_vulns_export_audit_controls", "fixture_status_export_req_own"])
      assert.ok(guide.includes(`"${t}"`), `${t} is generated (and in the customer guide's tool list)`);
    const held = copyOf("held", (id, j) => { if (id === "fixture_vulns") j.mcp = { ...(j.mcp ?? {}), exclude: ["fixture_vulns_export_audit_apps"] }; });
    assert.deepEqual(withheld(held), ["audit_apps"], "an excluded export: its area listed for the console");
    assert.ok(!readFileSync(path.join(held, "web", "src", "config", "pack-guides.generated.ts"), "utf8").includes('"fixture_vulns_export_audit_apps"'), "and off the MCP");
    ok("gen-packs: an export tool per area (in the guide's tool list); one a pack excludes is off the MCP and its area offers no Export CSV; zero packs, none");

    // ---------- 3 and 4: inside the build copy ----------
    const r = spawnSync(TSX, ["scripts/record-export-test.ts", "--inner", ...(BROWSER ? ["--browser"] : []), ...(SHOTS ? ["--shots", SHOTS] : [])],
      { cwd: one, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, AUTH_PROVIDER: "builtin" } });
    assert.equal(r.status, 0, "the checks inside the build copy");
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  console.log(`record-export: ${n} checks passed here${BROWSER ? "" : " (add --browser for the console)"}`);
}

// ---------- 3: the API ----------

async function inner() {
  const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
  const teardown: (() => unknown)[] = [];
  try {
    const http = await startHttp();
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    process.env.RESEND_API_URL = http.mock.url;
    await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
    const { dataApi } = await import("../src/data-api.js");
    const { putPlatform } = await import("../src/record-areas.js");
    const { exportArea } = await import("../src/record-export.js");
    const mt = await import("../src/mcp-tools.js");
    const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };
    const mkOrg = async (tag: string) => {
      const email = `owner-${tag}-${STAMP}@${tag}.example`;
      const r = await http.req("POST", "/api/admin/onboarding/orgs", adminH, { name: `Account ${tag} ${STAMP}`, email });
      assert.equal(r.status, 201);
      const slug = (await r.json()).org.slug;
      const [o] = await db.query<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE slug = $1", [slug]);
      return { email, org: { orgId: o!.id, name: o!.name, slug } as any };
    };
    const A = await mkOrg("a"), B = await mkOrg("b");
    const as = (o: { org: any }, role: "owner" | "member" | "viewer") => ({ orgId: o.org.orgId, role, userId: null });
    const fixture = (id: string) => JSON.parse(readFileSync(path.join("packs", id, "pack.json"), "utf8"));
    const optionOf = (pack: string, area: string, field: string) => {
      const f = fixture(pack).record_areas.find((a: any) => a.name === area).fields.find((x: any) => x.name === field);
      const o = f.options[0]; return typeof o === "string" ? o : o.value;
    };
    // Records: A's and B's own, and a shared control.
    await putPlatform(null, "audit_controls", "c-1", { title: "Shared control", data: { regulator: optionOf("fixture_vulns", "audit_controls", "regulator"), summary: "Keep it" } });
    for (const [o, tag] of [[A, "a"], [B, "b"]] as const) {
      await dataApi.create(as(o, "owner"), "audit_apps", `app-${tag}`, { title: tag === "a" ? "=SUM(1,2)" : "B's app", data: { url: `https://${tag}.example`, environment: optionOf("fixture_vulns", "audit_apps", "environment") } });
      for (let i = 1; i <= 7; i++)
        await dataApi.create(as(o, "owner"), "audit_findings", `f-${tag}${i}`, { title: `${tag.toUpperCase()} finding ${i}`, data: { severity: i % 2 ? "high" : "low", app: `app-${tag}`, due: `2026-11-0${i}`, cvss: i } });
    }
    const csvOf = async (o: any, area: string, q = {}, limits?: { rows: number; bytes: number }) => exportArea(as(o, "owner"), area, q, limits);
    const a = await csvOf(A, "audit_findings"), b = await csvOf(B, "audit_findings");
    assert.equal(a.records, 7); assert.equal(a.next, null);
    assert.match(a.csv, /^Key,Title,Severity,State,Application,Control,Regulator,Fix by,CVSS,Updated\r\n/);
    assert.match(a.csv, /\r\nf-a1,A finding 1,high,open,app-a,,,2026-11-01,1,\d{4}-/);
    assert.ok(!/f-b|B finding/.test(a.csv) && !/f-a|A finding/.test(b.csv), "never the other workspace's rows");
    assert.match((await csvOf(A, "audit_apps")).csv, /\r\napp-a,'=SUM\(1,2\)|\r\napp-a,"'=SUM\(1,2\)"/, "a title that is a formula is defused");
    assert.match((await csvOf(B, "audit_controls")).csv, /\r\nc-1,Shared control,/, "a shared area's rows in every workspace's export");
    ok("the API: each workspace's export holds its own records and the shared ones, never the other's; the header in the area's labels; a formula defused");

    // Filter and sort are list_<area>'s; paging returns every record once, in order.
    const high = await csvOf(A, "audit_findings", { filter: { severity: "high" }, sort: "-cvss" });
    assert.deepEqual(high.csv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0]), ["f-a7", "f-a5", "f-a3", "f-a1"], "filtered and sorted as list_<area>");
    const all: string[] = [];
    let after: string | undefined, calls = 0;
    do {
      const page = await csvOf(A, "audit_findings", { after }, { rows: 3, bytes: 1e6 });
      all.push(...page.csv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0]!));
      after = page.next ?? undefined; calls++;
    } while (after);
    assert.deepEqual([all, calls], [["f-a1", "f-a2", "f-a3", "f-a4", "f-a5", "f-a6", "f-a7"], 3], "3 rows a call: every record once, in order");
    const header = Buffer.byteLength(a.csv.split("\r\n")[0]! + "\r\n");
    const lineBytes = Buffer.byteLength(a.csv.split("\r\n")[1]! + "\r\n");
    const byBytes: string[] = [];
    after = undefined;
    do {
      const page = await csvOf(A, "audit_findings", { after }, { rows: 100, bytes: header + 2 * lineBytes + 5 });
      assert.ok(page.records <= 2, "cut mid-page by size");
      byBytes.push(...page.csv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0]!));
      after = page.next ?? undefined;
    } while (after);
    assert.deepEqual(byBytes, all, "cut by size mid-page: next is the cursor after the last record it holds");
    await assert.rejects(csvOf(A, "audit_findings", {}, { rows: 100, bytes: header + 10 }), /larger than an export may hold/);
    ok("filter and sort as list_<area>; paging by rows and by size (mid-page) returns every record once, in order; a record larger than an export is refused");

    // Roles: audit_apps is read by member, billing and owner only.
    const viewerOffered = (await mt.generatedTools()).filter((t) => t.door === "workspace" && mt.permitted(t, "viewer")).map((t) => t.name);
    assert.ok(!viewerOffered.includes("fixture_vulns_export_audit_apps") && viewerOffered.includes("fixture_vulns_export_audit_findings"), "a viewer is offered only the exports it may read");
    await assert.rejects(exportArea(as(A, "viewer"), "audit_apps"), /Viewer/);
    const called = await mt.callGeneratedTool({ ...A.org, role: "viewer" }, "fixture_vulns_export_audit_apps", {});
    assert.ok(called.isError, "called anyway: refused");
    const viaTool = await mt.callGeneratedTool(A.org, "fixture_vulns_export_audit_findings", {});
    assert.equal((viaTool.structuredContent as any).csv, a.csv, "the MCP tool's file is the export's");
    ok("roles: a viewer is not offered an area it may not read and is refused when it calls; the tool writes the same file");

    if (BROWSER) await browserChecks({ http, db, A, B, STAMP, TMP, teardown, mcpCsv: a.csv, exportArea, as });
  } finally {
    for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort */ } }
    cleanup();
  }
}

// ---------- 4: the console ----------

async function freePort() {
  return new Promise<number>((res, rej) => {
    const s = netServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

async function browserChecks(w: any) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const apiPort = await freePort();
  const web = path.join(ROOT, "web");
  const out = path.join(w.TMP, "console");
  cpSync(web, path.join(out, "web"), { recursive: true, filter: (src) => !["node_modules", ".next", ".turbo"].includes(path.basename(src)) && !path.basename(src).startsWith(".env") });
  symlinkSync(realpathSync(path.join(web, "node_modules")), path.join(out, "web", "node_modules"), "dir");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_AUTH_PROVIDER: "builtin", APP_API_URL: `http://127.0.0.1:${apiPort}` };
  console.log("  next build of the console…");
  const b = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) throw new Error(`next build failed:\n${(b.stdout + b.stderr).split("\n").slice(-40).join("\n")}`);
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  process.env.PUBLIC_URL = origin;
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  w.teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], { cwd: path.join(out, "web"), stdio: ["ignore", "pipe", "pipe"], env });
  let log = "";
  next.stdout?.on("data", (d) => { log = (log + d).slice(-8000); }); next.stderr?.on("data", (d) => { log = (log + d).slice(-8000); });
  w.teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { up = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })).status < 500; } catch { await wait(1000); }
  }
  assert.ok(up, `the console came up on ${origin}:\n${log}`);

  // A's owner signs in with an emailed code (the built-in sign-in).
  const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
  const h = { "x-forwarded-for": "198.51.100.9" };
  assert.equal((await w.http.req("POST", "/api/auth/email/request", h, { email: w.A.email })).status, 200);
  let code: string | null = null;
  for (let i = 0; i < 200 && !code; i++) {
    const m = (w.http.mock.state.emails as any[]).filter((e) => e.to.includes(w.A.email) && kindOf(e) === "sign_in_code").at(-1);
    code = m ? /sign-in code is (\d{8})/.exec(m.text)![1]! : null;
    if (!code) await wait(20);
  }
  const v = await w.http.req("POST", "/api/auth/email/verify", h, { email: w.A.email, code });
  assert.equal(v.status, 200);
  const cookie = v.headers.getSetCookie().find((c: string) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c))!.split(";")[0]!;

  const AXE = readFileSync(path.resolve(ROOT, "..", "testing", "accessibility", "vendor", "axe.min.js"), "utf8");
  const browser = await pw.chromium.launch();
  w.teardown.push(() => browser.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const ctx = async (width = 1280) => {
    const c = await browser.newContext({ baseURL: origin, acceptDownloads: true, serviceWorkers: "block", reducedMotion: "reduce", viewport: { width, height: 900 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    await c.addCookies([{ name: cookie.split("=")[0]!, value: cookie.slice(cookie.indexOf("=") + 1), url: origin }]);
    return c;
  };
  const download = async (p: any) => {
    const [d] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.locator('[data-testid="export-csv"]').click()]);
    return { name: d.suggestedFilename() as string, text: readFileSync(await d.path(), "utf8") };
  };
  const c = await ctx();
  const p = await c.newPage();
  // An area tab: the same file as the MCP tool's, with a byte-order mark for spreadsheets.
  await p.goto("/app/packs/fixture_vulns/vulnerabilities", { waitUntil: "networkidle" });
  await p.locator('[data-testid="export-csv"]').waitFor({ timeout: 20000 });
  await p.locator("table").first().waitFor({ timeout: 20000 });
  const tab = await download(p);
  assert.match(tab.name, /^fixture_vulns-vulnerabilities-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(tab.text, `\ufeff${w.mcpCsv}`, "the tab's file is the MCP tool's");
  assert.match(await p.locator('[role="status"]').filter({ hasText: "exported" }).innerText(), /7 records exported/);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "export-tab-1280.png"), fullPage: true });
  await p.addScriptTag({ content: AXE });
  const found = await p.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] }))
    .violations.map((x: any) => ({ id: x.id, impact: x.impact, target: x.nodes[0]?.target?.join(" ") })));
  assert.deepEqual(found.filter((x: any) => x.impact === "serious" || x.impact === "critical"), [], "axe on the tab");
  // A merged tab: its Source column and every area's rows.
  await p.goto("/app/packs/fixture_status/ours", { waitUntil: "networkidle" });
  await p.locator('[data-testid="export-csv"]').waitFor({ timeout: 20000 });
  const merged = await download(p);
  assert.match(merged.text, /^\ufeffKey,Title,Source,/, "the merged tab's Source column");
  // An area's records page.
  await p.goto("/app/records/audit_apps", { waitUntil: "networkidle" });
  await p.locator('[data-testid="export-csv"]').waitFor({ timeout: 20000 });
  const apps = await download(p);
  assert.ok(apps.text.includes("\r\napp-a,") && !apps.text.includes("app-b"), "the records page's file: A's application, never B's");
  await c.close();
  const narrow = await ctx(390);
  const q = await narrow.newPage();
  await q.goto("/app/packs/fixture_vulns/vulnerabilities", { waitUntil: "networkidle" });
  await q.locator('[data-testid="export-csv"]').waitFor({ timeout: 20000 });
  const wide = await q.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(wide[0]! <= wide[1]! + 1, `the tab at 390 px scrolls sideways (${wide[0]} > ${wide[1]})`);
  if (SHOTS) await q.screenshot({ path: path.join(SHOTS, "export-tab-390.png"), fullPage: true });
  await narrow.close();
  ok("the console: Export CSV on an area tab is the MCP tool's file (with a byte-order mark), a merged tab's has its Source column, an area's records page exports its own rows only; axe clean; nothing scrolls sideways at 390 px");
}
