// The console's Connected apps page (mold_v0-087; web/src/features/connected-apps, /app/connected-apps), under both
// sign-ins, offline: an embedded database and the mock providers.
//   npm run test:connected-apps                       both: builtin, then clerk (the page's words and rules, and the API)
//   tsx scripts/connected-apps-test.ts builtin|clerk [--browser] [--shots <dir>]
//
// Always:
// 1. The page's words and rules (web/src/features/connected-apps/model.ts): every text filled (no placeholder left), an
//    app's name and who vouches for it, the revoke question; the Clerk Account Portal address from a publishable key
//    (development and production instances; anything else falls back to the profile).
// 2. The page's place: an optional shell page (src/console-pages.ts: hideable, a sidebar entry by kind) with its route.
// 3. The API the page reads. builtin: a person with apps connected in two workspaces sees exactly theirs (not another
//    person's), each with the app, the workspace, when allowed and when last used; Revoke ends the app's tokens.
//    clerk: the built-in list does not answer (Clerk is the authorization server), so the page never asks it.
// With --browser, the console itself (next build for this sign-in, next start against this API; under Clerk the lane
// stand-in for @clerk/nextjs, molds/mold_v0/testing/console/clerk-standin), only this page:
// 4. builtin: the list (a verified app by its address, a registered one marked not verified, the workspace, the dates),
//    Revoke asks first, then the row goes and the app's token stops on /mcp; the empty state once none is left.
//    clerk: the "managed by your sign-in provider" note, the link to the person's account at Clerk (from the build's
//    publishable key), and no call to the built-in list.
// 5. axe (testing/accessibility/vendor/axe.min.js): no serious or critical WCAG A/AA violation, dark and light; at 390
//    and 1280 px nothing scrolls sideways.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
process.env.AUTH_PROVIDER = PROVIDER;
process.env.APP_PROXY_HOPS = "1";
const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
const ROOT = path.resolve(import.meta.dirname, "..");
const TESTING = path.resolve(ROOT, "..", "testing");
const PAGE = "/app/connected-apps";
/** A development instance's publishable key: the Frontend API host, base64, with a trailing `$`. */
const DEV_HOST = "quiet-otter-12.clerk.accounts.dev";
const DEV_KEY = `pk_test_${Buffer.from(`${DEV_HOST}$`).toString("base64")}`;

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const s256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const teardown: (() => unknown)[] = [];
type H = Record<string, string>;
interface Person { email: string; userId: string; h: () => Promise<H>; cookies: () => Promise<{ name: string; value: string }[]> }

async function freePort() {
  return new Promise<number>((res, rej) => {
    const s = netServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

try {
  // ---------- 1. the page's words and rules ----------
  const model = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "connected-apps", "model.ts")).href);
  {
    for (const t of [model.DESCRIPTION, model.EMPTY.title, model.EMPTY.text, model.CLERK_NOTE.title, model.CLERK_NOTE.text, model.CLERK_NOTE.disconnect])
      assert.ok(t && !/[{}]/.test(t), `a text with a placeholder left: ${t}`);
    assert.match(model.DESCRIPTION, /workspace/, "the build's word for a workspace");
    const app = (o: Partial<{ name: string | null; verified: boolean; id_host: string | null; url: string | null }> = {}) =>
      ({ id: "ogr_x", client: { name: "Claude", verified: false, id_host: null, url: null, ...o }, workspace: { id: "org_1", name: "Acme {run}" }, scope: ["mcp"], created_at: "", last_used_at: null });
    assert.equal(model.appName(app()), "Claude");
    assert.equal(model.appName(app({ name: "  ", verified: true, id_host: "claude.ai", url: "https://claude.ai/oauth/client.json" })), "claude.ai", "no name: the verified address");
    assert.equal(model.appName(app({ name: null })), "Unnamed app");
    assert.deepEqual(model.appIdentity(app({ verified: true, id_host: "claude.ai", url: "https://claude.ai/c.json" })), { verified: true, host: "claude.ai", url: "https://claude.ai/c.json" });
    assert.equal(model.appIdentity(app()).verified, false, "a registered client vouches for nothing");
    assert.equal(model.appIdentity(app({ verified: true })).verified, false, "verified with no address is not shown as verified");
    assert.match(model.revokeQuestion(app()).text, /Acme \{run\}/, "the workspace's own name, never filled as a placeholder");
    assert.equal(model.clerkAccountUrl(DEV_KEY), "https://quiet-otter-12.accounts.dev/user", "a development instance");
    assert.equal(model.clerkAccountUrl(`pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`), "https://accounts.example.com/user", "a production instance");
    assert.equal(model.clerkAccountUrl(`pk_live_${Buffer.from("clerk.app.example.co.uk$").toString("base64url")}`), "https://accounts.app.example.co.uk/user", "base64url");
    for (const bad of [undefined, null, "", "pk_test_", "sk_test_abc", `pk_live_${Buffer.from("clerk.example.com").toString("base64")}`, `pk_live_${Buffer.from("proxy.example.com$").toString("base64")}`,
      `pk_live_${Buffer.from("clerk.ex ample.com$").toString("base64")}`, `pk_live_${Buffer.from("clerk.example.com/evil$").toString("base64")}`, "pk_live_!!!"])
      assert.equal(model.clerkAccountUrl(bad), null, `no account address from ${bad}`);
    assert.deepEqual(model.clerkAccountLink(undefined), { href: "/app/profile", label: "Open your profile", external: false });
    assert.equal(model.clerkAccountLink(DEV_KEY).external, true);
    ok("the words: every text filled, the app's name and who vouches for it, the revoke question; the Clerk account address from a development or production key, else the profile");
  }

  // ---------- 2. the page's place ----------
  {
    const pages = await import("../src/console-pages.js");
    assert.equal(pages.CONSOLE_PAGES["connected-apps"], PAGE, "a shell page a build may hide");
    assert.ok((pages.SIDEBAR_SHELL_PAGES as readonly string[]).includes("connected-apps"), "a sidebar entry by kind");
    assert.equal(pages.sidebarShellPage("connected-apps"), "connected-apps");
    assert.equal(pages.sidebarShellPage("usage"), "activity", "a tab kind's page first");
    assert.equal(pages.sidebarShellPage("setup"), null);
    assert.equal(pages.sidebarShellPage("constructor"), null, "never an object's own property");
    assert.deepEqual(pages.consoleProblems({ hide: ["connected-apps"] }, "profile.json"), []);
    assert.ok(existsSync(path.join(ROOT, "web", "src", "app", "app", "connected-apps", "page.tsx")), "its route");
    assert.match(readFileSync(path.join(ROOT, "web", "src", "config", "nav-config.ts"), "utf8"), /url: '\/app\/connected-apps'/, "the shell's own sidebar lists it");
    ok("its place: an optional shell page (hideable, a sidebar entry by kind), its route, the shell's sidebar");
  }

  const http = await startHttp();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const call = async (method: string, p: string, h: H = {}, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const t = await r.text();
    let json: any = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = t; }
    return { status: r.status, body: json, headers: r.headers, text: t };
  };
  // The console's address (the browser's), known before anything is signed: tokens are bound to `${PUBLIC_URL}/mcp`.
  const origin = BROWSER ? `http://127.0.0.1:${await freePort()}` : http.base;
  process.env.PUBLIC_URL = origin;
  const RESOURCE = `${origin}/mcp`;
  const REDIRECT = "http://127.0.0.1:43999/callback";

  let ipN = 0;
  const ip = () => `203.0.113.${(++ipN % 250) + 1}`;
  const rpc = async (tok: string) => (await fetch(`${http.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;

  if (PROVIDER === "clerk") {
    // ---------- 3. clerk: the built-in list does not answer ----------
    const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };
    const mockPost = async (p: string, body: unknown) => (await fetch(`${http.mock.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const email = `owner-${STAMP}@a.example`;
    const A = await call("POST", "/api/admin/onboarding/orgs", adminH, { name: `Account A ${STAMP}`, email });
    assert.equal(A.status, 201, JSON.stringify(A.body));
    const [rowA] = await db.query<{ clerk_org_id: string }>("SELECT clerk_org_id FROM organizations WHERE slug = $1", [A.body.org.slug]);
    const inv = [...(http.mock.state.invitations as Map<string, any>).values()].find((x) => x.email_address === email && x.status === "pending");
    const acc = await mockPost(`/_mock/invitations/${inv.id}/accept`, {});
    const token = async () => (await mockPost("/_mock/session", { user_id: acc.user.id, org_id: rowA!.clerk_org_id, org_role: "admin" })).token as string;
    const owner: Person = { email, userId: acc.user.id, h: async () => ({ authorization: `Bearer ${await token()}`, "x-pack-request": "1" }),
      cookies: async () => [{ name: "__session", value: await token() }, { name: "__lane_identity", value: encodeURIComponent(JSON.stringify({ email, first: "Owner", last: "Person", org: `Account A ${STAMP}` })) }] };
    assert.equal((await call("GET", "/api/app/me", await owner.h())).status, 200, "the person is signed in");
    assert.equal((await call("GET", "/api/oauth/grants", await owner.h())).status, 404, "Clerk on: no built-in list");
    assert.equal((await call("POST", "/api/oauth/grants/ogr_x/revoke", { ...(await owner.h()), origin }, {})).status, 404);
    ok("clerk: the person is signed in, and the built-in list and revoke do not answer (Clerk keeps the connections)");
    if (BROWSER) await browserChecks({ kind: "clerk", owner });
  } else {
    // ---------- 3. builtin: the list and revoke ----------
    const { createOrg } = await import("../src/auth.js");
    const A = (await createOrg(`Connected A ${STAMP}`)).org, B = (await createOrg(`Connected B ${STAMP}`)).org;
    const dirA = `org_b${randomBytes(9).toString("base64url")}`, dirB = `org_b${randomBytes(9).toString("base64url")}`;
    await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [A.orgId, dirA]);
    await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [B.orgId, dirB]);
    const person = async (email: string, ms: [number, string][]): Promise<Person> => {
      const id = `user_b${randomBytes(9).toString("base64url")}`;
      await db.query("INSERT INTO auth_users (id, email, email_verified_at) VALUES ($1, $2, now())", [id, email]);
      for (const [org, role] of ms) await db.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [org, id, role]);
      const t = randomBytes(32).toString("base64url");
      await db.query("INSERT INTO auth_sessions (id, token_hash, user_id, active_org_id, method, expires_at) VALUES ($1, $2, $3, $4, 'email_code', now() + interval '1 day')",
        [`ses_b${randomBytes(9).toString("base64url")}`, sha256(t), id, ms[0]?.[0] ?? null]);
      return { email, userId: id, h: async () => ({ cookie: `oct_session=${t}`, "x-pack-request": "1", origin }), cookies: async () => [{ name: "oct_session", value: t }] };
    };
    const P = await person(`p-${STAMP}@a.example`, [[A.orgId, "member"], [B.orgId, "member"]]);
    const Q = await person(`q-${STAMP}@b.example`, [[B.orgId, "member"]]);

    // Client ID metadata documents answered without the network (src/mcp-oauth.ts guards the URLs first).
    const oauth = await import("../src/mcp-oauth.js");
    const DOC = "https://app.example.com/oauth/client.json";
    oauth.setDocumentFetcherForTest(async (u) => { if (u !== DOC) throw new Error("404"); return { client_id: DOC, client_name: "Example App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }; });
    const reg = await call("POST", "/oauth/register", { "x-forwarded-for": ip() }, { client_name: "Test Connector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    /** The whole connector flow for `who` in `dir` with `client`: its tokens. */
    const connect = async (who: Person, dir: string, client: string) => {
      const verifier = randomBytes(48).toString("base64url");
      const q = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: "S256", state: "s", resource: RESOURCE, scope: "mcp" });
      const a = await fetch(`${http.base}/oauth/authorize?${q}`, { redirect: "manual" });
      assert.equal(a.status, 302, await a.text());
      const request = new URL(a.headers.get("location")!).searchParams.get("request")!;
      const d = await call("POST", `/api/oauth/requests/${request}`, await who.h(), { decision: "allow", workspace: dir });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const code = new URL(d.body.redirect).searchParams.get("code")!;
      const t = await fetch(`${http.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip() },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: RESOURCE }) });
      const j = await t.json() as { access_token: string };
      assert.equal(t.status, 200, JSON.stringify(j));
      return j;
    };
    const tDcr = await connect(P, dirA, reg.body.client_id);
    const tDoc = await connect(P, dirB, DOC);
    const tQ = await connect(Q, dirB, DOC);
    for (const t of [tDcr, tDoc, tQ]) assert.equal(await rpc(t.access_token), 200);
    const list = await call("GET", "/api/oauth/grants", await P.h());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const grants = list.body.grants as any[];
    assert.equal(grants.length, 2, "exactly the person's own apps (not another person's)");
    const doc = grants.find((g) => g.client.verified), dcr = grants.find((g) => !g.client.verified);
    assert.deepEqual(doc.client, { name: "Example App", verified: true, id_host: "app.example.com", url: DOC });
    assert.deepEqual(doc.workspace, { id: dirB, name: B.name });
    assert.deepEqual(dcr.client, { name: "Test Connector", verified: false, id_host: null, url: null });
    assert.deepEqual(dcr.workspace, { id: dirA, name: A.name });
    for (const g of grants) assert.ok(g.created_at && g.last_used_at, "when allowed and when last used");
    assert.equal(grants[0].id, doc.id, "the latest first");
    ok("builtin: the person's own apps across their workspaces (a verified one by its address, a registered one not verified), with the dates; not another person's");
    if (BROWSER) await browserChecks({ kind: "builtin", owner: P, rpc, tokens: { dcr: tDcr.access_token, doc: tDoc.access_token, other: tQ.access_token }, names: { a: A.name, b: B.name } });
    else {
      assert.equal((await call("POST", `/api/oauth/grants/${dcr.id}/revoke`, await P.h(), {})).status, 200);
      assert.equal(await rpc(tDcr.access_token), 401, "revoked: the app's token stops");
      assert.equal(await rpc(tDoc.access_token), 200, "the other app is untouched");
      ok("builtin: Revoke ends that app's tokens only");
    }
    oauth.setDocumentFetcherForTest(null);
  }
  console.log(`connected-apps [${PROVIDER}]: ${n} checks passed${BROWSER ? "" : " (the words, the place and the API; add --browser for the page)"}`);
} finally {
  for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort */ } }
  cleanup();
}
process.exit(0);

// ---------- the page, in a browser ----------

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
    NEXT_PUBLIC_AUTH_PROVIDER: PROVIDER, APP_API_URL: `http://127.0.0.1:${apiPort}`,
    // Under Clerk the page links to the person's account at Clerk, read from the build's publishable key.
    ...(PROVIDER === "clerk" ? { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: DEV_KEY } : {}) };
  console.log(`  next build of the console (${PROVIDER})…`);
  const r = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`next build failed:\n${(r.stdout + r.stderr).split("\n").slice(-60).join("\n")}`);
  return path.join(out, "web");
}

type World = { kind: "clerk"; owner: Person } | { kind: "builtin"; owner: Person; rpc: (tok: string) => Promise<number>; tokens: { dcr: string; doc: string; other: string }; names: { a: string; b: string } };

async function browserChecks(w: World) {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const consoleOrigin = process.env.PUBLIC_URL!;
  // The API for the console: a second listener of the same app and database, on the port the build is pointed at.
  const port = await freePort();
  const consoleDir = process.env.CONNECTED_APPS_CONSOLE ?? buildConsole(port);
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(port, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const consolePort = new URL(consoleOrigin).port;
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", consolePort, "-H", "127.0.0.1"], {
    cwd: consoleDir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", APP_API_URL: `http://127.0.0.1:${port}` },
  });
  let log = "";
  next.stdout?.on("data", (b) => { log = (log + b).slice(-8000); }); next.stderr?.on("data", (b) => { log = (log + b).slice(-8000); });
  teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { up = (await fetch(`${consoleOrigin}/healthz`, { signal: AbortSignal.timeout(5000) })).status < 500; } catch { await wait(1000); }
  }
  assert.ok(up, `the console came up on ${consoleOrigin}:\n${log}`);

  const axePath = path.join(TESTING, "accessibility", "vendor", "axe.min.js");
  const AXE = existsSync(axePath) ? readFileSync(axePath, "utf8") : null;
  const browser = await pw.chromium.launch();
  teardown.push(() => browser.close());
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const ctxFor = async (opts: Record<string, unknown> = {}) => {
    const c = await browser.newContext({ baseURL: consoleOrigin, serviceWorkers: "block", reducedMotion: "reduce", ...opts });
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    await c.addCookies((await w.owner.cookies()).map((x) => ({ ...x, url: consoleOrigin })));
    return c;
  };
  const ready = w.kind === "clerk" ? "[data-connected-apps='provider']" : "[data-connected-apps='list'], [data-connected-apps='empty']";
  const open = async (opts: Record<string, unknown> = {}) => {
    const c = await ctxFor(opts);
    const p = await c.newPage();
    const asked: string[] = [];
    p.on("request", (r: any) => { if (new URL(r.url()).pathname.startsWith("/api/oauth/")) asked.push(r.url()); });
    const res = await p.goto(PAGE, { waitUntil: "networkidle" });
    await p.locator(ready).first().waitFor({ timeout: 20000 });
    return { c, p, status: res?.status() ?? 0, asked };
  };

  // ---------- 5. axe, light and dark; two widths ----------
  const theme = async (p: any, t: "dark" | "light") => {
    await p.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await p.evaluate((t: string) => { document.documentElement.classList.toggle("dark", t === "dark"); document.documentElement.style.colorScheme = t; }, t);
    await p.waitForTimeout(100);
  };
  const notes: string[] = [];
  for (const t of ["dark", "light"] as const) {
    for (const width of [390, 1280]) {
      const r = await open({ viewport: { width, height: 900 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      try {
        await r.p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin'), null, { timeout: 15000 }).catch(() => {});
        await theme(r.p, t);
        if (width === 1280) {
          if (!AXE) notes.push(`${t}: not covered (no vendored axe at ${axePath})`);
          else {
            await r.p.addScriptTag({ content: AXE });
            const v = await r.p.evaluate(async () => {
              const x = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] });
              return x.violations.map((y: any) => ({ id: y.id, impact: y.impact, n: y.nodes.length, target: y.nodes[0]?.target?.join(" ") }));
            });
            assert.deepEqual(v.filter((x: any) => x.impact === "serious" || x.impact === "critical"), [], `${t}: serious or critical axe violations`);
            notes.push(`${t}: axe clean (${v.length} minor/moderate)`);
          }
        }
        const wide = await r.p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
        assert.ok(wide.sw <= wide.vw + 1, `at ${width}px (${t}) the page scrolls sideways (${wide.sw} > ${wide.vw})`);
        if (SHOTS) await r.p.screenshot({ path: path.join(SHOTS, `${PROVIDER}-connected-apps-${width}-${t}.png`), fullPage: true });
      } finally { await r.c.close(); }
    }
  }
  for (const x of notes) console.log(`  ${x}`);
  ok(`axe: no serious or critical violation, dark and light; nothing scrolls sideways at 390 and 1280 px${SHOTS ? ` (screenshots: ${SHOTS})` : ""}`);

  // ---------- 4. the page ----------
  if (w.kind === "clerk") {
    const r = await open();
    try {
      assert.equal(r.status, 200);
      const note = r.p.locator("[data-connected-apps='provider']");
      assert.match(await note.innerText(), /Managed by your sign-in provider/);
      assert.match(await note.innerText(), /Clerk/);
      const link = note.getByRole("link", { name: /Open your account at Clerk/ });
      assert.equal(await link.getAttribute("href"), `https://${DEV_HOST.replace(".clerk.accounts.dev", ".accounts.dev")}/user`, "the person's account at Clerk, from the build's key");
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await note.getByRole("link", { name: "Your profile" }).getAttribute("href"), "/app/profile");
      assert.equal(await r.p.locator("table").count(), 0, "no list");
      assert.deepEqual(r.asked, [], "the page never asks the built-in list");
      assert.equal(await r.p.locator(`a[href='${PAGE}']`).count() > 0, true, "the sidebar links to it");
    } finally { await r.c.close(); }
    ok("the page (clerk): the managed-by-your-sign-in-provider note, the link to the person's account at Clerk and their profile; no list, and the built-in list never asked");
  } else {
    const r = await open();
    try {
      assert.equal(r.status, 200);
      const rows = r.p.locator("[data-connected-app]");
      assert.equal(await rows.count(), 2, "the person's two apps");
      const text = await r.p.locator("[data-connected-apps='list']").innerText();
      assert.match(text, /Example App/); assert.match(text, /Verified:\s*app\.example\.com/); assert.match(text, /Test Connector/); assert.match(text, /Not verified/);
      assert.ok(text.includes(w.names.a) && text.includes(w.names.b), "each app's workspace");
      assert.equal(await r.p.getByRole("link", { name: "app.example.com" }).getAttribute("href"), "https://app.example.com/oauth/client.json");
      assert.equal(await r.p.locator(`a[href='${PAGE}']`).count() > 0, true, "the sidebar links to it");
      // Revoke asks first; Cancel changes nothing.
      const row = rows.filter({ hasText: "Test Connector" });
      await row.getByRole("button", { name: /Revoke/ }).click();
      const dialog = r.p.getByRole("alertdialog");
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /Revoke Test Connector\?/);
      assert.ok((await dialog.innerText()).includes(w.names.a));
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await w.rpc(w.tokens.dcr), 200, "cancelled: still connected");
      await row.getByRole("button", { name: /Revoke/ }).click();
      await r.p.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await r.p.waitForFunction(() => document.querySelectorAll("[data-connected-app]").length === 1, null, { timeout: 15000 });
      assert.equal(await w.rpc(w.tokens.dcr), 401, "revoked from the page: the app's token stops on /mcp");
      assert.equal(await w.rpc(w.tokens.doc), 200, "the other app keeps working");
      assert.equal(await w.rpc(w.tokens.other), 200, "another person's app is untouched");
      if (SHOTS) await r.p.screenshot({ path: path.join(SHOTS, `${PROVIDER}-connected-apps-after-revoke.png`), fullPage: true });
      // The last one: the empty state.
      await r.p.locator("[data-connected-app]").getByRole("button", { name: /Revoke/ }).click();
      await r.p.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await r.p.locator("[data-connected-apps='empty']").waitFor({ timeout: 15000 });
      assert.match(await r.p.locator("[data-connected-apps='empty']").innerText(), /No apps connected/);
      assert.equal(await w.rpc(w.tokens.doc), 401);
    } finally { await r.c.close(); }
    ok("the page (builtin): the list (verified by its address, registered not verified, the workspaces), Revoke asks first, then the row goes and its token stops on /mcp; the empty state once none is left");
  }
}
