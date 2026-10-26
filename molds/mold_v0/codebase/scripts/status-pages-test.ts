// The console's standard status pages (mold_v0-131; web/src/features/status/, the not-found, forbidden and error files
// under web/src/app, src/status-pages.ts), under both sign-ins, offline: an embedded database and the mock providers.
//   npm run test:status-pages                                 both: builtin, then clerk (the words and the API only)
//   tsx scripts/status-pages-test.ts builtin|clerk [--browser] [--shots <dir>]
//
// Always:
// 1. The words: every kind has a title and one sentence, no placeholder left unfilled; the API's plain not-found page
//    says the console's words (src/status-pages.ts NOT_FOUND_WORDS = statusText('not_found')). Which addresses are
//    pages (mold_v0-155, web/src/lib/console-routes.ts): every dynamic route decided, unknown ones in each area known.
// 2. The API: a browser's unknown address is a 404 page (the console's when it answers, else the plain one with the same
//    words); an API client's, an /api address and the API's own pages are answered as before.
// With --browser, the console itself (next build for this sign-in, next start against this API; under Clerk the lane
// stand-in for @clerk/nextjs, molds/mold_v0/testing/console/clerk-standin), every row asserting the HTTP status and the
// standard page (data-status-page):
// 3. Signed out: /app, /app/usage, /admin and an unknown /app address go to sign-in (built-in: and back after).
// 4. Unknown addresses: the site's, the portal's, the admin console's, sign-in's, a pack page, a record area, a doc, a
//    host page: 404 and the not-found page, inside the area's shell where there is one; never the API's own text; drawn
//    on the server (mold_v0-155): the page's HTML carries it and its links.
// 5. Denied: /admin and any address under it for someone who is not platform staff is a 403 that names them and leads
//    to their account; staff see the admin console's 404 for an unknown address there.
// 6. The data hooks: a portal page whose API answer is 401, 403 (a role, with the role it needs), 403 suspended,
//    403 no_account, 404, 500 or no answer shows the status page for it (Try again where it helps), never a raw error
//    card or nothing; a suspended member and (Clerk) someone in an organization that is not an account meet theirs for
//    real; the admin console's account page for an account that is not there says not found.
// 7. axe (testing/accessibility/vendor/axe.min.js): no serious or critical WCAG A/AA violation on the status pages, dark
//    and light; at 390, 820 and 1440 px nothing scrolls sideways. Screenshots go to --shots <dir>.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
process.env.AUTH_PROVIDER = PROVIDER;
const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
const ROOT = path.resolve(import.meta.dirname, "..");
const TESTING = path.resolve(ROOT, "..", "testing");
const STAFF = `staff-${STAMP}@platform.example`;

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teardown: (() => unknown)[] = [];
type H = Record<string, string>;
interface Person { email: string; userId: string; h: () => Promise<H>; cookies: () => Promise<{ name: string; value: string }[]> }

try {
  // ---------- 1. the words ----------
  const words = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "status", "words.ts")).href);
  const { NOT_FOUND_WORDS, plainNotFound, NOT_FOUND_PAGE, forgetKeptPage } = await import("../src/status-pages.js");
  {
    const kinds = ["not_found", "denied", "staff_only", "suspended", "signed_out", "no_account", "error", "offline"];
    for (const k of kinds) for (const o of [{}, { role: "Owner" }, { area: "admin" }, { email: "a@b.example" }]) {
      const t = words.statusText(k, o);
      assert.ok(t.title && t.body, `${k}: a title and a sentence`);
      assert.doesNotMatch(t.title + t.body, /[{}]/, `${k}: no placeholder left (${t.title} / ${t.body})`);
    }
    assert.match(words.statusText("denied", { role: "Billing manager" }).body, /Billing manager role/);
    assert.match(words.statusText("staff_only", { email: "x@y.example" }).body, /^x@y\.example /);
    const nf = words.statusText("not_found");
    assert.equal(NOT_FOUND_WORDS.title, nf.title, "the API's plain page has the console's title");
    assert.equal(NOT_FOUND_WORDS.body, nf.body, "and its sentence");
    assert.equal(NOT_FOUND_WORDS.home, words.STATUS_ACTIONS.home.site, "and its action");
    assert.equal(words.signInHref("/app/usage?x=1"), "/auth/sign-in?redirect_url=%2Fapp%2Fusage%3Fx%3D1");
    for (const bad of ["//evil.example", "https://evil.example", "/auth/sign-in", null]) assert.equal(words.signInHref(bad), "/auth/sign-in", `no return to ${bad}`);
    ok("the words: every kind has a title and one sentence with no placeholder left; the API's plain not-found page says the same; sign-in returns only to this site's pages");
  }

  // ---------- 1b. which addresses are pages (mold_v0-155: web/src/proxy.ts answers any other with a 404 drawn on the server) ----------
  {
    const routes = await import(pathToFileURL(path.join(ROOT, "web", "src", "lib", "console-routes.ts")).href);
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "web", "src", "config", "console-routes.generated.json"), "utf8")) as { routes: string[]; status_pages: string[] };
    const undecided = manifest.routes.filter((r) => r.includes("[") && !(r in routes.RESOLVED) && !routes.OPEN.includes(r));
    assert.deepEqual(undecided, [], "every dynamic page route is resolved from its registry (src/lib/console-routes.ts RESOLVED) or left OPEN to its page");
    for (const r of [...Object.keys(routes.RESOLVED), ...routes.OPEN, ...Object.keys(routes.SHOWN)]) assert.ok(manifest.routes.includes(r), `${r}: a page route of the app directory`);
    assert.deepEqual(manifest.status_pages, ["/console-status/not-found"], "the console-status page the API relays: no page of the build either (a 404)");
    const doc = (await import(pathToFileURL(path.join(ROOT, "web", "src", "content", "customer-guide.ts")).href)).guidePages(JSON.parse(readFileSync(path.join(ROOT, "web", "src", "content", "mcp-tools.generated.json"), "utf8")))[0].slug;
    const adminDoc = (await import(pathToFileURL(path.join(ROOT, "web", "src", "content", "admin-docs.generated.ts")).href)).ADMIN_DOCS[0]?.slug;
    const known = ["/app", "/app/billing", "/app/usage", "/app/docs", `/app/docs/${doc}`, "/admin", "/admin/health", "/admin/accounts/any-account", "/auth/sign-in", "/auth/sign-in/factor-one", "/auth/sign-up", "/auth/consent", ...(adminDoc ? [`/admin/docs/${adminDoc}`] : [])];
    const unknown = ["/app/no-such-page", "/app/records", "/app/records/no-area", "/app/records/no-area/key-1", "/app/packs/no-pack/no-page", "/app/docs/no-such-doc", "/app/host/no-pack/x", "/app/a/b/c",
      "/admin/no-such-page", "/admin/docs/no-such-doc", "/admin/records/no-area", "/admin/packs/no-pack/no-page", "/auth/no-such-page", ...manifest.status_pages];
    for (const a of known) assert.equal(routes.isConsoleAddress(a), true, `${a}: a page of this build`);
    for (const a of unknown) assert.equal(routes.isConsoleAddress(a), false, `${a}: no page of this build`);
    for (const [a, area] of [["/app/x", "app"], ["/admin/x/y", "admin"], ["/auth/x", "auth"], ["/console-status/not-found", "site"], ["/privacy", "site"]])
      assert.equal(routes.notFoundAreaFor(a), area);
    ok(`the console's addresses: ${manifest.routes.length} page routes (every dynamic one resolved from its registry or left to its page), the build's docs and pages known; unknown addresses in every area are drawn as that area's not-found page`);
  }

  const http = await startHttp();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  process.env.RESEND_API_URL = http.mock.url;
  await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
  const call = async (method: string, p: string, h: H = {}, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const t = await r.text();
    let json: any = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = t; }
    return { status: r.status, body: json, headers: r.headers, text: t };
  };

  // ---------- 2. the API: a browser's unknown address ----------
  {
    // No console answers on PUBLIC_URL here (the API itself): the plain page, never a loop.
    process.env.PUBLIC_URL = http.base;
    forgetKeptPage();
    const html = await call("GET", "/no-such-page-anywhere", { accept: "text/html,application/xhtml+xml" });
    assert.equal(html.status, 404);
    assert.match(String(html.headers.get("content-type")), /text\/html/);
    assert.match(html.text, /data-status-page="not_found"/);
    assert.ok(html.text.includes(NOT_FOUND_WORDS.title) && html.text.includes(NOT_FOUND_WORDS.body.replace(/'/g, "&#39;")), "the console's words");
    assert.equal(html.text, plainNotFound(), "the plain page (the console did not answer)");
    const relayed = await call("GET", NOT_FOUND_PAGE, { accept: "text/html", "x-status-relay": "1" });
    assert.equal(relayed.status, 404); assert.doesNotMatch(relayed.text, /data-status-page/, "a relayed request is never relayed again");
    const json = await call("GET", "/no-such-page-anywhere", { accept: "application/json" });
    assert.equal(json.status, 404); assert.doesNotMatch(json.text, /data-status-page/, "an API client gets the API's answer");
    const api = await call("GET", "/api/no-such-route", { accept: "text/html" });
    assert.equal(api.status, 404); assert.doesNotMatch(api.text, /data-status-page/, "an /api address is never a page");
    assert.equal((await call("GET", "/healthz", { accept: "text/html" })).status, 200, "the API's own addresses answer as before");
    assert.equal((await call("GET", "/install", { accept: "text/html" })).status, 200);
    assert.equal((await call("POST", "/no-such-page-anywhere", { accept: "text/html" }, {})).status, 404);
    ok("the API: a browser's unknown address is the 404 page in the console's words; API clients, /api and the API's own pages as before; no relay loop");
  }

  // ---------- the people ----------
  const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };
  const mockPost = async (p: string, body: unknown, auth = false) => (await fetch(`${http.mock.url}${p}`, { method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer sk_test_mock" } : {}) }, body: JSON.stringify(body) })).json() as Promise<any>;
  const ownerEmail = `owner-${STAMP}@a.example`;
  const A = await call("POST", "/api/admin/onboarding/orgs", adminH, { name: `Account A ${STAMP}`, email: ownerEmail });
  assert.equal(A.status, 201, JSON.stringify(A.body));
  const slugA = A.body.org.slug as string;
  const [rowA] = await db.query<{ clerk_org_id: string }>("SELECT clerk_org_id FROM organizations WHERE slug = $1", [slugA]);
  const dirA = rowA!.clerk_org_id;

  let owner: Person, suspended: Person, staff: Person, outsider: Person | null = null;
  if (PROVIDER === "clerk") {
    const clerkPerson = async (email: string, first: string, o: { staff?: boolean; orgs?: { id: string; viewer?: boolean }[]; active?: string; orgName?: string } = {}): Promise<Person> => {
      const u = await mockPost("/_mock/clerk/users", { email, first_name: first, verified: true, ...(o.staff ? { platform_admin: true } : {}) });
      for (const m of o.orgs ?? []) await mockPost("/_mock/clerk/memberships", { org_id: m.id, user_id: u.id, role: "org:member" });
      const token = async () => (await mockPost("/_mock/session", { user_id: u.id, ...(o.active ? { org_id: o.active, org_role: "member" } : {}) })).token as string;
      return { email, userId: u.id, h: async () => ({ authorization: `Bearer ${await token()}`, "x-pack-request": "1" }),
        cookies: async () => [{ name: "__session", value: await token() }, { name: "__lane_identity", value: encodeURIComponent(JSON.stringify({ email, first, last: "Person", org: o.orgName ?? "" })) }] };
    };
    const inv = [...(http.mock.state.invitations as Map<string, any>).values()].find((x) => x.email_address === ownerEmail && x.status === "pending");
    const acc = await mockPost(`/_mock/invitations/${inv.id}/accept`, {});
    const ownerToken = async () => (await mockPost("/_mock/session", { user_id: acc.user.id, org_id: dirA, org_role: "admin" })).token as string;
    owner = { email: ownerEmail, userId: acc.user.id, h: async () => ({ authorization: `Bearer ${await ownerToken()}`, "x-pack-request": "1" }),
      cookies: async () => [{ name: "__session", value: await ownerToken() }, { name: "__lane_identity", value: encodeURIComponent(JSON.stringify({ email: ownerEmail, first: "Owner", last: "Person", org: `Account A ${STAMP}` })) }] };
    suspended = await clerkPerson(`paused-${STAMP}@a.example`, "Paused", { orgs: [{ id: dirA }], active: dirA, orgName: `Account A ${STAMP}` });
    staff = await clerkPerson(STAFF, "Staff", { staff: true });
    // In an organization of their own that is not an account (and no other): every portal call is 403 no_account.
    const own = (await mockPost("/v1/organizations", { name: `Own org ${STAMP}` }, true)).id as string;
    outsider = await clerkPerson(`maker-${STAMP}@c.example`, "Maker", { orgs: [{ id: own }], active: own, orgName: `Own org ${STAMP}` });
  } else {
    const emails = () => http.mock.state.emails as any[];
    const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
    const codeFor = async (to: string, after: number) => {
      for (let i = 0; i < 200; i++) {
        const m = emails().filter((e) => e.to.includes(to) && kindOf(e) === "sign_in_code");
        if (m.length > after) return /sign-in code is (\d{8})/.exec(m.at(-1).text)![1]!;
        await wait(20);
      }
      throw new Error(`no code emailed to ${to}`);
    };
    let ip = 0;
    const builtinPerson = async (email: string): Promise<Person> => {
      const h0 = { "x-forwarded-for": `198.51.100.${++ip}` };
      const before = emails().filter((e) => e.to.includes(email) && kindOf(e) === "sign_in_code").length;
      assert.equal((await call("POST", "/api/auth/email/request", h0, { email })).status, 200);
      const r = await call("POST", "/api/auth/email/verify", h0, { email, code: await codeFor(email, before) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const cookie = r.headers.getSetCookie().find((c) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c))!.split(";")[0]!;
      const userId = (await call("GET", "/api/auth/session", { cookie })).body.user.id as string;
      return { email, userId, h: async () => ({ cookie, "x-pack-request": "1" }), cookies: async () => [{ name: cookie.split("=")[0]!, value: cookie.slice(cookie.indexOf("=") + 1) }] };
    };
    owner = await builtinPerson(ownerEmail);
    const pausedEmail = `paused-${STAMP}@a.example`;
    assert.equal((await call("POST", "/api/app/team/invitations", await owner.h(), { email: pausedEmail, role: "member" })).status, 201);
    suspended = await builtinPerson(pausedEmail);
    await (await import("../src/admin-roles.js")).addAdmin({ actor: "status-pages-test", userId: null }, STAFF, "support");
    staff = await builtinPerson(STAFF);
  }
  const deact = await call("POST", `/api/app/team/members/${suspended.userId}/deactivate`, await owner.h());
  assert.ok([200, 204].includes(deact.status), JSON.stringify(deact.body));
  const paused = await call("GET", "/api/app/me", await suspended.h());
  assert.equal(paused.status, 403, JSON.stringify(paused.body)); assert.equal(paused.body.code, "suspended");
  if (outsider) assert.equal((await call("GET", "/api/app/me", await outsider.h())).body.code, "no_account");
  assert.equal((await call("GET", "/api/app/me", await owner.h())).status, 200);

  if (BROWSER) await browserChecks({ owner, suspended, staff, outsider, slugA });
  console.log(`status-pages [${PROVIDER}]: ${n} checks passed${BROWSER ? "" : " (the words and the API; add --browser for the console)"}`);
} finally {
  for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort */ } }
  cleanup();
}
process.exit(0);

// ---------- the console, in a browser ----------

async function freePort() {
  return new Promise<number>((res, rej) => {
    const s = netServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

/** The console built for this sign-in, against the API on `apiPort` (next build bakes the API's address into its rewrites). */
function buildConsole(apiPort: number): string {
  const web = path.join(ROOT, "web");
  const nm = realpathSync(path.join(web, "node_modules"));
  const out = path.join(TMP, "console");
  const skip = (p: string) => ["node_modules", ".next", ".turbo"].includes(path.basename(p)) || path.basename(p).startsWith(".env");
  cpSync(web, path.join(out, "web"), { recursive: true, filter: (src) => !skip(src) });
  const dst = path.join(out, "web", "node_modules");
  if (PROVIDER === "builtin") symlinkSync(nm, dst, "dir");
  else {
    // @clerk/nextjs replaced by the lane stand-in, which answers Clerk's hooks from the mock-signed session cookie.
    const standin = path.join(TESTING, "console", "clerk-standin");
    if (!existsSync(standin)) throw new Error(`the Clerk browser checks need the lane stand-in at ${standin} (the mold's testing folder)`);
    mkdirSync(dst);
    for (const e of readdirSync(nm)) {
      if (e !== "@clerk") { symlinkSync(path.join(nm, e), path.join(dst, e)); continue; }
      mkdirSync(path.join(dst, e));
      for (const s of readdirSync(path.join(nm, e))) if (s !== "nextjs") symlinkSync(path.join(nm, e, s), path.join(dst, e, s));
      cpSync(standin, path.join(dst, e, "nextjs"), { recursive: true });
      const types = path.join(nm, e, "nextjs", "dist", "types");
      if (existsSync(types)) symlinkSync(types, path.join(dst, e, "nextjs", "types"));
    }
  }
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_AUTH_PROVIDER: PROVIDER, APP_API_URL: `http://127.0.0.1:${apiPort}` };
  console.log(`  next build of the console (${PROVIDER})…`);
  const r = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`next build failed:\n${(r.stdout + r.stderr).split("\n").slice(-60).join("\n")}`);
  return path.join(out, "web");
}

async function browserChecks(w: { owner: Person; suspended: Person; staff: Person; outsider: Person | null; slugA: string }) {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const apiPort = await freePort();
  const consoleDir = process.env.STATUS_PAGES_CONSOLE ?? buildConsole(apiPort);
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  // The API sends a browser's unknown address the console's not-found page (src/status-pages.ts reads consoleUrl()).
  process.env.PUBLIC_URL = origin;
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], {
    cwd: consoleDir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", APP_API_URL: `http://127.0.0.1:${apiPort}` },
  });
  let log = "";
  next.stdout?.on("data", (b) => { log = (log + b).slice(-8000); }); next.stderr?.on("data", (b) => { log = (log + b).slice(-8000); });
  teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { up = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })).status < 500; } catch { await wait(1000); }
  }
  assert.ok(up, `the console came up on ${origin}:\n${log}`);

  const axePath = path.join(TESTING, "accessibility", "vendor", "axe.min.js");
  const AXE = existsSync(axePath) ? readFileSync(axePath, "utf8") : null;
  const browser = await pw.chromium.launch();
  teardown.push(() => browser.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const ctxFor = async (who: Person | null, opts: Record<string, unknown> = {}) => {
    const c = await browser.newContext({ baseURL: origin, serviceWorkers: "block", reducedMotion: "reduce", ...opts });
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    if (who) await c.addCookies((await who.cookies()).map((x) => ({ ...x, url: origin })));
    return c;
  };
  const settle = async (p: any) => {
    await p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin'), null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(200);
  };
  /** Open `url` as `who`; the navigation's status and the status page shown (kind, code, title). */
  const open = async (who: Person | null, url: string, prep?: (p: any) => Promise<void>) => {
    const c = await ctxFor(who);
    const p = await c.newPage();
    if (prep) await prep(p);
    const res = await p.goto(url, { waitUntil: "networkidle" });
    const el = p.locator("[data-status-page]").first();
    await el.waitFor({ timeout: 20000 }).catch(() => {});
    const shown = (await el.count()) ? { kind: await el.getAttribute("data-status-page"), code: await el.getAttribute("data-status-code"), text: await el.innerText() } : null;
    return { c, p, status: res?.status() ?? 0, shown, at: new URL(p.url()) };
  };
  const expect = async (who: Person | null, url: string, status: number, kind: string, extra: (r: Awaited<ReturnType<typeof open>>) => Promise<void> | void = () => {}, prep?: (p: any) => Promise<void>) => {
    const r = await open(who, url, prep);
    try {
      assert.equal(r.status, status, `${url}: HTTP ${r.status}, want ${status}${r.shown ? ` (shown: ${r.shown.kind})` : ""}`);
      assert.equal(r.shown?.kind, kind, `${url}: the ${kind} status page (got ${JSON.stringify(r.shown)})`);
      const body = await r.p.locator("body").innerText();
      assert.doesNotMatch(body, /Could not load this page|Cannot GET|This page could not be found|Application error/, `${url}: no raw error text`);
      const all = await r.p.locator("[data-status-page]").evaluateAll((els: Element[]) => els.map((e) => `${e.getAttribute("data-status-page")}: ${(e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 160)}`));
      const tries = await r.p.getByRole("button", { name: "Try again" }).evaluateAll((els: Element[]) => els.map((e) => e.outerHTML.slice(0, 200) + " in " + (e.closest("[data-status-page]")?.getAttribute("data-status-page") ?? "no status page")));
      if (tries.length > 1) console.log(`  note: ${url}: ${tries.length} Try again buttons: ${JSON.stringify(tries)}`);
      assert.equal(all.length, 1, `${url}: one status page (got ${JSON.stringify(all)}; Try again: ${JSON.stringify(tries)})`);
      await extra(r);
    } finally { await r.c.close(); }
  };
  const inShell = async (r: Awaited<ReturnType<typeof open>>) => assert.ok(await r.p.locator("#main-content").count(), `${r.at.pathname}: inside the area's shell`);

  // 3. signed out: sign-in, and back after.
  for (const url of ["/app", "/app/usage", "/admin", "/app/no-such-page"]) {
    const r = await fetch(`${origin}${url}`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308].includes(r.status), `${url} signed out: a redirect (got ${r.status})`);
    const to = new URL(r.headers.get("location")!, origin);
    assert.equal(to.pathname, "/auth/sign-in", `${url} signed out: to sign-in`);
    if (PROVIDER === "builtin") assert.equal(to.searchParams.get("redirect_url"), url, `${url}: back to it after`);
  }
  ok(`signed out: /app, a portal page, /admin and an unknown portal address go to sign-in${PROVIDER === "builtin" ? ", and back after" : ""}`);

  // 4. unknown addresses: 404 and the not-found page, in the area's shell.
  await expect(null, "/no-such-page-anywhere", 404, "not_found", async (r) => { assert.ok(await r.p.locator("main#main").count(), "a page of its own"); assert.match(r.shown!.text, /Page not found/); });
  await expect(null, "/auth/no-such-page", 404, "not_found");
  for (const url of ["/app/no-such-page", "/app/records/no-area/key-1", "/app/packs/no-pack/no-page", "/app/docs/no-such-doc", "/app/host/no-pack/x", "/app/a/b/c"])
    await expect(w.owner, url, 404, "not_found", inShell);
  for (const url of ["/admin/no-such-page", "/admin/docs/no-such-doc", "/admin/records/no-area"])
    await expect(w.staff, url, 404, "not_found", inShell);
  // Drawn on the server (mold_v0-155): the page's HTML itself carries the status page and its links, no script needed.
  const cookieOf = async (who: Person | null) => (who ? (await who.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") : "");
  for (const [who, url] of [[null, "/no-such-page-anywhere"], [null, "/auth/no-such-page"], [w.owner, "/app/no-such-page"], [w.owner, "/app/docs/no-such-doc"], [w.owner, "/app/records/no-area"],
    [w.owner, "/app/a/b/c"], [null, "/console-status/not-found"], [w.staff, "/admin/no-such-page"], [w.staff, "/admin/docs/no-such-doc"]] as const) {
    const r = await fetch(`${origin}${url}`, { headers: { accept: "text/html", cookie: await cookieOf(who) }, redirect: "manual" });
    const html = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, "");
    assert.equal(r.status, 404, `${url}: HTTP ${r.status}`);
    assert.match(html, /data-status-page="not_found"/, `${url}: the not-found page in the server's HTML`);
    assert.match(html, /<a [^>]*href="\/[^"]*"[^>]*>[^<]*(Go to|home)/i, `${url}: its link home in the server's HTML`);
    assert.doesNotMatch(html, /id="__next_error__"/, `${url}: never Next's empty error shell`);
  }
  ok("unknown addresses: the site's, sign-in's and every portal and admin route (pages, packs, records, docs, host pages) are a 404 with the not-found page, inside the area's shell where there is one; drawn on the server (in the page's HTML, its links with it)");

  // 5. denied: the admin console for someone who is not platform staff.
  for (const url of ["/admin", "/admin/accounts", "/admin/no-such-page"])
    await expect(w.owner, url, 403, "staff_only", async (r) => {
      assert.match(r.shown!.text, new RegExp(w.owner.email.replace(/[.+]/g, "\\$&")), `${url}: says who they are signed in as`);
      assert.equal(await r.p.getByRole("link", { name: "Open the customer portal" }).getAttribute("href"), "/app");
    });
  // The API's own addresses under /admin still reach it (next.config.ts), past /admin/[...missing].
  const sess = await fetch(`${origin}/admin/session`, { headers: { cookie: (await w.staff.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
  assert.equal(sess.status, 200); assert.equal((await sess.json() as { is_platform_admin: boolean }).is_platform_admin, true, "/admin/session is the API's");
  ok("denied: /admin and every address under it is a 403 for someone who is not staff, naming them and leading to their account; /admin/session still reaches the API");

  // 6. the data hooks: the API's answer, as the status page.
  const fake = (status: number, body: unknown) => async (p: any) => p.route("**/api/app/usage**", (route: any) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
  await expect(w.owner, "/app/usage", 200, "denied", (r) => assert.match(r.shown!.text, /Billing manager role/), fake(403, { error: "This needs the Billing manager role.", code: "forbidden", needs: "billing" }));
  await expect(w.owner, "/app/usage", 200, "not_found", undefined, fake(404, { error: "Not found" }));
  await expect(w.owner, "/app/usage", 200, "error", async (r) => assert.equal(await r.p.locator("[data-status-page]").getByRole("button", { name: "Try again" }).count(), 1), fake(500, { error: "Internal error" }));
  await expect(w.owner, "/app/usage", 200, "offline", async (r) => assert.equal(await r.p.locator("[data-status-page]").getByRole("button", { name: "Try again" }).count(), 1), async (p) => p.route("**/api/app/usage**", (route: any) => route.abort("failed")));
  await expect(w.owner, "/app/usage", 200, "no_account", async (r) => assert.equal(await r.p.locator('[data-status-page] [data-testid="no-account-notice"] a[href="/app"]').count(), 1, "the portal's no-account notice, leading to its page"), fake(403, { error: "You are not in an account yet.", code: "no_account" }));
  {
    // 401 from a page's own fetch: on to sign-in, back after.
    const r = await open(w.owner, "/app/files", async (p) => p.route("**/api/workspace-files**", (route: any) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Sign in"}' })));
    try {
      // The page's own helper may go to sign-in at once (lib/api-client.ts does): the signed-out page, or sign-in itself.
      assert.ok(r.shown?.kind === "signed_out" || r.at.pathname === "/auth/sign-in", `401: the signed-out page or sign-in (${JSON.stringify(r.shown)} at ${r.at.pathname})`);
      await r.p.waitForURL(/\/auth\/sign-in\?redirect_url=%2Fapp%2Ffiles/, { timeout: 10000 });
    } finally { await r.c.close(); }
  }
  await expect(w.suspended, "/app/usage", 200, "suspended", async (r) => assert.equal(await r.p.locator("[data-status-page]").getByRole("button", { name: "Sign out" }).count(), 1));
  if (w.outsider) {
    // In no account for real: the portal's layout shows its own page for that (mold_v0-098) on every route.
    const r = await open(w.outsider, "/app/usage");
    try {
      await r.p.locator('[data-testid="no-account"]').waitFor({ timeout: 20000 });
      assert.ok(r.status < 400, `/app/usage in no account: HTTP ${r.status}`);
      assert.doesNotMatch(await r.p.locator("body").innerText(), /Could not load this page/);
    } finally { await r.c.close(); }
  }
  await expect(w.staff, `/admin/accounts/no-such-account-${STAMP}`, 200, "not_found", inShell);
  ok(`the data hooks: a role refusal (with the role it needs), not found, a server error and no answer (Try again), no account and 401 (on to sign-in, back after) are each the status page; a suspended member${w.outsider ? ", someone in an organization that is not an account" : ""} and an admin account that is not there meet theirs for real`);

  // 7. axe, light and dark; three widths.
  // The theme switched with transitions off, so axe never measures a colour half-way between the two.
  const theme = async (p: any, t: "dark" | "light") => {
    await p.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await p.evaluate((t: string) => { document.documentElement.classList.toggle("dark", t === "dark"); document.documentElement.style.colorScheme = t; }, t);
    await p.waitForTimeout(100);
  };
  const grade = async (who: Person | null, url: string, label: string, prep?: (p: any) => Promise<void>) => {
    const notes: string[] = [];
    for (const t of ["dark", "light"] as const) {
      for (const width of [390, 820, 1440]) {
        const c = await ctxFor(who, { viewport: { width, height: 900 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
        const p = await c.newPage();
        if (prep) await prep(p);
        await p.goto(url, { waitUntil: "networkidle" });
        await p.locator("[data-status-page]").first().waitFor({ timeout: 20000 });
        await settle(p); await theme(p, t);
        if (width === 1440) {
          if (!AXE) notes.push(`${label} ${t}: not covered (no vendored axe at ${axePath})`);
          else {
            await p.addScriptTag({ content: AXE });
            const v = await p.evaluate(async () => {
              const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] });
              return r.violations.map((x: any) => ({ id: x.id, impact: x.impact, n: x.nodes.length, target: x.nodes[0]?.target?.join(" ") }));
            });
            assert.deepEqual(v.filter((x: any) => x.impact === "serious" || x.impact === "critical"), [], `${label} (${t}): serious or critical axe violations`);
            notes.push(`${label} ${t}: axe clean (${v.length} minor/moderate)`);
          }
        }
        const wide = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
        assert.ok(wide.sw <= wide.vw + 1, `${label} at ${width}px (${t}) scrolls sideways (${wide.sw} > ${wide.vw})`);
        const small = await p.evaluate(() => [...document.querySelectorAll("[data-status-page] a, [data-status-page] button")]
          .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 24 || r.height < 24)).length);
        assert.equal(small, 0, `${label} at ${width}px: every action at least 24 px`);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${PROVIDER}-${label.replace(/[^a-z0-9]+/gi, "-")}-${width}-${t}.png`), fullPage: true });
        await c.close();
      }
    }
    return notes;
  };
  const notes = [
    ...(await grade(null, "/no-such-page-anywhere", "not found (site)")),
    ...(await grade(w.owner, "/app/no-such-page", "not found (portal)")),
    ...(await grade(w.staff, "/admin/no-such-page", "not found (admin)")),
    ...(await grade(w.owner, "/admin", "staff only")),
    ...(await grade(w.owner, "/app/usage", "denied (portal)", fake(403, { error: "x", code: "forbidden", needs: "owner" }))),
    ...(await grade(w.owner, "/app/usage", "error (portal)", fake(500, { error: "Internal error" }))),
    ...(await grade(w.suspended, "/app/usage", "suspended")),
    ...(await grade(w.owner, "/app/usage", "no account", fake(403, { error: "x", code: "no_account" }))),
  ];
  for (const x of notes) console.log(`  ${x}`);
  ok(`axe: no serious or critical violation, dark and light; nothing scrolls sideways at 390, 820 and 1440 px; every action at least 24 px${SHOTS ? ` (screenshots: ${SHOTS})` : ""}`);
}
