// The platform account (mold_v0-276; src/platform-account.ts, src/app.ts customerSession, POST /api/cron/platform-account,
// web/src/components/layout/portal-frame.tsx), under both sign-ins, offline: an embedded database and the mock providers
// (a fake Clerk, Resend as the email transport).
//   npm run test:platform-account                            both: builtin, then clerk (the API only)
//   tsx scripts/platform-account-test.ts builtin|clerk [--browser] [--shots <dir>]
//
// 1. A platform admin (APP_PLATFORM_ADMINS) with no account signs in and reaches /app: the platform account is made
//    (named "<brand> (platform)", slug `platform`, marked), they land in it as its owner; three requests at once make
//    one account and one membership.
// 2. A second sign-in makes nothing new: the same account, the same one membership.
// 3. A second admin joins the same account as an owner; a person given a lesser platform role (support) joins it as a
//    member; still one platform account.
// 4. Someone who is no platform admin still gets 403 no_account (the page for no account), and is put in nothing.
// 5. The staff log has the account made and each member added (src/admin.ts log lines) and, with the platform trail on,
//    a staff entry for each in the account's slice (audit_platform_events).
// 6. The factory's call: POST /api/cron/platform-account refuses without the cron secret or the worker token; with either
//    it answers counts only (no address) and changes nothing more; an owner demoted on the account's Team page is made
//    owner again. With the mark gone (as sql/rollback/0058 leaves it) it makes the account afresh under the next free
//    slug, every admin in it.
// 7. An address taken off APP_PLATFORM_ADMINS keeps its membership; the account is not deleted.
// With --browser (built-in): the console built and started against this API; an admin signs in and opens /app, and the
// portal opens in the platform account (no page for no account); a screenshot, light, 1440 px, to --shots <dir>.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import path from "node:path";

const PROVIDER = process.argv[2] === "clerk" ? "clerk" : "builtin";
const BROWSER = process.argv.includes("--browser");
const SHOTS = process.argv.includes("--shots") ? path.resolve(process.argv[process.argv.indexOf("--shots") + 1]!) : null;
process.env.AUTH_PROVIDER = PROVIDER;
const T = Date.now().toString(36);
const ADMIN1 = `first-${T}@platform.example`, ADMIN2 = `second-${T}@platform.example`, ADMIN3 = `third-${T}@platform.example`;
process.env.APP_PLATFORM_ADMINS = [ADMIN1, ADMIN2, ADMIN3].join(",");
process.env.CRON_SECRET = `cron-${T}-secret`;
const { cleanup, startHttp, STAMP, TMP } = await import("./lib/test-world.js");
const ROOT = path.resolve(import.meta.dirname, "..");

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ [${PROVIDER}] ${what}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teardown: (() => unknown)[] = [];
// The staff log (src/admin.ts log): one stderr line per change.
const staffLog: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { const line = a.map(String).join(" "); if (line.startsWith("admin ")) staffLog.push(line); origError(...a); };

try {
  const http = await startHttp();
  const { getDb } = await import("../src/db.js");
  const { PROFILE } = await import("../src/profile.js");
  const audit = await import("../src/audit-trail.js");
  audit.setAuditForTest({ platform: true });
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
  const mockPost = async (p: string, body: unknown) => (await fetch(`${http.mock.url}${p}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const emails = () => http.mock.state.emails as any[];
  const kindOf = (e: any) => e.tags?.find((t: any) => t.name === "kind")?.value;
  let ip = 0;
  const codeSignIn = async (email: string) => {
    const h = { "x-forwarded-for": `198.51.100.${++ip}` };
    const before = emails().filter((e) => e.to.includes(email) && kindOf(e) === "sign_in_code").length;
    assert.equal((await call("POST", "/api/auth/email/request", h, { email })).status, 200);
    let code = "";
    for (let i = 0; i < 200 && !code; i++) {
      const m = emails().filter((e) => e.to.includes(email) && kindOf(e) === "sign_in_code");
      if (m.length > before) code = /sign-in code is (\d{8})/.exec(m.at(-1).text)![1]!; else await wait(20);
    }
    assert.ok(code, `a code emailed to ${email}`);
    const r = await call("POST", "/api/auth/email/verify", h, { email, code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const set = r.headers.getSetCookie().find((c) => /^(__Host-)?oct_session=[^;]+/.test(c) && !/Max-Age=0/.test(c));
    assert.ok(set, "a session cookie");
    return set!.split(";")[0]!;
  };

  /** A person who signs in afresh each time sign() is called: request headers for that sign-in. */
  interface Person { email: string; sign: () => Promise<H>; userId: () => Promise<string>; cookies?: () => Promise<{ name: string; value: string }[]> }
  const person = async (email: string, opts: { platform_role?: string } = {}): Promise<Person> => {
    if (PROVIDER === "clerk") {
      const u = await mockPost("/_mock/clerk/users", { email, first_name: "Pat", verified: true, ...(opts.platform_role ? { platform_role: opts.platform_role } : {}) });
      return { email, userId: async () => u.id, sign: async () => ({ authorization: `Bearer ${(await mockPost("/_mock/session", { user_id: u.id })).token}` }) };
    }
    if (opts.platform_role) await (await import("../src/admin-roles.js")).addAdmin({ actor: "platform-account-test", userId: null }, email, opts.platform_role);
    let last = "";
    const sign = async () => { last = await codeSignIn(email); return { cookie: last, "x-pack-request": "1" }; };
    return { email, sign, userId: async () => (await call("GET", "/api/auth/session", { cookie: last || (await sign()).cookie })).body.user.id as string,
      cookies: async () => { if (!last) await sign(); return [{ name: last.split("=")[0]!, value: last.slice(last.indexOf("=") + 1) }]; } };
  };
  const marked = async () => db.query<{ id: number; slug: string; name: string; clerk_org_id: string }>("SELECT id, slug, name, clerk_org_id FROM organizations WHERE platform_account");
  const orgCount = async () => Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM organizations"))[0]!.n);
  const membersOf = async (dirId: string) => (await (await import("../src/people.js")).people().memberships.list(dirId));
  const roleIn = async (dirId: string, userId: string) => {
    const m = (await membersOf(dirId)).find((x) => x.public_user_data?.user_id === userId);
    return m ? (await import("../src/account-roles.js")).accountRoleOf(m) : null;
  };

  // ---------- 1. an admin with no account gets one and lands in it as owner ----------
  assert.equal((await marked()).length, 0, "no platform account before anyone signs in");
  const a1 = await person(ADMIN1);
  const h1 = await a1.sign();
  const before = await orgCount();
  const three = await Promise.all([1, 2, 3].map(() => call("GET", "/api/app/access", h1)));
  assert.deepEqual(three.map((r) => r.status), [200, 200, 200], JSON.stringify(three.map((r) => r.body)));
  const [acct, ...more] = await marked();
  assert.ok(acct && !more.length, "exactly one platform account");
  assert.equal(await orgCount(), before + 1, "one account made");
  assert.equal(acct!.name, `${PROFILE.name} (platform)`, "named from the build's brand");
  assert.equal(acct!.slug, "platform", "under the stable slug");
  const me1 = await call("GET", "/api/app/me", h1);
  assert.equal(me1.status, 200, JSON.stringify(me1.body));
  assert.equal(me1.body.account.slug, "platform"); assert.equal(me1.body.account_role, "owner", "lands as its owner");
  assert.equal(me1.body.email, ADMIN1);
  assert.equal((await membersOf(acct!.clerk_org_id)).length, 1, "one membership, whatever ran at once");
  ok("an admin with no account signs in: the platform account is made (brand name, slug platform, marked) and they land in it as owner; three requests at once made one account and one membership");

  // ---------- 2. a second sign-in creates nothing new ----------
  const h1b = await a1.sign();
  assert.equal((await call("GET", "/api/app/access", h1b)).status, 200);
  assert.equal((await call("GET", "/api/app/me", h1b)).body.account.slug, "platform");
  assert.equal(await orgCount(), before + 1, "no new account");
  assert.equal((await marked()).length, 1);
  assert.equal((await membersOf(acct!.clerk_org_id)).length, 1, "no new membership");
  ok("a second sign-in makes nothing new: the same account, the same membership");

  // ---------- 3. a second admin joins the same account; a lesser platform role joins as member ----------
  const a2 = await person(ADMIN2);
  const h2 = await a2.sign();
  const me2 = await call("GET", "/api/app/me", h2);
  assert.equal(me2.status, 200, JSON.stringify(me2.body));
  assert.equal(me2.body.account.slug, "platform"); assert.equal(me2.body.account_role, "owner");
  const sup = await person(`support-${T}@platform.example`, { platform_role: "support" });
  const hs = await sup.sign();
  const meS = await call("GET", "/api/app/me", hs);
  assert.equal(meS.status, 200, JSON.stringify(meS.body)); assert.equal(meS.body.account.slug, "platform"); assert.equal(meS.body.account_role, "member", "support staff work in it, as a member");
  assert.equal((await marked()).length, 1, "still one platform account");
  assert.equal(await orgCount(), before + 1);
  assert.equal((await membersOf(acct!.clerk_org_id)).length, 3);
  // The team page lists them as anyone's (the owners see each other).
  const team = await call("GET", "/api/app/team", h2);
  assert.deepEqual(team.body.members.map((m: any) => m.email).sort(), [ADMIN1, ADMIN2, sup.email].sort(), JSON.stringify(team.body));
  ok("a second admin joins the same account as owner; support staff join it as member; one platform account");

  // ---------- 4. someone who is no platform admin still has no account ----------
  const stranger = await person(`stranger-${T}@b.example`);
  if (PROVIDER === "builtin") {
    // The built-in sign-in emails a code only to a known address: invited to an account and then removed from it.
    const own = await call("POST", "/api/admin/onboarding/orgs", { authorization: `Bearer ${await http.adminToken("owner")}` }, { name: `Account A ${T}`, email: `owner-${T}@a.example` });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const ho = { cookie: await codeSignIn(`owner-${T}@a.example`), "x-pack-request": "1" };
    assert.equal((await call("POST", "/api/app/team/invitations", ho, { email: stranger.email, role: "member" })).status, 201);
    const sid = await stranger.userId();
    assert.ok([200, 204].includes((await call("POST", `/api/app/team/members/${sid}/remove`, ho)).status));
  }
  const accountsBefore = await orgCount();
  const hx = await stranger.sign();
  const sx = await call("GET", "/api/app/access", hx);
  assert.equal(sx.status, 403, JSON.stringify(sx.body)); assert.equal(sx.body.code, "no_account", "the page for no account, as before");
  assert.equal((await call("GET", "/admin/session", hx)).body.is_platform_admin, false);
  assert.equal(await roleIn(acct!.clerk_org_id, await stranger.userId()), null, "never put in the platform account");
  assert.equal(await orgCount(), accountsBefore, "nothing made for them");
  ok("someone who is no platform admin still gets 403 no_account and is put in nothing");

  // ---------- 5. the staff log and the platform trail ----------
  const lines = (what: string) => staffLog.filter((l) => l.includes(` ${what} `) && l.includes("org=platform"));
  assert.equal(lines("org.create").length, 1, staffLog.join("\n"));
  assert.equal(lines("platform_account.create").length, 1, "the account made, once");
  assert.equal(lines("platform_account.member_add").length, 3, "each member added, once");
  assert.ok(lines("platform_account.member_add").some((l) => l.startsWith(`admin ${ADMIN1} `) && l.includes('"role":"owner"')), "by whom, with the role");
  await audit.flushAudit();
  const trail = await db.query<{ path: string; actor_kind: string; org_id: number | null }>(
    "/* tenant: platform: the test reads the platform trail */ SELECT path, actor_kind, org_id FROM audit_platform_events WHERE path LIKE '/platform-account/%' ORDER BY seq");
  assert.deepEqual(trail.map((r) => r.path), ["/platform-account/create", "/platform-account/member-add/owner", "/platform-account/member-add/owner", "/platform-account/member-add/member"], JSON.stringify(trail));
  assert.ok(trail.every((r) => r.actor_kind === "staff" && r.org_id === acct!.id), "staff entries in the account's slice");
  ok("the staff log has the account made and each member added; the platform trail has a staff entry for each, in the account's slice");

  // ---------- 6. the factory's call ----------
  const P = "/api/cron/platform-account";
  assert.equal((await call("POST", P)).status, 401, "no secret: refused");
  assert.equal((await call("POST", P, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call("POST", P, { authorization: `Bearer ${await http.adminToken("owner")}` })).status, 401, "an admin token is not the factory's");
  const viaCron = await call("POST", P, { authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(viaCron.status, 200, JSON.stringify(viaCron.body));
  assert.deepEqual({ ...viaCron.body, account: viaCron.body.account.slug }, { ok: true, account: "platform", created: false, staff: 3, added: 0, promoted: 0, suspended: 0, not_signed_in: 1 },
    "everyone there already; the third listed address has not signed in");
  assert.ok(!JSON.stringify(viaCron.body).includes("@"), "counts only: no address in the answer");
  // An owner demoted on the account's Team page is made owner again by the factory's call (the list keeps every admin owner).
  assert.equal((await call("POST", `/api/app/team/members/${await a2.userId()}/role`, h1, { role: "member" })).status, 204);
  assert.equal(await roleIn(acct!.clerk_org_id, await a2.userId()), "member");
  const viaWorker = await call("POST", P, { authorization: `Bearer ${process.env.APP_WORKER_TOKEN}` });
  assert.equal(viaWorker.status, 200, JSON.stringify(viaWorker.body));
  assert.equal(viaWorker.body.promoted, 1); assert.equal(viaWorker.body.added, 0);
  assert.equal(await roleIn(acct!.clerk_org_id, await a2.userId()), "owner", "owner again");
  assert.equal(lines("platform_account.member_role").length, 1, "the role raised is in the staff log");
  // The mark gone (sql/rollback/0058_platform_account.sql leaves the account as an ordinary one): the call makes it afresh
  // under the next free slug, with every admin who has signed in.
  await db.query("UPDATE organizations SET platform_account = false WHERE id = $1", [acct!.id]);
  const fresh = await call("POST", P, { authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.created, true); assert.equal(fresh.body.account.slug, "platform-account", "the next free slug"); assert.equal(fresh.body.added, 3);
  const [acct2] = await marked();
  assert.equal(await roleIn(acct2!.clerk_org_id, await a1.userId()), "owner"); assert.equal(await roleIn(acct2!.clerk_org_id, await a2.userId()), "owner");
  assert.equal(await roleIn(acct2!.clerk_org_id, await sup.userId()), "member");
  const again = await call("POST", P, { authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(again.body.created, false); assert.equal(again.body.added, 0, "and once is enough");
  assert.equal((await marked()).length, 1);
  ok("the factory's call: refused without the cron secret or the worker token; counts only; an owner demoted is owner again; with the mark gone it makes the account afresh (next free slug, every admin in it), once");

  // ---------- 7. an address taken off the list keeps its membership; nothing is deleted ----------
  process.env.APP_PLATFORM_ADMINS = [ADMIN2, ADMIN3].join(",");
  const h1c = await a1.sign();
  assert.equal((await call("GET", "/admin/session", h1c)).body.is_platform_admin, false, "no longer platform staff");
  assert.equal((await call("GET", "/api/app/access", h1c)).status, 200, "still in the platform account");
  assert.equal(await roleIn(acct2!.clerk_org_id, await a1.userId()), "owner", "the membership stays");
  assert.equal((await call("POST", P, { authorization: `Bearer ${process.env.CRON_SECRET}` })).body.staff, 2, "the factory counts the list as it is now");
  assert.equal((await marked()).length, 1, "the account stays");
  assert.equal(await roleIn(acct2!.clerk_org_id, await a1.userId()), "owner", "and the factory's call removes nobody");
  process.env.APP_PLATFORM_ADMINS = [ADMIN1, ADMIN2, ADMIN3].join(",");
  ok("an address taken off APP_PLATFORM_ADMINS keeps its membership; the account is never deleted");

  if (BROWSER) {
    if (PROVIDER !== "builtin") console.log("  --browser: built-in sign-in only (the console's Clerk stand-in is the no-account test's)");
    else await browserCheck(await person(ADMIN3), acct2!.name, call);
  }
  console.log(`platform-account [${PROVIDER}]: ${n} checks passed${BROWSER ? "" : " (the API; add --browser for the console)"}`);
} finally {
  for (const f of teardown.reverse()) { try { await f(); } catch { /* best effort */ } }
  console.error = origError;
  cleanup();
}
process.exit(0);

// ---------- the console, in a browser (built-in sign-in) ----------

async function freePort() {
  return new Promise<number>((res, rej) => {
    const s = netServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

async function browserCheck(admin: { email: string; cookies?: () => Promise<{ name: string; value: string }[]> }, accountName: string, call: (m: string, p: string, h?: Record<string, string>) => Promise<{ status: number; body: any }>) {
  const pw = createRequire("/usr/lib/node_modules/")("playwright");
  const apiPort = await freePort(), consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  const web = path.join(ROOT, "web"), out = path.join(TMP, "console");
  const skip = (p: string) => ["node_modules", ".next", ".turbo"].includes(path.basename(p)) || path.basename(p).startsWith(".env");
  cpSync(web, path.join(out, "web"), { recursive: true, filter: (src) => !skip(src) });
  symlinkSync(realpathSync(path.join(web, "node_modules")), path.join(out, "web", "node_modules"), "dir");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_AUTH_PROVIDER: "builtin", APP_API_URL: `http://127.0.0.1:${apiPort}` };
  console.log("  next build of the console (builtin)…");
  const b = spawnSync("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: path.join(out, "web"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) throw new Error(`next build failed:\n${(b.stdout + b.stderr).split("\n").slice(-40).join("\n")}`);
  process.env.PUBLIC_URL = origin;
  const { createApp } = await import("../src/http.js");
  const api = createApp().listen(apiPort, "127.0.0.1");
  await new Promise<void>((res, rej) => { api.once("listening", () => res()); api.once("error", rej); });
  teardown.push(() => new Promise((r) => api.close(() => r(null))));
  const next: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(consolePort), "-H", "127.0.0.1"], { cwd: path.join(out, "web"), stdio: ["ignore", "pipe", "pipe"], env });
  let log = "";
  next.stdout?.on("data", (x) => { log = (log + x).slice(-8000); }); next.stderr?.on("data", (x) => { log = (log + x).slice(-8000); });
  teardown.push(() => new Promise((r) => { if (next.exitCode !== null) return r(null); next.once("exit", () => r(null)); next.kill("SIGTERM"); setTimeout(() => { next.kill("SIGKILL"); r(null); }, 5000); }));
  let up = false;
  for (let i = 0; i < 120 && !up && next.exitCode === null; i++) {
    try { up = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })).status < 500; } catch { await wait(1000); }
  }
  assert.ok(up, `the console came up on ${origin}:\n${log}`);
  const browser = await pw.chromium.launch();
  teardown.push(() => browser.close());
  const c = await browser.newContext({ baseURL: origin, serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  await c.route("**/*", (route: any) => (/^(data:|blob:|https?:\/\/(127\.0\.0\.1|localhost)[:/])/.test(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
  await c.addInitScript(() => { try { localStorage.setItem("console-color-mode", "light"); } catch { /* none */ } });
  await c.addCookies((await admin.cookies!()).map((x) => ({ ...x, url: origin })));
  const p = await c.newPage();
  await p.goto("/app", { waitUntil: "networkidle" });
  await p.waitForSelector("#main-content", { timeout: 30000 });
  assert.equal(await p.locator('[data-testid="no-account"]').count(), 0, "never the page for no account");
  assert.equal(await p.locator('[data-testid="platform-account-problem"]').count(), 0);
  await p.waitForFunction((name: string) => document.body.innerText.includes(name), accountName, { timeout: 20000 });
  await p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin'), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => document.documentElement.classList.contains("dark")), false, "light");
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, "platform-admin-app-light-1440.png") }); }
  const me = await call("GET", "/api/app/me", { cookie: (await admin.cookies!()).map((x) => `${x.name}=${x.value}`).join("; ") });
  assert.equal(me.body.account_role, "owner");
  await c.close();
  ok(`the console: a platform admin signs in, opens /app and lands in ${accountName} as owner${SHOTS ? ` (screenshot: ${path.join(SHOTS, "platform-admin-app-light-1440.png")})` : ""}`);
}
