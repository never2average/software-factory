// Health › Sign-in's checker (mold_v0-270; src/sign-in-check.ts, web/src/features/admin/sign-in-check.tsx).
//   npm run test:sign-in-check            offline: every provider is a stand-in on 127.0.0.1
//   SIGN_IN_SNAPSHOT_DIR=<dir>            keep screenshots of the tab (light 1440 px, dark 390 px) when the machine has a
//                                         headless browser (CHROME_BIN, or a Playwright cache)
//
// The providers' own addresses (accounts.google.com, github.com, api.clerk.com, the Clerk instance's Frontend API, a
// pack's OAuth provider) are mapped to stand-in servers that answer as each was measured to: Google 302s to its sign-in
// page for a listed return address and to /signin/oauth/error?authError=<redirect_uri_mismatch> for one it does not
// list; GitHub sends every anonymous request to its sign-in page (naming the app for a known client id); Clerk's Backend
// API names the instance's domains, its Frontend API its social sign-ins and, for an anonymous sign-in attempt, the
// provider's authorize address (refused for an origin it does not hold). Nothing reaches a real provider.
//
// 1. The classifiers: pass, fail and unknown for Google, GitHub and any other provider; nothing they cannot read is a pass.
// 2. An app on Clerk: its domain, Google and GitHub through Clerk, AI clients' registration; then the front door moves to
//    a domain Clerk does not hold (fail, with Clerk's Domains steps), Google stops listing Clerk's callback (fail, with
//    the exact address on its own line), Clerk's settings cannot be read (unknown).
// 3. The built-in sign-in: Google's callback on the front door, pass / fail / unknown; AI clients on the front door.
// 4. The platform GitHub App: the callback is unknown from a probe and decided by what came back (an old address: fail;
//    the front door: pass; an error GitHub sent back with a state this server signed: fail; a forged one: ignored), the
//    install's authorization, the webhook address GitHub holds.
// 5. A credential OAuth provider: unregistered (fail), registered (unknown, then pass once someone came back), through
//    the callback route itself.
// 6. The report: at most an hour old, "check again" at most once a minute, a new front door starts afresh; the staff
//    answer carries no client id and no secret, the factory's (the cron secret) the public client ids.
// 7. The two routes: the staff tab's (an admin token) and the factory's (CRON_SECRET only).
// 8. The tab in a headless browser: a pass, a fail and an unknown card; screenshots with SIGN_IN_SNAPSHOT_DIR.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanup, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FRONT = "https://app.example.com", NEW_FRONT = "https://app.newco.test", API = "https://app-api.example.net", FAPI = "https://clerk.example.com";
const SK = `sk_live_standin_${randomBytes(12).toString("hex")}`;
const CRON = `cron-${randomBytes(12).toString("hex")}`;
const CLERK_GOOGLE = "111111111111-clerkgoogleclientaaaaaaaaaaaaaaaa.apps.googleusercontent.com";
const OWN_GOOGLE = "222222222222-builtingoogleclientbbbbbbbbbbbbbbb.apps.googleusercontent.com";
const CLERK_GITHUB = `Ov23li${randomBytes(7).toString("hex")}`;
const GH_CLIENT = `Iv1.${randomBytes(8).toString("hex")}`, GH_SECRET = `gh-secret-canary-${randomBytes(12).toString("hex")}`, GH_HOOK_SECRET = `hook-canary-${randomBytes(12).toString("hex")}`;
const ACME_CLIENT = `acme-client-${randomBytes(6).toString("hex")}`;
const { privateKey: GH_KEY } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SECRETS = [SK, CRON, GH_SECRET, GH_HOOK_SECRET, ...GH_KEY.split("\n").filter((l) => l.length > 40)];
const CLIENT_IDS = [CLERK_GOOGLE, OWN_GOOGLE, CLERK_GITHUB, GH_CLIENT, ACME_CLIENT];

Object.assign(process.env, { APP_CONSOLE_URL: FRONT, PUBLIC_URL: API, CLERK_SECRET_KEY: SK, CLERK_FRONTEND_API_URL: FAPI, CRON_SECRET: CRON,
  CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from("clerk.example.com$").toString("base64")}` });
delete process.env.AUTH_PROVIDER; delete process.env.APP_MCP_URL; delete process.env.GOOGLE_REDIRECT_URI; delete process.env.CLERK_API_URL;

// ---------------------------------------------------------------- the stand-in providers

type Reply = { status: number; headers?: Record<string, string | string[]>; body?: string };
const calls: { host: string; method: string; path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
async function serve(host: string, h: (u: URL, req: IncomingMessage, body: string) => Reply) {
  const s = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const u = new URL(req.url ?? "/", `https://${host}`);
    calls.push({ host, method: req.method ?? "GET", path: u.pathname, headers: req.headers, body });
    const a = h(u, req, body);
    res.writeHead(a.status, a.headers ?? {}); res.end(a.body ?? "");
  });
  s.listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r));
  return { local: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}
const b64u = (b: string) => Buffer.from(b, "latin1").toString("base64url");
const page = (s: string) => ({ status: 200, headers: { "content-type": "text/html" }, body: `<!doctype html><html><body>${s}</body></html>` });
const send = (status: number, j: unknown, headers: Record<string, string | string[]> = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(j) });

/** Google: per client, the return addresses it lists. */
const google = { lists: new Map<string, Set<string>>([[CLERK_GOOGLE, new Set([`${FAPI}/v1/oauth_callback`])], [OWN_GOOGLE, new Set([`${FRONT}/api/auth/google/callback`])]]), mode: "up" as "up" | "garbled" };
const G = await serve("accounts.google.com", (u) => {
  if (google.mode === "garbled") return page("a new page");
  if (u.pathname === "/o/oauth2/v2/auth" || u.pathname === "/o/oauth2/auth") {
    const list = google.lists.get(u.searchParams.get("client_id") ?? "");
    if (!list) return { status: 302, headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${b64u("\n\x0einvalid_client\x12\x1aThe OAuth client was not found.")}` } };
    return list.has(u.searchParams.get("redirect_uri") ?? "")
      ? { status: 302, headers: { location: "https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow" } }
      : { status: 302, headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${b64u("\n\x15redirect_uri_mismatch\x12\x10You can't sign in")}&client_id=x` } };
  }
  return { status: 404 };
});
/** GitHub: every anonymous authorize goes to the sign-in page, which names a known app (as measured, 2026-11-07). */
const github = { apps: new Map([[GH_CLIENT, "Platform App"], [CLERK_GITHUB, "Sign-in App"]]), checksFirst: false, hook: `${API}/api/github-app/webhook`, callbacks: new Map([[GH_CLIENT, `${FRONT}/api/github-app/callback`]]) };
const H = await serve("github.com", (u, req) => {
  if (u.pathname === "/login/oauth/authorize") {
    const cid = u.searchParams.get("client_id") ?? "";
    if (github.checksFirst && github.callbacks.get(cid) && github.callbacks.get(cid) !== u.searchParams.get("redirect_uri"))
      return { status: 302, headers: { location: `${github.callbacks.get(cid)}?error=redirect_uri_mismatch&error_description=The+redirect_uri+MUST+match` } };
    return { status: 302, headers: { location: `https://github.com/login?client_id=${encodeURIComponent(cid)}&return_to=${encodeURIComponent(u.pathname + u.search)}` } };
  }
  if (u.pathname === "/login") {
    const app = github.apps.get(u.searchParams.get("client_id") ?? "");
    return page(`<p>Sign in to <strong>GitHub</strong>${app ? `<br>to continue to <strong>${app}</strong>` : ""}</p><form></form>`);
  }
  if (u.pathname === "/app/hook/config") return /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(String(req.headers.authorization ?? "")) ? send(200, { content_type: "json", insecure_ssl: "0", url: github.hook }) : send(401, { message: "Bad credentials" });
  return { status: 404 };
});
/** Clerk's Backend API (the secret key) and its Frontend API (public). */
const clerk = { env: "production", domains: ["example.com"], allowed: [] as string[], social: true, registration: true, backend: true, refuse: "" };
const holds = (o: string) => { try { const h = new URL(o).host; return clerk.env === "development" || clerk.domains.some((d) => h === d || h.endsWith(`.${d}`)) || clerk.allowed.includes(o); } catch { return false; } };
const CB = await serve("api.clerk.com", (u, req) => {
  if (!clerk.backend || req.headers.authorization !== `Bearer ${SK}`) return send(401, { errors: [{ code: "authentication_invalid" }] });
  if (u.pathname === "/v1/instance") return send(200, { object: "instance", id: "ins_1", environment_type: clerk.env, allowed_origins: clerk.allowed });
  if (u.pathname === "/v1/domains") return send(200, { data: clerk.domains.map((name, i) => ({ object: "domain", id: `dmn_${i}`, name, is_satellite: i > 0, frontend_api_url: FAPI })), total_count: clerk.domains.length });
  return send(404, {});
});
const CF = await serve("clerk.example.com", (u, req, body) => {
  if (u.pathname === "/v1/environment") return clerk.social ? send(200, { user_settings: { social: {
    oauth_google: { enabled: true, strategy: "oauth_google", name: "Google" }, oauth_github: { enabled: true, strategy: "oauth_github", name: "GitHub" }, oauth_apple: { enabled: false, strategy: "oauth_apple", name: "Apple" } } } }) : send(503, {});
  if (u.pathname === "/v1/client" && req.method === "GET") return send(200, { response: null }, { "set-cookie": ["__client=standin-client; Path=/; Secure; HttpOnly", "other=1"] });
  if (u.pathname === "/v1/client/sign_ins" && req.method === "POST") {
    const f = new URLSearchParams(body);
    if (!holds(String(req.headers.origin ?? "")) || !holds(f.get("redirect_url") ?? "")) return send(400, { errors: [{ code: "origin_invalid", message: "is invalid", long_message: "The origin is not allowed for this instance", meta: { param_name: "redirect_url" } }] });
    const cb = encodeURIComponent(`${FAPI}/v1/oauth_callback`);
    const ext = f.get("strategy") === "oauth_google" ? `https://accounts.google.com/o/oauth2/auth?client_id=${CLERK_GOOGLE}&redirect_uri=${cb}&response_type=code&scope=openid&state=s`
      : f.get("strategy") === "oauth_github" ? `https://github.com/login/oauth/authorize?client_id=${CLERK_GITHUB}&redirect_uri=${cb}&scope=user%3Aemail&state=s` : null;
    return ext ? send(200, { response: { object: "sign_in_attempt", status: "needs_first_factor", first_factor_verification: { status: "unverified", strategy: f.get("strategy"), external_verification_redirect_url: ext } } })
      : send(422, { errors: [{ code: "strategy_for_user_invalid" }] });
  }
  if (u.pathname === "/.well-known/oauth-authorization-server") return send(200, { issuer: FAPI, authorization_endpoint: `${FAPI}/oauth/authorize`, ...(clerk.registration ? { registration_endpoint: `${FAPI}/oauth/register` } : {}) });
  return send(404, {});
});
/** A pack's OAuth provider: refuses a return address it does not hold before any sign-in (as many do). */
const acme = { registered: new Set<string>() };
const A = await serve("login.acme.test", (u) => {
  if (u.pathname !== "/authorize") return { status: 404 };
  return acme.registered.has(u.searchParams.get("redirect_uri") ?? "") ? { status: 302, headers: { location: "https://login.acme.test/login?next=x" } }
    : send(400, { error: "invalid_request", error_description: "The redirect_uri is not registered for this client" });
});
const MAP: Record<string, string> = { "https://accounts.google.com": G.local, "https://github.com": H.local, "https://api.github.com": H.local, "https://api.clerk.com": CB.local,
  [FAPI]: CF.local, "https://login.acme.test": A.local, "https://down.example.test": "http://127.0.0.1:9" };
const rewrite = (url: string) => { const o = new URL(url).origin; return MAP[o] ? MAP[o] + url.slice(o.length) : url; };

try {
  const SIC = await import("../src/sign-in-check.js");
  SIC.setSignInEndpointsForTest({ rewrite });
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const { createOrg } = await import("../src/auth.js");
  const { issueState } = await import("../src/oauth-state.js");
  const ghApp = await import("../src/github-app.js");
  ghApp.setGithubEndpointsForTest({ api: H.local, web: "https://github.com" });
  const byId = (fl: { id: string }[], id: string) => fl.find((f) => f.id === id) as Awaited<ReturnType<typeof SIC.checkSignIn>>[number];
  const noSecret = (text: string, what: string) => assert.deepEqual(SECRETS.filter((s) => text.includes(s)).map((s) => s.slice(0, 8)), [], `${what}: no secret`);

  // ---------- 1. the classifiers ----------
  {
    const g = (cid: string, uri: string) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(uri)}&response_type=code`;
    assert.equal((await SIC.probeGoogle(g(OWN_GOOGLE, `${FRONT}/api/auth/google/callback`))).result, "pass", "Google lists it: pass");
    const miss = await SIC.probeGoogle(g(OWN_GOOGLE, `${NEW_FRONT}/api/auth/google/callback`));
    assert.equal(miss.result, "fail"); assert.match(miss.detail, /redirect_uri_mismatch/, "Google does not list it: fail, saying redirect_uri_mismatch");
    assert.match((await SIC.probeGoogle(g("999-nope.apps.googleusercontent.com", FRONT))).detail, /invalid_client/, "an unknown client: fail, saying so");
    google.mode = "garbled";
    assert.equal((await SIC.probeGoogle(g(OWN_GOOGLE, `${FRONT}/api/auth/google/callback`))).result, "unknown", "a page not understood: unknown, never pass");
    google.mode = "up";
    assert.equal((await SIC.probeGoogle("https://down.example.test/o/oauth2/v2/auth")).result, "unknown", "nothing answers: unknown");
    const gh = await SIC.probeGithub(`https://github.com/login/oauth/authorize?client_id=${GH_CLIENT}&redirect_uri=${encodeURIComponent(`${NEW_FRONT}/api/github-app/callback`)}`);
    assert.equal(gh.result, "unknown", "GitHub, anonymous, a wrong address: unknown (it checks after a sign-in), never pass");
    assert.match(gh.detail, /knows the app \(Platform App\)/);
    assert.match((await SIC.probeGithub("https://github.com/login/oauth/authorize?client_id=Iv1.unknown")).detail, /did not name an app/, "an unknown client id is said, still unknown");
    github.checksFirst = true;
    assert.equal((await SIC.probeGithub(`https://github.com/login/oauth/authorize?client_id=${GH_CLIENT}&redirect_uri=${encodeURIComponent(`${NEW_FRONT}/api/github-app/callback`)}`)).result, "fail", "GitHub sending back redirect_uri_mismatch: fail");
    github.checksFirst = false;
    const ac = (uri: string) => `https://login.acme.test/authorize?client_id=${ACME_CLIENT}&redirect_uri=${encodeURIComponent(uri)}&response_type=code`;
    assert.equal((await SIC.probeGeneric(ac(`${FRONT}/x`), `${FRONT}/x`)).result, "fail", "another provider naming the address as not registered: fail");
    acme.registered.add(`${FRONT}/x`);
    assert.equal((await SIC.probeGeneric(ac(`${FRONT}/x`), `${FRONT}/x`)).result, "unknown", "another provider going on to its sign-in: unknown, never pass");
    acme.registered.clear();
    console.log("✓ the classifiers: Google pass / fail / unknown, GitHub unknown unless it says the mismatch, another provider fail or unknown");
  }

  // ---------- 2. an app on Clerk ----------
  {
    calls.length = 0;
    let fl = await SIC.checkSignIn();
    assert.deepEqual(fl.map((f) => f.id), ["clerk.domain", "clerk.oauth_google", "clerk.oauth_github", "mcp"], "Clerk's domain, its two social sign-ins that are on (not Apple), AI clients");
    assert.equal(byId(fl, "clerk.domain").result, "pass");
    const cg = byId(fl, "clerk.oauth_google");
    assert.deepEqual([cg.result, cg.redirect_uri, cg.provider], ["pass", `${FAPI}/v1/oauth_callback`, "google"], "Google through Clerk: Clerk's own callback, listed: pass");
    assert.match(cg.detail, /custom credentials \(a production instance/, "a production instance: custom credentials");
    assert.equal(byId(fl, "clerk.oauth_github").result, "unknown", "GitHub through Clerk: unknown (GitHub checks after a sign-in)");
    assert.equal(byId(fl, "mcp").result, "pass", "AI clients may register with Clerk");
    const attempt = calls.find((c) => c.path === "/v1/client/sign_ins")!;
    assert.equal(attempt.headers.origin, FRONT, "the sign-in attempt is started from the front door");
    assert.match(String(attempt.headers.cookie), /^__client=standin-client$/, "with the client cookie Clerk set, and only it");
    assert.ok(calls.filter((c) => c.host === "api.clerk.com").every((c) => c.headers.authorization === `Bearer ${SK}`) && calls.filter((c) => c.host !== "api.clerk.com").every((c) => !JSON.stringify(c.headers).includes(SK)),
      "the Clerk secret goes to Clerk's Backend API only");
    noSecret(JSON.stringify(fl), "the flows");

    process.env.APP_CONSOLE_URL = NEW_FRONT;   // moved to a domain the instance does not hold
    fl = await SIC.checkSignIn();
    const d = byId(fl, "clerk.domain");
    assert.equal(d.result, "fail"); assert.match(d.detail, /not app\.newco\.test/);
    assert.equal(d.where, "Clerk dashboard → Configure → Domains");
    assert.ok(d.steps.some((s) => /Add satellite domain/.test(s) && s.includes("app.newco.test")), "the Domains steps name the new address");
    assert.equal(byId(fl, "clerk.oauth_google").result, "fail", "Clerk refuses a sign-in started on the new address: fail");
    assert.match(byId(fl, "clerk.oauth_google").detail, /Clerk refused a sign-in started on app\.newco\.test/);
    clerk.allowed = [NEW_FRONT];
    assert.equal(byId(await SIC.checkSignIn(), "clerk.domain").result, "pass", "an allowed origin counts");
    clerk.allowed = []; process.env.APP_CONSOLE_URL = FRONT;

    google.lists.get(CLERK_GOOGLE)!.clear();
    const cg2 = byId(await SIC.checkSignIn(), "clerk.oauth_google");
    assert.equal(cg2.result, "fail"); assert.match(cg2.detail, /redirect_uri_mismatch/);
    assert.match(cg2.where, /Google Cloud Console → APIs & Services → Credentials → the OAuth client → Authorized redirect URIs/);
    assert.ok(cg2.steps.includes(`    ${FAPI}/v1/oauth_callback`) && cg2.steps.some((s) => /Clerk dashboard → Configure → SSO connections → Google/.test(s)), "the exact address on its own line, and which client (the one Clerk shows)");
    google.lists.get(CLERK_GOOGLE)!.add(`${FAPI}/v1/oauth_callback`);

    clerk.social = false; clerk.backend = false; clerk.registration = false;
    fl = await SIC.checkSignIn();
    assert.deepEqual(fl.map((f) => [f.id, f.result]), [["clerk.domain", "unknown"], ["clerk.social", "unknown"], ["mcp", "fail"]], "Clerk not readable: unknown, never pass; registration off: AI clients fail");
    clerk.social = true; clerk.backend = true; clerk.registration = true;
    clerk.env = "development";
    assert.match(byId(await SIC.checkSignIn(), "clerk.oauth_google").detail, /shared development credentials/, "a development instance: Clerk's shared credentials, said");
    clerk.env = "production";
    console.log("✓ an app on Clerk: its domain, Google and GitHub through Clerk, AI clients; a new front door Clerk does not hold, an unlisted callback, an unreadable Clerk");
  }

  // ---------- 3. the built-in sign-in ----------
  {
    Object.assign(process.env, { AUTH_PROVIDER: "builtin", GOOGLE_CLIENT_ID: OWN_GOOGLE, GOOGLE_CLIENT_SECRET: `google-secret-${randomBytes(8).toString("hex")}` });
    SECRETS.push(process.env.GOOGLE_CLIENT_SECRET!);
    let fl = await SIC.checkSignIn();
    assert.deepEqual(fl.map((f) => [f.id, f.result]), [["google", "pass"], ["mcp", "pass"]], "the built-in Google on the front door, listed: pass; AI clients on the front door");
    assert.equal(byId(fl, "google").redirect_uri, `${FRONT}/api/auth/google/callback`);
    process.env.APP_CONSOLE_URL = NEW_FRONT;
    fl = await SIC.checkSignIn();
    assert.equal(byId(fl, "google").result, "fail", "after a move Google does not list the new callback: fail");
    assert.ok(byId(fl, "google").steps.includes(`    ${NEW_FRONT}/api/auth/google/callback`));
    process.env.APP_MCP_URL = FRONT;
    assert.equal(byId(await SIC.checkSignIn(), "mcp").result, "fail", "AI clients told to sign in at the old address: fail");
    delete process.env.APP_MCP_URL; process.env.APP_CONSOLE_URL = FRONT;
    noSecret(JSON.stringify(fl), "the built-in flows");
    console.log("✓ the built-in sign-in: Google's callback on the front door (pass, then fail after a move), AI clients' address");
  }

  // ---------- 4 and 5. the platform GitHub App and a credential OAuth provider ----------
  const fixture = definePack({
    id: "fixture_si",
    oauthProviders: [{ name: "acme", label: "Acme", authorize_url: "https://login.acme.test/authorize", token_url: "https://login.acme.test/token", scopes: ["read"],
      client_id: { vault: "acme.client_id" }, client_secret: { vault: "acme.client_secret" } }],
    credentials: [{ name: "repo_token", label: "Repository token", bound_to: "workspace", github_app: true, deliver_as: { file: "gh_token" } },
      { name: "acme_token", label: "Acme", bound_to: "workspace", oauth: "acme", deliver_as: { file: "acme_token" } }],
  });
  setPacksForTest([{ manifest: { id: "fixture_si", name: "Fixture sign-in", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  const kv = await import("../src/keyvault.js");
  for (const slug of ["github_app", "oauth_clients"]) if (!(await kv.getProvider(slug))) await kv.upsertProvider({ slug, name: slug, mode: "proxy", env_vars: [] } as never);
  await ghApp.setAppConfig({ app_id: "424242", slug: "platform-app", client_id: GH_CLIENT, client_secret: GH_SECRET, private_key: GH_KEY, webhook_secret: GH_HOOK_SECRET });
  await kv.setCredential("oauth_clients", ACME_CLIENT, { label: "acme.client_id" });
  await kv.setCredential("oauth_clients", `acme-secret-${randomBytes(8).toString("hex")}`, { label: "acme.client_secret" });
  const org = (await createOrg(`Sign-in ${STAMP}`)).org;
  {
    let fl = await SIC.checkSignIn();
    assert.deepEqual(fl.map((f) => f.id), ["google", "github_app.callback", "github_app.setup", "github_app.webhook", "oauth.fixture_si.acme", "mcp"]);
    const cb = byId(fl, "github_app.callback");
    assert.deepEqual([cb.result, cb.redirect_uri, cb.where], ["unknown", `${FRONT}/api/github-app/callback`, "GitHub → Settings → Developer settings → GitHub Apps → the app → Callback URL"], "the callback: unknown before anyone came back");
    assert.ok(cb.steps.includes(`    ${FRONT}/api/github-app/callback`) && cb.steps.some((s) => /Request user authorization \(OAuth\) during installation/.test(s)));
    assert.equal(byId(fl, "github_app.setup").result, "unknown");
    assert.equal(byId(fl, "github_app.webhook").result, "pass", "the webhook GitHub holds is the API's");
    github.hook = "https://old-api.example.net/api/github-app/webhook";
    assert.match(byId(await SIC.checkSignIn(), "github_app.webhook").detail, /old-api\.example\.net/, "another webhook address: fail, naming it");
    github.hook = `${API}/api/github-app/webhook`;

    // What came back: only for a state this server signed.
    const st = (await issueState(org.orgId, "user_1", "github_app")).state;
    await SIC.noteCallback("github_app", "github_app", { state: `${st.split(".")[0]}.forged`, installation_id: "1", code: "c" }, "https://old.example.org", true);
    assert.equal((await db.query("SELECT 1 FROM sign_in_checks WHERE key = 'callback:github_app'")).length, 0, "a forged state is not noted");
    await SIC.noteCallback("github_app", "github_app", { state: st, installation_id: "1", code: "c" }, "https://old.example.org", true);
    fl = await SIC.checkSignIn();
    assert.equal(byId(fl, "github_app.callback").result, "fail", "GitHub sent someone back to the old address: fail");
    assert.match(byId(fl, "github_app.callback").detail, /old\.example\.org .*still holds the old address/);
    assert.equal(byId(fl, "github_app.setup").result, "pass", "with the person's authorization: the install's return is right");
    await db.query("DELETE FROM sign_in_checks");
    await SIC.noteCallback("github_app", "github_app", { state: st, installation_id: "1" }, FRONT, false);
    fl = await SIC.checkSignIn();
    assert.deepEqual([byId(fl, "github_app.callback").result, byId(fl, "github_app.setup").result], ["pass", "fail"], "back at the front door: pass; without the authorization the app needs: fail");
    await db.query("DELETE FROM sign_in_checks");
    await SIC.noteCallback("github_app", "github_app", { state: st, error: "redirect_uri_mismatch" }, FRONT);
    assert.equal(byId(await SIC.checkSignIn(), "github_app.callback").result, "fail", "GitHub's redirect_uri_mismatch, with a state this server signed: fail");
    assert.equal(byId(await SIC.checkSignIn(FRONT, new Date(Date.now() + 1000).toISOString()), "github_app.callback").result, "unknown", "what came back before the front door changed says nothing");
    await db.query("DELETE FROM sign_in_checks");

    const ac = byId(fl, "oauth.fixture_si.acme");
    assert.deepEqual([ac.result, ac.redirect_uri], ["fail", `${FRONT}/api/credential-connections/callback`], "Acme refuses the address: fail");
    acme.registered.add(`${FRONT}/api/credential-connections/callback`);
    assert.equal(byId(await SIC.checkSignIn(), "oauth.fixture_si.acme").result, "unknown", "Acme goes on to its sign-in: unknown");
    // Through the route: someone came back from Acme at the front door (no session there: refused all the same, noted first).
    const { createApp } = await import("../src/http.js");
    const server = createApp().listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const os = (await issueState(org.orgId, "user_1", "oauth", { pack: "fixture_si", name: "acme_token", asset: null, environment: null, provider: "acme", verifier: null })).state;
      const r = await fetch(`${base}/api/credential-connections/callback?state=${encodeURIComponent(os)}&code=abc`, { redirect: "manual", headers: { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" } });
      assert.ok([303, 401].includes(r.status), `the callback answered as before (${r.status})`);
      assert.equal(byId(await SIC.checkSignIn(), "oauth.fixture_si.acme").result, "pass", "someone came back at the front door: pass");
      const g2 = (await issueState(org.orgId, "user_1", "github_app")).state;
      await fetch(`${base}/api/github-app/callback?state=${encodeURIComponent(g2)}&installation_id=7&code=abc`, { redirect: "manual", headers: { "x-forwarded-host": "old.example.org", "x-forwarded-proto": "https" } });
      assert.equal(byId(await SIC.checkSignIn(), "github_app.callback").result, "fail", "the GitHub callback route notes where GitHub sent the browser");
      const noted = JSON.stringify(await db.query("SELECT key, value FROM sign_in_checks"));
      assert.ok(!noted.includes("abc") && !noted.includes(g2) && !noted.includes(os), "a note holds no code and no state");
      console.log("✓ the GitHub App (callback by what came back, the install's authorization, the webhook) and a credential provider (fail, unknown, then pass through its route)");

      // ---------- 6. the report ----------
      await db.query("DELETE FROM sign_in_checks");
      const t0 = Date.now();
      const r1 = await SIC.signInReport({ now: t0 });
      assert.deepEqual(r1.totals, { pass: r1.flows.filter((f) => f.result === "pass").length, fail: r1.flows.filter((f) => f.result === "fail").length, unknown: r1.flows.filter((f) => f.result === "unknown").length });
      assert.equal(r1.front_door, FRONT);
      const r2 = await SIC.signInReport({ now: t0 + 30 * 60_000 });
      assert.equal(r2.checked_at, r1.checked_at, "under an hour old: the stored one");
      const r3 = await SIC.signInReport({ now: t0 + 30_000, refresh: true });
      assert.ok(r3.throttled && r3.checked_at === r1.checked_at, "check again within a minute: the last one, said");
      const r4 = await SIC.signInReport({ now: t0 + 2 * 60_000, refresh: true });
      assert.ok(!r4.throttled && r4.checked_at !== r1.checked_at && r4.front_door_since === r1.front_door_since, "check again after a minute: checked again, same front door");
      const r5 = await SIC.signInReport({ now: t0 + 125 * 60_000 });
      assert.notEqual(r5.checked_at, r4.checked_at, "over an hour old: checked again");
      process.env.APP_CONSOLE_URL = NEW_FRONT;
      const r6 = await SIC.signInReport({ now: t0 + 126 * 60_000 });
      assert.ok(r6.front_door === NEW_FRONT && r6.front_door_since === r6.checked_at && r6.checked_at !== r5.checked_at, "a new front door: checked at once, and what came back before it no longer counts");
      process.env.APP_CONSOLE_URL = FRONT;
      const staff = JSON.stringify(r5), factory = JSON.stringify(await SIC.signInReport({ now: t0 + 126 * 60_000, factory: true }));
      noSecret(staff, "the staff answer"); noSecret(factory, "the factory's answer");
      assert.deepEqual(CLIENT_IDS.filter((c) => staff.includes(c)), [], "the staff answer carries no client id (a fingerprint)");
      assert.ok(factory.includes(OWN_GOOGLE) && factory.includes(GH_CLIENT), "the factory's answer carries the public client ids it probes with");

      // ---------- 7. the routes ----------
      assert.equal((await fetch(`${base}/api/cron/sign-in-check`)).status, 401, "the factory's route: nothing without the cron secret");
      assert.equal((await fetch(`${base}/api/cron/sign-in-check`, { headers: { authorization: "Bearer wrong" } })).status, 401);
      const fr = await fetch(`${base}/api/cron/sign-in-check`, { headers: { authorization: `Bearer ${CRON}` } });
      const fj = await fr.json() as { flows: { id: string; client_id?: string }[] };
      assert.ok(fr.status === 200 && fj.flows.some((f) => f.id === "github_app.callback" && f.client_id === GH_CLIENT), "with it: the report and the public client ids");
      const { createAdminToken } = await import("../src/admin-tokens.js");
      const tok = (await createAdminToken({ label: `si-${STAMP}`, role: "viewer", days: 1, createdBy: "sign-in-test" })).token;
      assert.equal((await fetch(`${base}/api/admin/onboarding/health/sign-in`)).status, 401, "the staff route: staff only");
      const sr = await fetch(`${base}/api/admin/onboarding/health/sign-in`, { headers: { authorization: `Bearer ${tok}` } });
      const st2 = await sr.text();
      assert.equal(sr.status, 200, st2.slice(0, 200));
      assert.ok(JSON.parse(st2).flows.length >= 5 && !CLIENT_IDS.some((c) => st2.includes(c)), "a viewer reads it, with no client id");
      noSecret(st2, "the staff route");
      console.log("✓ the report (an hour, a minute, a new front door; no client id or secret for staff) and its two routes");

      // ---------- 8. the tab, in a browser ----------
      const chrome = findChrome();
      if (!chrome) console.log("✓ (no headless browser on this machine: the rendered tab is skipped; set CHROME_BIN)");
      else {
        acme.registered.clear();
        await db.query("DELETE FROM sign_in_checks");
        const shown = await SIC.signInReport();
        const kinds = new Set(shown.flows.map((f) => f.result));
        assert.ok(kinds.has("pass") && kinds.has("fail") && kinds.has("unknown"), `the drawn report has a pass, a fail and an unknown: ${[...kinds]}`);
        const dom = await drawTab(chrome, path.join(ROOT, "web"), shown);
        for (const r of ["pass", "fail", "unknown"]) assert.match(dom, new RegExp(`data-result="${r}"`), `a ${r} card is drawn`);
        assert.match(dom, />Fail</); assert.match(dom, />Unknown</); assert.match(dom, />Pass</);
        assert.match(dom, /Check again/);
        assert.ok(dom.includes(`${FRONT}/api/credential-connections/callback`), "the exact address is on the card");
        console.log(`✓ the tab drawn in a headless browser: a pass, a fail and an unknown card${process.env.SIGN_IN_SNAPSHOT_DIR ? `; screenshots in ${process.env.SIGN_IN_SNAPSHOT_DIR}` : ""}`);
      }
    } finally { server.close(); }
  }
} finally {
  for (const s of [G, H, CB, CF, A]) s.close();
  cleanup();
}
process.exit(0);

/** A headless Chrome on this machine: CHROME_BIN, else one a Playwright install left in its cache. */
function findChrome(): string | null {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
    for (const sub of existsSync(path.join(cache, d)) ? readdirSync(path.join(cache, d)) : []) {
      const bin = path.join(cache, d, sub, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  return null;
}

/**
 * The console's Sign-in tab (SignInTab, bundled with esbuild, its API answered in the page by `report`) under Health's
 * tab strip (no title above it, mold_v0-272), with the console's own compiled CSS (Tailwind over web/src); the DOM back, and with SIGN_IN_SNAPSHOT_DIR the
 * light theme at 1440 px and the dark one at 390 px.
 */
async function drawTab(chrome: string, web: string, report: unknown): Promise<string> {
  const { build } = await import("esbuild");
  const dir = path.join(TMP, "render-sign-in");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(web, "render-sign-in.tsx"), `import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignInTab } from '@/features/admin/sign-in-check';
const qc = new QueryClient();
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}><div className='flex flex-col gap-3 p-4 md:p-6'>
  <div role='tablist' className='text-muted-foreground flex gap-4 border-b text-sm'><span>Errors</span><span>Status</span><span className='text-foreground border-foreground border-b-2 pb-2 font-medium'>Sign-in</span></div>
  <SignInTab /></div></QueryClientProvider>);
setTimeout(() => { document.body.setAttribute('data-ready', '1'); }, 2500);
`);
  writeFileSync(path.join(web, "render-link.tsx"), "export default function Link({ href, children, ...rest }: { href: string; children?: unknown }) { return <a href={href} {...(rest as object)}>{children as never}</a>; }\n");
  writeFileSync(path.join(web, "render-auth.ts"), "export * from './src/lib/auth/builtin-client';\nexport const CLERK = false;\nexport const AUTH_PROVIDER = 'builtin';\n");
  try {
    await build({ entryPoints: [path.join(web, "render-sign-in.tsx")], bundle: true, format: "iife", platform: "browser", outfile: path.join(dir, "bundle.js"), absWorkingDir: web,
      tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_AUTH_PROVIDER": '"builtin"' },
      alias: { "next/link": path.join(web, "render-link.tsx") }, logLevel: "error",
      plugins: [{ name: "auth", setup(b) { b.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({ path: path.join(web, "render-auth.ts") })); } }] });
  } finally { for (const f of ["render-sign-in.tsx", "render-link.tsx", "render-auth.ts"]) rmSync(path.join(web, f), { force: true }); }
  const req = createRequire(path.join(web, "package.json"));
  const postcss = req("postcss"), tw = req("@tailwindcss/postcss");
  const from = path.join(web, "src", "styles", "globals.css");
  const css = (await postcss([tw({ base: web })]).process(readFileSync(from, "utf8"), { from })).css as string;
  const html = (dark: boolean) => {
    const f = path.join(dir, dark ? "dark.html" : "light.html");
    writeFileSync(f, `<!doctype html><html data-theme="supabase" class="${dark ? "dark" : ""}" style="color-scheme: ${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body><div id="root"></div><script>const REPORT = ${JSON.stringify(report).replace(/</g, "\\u003c")};
window.fetch = async (url) => { const p = new URL(String(url), 'http://console.test').pathname;
  return p === '/api/admin/onboarding/health/sign-in' ? new Response(JSON.stringify(REPORT), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 }); };</script><script src="bundle.js"></script></body></html>`);
    return f;
  };
  const args = (w: number, h: number) => ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=10000", `--window-size=${w},${h}`];
  const r = spawnSync(chrome, [...args(1440, 1600), "--dump-dom", `file://${html(false)}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `the browser ran: ${r.stderr.slice(0, 1000)}`);
  assert.match(r.stdout, /data-ready="1"/, `the tab rendered (${r.stdout.slice(0, 300)})`);
  assert.match(r.stdout, /data-sign-in/, `the report is on the page (${r.stdout.slice(0, 600)})`);
  const out = process.env.SIGN_IN_SNAPSHOT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    spawnSync(chrome, [...args(1440, 1700), `--screenshot=${path.join(out, "sign-in-light-1440.png")}`, `file://${html(false)}`], { timeout: 120_000 });
    spawnSync(chrome, [...args(390, 4200), `--screenshot=${path.join(out, "sign-in-dark-390.png")}`, `file://${html(true)}`], { timeout: 120_000 });
    writeFileSync(path.join(out, "sign-in-dom.html"), r.stdout);
  }
  return r.stdout;
}
