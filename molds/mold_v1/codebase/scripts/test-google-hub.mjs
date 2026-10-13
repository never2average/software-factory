/**
 * THE GOOGLE SIGN-IN HUB, END TO END AGAINST A GOOGLE MADE HERE, AND EVERYTHING THAT MUST REFUSE.
 *
 * Google hands a sign-in only to an address written by hand on the OAuth client's page, so a deployment at a new
 * address showed a "Continue with Google" button that could not work. lib/google-hub.ts lets an address Google
 * knows (the hub) do the Google part for one it does not (the app), and lib/google-sign-in-mode.ts decides, before
 * a button is drawn, whether Google sign-in works at an address directly, through a hub, or not at all.
 *
 * This drives the REAL route handlers of both sides in one process (the app's start and callback, the hub's page and
 * status, the availability answer), with Google replaced by a key pair made here: the tokens are signed exactly as
 * Google's are (RS256, its issuer, the client as audience, the nonce inside), so every check the server makes on a
 * real token runs. Nothing leaves the machine, but for two cases at the end that prove a production server ignores
 * the test's keys: there the server asks Google's own published keys (or fails to reach them) and refuses either way.
 *
 * The security properties, each with its own section and each failing if the code that provides it is removed:
 *   1. the hub answers only its allow-list: exact https origins, no wildcard, no open redirect, the path fixed here;
 *   2. the nonce binds the token to one sign-in: a token for another app, session or flow is refused;
 *   3. the state binds the answer to the browser that started it: no cross-site finish, no login fixation;
 *   4. the token is never in an address and never in a log line;
 *   5. the hub page cannot be framed;
 *   6. the hub page says which address the person is signing in to, in the hub operator's words, not the caller's.
 * And the button: drawn only where it leads somewhere (direct, hub or none), never hidden on a guess.
 *
 *   npm run test:google-hub
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

/* A child of this test (see "the test key set" below): verify one token as the process's own settings say, and say so. */
if (process.env.HUB_TEST_CHILD) {
  const { verifyHubSignIn } = await import("../lib/ops-auth.ts");
  const [token, nonce] = JSON.parse(process.env.HUB_TEST_CHILD);
  process.stdout.write(JSON.stringify(await verifyHubSignIn(token, nonce)));
  process.exit(0);
}

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const section = (title) => console.log(`\n${title}`);

/* ---- two deployments, one process: what differs between them is their settings -------------------------------- */
const APP = "https://app.test";
const HUB = "https://hub.test";
const OTHER_APP = "https://other.test";
const CLIENT = "hub-test-client.apps.googleusercontent.com";
const BASE_ENV = { NEXT_PUBLIC_GOOGLE_CLIENT_ID: CLIENT, AUTH_GOOGLE_ADDRESS_CHECK: "off" };
const HUB_ENV = { AUTH_GOOGLE_HUB_ALLOWED_RETURNS: `${APP}=First App, ${OTHER_APP}` };
const APP_ENV = { AUTH_GOOGLE_HUB_ORIGIN: HUB };
const SETTINGS = ["NEXT_PUBLIC_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_ADDRESS_CHECK", "AUTH_GOOGLE_HUB_ALLOWED_RETURNS", "AUTH_GOOGLE_HUB_ORIGIN"];
async function withEnv(env, fn) {
  const before = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k]]));
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  try {
    return await fn();
  } finally {
    for (const k of SETTINGS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}
const asApp = (fn, extra = {}) => withEnv({ ...APP_ENV, ...extra }, fn);
const asHub = (fn, extra = {}) => withEnv({ ...HUB_ENV, ...extra }, fn);

/* ---- every line any of this writes to a log is kept, to prove no token is ever in one ------------------------- */
const logged = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(" "));
    real(...args);
  };
}
const issued = [];

const { NextRequest } = await import("next/server");
const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import("jose");
const hubRules = await import("../lib/google-hub.ts");
const { hubPage } = await import("../lib/google-hub-page.ts");
const probe = await import("../lib/google-origin-probe.ts");
const mode = await import("../lib/google-sign-in-mode.ts");
const { __setGoogleKeysForTest } = await import("../lib/ops-auth.ts");
const startRoute = await import("../app/api/auth/google-hub/start/route.ts");
const callbackRoute = await import("../app/api/auth/google-hub/callback/route.ts");
const statusRoute = await import("../app/api/auth/google-hub/status/route.ts");
const pageRoute = await import("../app/auth/google-hub/route.ts");
const availabilityRoute = await import("../app/api/auth/google/availability/route.ts");

/* ---- Google, replaced by keys made here ----------------------------------------------------------------------- */
const google = await generateKeyPair("RS256");
__setGoogleKeysForTest(createLocalJWKSet({ keys: [{ ...(await exportJWK(google.publicKey)), kid: "hub-test", alg: "RS256", use: "sig" }] }));
const stranger = await generateKeyPair("RS256");
async function googleToken({ nonce, aud = CLIENT, key = google.privateKey, iss = "https://accounts.google.com", exp = "1h", email = "person@work.test" } = {}) {
  let jwt = new SignJWT({ email, email_verified: true, hd: "work.test", ...(nonce === undefined ? {} : { nonce }) })
    .setProtectedHeader({ alg: "RS256", kid: "hub-test" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(`google-${email}`)
    .setIssuedAt();
  if (exp !== null) jwt = jwt.setExpirationTime(exp);
  const token = await jwt.sign(key);
  issued.push(token);
  return token;
}

/* ---- a browser, as far as these routes can tell: an address, cookies, and an Origin on a cross-site POST -------- */
class Browser {
  cookies = new Map();
  keep(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      if (!value || (maxAge && Number(maxAge.split("=")[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  /** Start a sign-in on the app: the redirect to the hub, and the cookie kept. */
  async start(back = "/") {
    const res = await asApp(() => startRoute.GET(new NextRequest(`${APP}/api/auth/google-hub/start?back=${encodeURIComponent(back)}`, { headers: { cookie: this.header() } })));
    this.keep(res);
    const to = new URL(res.headers.get("location"));
    return { res, to, state: to.searchParams.get("state"), nonce: to.searchParams.get("nonce"), setCookie: res.headers.getSetCookie() };
  }
  /** The hub's form POST arriving at the app. */
  async finish({ credential, state, from = HUB, cookies = true, env = {} }) {
    const body = new URLSearchParams({ ...(credential === undefined ? {} : { credential }), ...(state === undefined ? {} : { state }) }).toString();
    const res = await asApp(
      () =>
        callbackRoute.POST(
          new NextRequest(`${APP}/api/auth/google-hub/callback`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              ...(from ? { origin: from } : {}),
              ...(cookies && this.cookies.size ? { cookie: this.header() } : {}),
            },
            body,
          }),
        ),
      env,
    );
    this.keep(res);
    return { res, status: res.status, location: res.headers.get("location"), body: res.status === 200 ? await res.text() : "" };
  }
}
const hubPageFor = (url, env = {}) => asHub(() => pageRoute.GET(new NextRequest(String(url))), env);
const refusalOf = (location) => (location ? new URL(location).searchParams.get("sign_in_error") : null);
const signedIn = (r) => r.status === 200 && r.body.includes("sessionStorage.setItem");

/* ================================================================================================================ */
section("The flow, end to end: app → hub → (a Google made here) → app");
let happyToken;
{
  const browser = new Browser();
  const back = "/?chatSession=wrun_1&org=o1";
  const s = await browser.start(back);
  check("the app sends the browser to its hub's page, and nowhere else", s.res.status === 303 && s.to.origin === HUB && s.to.pathname === "/auth/google-hub");
  check("it names its own origin as the return, with a fresh state and nonce", s.to.searchParams.get("return") === APP && hubRules.validHubValue(s.state) && hubRules.validHubValue(s.nonce) && s.state !== s.nonce);
  check("the path to come back to stays in the cookie, not in the address sent to the hub", !s.to.search.includes("chatSession") && [...s.to.searchParams.keys()].sort().join() === "nonce,return,state");
  const cookie = s.setCookie.join("\n");
  check("the sign-in is kept in a cookie no script can read, sent with the hub's cross-site POST, for ten minutes", /^__Host-google-hub=v1\./.test(cookie) && /; HttpOnly/.test(cookie) && /; Secure/.test(cookie) && /; SameSite=None/.test(cookie) && /; Path=\//.test(cookie) && /; Max-Age=600/.test(cookie) && !/Domain=/i.test(cookie));

  const page = await hubPageFor(s.to);
  const html = await page.text();
  check("the hub shows its page for an origin on its allow-list", page.status === 200 && page.headers.get("content-type").startsWith("text/html"));
  check("the page binds Google's button to the app's nonce", html.includes(`"nonce":"${s.nonce}"`) && /initialize\(\{client_id:c\.clientId,nonce:c\.nonce/.test(html));
  const action = /<form id="f" method="post" action="([^"]+)"/.exec(html)?.[1];
  check("the token goes back by form POST to the app's fixed callback", action === `${APP}/api/auth/google-hub/callback`, action);
  check("the form carries the app's state back unchanged", html.includes(`name="state" value="${s.state}"`));

  happyToken = await googleToken({ nonce: s.nonce });
  const done = await browser.finish({ credential: happyToken, state: s.state });
  check("the app accepts Google's token: signature, audience, issuer, expiry, nonce and state all hold", signedIn(done), { status: done.status, location: done.location });
  check("the browser is handed the token in the page's body, for the sign-in gate to adopt", done.body.includes(JSON.stringify(happyToken)) && done.body.includes('"key":"workspace-google-hub-handoff"'));
  check("…and goes back to the address the sign-in was started from", done.body.includes(JSON.stringify(back).replace(/</g, "\\u003c")));
  check("the answer page runs one script by nonce, is never cached and cannot be framed", /script-src 'nonce-[a-f0-9]{32}'/.test(done.res.headers.get("content-security-policy")) && !done.res.headers.get("content-security-policy").includes("unsafe-inline") && done.res.headers.get("cache-control") === "no-store" && done.res.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  check("the cookie is spent: cleared with the answer", browser.cookies.size === 0);
  const again = await browser.finish({ credential: happyToken, state: s.state });
  check("the same answer posted a second time is refused (one start, one answer)", again.status === 303 && refusalOf(again.location) === "expired", again.location);
}

/* ================================================================================================================ */
section("1. The hub answers only its allow-list: exact https origins, no wildcard, no open redirect, a fixed path");
{
  const prod = { NODE_ENV: "production" };
  const ok = ["https://a.example", "https://a.example:8443", "https://xn--bcher-kva.example"];
  const no = ["http://a.example", "https://a.example/", "https://a.example/path", "https://a.example?x=1", "https://a.example#f", "https://*.example", "https://*", "*",
    "https://A.example", "HTTPS://a.example", "https://user@a.example", "https://user:pw@a.example", "//a.example", "a.example", "javascript:alert(1)", "data:text/html,x",
    "https://a.example:443", " ", "", null, undefined, "https://a.example https://b.example", "ftp://a.example", "http://localhost:3000", "http://127.0.0.1:3000"];
  check("an exact https origin is accepted", ok.every((o) => hubRules.exactOrigin(o, prod) === o), ok.filter((o) => hubRules.exactOrigin(o, prod) !== o));
  check("anything else is refused, not repaired: http, a path, a slash, a wildcard, credentials, other spellings", no.every((o) => hubRules.exactOrigin(o, prod) === null), no.filter((o) => hubRules.exactOrigin(o, prod) !== null));
  check("http is accepted for a loopback address only, and only outside a production build", hubRules.exactOrigin("http://localhost:3000", {}) === "http://localhost:3000" && hubRules.exactOrigin("http://127.0.0.1:3000", {}) !== null && hubRules.exactOrigin("http://a.example", {}) === null);

  const parsed = hubRules.allowedReturns({ NODE_ENV: "production", AUTH_GOOGLE_HUB_ALLOWED_RETURNS: "https://a.example=Team A,\n https://b.example , https://*.example, http://c.example, https://d.example/x, https://a.example, https://e.example=<b>x</b>" });
  check("the allow-list keeps exact origins and their names", JSON.stringify(parsed.list.map((e) => [e.origin, e.label])) === JSON.stringify([["https://a.example", "Team A"], ["https://b.example", null], ["https://e.example", null]]), parsed.list);
  check("a wildcard, an http origin and an origin with a path are dropped and reported", parsed.invalid.length === 3 && parsed.invalid.some((x) => x.includes("*")), parsed.invalid);
  check("an unset allow-list means this deployment is not a hub", hubRules.hubEnabled({}) === false && hubRules.hubEnabled({ AUTH_GOOGLE_HUB_ALLOWED_RETURNS: "https://*.example" }) === false);

  const env = { NODE_ENV: "production", AUTH_GOOGLE_HUB_ALLOWED_RETURNS: `${APP}, ${OTHER_APP}` };
  const lookalikes = [`${APP}/`, `${APP}/x`, "https://APP.test", `${APP}@evil.test`, `${APP}.evil.test`, `https://evil.test/?${APP}`, `https://evil.test#${APP}`, ` ${APP}`, `${APP} `,
    "https://evil.test", "http://app.test", `${APP}:443`, `${APP}\\@evil.test`, `${APP}%2f@evil.test`, "//app.test", "app.test", "", null, undefined, `${APP},${OTHER_APP}`];
  check("the return is matched as text against the list: nothing that merely looks like or resolves to an allowed origin passes", hubRules.allowedReturn(APP, env)?.origin === APP && lookalikes.every((v) => hubRules.allowedReturn(v, env) === null), lookalikes.filter((v) => hubRules.allowedReturn(v, env) !== null));
  check("where the token is posted is built here from the list entry", hubRules.callbackUrlFor(hubRules.allowedReturn(APP, env)) === `${APP}/api/auth/google-hub/callback`);

  const browser = new Browser();
  const s = await browser.start();
  const url = (changes) => {
    const u = new URL(s.to);
    for (const [k, v] of Object.entries(changes)) (v === null ? u.searchParams.delete(k) : u.searchParams.set(k, v));
    return u;
  };
  let allRefused = true;
  const leaks = [];
  for (const target of ["https://evil.test", `${APP}@evil.test`, `${APP}.evil.test`, `${APP}/`, "https://evil.test/api/auth/google-hub/callback", "http://app.test", "//evil.test", "javascript:alert(1)"]) {
    const res = await hubPageFor(url({ return: target }));
    const html = await res.text();
    if (res.status !== 400 || res.headers.get("location") || /<form|<a |<script|evil\.test|http-equiv/i.test(html)) {
      allRefused = false;
      leaks.push([target, res.status]);
    }
  }
  check("NO OPEN REDIRECT: an origin not on the list gets a page with no redirect, no link, no form, and none of its text", allRefused, leaks);
  const noReturn = await hubPageFor(url({ return: null }));
  check("a request naming no return is refused the same way", noReturn.status === 400 && !noReturn.headers.get("location"));
  const extra = await (await hubPageFor(url({ callback: "https://evil.test/take", path: "/evil", redirect_uri: "https://evil.test", return_path: "/x" }))).text();
  check("the caller cannot choose the path or add a destination: the form posts to the fixed callback, whatever else is sent", /action="https:\/\/app\.test\/api\/auth\/google-hub\/callback"/.test(extra) && !extra.includes("evil.test"));
  const off = await withEnv({}, () => pageRoute.GET(new NextRequest(String(s.to))));
  check("with no allow-list set there is no hub page at all (404)", off.status === 404 && !(await off.text()).includes("<form"));
  const badShape = await hubPageFor(url({ nonce: 'x"><script>alert(1)</script>' }));
  const badHtml = await badShape.text();
  check("a state or nonce that is not the shape the app makes is refused, and never echoed", badShape.status === 400 && !badHtml.includes("alert(1)"));
  const shortState = await hubPageFor(url({ state: "abc" }));
  check("…the same for a short state", shortState.status === 400);

  const status = async (ret, env2 = {}) => (await asHub(() => statusRoute.GET(new NextRequest(`${HUB}/api/auth/google-hub/status?return=${encodeURIComponent(ret)}`)), env2)).json();
  const yes = await status(APP);
  const nope = await status("https://evil.test");
  check("the hub's status says yes for a listed origin and no for any other, and names no one else on the list", yes.hub === true && yes.allowed === true && nope.allowed === false && !JSON.stringify(nope).includes("other.test") && !JSON.stringify(yes).includes("other.test"));
  check("the status carries a fingerprint of the client, never the client id", typeof yes.client === "string" && /^[0-9a-f]{12}$/.test(yes.client) && !JSON.stringify(yes).includes(CLIENT));
  const offStatus = await (await withEnv({}, () => statusRoute.GET(new NextRequest(`${HUB}/api/auth/google-hub/status?return=${encodeURIComponent(APP)}`)))).json();
  check("a deployment that is not a hub says so", offStatus.hub === false && offStatus.allowed === false);
}

/* ================================================================================================================ */
section("2. The nonce binds the token to one sign-in");
{
  const attempt = async (make) => {
    const browser = new Browser();
    const s = await browser.start();
    return browser.finish({ credential: await make(s), state: s.state });
  };
  const other = new Browser();
  const otherStart = await other.start();
  const forOtherSession = await attempt(() => googleToken({ nonce: otherStart.nonce }));
  check("a token Google minted for ANOTHER session's nonce is refused", refusalOf(forOtherSession.location) === "nonce", forOtherSession);
  const replayed = await attempt(() => happyToken);
  check("the token of an earlier, finished sign-in is refused when replayed into a new one", refusalOf(replayed.location) === "nonce");
  const noNonce = await attempt(() => googleToken({}));
  check("a token with no nonce at all (one minted by the direct flow, or for another app) is refused", refusalOf(noNonce.location) === "nonce");
  const prefix = await attempt((s) => googleToken({ nonce: s.nonce.slice(0, -1) }));
  check("a nonce that is merely close is refused", refusalOf(prefix.location) === "nonce");
  const otherClient = await attempt((s) => googleToken({ nonce: s.nonce, aud: "another-app.apps.googleusercontent.com" }));
  check("a token for another app's client is refused even with the right nonce (audience)", refusalOf(otherClient.location) === "token");
  const cli = await withEnv({}, async () => {
    process.env.WORKSPACE_OAUTH_CLIENT_ID = "cli-client.apps.googleusercontent.com";
    try {
      return await attempt((s) => googleToken({ nonce: s.nonce, aud: "cli-client.apps.googleusercontent.com" }));
    } finally {
      delete process.env.WORKSPACE_OAUTH_CLIENT_ID;
    }
  });
  check("…and so is one for this deployment's own command-line client: this door admits the web client only", refusalOf(cli.location) === "token");
  const forged = await attempt((s) => googleToken({ nonce: s.nonce, key: stranger.privateKey }));
  check("a token Google did not sign is refused", refusalOf(forged.location) === "token");
  const wrongIssuer = await attempt((s) => googleToken({ nonce: s.nonce, iss: "https://accounts.example.com" }));
  check("a token from another issuer is refused", refusalOf(wrongIssuer.location) === "token");
  const expired = await attempt((s) => googleToken({ nonce: s.nonce, exp: Math.floor(Date.now() / 1000) - 3600 }));
  check("an expired token is refused", refusalOf(expired.location) === "token");
  const noExpiry = await attempt((s) => googleToken({ nonce: s.nonce, exp: null }));
  check("a token with no expiry is refused", refusalOf(noExpiry.location) === "token");
  const garbage = await attempt(() => "not.a.token");
  check("something that is not a token is refused", refusalOf(garbage.location) === "token");
  const unsigned = await attempt((s) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT, nonce: s.nonce, exp: Math.floor(Date.now() / 1000) + 600, email: "x@work.test" })}.`;
  });
  check("an unsigned token (alg none) is refused", refusalOf(unsigned.location) === "token");
}

/* ================================================================================================================ */
section("3. The state binds the answer to the browser that started it");
{
  // Login fixation: the attacker completes Google as THEMSELVES in their own browser, then gets the victim's browser
  // to post that answer, so the victim would work signed in to the attacker's account.
  const attacker = new Browser();
  const a = await attacker.start();
  const attackerToken = await googleToken({ nonce: a.nonce, email: "attacker@work.test" });

  const victim = new Browser();
  const v = await victim.start();
  const fixation = await victim.finish({ credential: attackerToken, state: a.state });
  check("LOGIN FIXATION: the attacker's finished sign-in, posted in the victim's browser, is refused (state)", refusalOf(fixation.location) === "state", fixation.location);
  check("…and it spends the victim's started sign-in rather than leaving it open", victim.cookies.size === 0);

  const fresh = new Browser();
  const noCookie = await fresh.finish({ credential: attackerToken, state: a.state });
  check("the same POST in a browser that started nothing is refused (no cookie)", refusalOf(noCookie.location) === "expired");

  const victim2 = new Browser();
  const v2 = await victim2.start();
  const mixed = await victim2.finish({ credential: attackerToken, state: v2.state });
  check("the attacker's token with the victim's own state is refused too (the nonce is the victim's)", refusalOf(mixed.location) === "nonce");

  const b = new Browser();
  const s = await b.start();
  const good = await googleToken({ nonce: s.nonce });
  const crossSite = await b.finish({ credential: good, state: s.state, from: "https://evil.test" });
  check("CROSS-SITE POST: a correct answer posted from a site that is not the hub is refused", refusalOf(crossSite.location) === "origin");
  const bn = new Browser();
  const sn = await bn.start();
  const opaque = await bn.finish({ credential: await googleToken({ nonce: sn.nonce }), state: sn.state, from: "null" });
  check("…and from a page that hides where it is (Origin: null, a sandboxed frame)", refusalOf(opaque.location) === "origin");
  const b2 = new Browser();
  const s2 = await b2.start();
  const fromApp = await b2.finish({ credential: await googleToken({ nonce: s2.nonce }), state: s2.state, from: APP });
  check("…including from the app's own pages: only the hub posts here", refusalOf(fromApp.location) === "origin");

  const b3 = new Browser();
  const s3 = await b3.start();
  const noState = await b3.finish({ credential: await googleToken({ nonce: s3.nonce }) });
  check("an answer with no state is refused", refusalOf(noState.location) === "incomplete");
  const b4 = new Browser();
  const s4 = await b4.start();
  const noCredential = await b4.finish({ state: s4.state });
  check("an answer with no token is refused", refusalOf(noCredential.location) === "incomplete");

  const b5 = new Browser();
  const first = await b5.start();
  const second = await b5.start();
  const stale = await b5.finish({ credential: await googleToken({ nonce: first.nonce }), state: first.state });
  check("a second start replaces the first: the earlier one's answer is refused", first.state !== second.state && refusalOf(stale.location) === "state");

  const b6 = new Browser();
  const s6 = await b6.start();
  b6.cookies.set("__Host-google-hub", "v1.short.short.Lw");
  const tampered = await b6.finish({ credential: await googleToken({ nonce: s6.nonce }), state: s6.state });
  check("a cookie that is not one this code wrote is no cookie", refusalOf(tampered.location) === "expired");

  const b7 = new Browser();
  const s7 = await b7.start();
  const noHub = await b7.finish({ credential: await googleToken({ nonce: s7.nonce }), state: s7.state, env: { AUTH_GOOGLE_HUB_ORIGIN: "" } });
  check("a deployment that names no hub accepts no hub answer at all", refusalOf(noHub.location) === "off");
  const startOff = await withEnv({}, () => startRoute.GET(new NextRequest(`${APP}/api/auth/google-hub/start`)));
  check("…and starts none", startOff.status === 303 && new URL(startOff.headers.get("location")).origin === APP && startOff.headers.getSetCookie().length === 0);
  const selfHub = await withEnv({ AUTH_GOOGLE_HUB_ORIGIN: APP }, () => startRoute.GET(new NextRequest(`${APP}/api/auth/google-hub/start`)));
  check("a deployment is never its own hub", new URL(selfHub.headers.get("location")).origin === APP);

  const backs = { "/": "/", "/?chatSession=a&org=b": "/?chatSession=a&org=b", "https://evil.test": "/", "//evil.test": "/", "/\\evil.test": "/", "javascript:alert(1)": "/", "": "/", "/a\nb": "/" };
  check("the path to come back to is a path on this site, or the home page", Object.entries(backs).every(([i, o]) => hubRules.safeBackPath(i) === o), Object.entries(backs).filter(([i, o]) => hubRules.safeBackPath(i) !== o));
  const b8 = new Browser();
  const s8 = await b8.start("https://evil.test/after");
  const safe = await b8.finish({ credential: await googleToken({ nonce: s8.nonce }), state: s8.state });
  check("…so a sign-in started with an outside address still lands on this site", signedIn(safe) && safe.body.includes('"back":"/"') && !safe.body.includes("evil.test"));
}

/* ================================================================================================================ */
section("4. The token is never in an address and never in a log line");
{
  const browser = new Browser();
  const s = await browser.start();
  const token = await googleToken({ nonce: s.nonce });
  const done = await browser.finish({ credential: token, state: s.state });
  const headers = [...done.res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  check("an accepted token is in the answer's body only: no header, no redirect, no cookie carries it", signedIn(done) && !headers.includes(token) && !headers.includes(token.split(".")[1]) && !done.location);
  const refused = await new Browser().finish({ credential: token, state: s.state });
  check("a refusal's address carries a short code and nothing from the token", /^https:\/\/app\.test\/\?sign_in_error=[a-z]+$/.test(refused.location), refused.location);
  const wrong = new Browser();
  const ws = await wrong.start();
  const wrongToken = await googleToken({ nonce: s.nonce });
  const wrongNonce = await wrong.finish({ credential: wrongToken, state: ws.state });
  const forgedToken = await googleToken({ nonce: ws.nonce, key: stranger.privateKey });
  const wrong2 = new Browser();
  const ws2 = await wrong2.start();
  const badToken = await wrong2.finish({ credential: await googleToken({ nonce: ws2.nonce, aud: "x.apps.googleusercontent.com" }), state: ws2.state });
  check("…whichever check refused it: a token that failed verification is not put in the address either", wrongNonce.location === `${APP}/?sign_in_error=nonce` && badToken.location === `${APP}/?sign_in_error=token` && forgedToken.length > 0);
  const page = await (await hubPageFor(s.to)).text();
  check("the hub page posts the token (a form POST), it never navigates with it", /<form id="f" method="post"/.test(page) && !/location\.(assign|replace|href)[^;]*credential/.test(page) && !/[?&](credential|id_token)=/.test(page.replace(/response_type=id_token/g, "")));
  check("the hub page's script writes nothing to the console", !/console\./.test(page));
  check("the full-page flow asks Google for the token in the URL fragment, which no server receives", /response_type=id_token/.test(page) && !/response_mode=query/.test(page));
  check("the hub page removes the fragment before it does anything with it", /history\.replaceState\(null,"",location\.pathname\+location\.search\);send\(/.test(page));
  const parts = issued.flatMap((t) => [t, t.split(".")[1], t.split(".")[2]]).filter((p) => p && p.length > 20);
  const leaked = logged.filter((line) => parts.some((p) => line.includes(p)));
  check(`none of the ${issued.length} tokens issued in this run, nor any part of one, was written to a log (${logged.length} lines read)`, issued.length >= 15 && leaked.length === 0, leaked.map((l) => l.slice(0, 80)));
  check("a refusal is logged as its reason alone", logged.some((l) => l === "[google-hub] sign-in refused: nonce") && logged.filter((l) => l.startsWith("[google-hub]")).every((l) => /^\[google-hub\] sign-in refused: [a-z]+$/.test(l)));
  for (const file of ["app/api/auth/google-hub/callback/route.ts", "app/api/auth/google-hub/start/route.ts", "app/auth/google-hub/route.ts", "lib/google-hub.ts", "lib/google-hub-page.ts"]) {
    const src = readFileSync(file, "utf8");
    const calls = src.match(/console\.\w+\([^)]*\)/g) ?? [];
    check(`${file}: no log call names the token, the request body or a claim`, calls.every((c) => !/credential|token|body|payload|form|flow|nonce|state/i.test(c.replace("sign-in refused", ""))), calls);
  }
}

/* ================================================================================================================ */
section("5. The hub page cannot be framed");
{
  const browser = new Browser();
  const s = await browser.start();
  const page = await hubPageFor(s.to);
  const csp = page.headers.get("content-security-policy") ?? "";
  const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
  check("frame-ancestors 'none' and X-Frame-Options DENY", directives["frame-ancestors"] === "'none'" && page.headers.get("x-frame-options") === "DENY");
  check("its form may post to the one allowed origin and nowhere else", directives["form-action"] === APP, directives["form-action"]);
  check("it runs its one script by nonce and Google's client: no 'unsafe-inline', no 'self', no wildcard", /^'nonce-[a-f0-9]{32}' https:\/\/accounts\.google\.com\/gsi\/client$/.test(directives["script-src"] ?? ""), directives["script-src"]);
  check("nothing else is allowed by default, and the base address cannot be changed", directives["default-src"] === "'none'" && directives["base-uri"] === "'none'");
  check("it is never cached, and tells the page it posts to its origin only, never its address (which holds the state and nonce)", page.headers.get("cache-control") === "no-store" && page.headers.get("referrer-policy") === "strict-origin");
  const two = await hubPageFor(s.to);
  check("the script nonce is new on every response", /'nonce-([a-f0-9]{32})'/.exec(csp)[1] !== /'nonce-([a-f0-9]{32})'/.exec(two.headers.get("content-security-policy"))[1]);
  const refusal = await hubPageFor(`${HUB}/auth/google-hub?return=https://evil.test`);
  check("the refusal page cannot be framed either", (refusal.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") && refusal.headers.get("x-frame-options") === "DENY");
  const proxy = readFileSync("proxy.ts", "utf8");
  check("the site-wide policy steps aside for the hub's two pages, so theirs is the only one on the response", /pathname === HUB_PAGE_PATH \|\| pathname === HUB_CALLBACK_PATH\) return NextResponse\.next\(\)/.test(proxy));
}

/* ================================================================================================================ */
section("6. The hub page says which address the person is signing in to");
{
  const browser = new Browser();
  const s = await browser.start();
  const html = await (await hubPageFor(s.to)).text();
  check("the name the hub's operator gave the origin, and its host", /You are signing in to <span class="to" data-hub-return>First App <span class="muted">\(app\.test\)<\/span><\/span>/.test(html), html.slice(html.indexOf("You are"), html.indexOf("You are") + 160));
  check("the title names it too", /<title>Sign in to First App<\/title>/.test(html));
  const u = new URL(s.to);
  u.searchParams.set("return", OTHER_APP);
  const plain = await (await hubPageFor(u)).text();
  check("an origin with no name is shown by its host", /data-hub-return>other\.test<\/span>/.test(plain));
  u.searchParams.set("name", "Your Bank");
  u.searchParams.set("label", "Your Bank");
  u.searchParams.set("app", "Your Bank");
  const spoof = await (await hubPageFor(u)).text();
  check("the caller cannot supply the name shown", !spoof.includes("Your Bank") && /data-hub-return>other\.test<\/span>/.test(spoof));
  const marked = await (await hubPageFor(s.to, { AUTH_GOOGLE_HUB_ALLOWED_RETURNS: `${APP}=<img src=x onerror=alert(1)>` })).text();
  check("a name with markup in the allow-list is dropped, not shown", !marked.includes("<img") && !marked.includes("alert(1)") && /data-hub-return>app\.test<\/span>/.test(marked));
  const entry = { origin: APP, host: "app.test", label: "A & B" };
  const base = { to: entry, state: s.state, nonce: s.nonce, clientId: CLIENT, hubOrigin: HUB, hubName: "Hub <One>", cspNonce: "0".repeat(32) };
  const escaped = hubPage({ ...base, listed: { redirect: "listed", origin: "listed" } }).body;
  check("names are written as text", escaped.includes("A &amp; B") && escaped.includes("Hub &lt;One&gt;") && !escaped.includes("Hub <One>"));
  const onlyFullPage = hubPage({ ...base, listed: { redirect: "listed", origin: "unlisted" } }).body;
  const onlyButton = hubPage({ ...base, listed: { redirect: "unlisted", origin: "listed" } }).body;
  check("the hub offers Google's button only where Google lists the hub for it, and the full-page flow likewise", onlyFullPage.includes('"button":false,"fullPage":true') && onlyButton.includes('"button":true,"fullPage":false'));
  const neither = hubPage({ ...base, listed: { redirect: "unlisted", origin: "unlisted" } });
  check("a hub Google lists for neither says so instead of drawing a button that cannot work", neither.status === 503 && !neither.body.includes("<form") && !neither.body.includes("<script"));
  const redirect = /"redirect":"([^"]+)"/.exec(escaped)[1].replace(/\\u0026/g, "&");
  const q = new URL(redirect).searchParams;
  const trip = hubRules.decodeHubRoundTrip(q.get("state"));
  check("the full-page flow returns to the hub's home address with the same nonce, and remembers which sign-in it is", q.get("redirect_uri") === HUB && q.get("nonce") === s.nonce && trip?.returnTo === APP && trip.state === s.state && trip.nonce === s.nonce);
  check("a round trip's state that was not made here names nothing", hubRules.decodeHubRoundTrip("hub.bm90LWpzb24") === null && hubRules.decodeHubRoundTrip("xyz") === null && hubRules.decodeHubRoundTrip(null) === null);
  check("…and when it names an origin, the hub page still checks it against the list", hubRules.hubPageUrl("", { returnTo: "https://evil.test", state: s.state, nonce: s.nonce }).startsWith("/auth/google-hub?return=https%3A%2F%2Fevil.test"));
}

/* ================================================================================================================ */
section("The button is drawn only where it leads somewhere: direct, through the hub, or not at all");
{
  const mismatch = Buffer.from("\n\u0015redirect_uri_mismatch\u0012\u00b0\u0001You can't sign in to this app").toString("base64url");
  /** Google's two endpoints as measured (lib/google-origin-probe.ts), and a hub, for a table of addresses. */
  const world = ({ redirect = [], origin = [], hubs = {}, google = "up" } = {}) => {
    const calls = [];
    const fetcher = async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url: String(input), headers: init.headers ?? {} });
      if (url.hostname === "accounts.google.com") {
        if (google === "down") throw new Error("network");
        if (google === "captcha") return new Response("<html>unusual traffic</html>", { status: 200 });
        if (google === "error") return new Response("oops", { status: 500 });
        if (url.pathname === "/o/oauth2/v2/auth") {
          const ok = redirect.includes(url.searchParams.get("redirect_uri"));
          return new Response(null, { status: 302, headers: { location: ok ? `https://accounts.google.com/v3/signin/identifier?client_id=${url.searchParams.get("client_id")}` : `https://accounts.google.com/signin/oauth/error?authError=${mismatch}&client_id=x` } });
        }
        if (url.pathname === "/gsi/status") {
          if (!/Chrome\//.test(init.headers?.["user-agent"] ?? "")) return new Response(")]}'\n[[\"t\"],[9]]", { status: 403 });
          return origin.includes(init.headers?.origin) ? new Response(")]}'\n[[\"t\"],null,0,0,1,90,120,null,0]", { status: 200 }) : new Response(")]}'\n[[\"t\"],[5]]", { status: 403 });
        }
      }
      const hub = hubs[url.origin];
      if (hub && url.pathname === "/api/auth/google-hub/status") {
        if (hub === "down") throw new Error("network");
        return new Response(JSON.stringify(typeof hub === "function" ? hub(url.searchParams.get("return")) : hub), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };
    fetcher.calls = calls;
    return fetcher;
  };
  const fp = await hubRules.clientFingerprint(CLIENT);
  const goodHub = (ret) => ({ hub: true, allowed: ret === APP, client: fp, listed: { redirect: "listed", origin: "listed" }, ready: true, dropped: 0 });
  const ask = (origin, env, fetcher) => {
    probe.__forgetGoogleAddressChecks();
    mode.__forgetHubAnswers();
    return mode.googleAvailability(origin, { env: { NEXT_PUBLIC_GOOGLE_CLIENT_ID: CLIENT, ...env }, fetcher });
  };

  const w1 = world({ redirect: [HUB], origin: [HUB] });
  const direct = await ask(HUB, {}, w1);
  check("an address Google lists: the button signs in directly, with One Tap", direct.google === "direct" && direct.oneTap === true && direct.reason === "listed");
  check("Google is asked as a browser would ask, naming the address", w1.calls.some((c) => c.url.includes("redirect_uri=https%3A%2F%2Fhub.test")) && w1.calls.some((c) => c.url.includes("/gsi/status") && c.headers.origin === HUB && /Chrome\//.test(c.headers["user-agent"])));
  const redirectOnly = await ask(HUB, {}, world({ redirect: [HUB] }));
  check("listed for the full-page flow only: the button works, One Tap is not started", redirectOnly.google === "direct" && redirectOnly.oneTap === false);

  const unlisted = await ask(APP, {}, world({ redirect: [HUB], origin: [HUB] }));
  check("NO DEAD BUTTON: an address Google does not list, with no hub, gets no Google button", unlisted.google === "none" && unlisted.reason === "unlisted" && unlisted.oneTap === false);

  const viaHub = await ask(APP, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ redirect: [HUB], origin: [HUB], hubs: { [HUB]: goodHub } }));
  check("the same address with a hub that answers for it: the button goes through the hub", viaHub.google === "hub" && viaHub.hub === HUB && viaHub.oneTap === false);
  const listedWithHub = await ask(APP, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ redirect: [HUB, APP], origin: [APP], hubs: { [HUB]: goodHub } }));
  check("an address Google lists signs in directly even when a hub is set", listedWithHub.google === "direct" && listedWithHub.oneTap === true);

  const cases = {
    "hub-refuses": { [HUB]: (r) => ({ ...goodHub(r), allowed: false }) },
    "hub-off": { [HUB]: { hub: false, allowed: false, client: null, listed: { redirect: "unknown", origin: "unknown" }, ready: false, dropped: 0 } },
    "hub-other-client": { [HUB]: (r) => ({ ...goodHub(r), client: "0123456789ab" }) },
    "hub-not-ready": { [HUB]: (r) => ({ ...goodHub(r), ready: false }) },
    "hub-unreachable": { [HUB]: "down" },
  };
  for (const [why, hubs] of Object.entries(cases)) {
    const a = await ask(APP, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ redirect: [HUB], hubs }));
    check(`a hub that cannot serve this address (${why}): no Google button, and the reason is kept`, a.google === "none" && a.reason === why, a);
  }
  const notJson = await ask(APP, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ redirect: [HUB], hubs: {} }));
  check("a hub address that answers something else is no hub", notJson.google === "none" && notJson.reason === "hub-unreachable");
  const selfHub = await ask(HUB, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ hubs: { [HUB]: goodHub } }));
  check("a deployment whose hub setting is its own address does not send people round in a circle", selfHub.google === "none" && selfHub.hub === null);
  const httpHub = await ask(APP, { NODE_ENV: "production", AUTH_GOOGLE_HUB_ORIGIN: "http://hub.test" }, world({ hubs: { "http://hub.test": goodHub } }));
  check("a hub that is not https is not a hub", httpHub.google === "none" && httpHub.hub === null);

  for (const google of ["down", "captcha", "error"]) {
    const a = await ask(APP, {}, world({ google }));
    check(`NEVER HIDDEN ON A GUESS: when Google's answer is not understood (${google}), the button stays as it was`, a.google === "direct" && a.reason === "unverified" && a.listed.redirect === "unknown", a);
  }
  const unknownWithHub = await ask(APP, { AUTH_GOOGLE_HUB_ORIGIN: HUB }, world({ google: "down", hubs: { [HUB]: goodHub } }));
  check("…and with a hub that answers, the hub is used", unknownWithHub.google === "hub");
  const noClient = await ask(APP, { NEXT_PUBLIC_GOOGLE_CLIENT_ID: "" }, world());
  check("no Google client set: no Google button", noClient.google === "none" && noClient.reason === "no-client");
  const offEnv = await ask(APP, { AUTH_GOOGLE_ADDRESS_CHECK: "off" }, world({ redirect: [] }));
  check("AUTH_GOOGLE_ADDRESS_CHECK=off asks Google nothing and keeps the button", offEnv.google === "direct" && offEnv.listed.redirect === "unknown");

  const res = (status, location) => async () => new Response(null, { status, headers: location ? { location } : {} });
  const R = (f) => probe.probeRedirectList(CLIENT, APP, f);
  check("redirect list: on to Google's sign-in pages is listed", (await R(res(302, "https://accounts.google.com/v3/signin/identifier?x=1"))) === "listed" && (await R(res(302, "https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount?x"))) === "listed");
  check("redirect list: only redirect_uri_mismatch is unlisted", (await R(res(302, `https://accounts.google.com/signin/oauth/error?authError=${mismatch}`))) === "unlisted");
  const otherError = Buffer.from("\n\u000einvalid_client\u0012\u0010no such client").toString("base64url");
  check("redirect list: another error (a wrong client), another host or another status says nothing", (await R(res(302, `https://accounts.google.com/signin/oauth/error?authError=${otherError}`))) === "unknown" && (await R(res(302, "https://evil.test/v3/signin/identifier"))) === "unknown" && (await R(res(200))) === "unknown" && (await R(res(302))) === "unknown" && (await R(res(302, "https://accounts.google.com/somewhere/new"))) === "unknown");
  const st = (status, body) => async () => new Response(body, { status });
  const O = (f) => probe.probeOriginList(CLIENT, APP, f);
  check("origin list: 200 is listed, 403 with code 5 is unlisted, any other code or status says nothing", (await O(st(200, ")]}'\n[[\"t\"],null,0]"))) === "listed" && (await O(st(403, ")]}'\n[[\"t\"],[5]]"))) === "unlisted" && (await O(st(403, ")]}'\n[[\"t\"],[9]]"))) === "unknown" && (await O(st(403, ")]}'\n[[\"t\"],[3]]"))) === "unknown" && (await O(st(403, "<html>Forbidden</html>"))) === "unknown" && (await O(st(500, ""))) === "unknown");

  probe.__forgetGoogleAddressChecks();
  const counted = world({ redirect: [HUB], origin: [HUB] });
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: counted, env: {}, now: 1_000 });
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: counted, env: {}, now: 60_000 });
  const afterTwo = counted.calls.length;
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: counted, env: {}, now: 11 * 60_000 });
  check("Google's answer is remembered for ten minutes, not asked on every page load", afterTwo === 2 && counted.calls.length === 4);
  probe.__forgetGoogleAddressChecks();
  const flaky = world({ google: "down" });
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: flaky, env: {}, now: 1_000 });
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: flaky, env: {}, now: 30_000 });
  await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: flaky, env: {}, now: 62_000 });
  check("…an answer that was not understood is asked again after a minute", flaky.calls.length === 4);

  probe.__forgetGoogleAddressChecks();
  const flood = world({ redirect: [HUB], origin: [HUB] });
  const answers = [];
  for (let i = 0; i < 40; i++) answers.push(await probe.checkGoogleAddress(CLIENT, `https://invented-${i}.test`, { fetcher: flood, env: {}, now: 5_000 + i }));
  const real = await probe.checkGoogleAddress(CLIENT, HUB, { fetcher: flood, env: {}, now: 70_000 });
  check("a stream of invented addresses cannot make the server question Google without end: a ceiling per minute, and over it the answer is 'unknown', never 'unlisted'",
    flood.calls.length === 24 + 2 && answers.slice(12).every((a) => a.redirect === "unknown" && a.origin === "unknown") && answers[0].redirect === "unlisted" && real.redirect === "listed", flood.calls.length);
  probe.__forgetGoogleAddressChecks();

  const servedByRoute = await withEnv({ AUTH_GOOGLE_HUB_ORIGIN: "" }, async () => (await availabilityRoute.GET(new NextRequest(`${APP}/api/auth/google/availability`))).json());
  check("the page's question is answered by the same rule", servedByRoute.google === "direct" && servedByRoute.reason === "unverified");
  const viaProxy = hubRules.requestOrigin({ url: "http://127.0.0.1:3000/x", headers: new Headers({ "x-forwarded-host": "app.test", "x-forwarded-proto": "https", host: "127.0.0.1:3000" }) });
  check("behind a reverse proxy the address asked about is the one the browser used", viaProxy === APP && hubRules.requestOrigin({ url: "http://127.0.0.1:3000/x", headers: new Headers({ host: "localhost:3000" }) }) === "http://localhost:3000");

  const gate = readFileSync("app/_components/auth-gate.tsx", "utf8");
  const button = gate.indexOf("              Continue with Google\n");
  const guard = gate.lastIndexOf('{google.mode === "direct" || google.mode === "hub" ? (', button);
  check("the sign-in page draws the Google button only for `direct` or `hub`", guard > -1 && gate.slice(guard, button).includes("onClick={google.mode === \"hub\" ? signInViaHub : signInRedirect}") && (gate.match(/Continue with Google\n/g) ?? []).length === 1);
  check("…asks before drawing it, and where there is none opens the emailed-code sign-in", gate.includes('fetch("/api/auth/google/availability"') && gate.includes('open={google.mode === "none"}'));
  check("…and starts Google's own client only where Google lists the address for it", /if \(google\.mode !== "direct" \|\| !google\.oneTap\) return;/.test(gate));
  check("a hub's home page passes a hub sign-in back to the hub page instead of adopting the token", /const trip = decodeHubRoundTrip\(params\.get\("state"\)\);\s+if \(trip\) \{\s+window\.location\.replace\(/.test(gate));
  // The test key set (GOOGLE_JWKS_URL_FOR_TEST), for real: a key server on loopback publishing the key made here, and
  // a fresh process per case verifying a token that key signed.
  const { createServer } = await import("node:http");
  const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(google.publicKey)), kid: "hub-test", alg: "RS256", use: "sig" }] });
  const keyServer = createServer((_, res) => res.writeHead(200, { "content-type": "application/json" }).end(jwksBody));
  await new Promise((r) => keyServer.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${keyServer.address().port}/jwks`;
  const childNonce = hubRules.randomHubValue();
  const childToken = await googleToken({ nonce: childNonce });
  // Asynchronously: the key server answers on this process's own event loop.
  const { spawn } = await import("node:child_process");
  const verifyAsync = (env) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/test-google-hub.mjs"], {
        env: { PATH: process.env.PATH, NEXT_PUBLIC_GOOGLE_CLIENT_ID: CLIENT, HUB_TEST_CHILD: JSON.stringify([childToken, childNonce]), ...env },
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({ error: out.slice(-200) });
        }
      });
    });
  const dev = await verifyAsync({ GOOGLE_JWKS_URL_FOR_TEST: jwksUrl });
  const prod = await verifyAsync({ GOOGLE_JWKS_URL_FOR_TEST: jwksUrl, NODE_ENV: "production" });
  const elsewhere = await verifyAsync({ GOOGLE_JWKS_URL_FOR_TEST: jwksUrl.replace("127.0.0.1", "127.0.0.2") });
  keyServer.close();
  check("a development server can be given the test's keys at a loopback address", dev.ok === true, dev);
  check("A PRODUCTION SERVER IGNORES THAT SETTING: the same token, signed by the test's key, is refused (only Google's keys are asked)", prod.ok === false && prod.reason === "token", prod);
  check("…and so does any server when the address is not loopback", elsewhere.ok === false && elsewhere.reason === "token", elsewhere);
  const auth = readFileSync("lib/ops-auth.ts", "utf8");
  check("the test key set is read only outside a production build and only at a loopback address", /function testKeySet\(\)[^}]*\{\s+if \(process\.env\.NODE_ENV === "production"\) return null;/.test(auth) && /url\.protocol !== "http:" \|\| \(url\.hostname !== "127\.0\.0\.1" && url\.hostname !== "localhost"\)\) return null/.test(auth));
}

console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED:\n  - ${failed.join("\n  - ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
