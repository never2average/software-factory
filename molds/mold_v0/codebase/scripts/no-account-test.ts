// A signed-in person with no account here (mold_v0-098; src/app.ts customerSession and GET /api/app/access, src/auth.ts
// accountsMode, web/src/app/app/layout.tsx, web/src/features/portal/no-account.tsx, web/src/features/site/), under both
// sign-ins, offline: an embedded database and the mock providers (a fake Clerk, Resend as the email transport).
//   npm run test:no-account                          both: builtin, then clerk (the API only)
//   tsx scripts/no-account-test.ts builtin|clerk [--browser] [--shots <dir>]
//
// The API (always):
// 1. /api/auth/config says who may open an account: invite_only (the shell's default).
// 2. Signed in with no account open is a 403 no_account:
//    nobody's member (Clerk: anyone who signed up; built-in: someone removed from their workspace), a member of a
//    directory organization that is not an account (Clerk), and platform staff with no account of their own, whom
//    /admin/session names as staff. A member of an account gets 200 from GET /api/app/access.
// 3. The request (POST /api/access-requests) is stored with the address, company, message and where it came from; a bad
//    address is refused.
// 4. Built-in: an invitation to the person's address is listed and accepted, and the account opens.
// With --browser, the console itself (next build for this sign-in, then next start against this API; under Clerk with the
// lane stand-in for @clerk/nextjs, molds/mold_v0/testing/console/clerk-standin, which reads the mock's session):
// 5. Every portal route (/app, /app/usage) shows the page for no account: who they are signed in as, the form with their
//    address filled in; sending it shows the confirmation and stores the request (source: /app).
// 6. Platform staff see "Open the admin console" (and no request form). Clerk: someone whose active organization is one
//    they made (no account) gets the page. Built-in, last: an invitation shows as "Join <account>" (the portal's
//    invitation dialog's buttons, web/src/features/portal/invitation-landing.tsx) and opens the account in one click.
// 7. Invite-only: the landing page's calls to action lead to /request-access, whose form sends; sign-up says so.
// 8. axe (molds/mold_v0/testing/accessibility/vendor/axe.min.js): no serious or critical WCAG A/AA violation on the page,
//    the request page and the landing, in the dark theme and the light one; at 390, 820 and 1440 px nothing scrolls
//    sideways. Screenshots go to --shots <dir> when given.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import path from "node:path";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
process.env.AUTH_PROVIDER = PROVIDER;
const STAFF = `staff-${Date.now().toString(36)}@platform.example`;
const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
const ROOT = path.resolve(import.meta.dirname, "..");
const TESTING = path.resolve(ROOT, "..", "testing");

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teardown: (() => unknown)[] = [];

try {
  const http = await startHttp();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  process.env.RESEND_API_URL = http.mock.url;
  await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
  type H = Record<string, string>;
  const call = async (method: string, p: string, h: H = {}, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const t = await r.text();
    let json: any = null;
    try { json = t ? JSON.parse(t) : null; } catch { json = t; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const mockPost = async (p: string, body: unknown, auth = false) => (await fetch(`${http.mock.url}${p}`, { method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer sk_test_mock" } : {}) }, body: JSON.stringify(body) })).json() as Promise<any>;
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
  /** Built-in: sign in with an emailed code; the session cookie (name=value). */
  const codeSignIn = async (email: string) => {
    const h = { "x-forwarded-for": `198.51.100.${++ip}` };
    const before = emails().filter((e) => e.to.includes(email) && kindOf(e) === "sign_in_code").length;
    assert.equal((await call("POST", "/api/auth/email/request", h, { email })).status, 200);
    const r = await call("POST", "/api/auth/email/verify", h, { email, code: await codeFor(email, before) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const set = r.headers.getSetCookie().find((c) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c));
    assert.ok(set, "a session cookie");
    return set!.split(";")[0]!;
  };

  /** A person as both the API and the browser need them: request headers, and the cookies a browser carries. */
  interface Person { email: string; h: () => Promise<H>; cookies: () => Promise<{ name: string; value: string }[]>; userId: string }
  const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };

  // ---------- an account, A, with its owner ----------
  const ownerEmail = `owner-${STAMP}@a.example`;
  const A = await call("POST", "/api/admin/onboarding/orgs", adminH, { name: `Account A ${STAMP}`, email: ownerEmail });
  assert.equal(A.status, 201, JSON.stringify(A.body));
  const [rowA] = await db.query<{ clerk_org_id: string; name: string }>("SELECT clerk_org_id, name FROM organizations WHERE slug = $1", [A.body.org.slug]);
  const dirA = rowA!.clerk_org_id;

  let owner: Person, stranger: Person, staff: Person, selfMade: Person | null = null, alsoInA: Person | null = null, invitee: Person | null = null;
  if (PROVIDER === "clerk") {
    const clerkPerson = async (email: string, first: string, opts: { platform_admin?: boolean; orgs?: string[]; active?: string; orgName?: string } = {}): Promise<Person> => {
      const u = await mockPost("/_mock/clerk/users", { email, first_name: first, verified: true, ...(opts.platform_admin ? { platform_admin: true } : {}) });
      for (const o of opts.orgs ?? []) await mockPost("/_mock/clerk/memberships", { org_id: o, user_id: u.id, role: "org:admin" });
      const token = async () => (await mockPost("/_mock/session", { user_id: u.id, ...(opts.active ? { org_id: opts.active, org_role: "admin" } : {}) })).token as string;
      return {
        email, userId: u.id, h: async () => ({ authorization: `Bearer ${await token()}`, "x-pack-request": "1" }),
        // The lane stand-in reads the session cookie and what Clerk's client would have loaded (name, address, workspace).
        cookies: async () => [{ name: "__session", value: await token() },
          { name: "__lane_identity", value: encodeURIComponent(JSON.stringify({ email, first, last: "Person", org: opts.orgName ?? "" })) }],
      };
    };
    const inv = [...(http.mock.state.invitations as Map<string, any>).values()].find((x) => x.email_address === ownerEmail && x.status === "pending");
    const acc = await mockPost(`/_mock/invitations/${inv.id}/accept`, {});
    owner = { email: ownerEmail, userId: acc.user.id, h: async () => ({ authorization: `Bearer ${(await mockPost("/_mock/session", { user_id: acc.user.id, org_id: dirA })).token}` }), cookies: async () => [] };
    stranger = await clerkPerson(`stranger-${STAMP}@b.example`, "Sam");
    staff = await clerkPerson(STAFF, "Staff", { platform_admin: true });
    // Someone who made a Clerk organization of their own (not an account: self-serve is off) and is also in A.
    const own = (await mockPost("/v1/organizations", { name: `Own org ${STAMP}` }, true)).id as string;
    selfMade = await clerkPerson(`maker-${STAMP}@b.example`, "Maker", { orgs: [own], active: own, orgName: `Own org ${STAMP}` });
    // The same, but also in A: the server uses A (the oldest account membership; mold_v0 #70), so the portal opens.
    alsoInA = await clerkPerson(`maker-a-${STAMP}@a.example`, "Maker", { orgs: [own, dirA], active: own, orgName: `Own org ${STAMP}` });
  } else {
    const builtinPerson = async (email: string): Promise<Person & { resign: () => Promise<void> }> => {
      let cookie = await codeSignIn(email);
      const userId = (await call("GET", "/api/auth/session", { cookie })).body.user.id as string;
      return { email, userId, h: async () => ({ cookie, "x-pack-request": "1" }), cookies: async () => [{ name: cookie.split("=")[0]!, value: cookie.slice(cookie.indexOf("=") + 1) }],
        resign: async () => { cookie = await codeSignIn(email); } };
    };
    owner = await builtinPerson(ownerEmail);
    // Someone invited, then removed: known here, so they may sign in, but in no account.
    const strangerEmail = `former-${STAMP}@a.example`;
    assert.equal((await call("POST", "/api/app/team/invitations", await owner.h(), { email: strangerEmail, role: "member" })).status, 201);
    const former = await builtinPerson(strangerEmail);
    assert.ok([200, 204].includes((await call("POST", `/api/app/team/members/${former.userId}/remove`, await owner.h())).status), "removed");
    // Removal ends their sessions: they sign in again, as someone this server knows.
    await former.resign();
    stranger = former;
    // Platform staff as /admin/admins makes them (a role on the person, who then signs in with an emailed code).
    await (await import("../src/admin-roles.js")).addAdmin({ actor: "no-account-test", userId: null }, STAFF, "support");
    staff = await builtinPerson(STAFF);
    invitee = stranger;
  }

  // ---------- 1. who may open an account ----------
  const cfg = await call("GET", "/api/auth/config");
  assert.equal(cfg.body.provider, PROVIDER);
  assert.equal(cfg.body.accounts, "invite_only", "the shell's default: accounts are opened by staff");
  ok("/api/auth/config says accounts are invite-only");

  // ---------- 2. no account: 403 no_account, with the accounts the person is in ----------
  assert.equal((await call("GET", "/api/app/access", await owner.h())).status, 200, "a member of A: the portal opens");
  const s1 = await call("GET", "/api/app/access", await stranger.h());
  assert.equal(s1.status, 403, JSON.stringify(s1.body)); assert.equal(s1.body.code, "no_account");
  assert.equal((await call("GET", "/api/app/me", await stranger.h())).body.code, "no_account", "every portal call says the same");
  assert.equal((await call("GET", "/admin/session", await stranger.h())).body.is_platform_admin, false);
  const s2 = await call("GET", "/api/app/access", await staff.h());
  assert.equal(s2.status, 403); assert.equal(s2.body.code, "no_account");
  const ss = await call("GET", "/admin/session", await staff.h());
  assert.equal(ss.body.is_platform_admin, true, JSON.stringify(ss.body)); assert.equal(ss.body.email, STAFF);
  if (selfMade) {
    const s3 = await call("GET", "/api/app/access", await selfMade.h());
    assert.equal(s3.status, 403, JSON.stringify(s3.body)); assert.equal(s3.body.code, "no_account", "an organization they made themselves is no account");
    assert.equal((await call("GET", "/api/app/access", await alsoInA!.h())).status, 200, "in an account too: the server uses it");
  }
  ok(`no account open: 403 no_account (${PROVIDER === "clerk" ? "nobody's member, an organization that is not an account" : "someone removed from their workspace"}); staff are named by /admin/session`);

  // ---------- 3. the request ----------
  const req1 = await call("POST", "/api/access-requests", {}, { email: stranger.email, company: "Example Co", name: "Sam", message: "We would like to try it.", source: { landing: "/app" } });
  assert.equal(req1.status, 201, JSON.stringify(req1.body));
  const [stored] = await db.query<{ company: string; message: string; source: any }>("SELECT company, message, source FROM access_requests WHERE email = $1 ORDER BY id DESC LIMIT 1", [stranger.email]);
  assert.equal(stored?.company, "Example Co"); assert.equal(stored?.message, "We would like to try it.");
  assert.equal((typeof stored!.source === "string" ? JSON.parse(stored!.source) : stored!.source).landing, "/app");
  assert.equal((await call("POST", "/api/access-requests", {}, { email: "not-an-address", company: "X" })).status, 400, "a bad address is refused");
  ok("a request is stored with its address, company, message and where it came from; a bad address is refused");

  // ---------- 4. built-in: an invitation waiting for the address opens the account ----------
  let inviteId: string | null = null;
  if (PROVIDER === "builtin") {
    assert.equal((await call("POST", "/api/app/team/invitations", await owner.h(), { email: stranger.email, role: "member" })).status, 201);
    const sv = await call("GET", "/api/auth/session", await stranger.h());
    assert.equal(sv.body.invitations.length, 1, JSON.stringify(sv.body));
    assert.equal(sv.body.invitations[0].organization.id, dirA);
    inviteId = sv.body.invitations[0].id;
    assert.equal((await call("GET", "/api/app/access", await stranger.h())).status, 403, "until it is accepted, still no account");
    ok("built-in: the invitation to their address is listed for the page to offer");
  }

  if (BROWSER) {
    await browserChecks({ owner, stranger, staff, selfMade, invitee, dirA, nameA: rowA!.name, inviteId, db, call });
  } else {
    // Without the browser part the invitation is accepted here, so the account opens either way.
    if (inviteId) {
      const h = await stranger.h();
      const r = await fetch(`${http.base}/api/auth/invitations/${inviteId}/accept`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 200);
      assert.equal((await call("GET", "/api/app/access", h)).status, 200, "accepted: the portal opens");
      ok("built-in: accepting the invitation opens the account");
    }
  }
  console.log(`no-account [${PROVIDER}]: ${n} checks passed${BROWSER ? "" : " (the API; add --browser for the console)"}`);
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

/** Where the console finds the API (web/next.config.ts, src/lib/server-api.ts). */
function apiUrlEnv(port: number) { return { APP_API_URL: `http://127.0.0.1:${port}` }; }

/** The console built for this sign-in, against the API on `apiPort` (next build bakes the API's address in its rewrites). */
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
    NEXT_PUBLIC_AUTH_PROVIDER: PROVIDER, ...apiUrlEnv(apiPort) };
  console.log(`  next build of the console (${PROVIDER})…`);
  const r = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`next build failed:\n${(r.stdout + r.stderr).split("\n").slice(-40).join("\n")}`);
  return path.join(out, "web");
}

async function browserChecks(w: { owner: any; stranger: any; staff: any; selfMade: any; invitee: any; dirA: string; nameA: string; inviteId: string | null; db: any; call: any }) {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const apiPort = await freePort();
  const consoleDir = buildConsole(apiPort);
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  process.env.PUBLIC_URL = origin;
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], {
    cwd: consoleDir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ...apiUrlEnv(apiPort) },
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
  const ctxFor = async (who: any | null, opts: Record<string, unknown> = {}) => {
    const c = await browser.newContext({ baseURL: origin, serviceWorkers: "block", reducedMotion: "reduce", ...opts });
    await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
    if (who) await c.addCookies((await who.cookies()).map((x: any) => ({ ...x, url: origin })));
    return c;
  };
  const settle = async (p: any) => {
    await p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin'), null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(200);
  };
  const theme = async (p: any, t: "dark" | "light") => p.evaluate((t: string) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.style.colorScheme = t;
  }, t);
  const axe = async (p: any, label: string) => {
    if (!AXE) return `${label}: not covered (no vendored axe at ${axePath})`;
    await p.addScriptTag({ content: AXE });
    const v = await p.evaluate(async () => {
      const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] }, resultTypes: ["violations"] });
      return r.violations.map((x: any) => ({ id: x.id, impact: x.impact, n: x.nodes.length, target: x.nodes[0]?.target?.join(" ") }));
    });
    const bad = v.filter((x: any) => x.impact === "serious" || x.impact === "critical");
    assert.deepEqual(bad, [], `${label}: serious or critical axe violations`);
    return `${label}: axe clean (${v.length} minor/moderate)`;
  };
  const grade = async (who: any | null, url: string, label: string, ready: string) => {
    const notes: string[] = [];
    for (const t of ["dark", "light"] as const) {
      const c = await ctxFor(who, { viewport: { width: 1280, height: 900 } });
      const p = await c.newPage();
      await p.goto(url, { waitUntil: "networkidle" });
      await p.waitForSelector(ready, { timeout: 20000 });
      await settle(p); await theme(p, t);
      notes.push(await axe(p, `${label} ${t}`));
      await c.close();
      for (const width of [390, 820, 1440]) {
        const c2 = await ctxFor(who, { viewport: { width, height: 900 }, ...(width < 1024 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
        const p2 = await c2.newPage();
        await p2.goto(url, { waitUntil: "networkidle" });
        await p2.waitForSelector(ready, { timeout: 20000 });
        await settle(p2); await theme(p2, t);
        const wide = await p2.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const over = [...document.querySelectorAll("body *")].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; });
          return { sw: document.documentElement.scrollWidth, vw, over: over ? `${over.tagName.toLowerCase()}.${String((over as HTMLElement).className).slice(0, 60)}` : null };
        });
        assert.ok(wide.sw <= wide.vw + 1, `${label} at ${width}px (${t}) scrolls sideways (${wide.sw} > ${wide.vw}; ${wide.over})`);
        if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, `${PROVIDER}-${label.replace(/[^a-z0-9]+/gi, "-")}-${width}-${t}.png`), fullPage: true });
        await c2.close();
      }
    }
    return notes;
  };

  // 5. every portal route: the page, the form filled in, the request sent.
  {
    const c = await ctxFor(w.stranger);
    const p = await c.newPage();
    for (const route of ["/app/usage", "/app"]) {
      const res = await p.goto(route, { waitUntil: "networkidle" });
      assert.ok((res?.status() ?? 0) < 400, `${route}: HTTP ${res?.status()}`);
      await p.waitForSelector('[data-testid="no-account"]', { timeout: 20000 });
      assert.match(await p.locator("h1").innerText(), /not in an? .+ account yet/, `${route}: the heading says so`);
      assert.equal((await p.locator('[data-testid="signed-in-as"]').innerText()).trim(), w.stranger.email, `${route}: who they are signed in as`);
      assert.equal(await p.locator('text=Could not load this page').count(), 0, `${route}: no error card`);
    }
    assert.equal(await p.locator('[data-testid="open-admin"]').count(), 0, "no admin link for someone who is not staff");
    await settle(p);
    const form = p.locator('[data-testid="request-access-form"]');
    assert.equal(await form.locator('input[name="email"]').inputValue(), w.stranger.email, "the address is filled in");
    await form.locator('input[name="company"]').fill("Browser Co");
    await form.locator('textarea[name="message"]').fill("Sent from the page for no account.");
    await form.locator('button[type="submit"]').click();
    await p.waitForSelector('[data-testid="request-access-sent"]', { timeout: 15000 });
    assert.match(await p.locator('[data-testid="request-access-sent"]').innerText(), new RegExp(w.stranger.email.replace(/[.+]/g, "\\$&")));
    const [row] = await w.db.query("SELECT email, company, message, source FROM access_requests WHERE company = 'Browser Co'");
    assert.equal(row?.email, w.stranger.email); assert.equal(row?.message, "Sent from the page for no account.");
    assert.equal((typeof row.source === "string" ? JSON.parse(row.source) : row.source).landing, "/app");
    await c.close();
    ok("every portal route shows the page for no account (who they are, the form with their address); the request is sent, confirmed and stored");
  }
  // 6. staff, and the ways into an account.
  {
    const c = await ctxFor(w.staff);
    const p = await c.newPage();
    await p.goto("/app", { waitUntil: "networkidle" });
    await p.waitForSelector('[data-testid="open-admin"]', { timeout: 20000 });
    assert.equal(await p.locator('[data-testid="open-admin"]').getAttribute("href"), "/admin");
    assert.match(await p.locator("#no-account-admin").innerText(), /platform staff/i);
    assert.equal(await p.locator('[data-testid="request-access-form"]').count(), 0, "staff open accounts themselves: no request form");
    await c.close();
    ok("platform staff see “Open the admin console” and why");
    if (w.selfMade) {
      const c2 = await ctxFor(w.selfMade);
      const p2 = await c2.newPage();
      await p2.goto("/app", { waitUntil: "networkidle" });
      await p2.waitForSelector('[data-testid="request-access-form"]', { timeout: 20000 });
      assert.match(await p2.locator("h1").innerText(), /not in an? .+ account yet/);
      assert.equal(await p2.locator('text=Could not load this page').count(), 0, "no error card");
      await c2.close();
      ok("Clerk: someone whose active organization is one they made themselves (no account) gets the page, not an error card");
    }
  }
  // 7. invite-only public pages.
  {
    const c = await ctxFor(null);
    const p = await c.newPage();
    await p.goto("/", { waitUntil: "networkidle" });
    const hero = p.locator("#landing-hero").locator("xpath=..");
    assert.equal(await hero.getByRole("link", { name: "Request access" }).getAttribute("href"), "/request-access", "the hero's call leads to the request form");
    assert.equal(await p.locator('a[href="/auth/sign-up"]').count(), 0, "no call leads to sign-up");
    await p.goto("/auth/sign-up", { waitUntil: "networkidle" });
    await p.waitForSelector('[data-testid="invite-only-note"]', { timeout: 20000 });
    assert.equal(await p.locator('[data-testid="invite-only-note"] a').getAttribute("href"), "/request-access");
    await p.goto("/request-access", { waitUntil: "networkidle" });
    const form = p.locator('[data-testid="request-access-form"]');
    await form.locator('input[name="email"]').fill(`visitor-${STAMP}@c.example`);
    await form.locator('input[name="company"]').fill("Visitor Co");
    await form.locator('button[type="submit"]').click();
    await p.waitForSelector('[data-testid="request-access-sent"]', { timeout: 15000 });
    const [row] = await w.db.query("SELECT source FROM access_requests WHERE email = $1", [`visitor-${STAMP}@c.example`]);
    assert.equal((typeof row.source === "string" ? JSON.parse(row.source) : row.source).landing, "/request-access");
    await c.close();
    ok("invite-only: the landing's calls lead to /request-access, whose form sends; sign-up says so and links there");
  }
  // 8. axe, light and dark, and three widths.
  const notes = [
    ...(await grade(w.stranger, "/app", "app no account", '[data-testid="request-access-form"]')),
    ...(await grade(w.staff, "/app", "app staff", '[data-testid="open-admin"]')),
    ...(w.selfMade ? await grade(w.selfMade, "/app", "app own org", '[data-testid="request-access-form"]') : []),
    ...(await grade(null, "/request-access", "request access", '[data-testid="request-access-form"]')),
    ...(await grade(null, "/", "landing", "#landing-hero")),
  ];
  for (const x of notes) console.log(`  ${x}`);
  ok(`axe: no serious or critical violation, dark and light; nothing scrolls sideways at 390, 820 and 1440 px${SHOTS ? ` (screenshots: ${SHOTS})` : ""}`);
  // Last: accepting the invitation gives the person an account, so every check of the page for no account comes first.
  {
    if (w.inviteId && w.invitee) {
      const c3 = await ctxFor(w.invitee);
      const p3 = await c3.newPage();
      await p3.goto("/app", { waitUntil: "networkidle" });
      const btn = p3.getByRole("button", { name: `Join ${w.nameA}` });
      await btn.waitFor({ timeout: 20000 });
      // Graded before it is accepted (below), so the page with an invitation is measured too.
      if (SHOTS) await p3.screenshot({ path: path.join(SHOTS, `${PROVIDER}-app-invitation-1440-dark.png`), fullPage: true });
      await btn.click();
      await p3.waitForURL(/\/app$/, { timeout: 20000 });
      await p3.waitForFunction(() => !document.querySelector('[data-testid="no-account"]'), null, { timeout: 20000 });
      assert.equal((await w.call("GET", "/api/app/access", await w.invitee.h())).status, 200, "the account is open");
      await c3.close();
      ok("built-in: the invitation is accepted in one click and the account opens");
    }
  }
}
