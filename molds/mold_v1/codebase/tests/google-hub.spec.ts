import { expect as playwrightExpect, test, type BrowserContext, type Page } from "@playwright/test";
import { GOOGLE_HUB_TEST } from "../playwright.config";

/**
 * "CONTINUE WITH GOOGLE" THROUGH THE SIGN-IN HUB, IN A REAL BROWSER, AGAINST A GOOGLE MADE HERE.
 *
 * The dev server plays both deployments (playwright.config.ts): the APP at http://localhost:<port>, which Google
 * "does not list" and which names a hub, and the HUB at http://127.0.0.1:<port>. To Chromium those are two sites,
 * so what is exercised is what happens between two real addresses: the httpOnly cookie that must come back with a
 * cross-site form POST, the hub page's policy (its form may post to the app and nowhere else; it cannot be framed),
 * the app's page adopting the sign-in.
 *
 * Google is tests/fake-google.mjs: it signs ID tokens as Google does and the server verifies them with every check
 * it makes on a real one. In the browser, Google's script (`accounts.google.com/gsi/client`) and its full-page
 * sign-in (`accounts.google.com/o/oauth2/v2/auth`) are answered here: the script draws a button that asks the fake
 * Google for a token bound to the nonce the page gave it, which is what Google's does.
 *
 * scripts/test-google-hub.mjs holds every refusal against the route handlers directly; the ones here are those a
 * browser has a say in.
 */
const { app: APP, hub: HUB, google: GOOGLE, clientId: CLIENT, appName: APP_NAME } = GOOGLE_HUB_TEST;
const TOKEN_KEY = "workspace-google-token";

/**
 * How long an assertion here waits for the page: 45 s, the budget a spec has in playwright.config.ts, not Playwright's
 * default 5 s.
 *
 * Everything these tests wait for after a navigation is drawn by the page's own script: the refusal sentence comes
 * from an effect in app/_components/auth-gate.tsx (which shows it and only then takes the code out of the address),
 * the adopted token from another, the button from the availability answer. `page.goto` returns at the load event, and
 * `next dev` runs the page's script after it: 0.3 to 0.5 s on a quiet 4-core machine, 9.7 s when the server was
 * compiling beside another worker. With the default wait "could not be matched to this browser" was then "not found"
 * and the test failed with the page about to show it (the code was still in the address: nothing had been lost, and
 * the sentence, once shown, stayed). The same lines fail every time with the browser's processor slowed 20x and pass
 * with this wait. A sentence that never comes still fails, 40 s later.
 */
const expect = playwrightExpect.configure({ timeout: 45_000 });

interface MintInput {
  nonce?: string | null;
  aud?: string;
  email?: string;
  /** The Google Workspace domain; "" for a personal account (Google sends no `hd` for one). */
  hd?: string;
  forged?: boolean;
  expired?: boolean;
}
const minted: string[] = [];
async function mint(input: MintInput = {}): Promise<string> {
  const res = await fetch(`${GOOGLE}/mint`, { method: "POST", body: JSON.stringify({ aud: CLIENT, ...input }) });
  const { token } = (await res.json()) as { token: string };
  minted.push(token);
  return token;
}

interface Watch {
  /** Every address the browser asked for, navigations and form posts included. */
  urls: string[];
  console: string[];
}

/** Google, as the browser meets it; and nothing from this app's own backend that needs a database. */
async function arrange(context: BrowserContext, { tamper }: { tamper?: (nonce: string | null) => MintInput } = {}): Promise<Watch> {
  const watch: Watch = { urls: [], console: [] };
  context.on("request", (r) => watch.urls.push(r.url()));
  context.on("console", (m) => watch.console.push(m.text()));
  await context.exposeFunction("__fakeGoogleMint", (nonce: string | null) => mint(tamper ? tamper(nonce) : { nonce }));
  // Google's sign-in script: the button it draws asks "Google" for a token carrying the page's nonce.
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.google={accounts:{id:{
        initialize:function(c){window.__gis=c},
        renderButton:function(el){var b=document.createElement("button");b.type="button";b.setAttribute("data-fake-google","");
          b.textContent="Continue with Google";b.onclick=function(){window.__fakeGoogleMint(window.__gis.nonce||null).then(function(t){window.__gis.callback({credential:t})})};
          el.appendChild(b)},
        prompt:function(){},disableAutoSelect:function(){}}}};`,
    }),
  );
  // Google's full-page sign-in: straight back to the redirect address with the token in the fragment.
  await context.route("https://accounts.google.com/o/oauth2/v2/auth**", async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const token = await mint(tamper ? tamper(q.get("nonce")) : { nonce: q.get("nonce") });
    const back = `${q.get("redirect_uri")}#id_token=${token}&state=${encodeURIComponent(q.get("state") ?? "")}`;
    await route.fulfill({ status: 302, headers: { location: back } });
  });
  // What the signed-in app asks its backend for needs a database; none of it is what is tested here.
  await context.route(/\/(api\/ops|eve|api\/chat-queue)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/ops/orgs") return route.fulfill({ json: { items: [{ orgId: "o1", name: "Test workspace", role: "owner" }] } });
    if (path === "/api/ops/me/workspaces") return route.fulfill({ json: { memberships: [{ orgId: "o1", name: "Test workspace", role: "owner" }], invites: [], active: "o1" } });
    return route.fulfill({ status: 200, json: { items: [] } });
  });
  return watch;
}

async function serverIsThisConfigs(page: Page): Promise<void> {
  const a = (await (await page.request.get(`${APP}/api/auth/google/availability`)).json()) as { google?: string; hub?: string };
  expect(a, "the dev server on this port was not started by playwright.config.ts (a reused server has no hub settings): stop it, or set PLAYWRIGHT_PORT").toMatchObject({ google: "hub", hub: HUB });
}

const storedToken = (page: Page) => page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);

test.describe("Google sign-in through the hub", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Google's button on the hub signs the person in to the app, and the token is never in an address", async ({ page, context }) => {
    const watch = await arrange(context);
    await serverIsThisConfigs(page);
    await page.goto(`${APP}/?from=test`);
    const button = page.locator('[data-google-sign-in="hub"] button');
    await expect(button).toBeVisible();
    await button.click();

    // On the hub: its own address, and the page says where the person is signing in to.
    await page.waitForURL(`${HUB}/auth/google-hub?**`);
    await expect(page.locator("[data-hub-return]")).toHaveText(`${APP_NAME} (${new URL(APP).host})`);
    const started = await context.cookies(APP);
    const cookie = started.find((c) => c.name === "google-hub");
    expect(cookie, "the started sign-in is a cookie on the app").toBeTruthy();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "None", path: "/" });

    await page.locator("[data-fake-google]").click();
    await page.waitForURL(`${APP}/?from=test`);
    await expect.poll(() => storedToken(page)).toBe(minted.at(-1));
    await expect(page.locator("[data-signed-out]")).toHaveCount(0);
    expect((await context.cookies(APP)).find((c) => c.name === "google-hub"), "the cookie is spent").toBeUndefined();
    expect(await page.evaluate(() => sessionStorage.getItem("workspace-google-hub-handoff")), "the hand-over is read once and removed").toBeNull();

    const token = minted.at(-1)!;
    const carried = watch.urls.filter((u) => u.includes(token) || u.includes(token.split(".")[1]));
    expect(carried, "no address the browser asked for carried the token").toEqual([]);
    expect(watch.urls.some((u) => /[?&](credential|id_token)=/.test(u)), "no address carried a token parameter").toBe(false);
    expect(watch.console.filter((l) => l.includes(token.split(".")[1])), "nothing was written to the console").toEqual([]);
    // The hub itself was not signed in to: it only did the Google part.
    const hubPage = await context.newPage();
    await hubPage.goto(`${HUB}/`);
    expect(await storedToken(hubPage)).toBeNull();
  });

  test("the full-page flow (no Google button, no pop-up) signs in the same way", async ({ page, context }) => {
    await arrange(context);
    await page.goto(`${APP}/?from=full-page`);
    await page.locator('[data-google-sign-in="hub"] button').click();
    await page.waitForURL(`${HUB}/auth/google-hub?**`);
    await page.locator("[data-hub-full-page]").click();
    // Google returns to the hub's home address; it passes the answer to the hub page, which posts it to the app.
    await page.waitForURL(`${APP}/?from=full-page`);
    await expect.poll(() => storedToken(page)).toBe(minted.at(-1));
    expect(page.url()).not.toContain("id_token");
    const hubPage = await context.newPage();
    await hubPage.goto(`${HUB}/`);
    expect(await storedToken(hubPage), "the hub's home page did not adopt a sign-in that was the app's").toBeNull();
  });

  test("a token Google minted for another sign-in's nonce is refused by the hub page and by the app", async ({ page, context }) => {
    await arrange(context, { tamper: () => ({ nonce: "another-sign-ins-nonce-0123456789abcdefghij" }) });
    await page.goto(`${APP}/`);
    await page.locator('[data-google-sign-in="hub"] button').click();
    await page.waitForURL(`${HUB}/auth/google-hub?**`);
    const state = new URL(page.url()).searchParams.get("state")!;
    await page.locator("[data-fake-google]").click();
    await expect(page.locator("#err")).toContainText("did not match this page");
    expect(page.url().startsWith(HUB)).toBe(true);

    // Past the page: the same token posted to the app with the right state and this browser's cookie.
    const res = await context.request.post(`${APP}/api/auth/google-hub/callback`, {
      form: { credential: minted.at(-1)!, state },
      headers: { origin: HUB },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe(`${APP}/?sign_in_error=nonce`);
    await page.goto(res.headers().location);
    await expect(page.locator("[data-signed-out]")).toBeVisible();
    await expect(page.getByText("could not be matched to this browser")).toBeVisible();
    expect(page.url(), "the code is removed from the address once shown").toBe(`${APP}/`);
    expect(await storedToken(page)).toBeNull();
  });

  test("someone else's finished sign-in cannot be completed in this browser (state), nor replayed", async ({ browser }) => {
    // The attacker signs in as themselves, in their own browser, and keeps what the hub would have posted.
    const attacker = await browser.newContext();
    await arrange(attacker);
    const theirs = await attacker.newPage();
    await theirs.goto(`${APP}/`);
    await theirs.locator('[data-google-sign-in="hub"] button').click();
    await theirs.waitForURL(`${HUB}/auth/google-hub?**`);
    const q = new URL(theirs.url()).searchParams;
    const attackerToken = await mint({ nonce: q.get("nonce"), email: "attacker@work.test" });
    const form = { credential: attackerToken, state: q.get("state")! };

    // The victim has a sign-in of their own under way. The attacker's answer is posted in the victim's browser.
    const victim = await browser.newContext();
    await arrange(victim);
    const theirPage = await victim.newPage();
    await theirPage.goto(`${APP}/`);
    await theirPage.locator('[data-google-sign-in="hub"] button').click();
    await theirPage.waitForURL(`${HUB}/auth/google-hub?**`);
    const fixed = await victim.request.post(`${APP}/api/auth/google-hub/callback`, { form, headers: { origin: HUB }, maxRedirects: 0 });
    expect(fixed.headers().location).toBe(`${APP}/?sign_in_error=state`);

    // A browser that started nothing.
    const fresh = await browser.newContext();
    const none = await fresh.request.post(`${APP}/api/auth/google-hub/callback`, { form, headers: { origin: HUB }, maxRedirects: 0 });
    expect(none.headers().location).toBe(`${APP}/?sign_in_error=expired`);

    // Posted from a site that is not the hub, in the attacker's own browser where state and cookie match.
    const crossSite = await attacker.request.post(`${APP}/api/auth/google-hub/callback`, { form, headers: { origin: "https://evil.test" }, maxRedirects: 0 });
    expect(crossSite.headers().location).toBe(`${APP}/?sign_in_error=origin`);
    // …which spent the cookie: the genuine answer afterwards is refused too. One start, one answer.
    const replay = await attacker.request.post(`${APP}/api/auth/google-hub/callback`, { form, headers: { origin: HUB }, maxRedirects: 0 });
    expect(replay.headers().location).toBe(`${APP}/?sign_in_error=expired`);
    await Promise.all([attacker.close(), victim.close(), fresh.close()]);
  });

  test("the hub answers only its allow-list, names nothing the caller sent, and cannot be framed", async ({ page, context }) => {
    await arrange(context);
    const v = "a".repeat(43);
    for (const target of ["https://evil.test", `${APP}@evil.test`, `${APP}/`, `${APP}.evil.test`]) {
      const res = await page.goto(`${HUB}/auth/google-hub?return=${encodeURIComponent(target)}&state=${v}&nonce=${v}`);
      expect(res?.status(), target).toBe(400);
      expect(page.url().startsWith(`${HUB}/auth/google-hub`), "no redirect").toBe(true);
      await expect(page.locator("form, a, script")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("evil.test");
    }
    const hubUrl = `${HUB}/auth/google-hub?return=${encodeURIComponent(APP)}&state=${v}&nonce=${v}&name=Your%20Bank`;
    await page.goto(hubUrl);
    await expect(page.locator("[data-hub-return]")).toHaveText(`${APP_NAME} (${new URL(APP).host})`);
    await expect(page.locator("body")).not.toContainText("Your Bank");
    expect(await page.locator("#f").getAttribute("action")).toBe(`${APP}/api/auth/google-hub/callback`);

    // Framed by another site (the app's address is another site to the hub): the browser refuses to draw it.
    const framer = await context.newPage();
    await framer.route(`${APP}/frame-test`, (route) => route.fulfill({ contentType: "text/html", body: `<iframe id="x" src="${hubUrl}"></iframe>` }));
    await framer.goto(`${APP}/frame-test`);
    await framer.waitForTimeout(1500);
    const drawn = framer.frames().filter((f) => f.url().startsWith(`${HUB}/auth/google-hub`));
    for (const f of drawn) expect(await f.locator("[data-hub-return]").count(), "the hub page is not drawn inside a frame").toBe(0);
    const res = await framer.request.get(hubUrl);
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });

  test("no dead button: where Google sign-in cannot work there is no Google button, only the emailed code", async ({ page, context }) => {
    await arrange(context);
    await context.route("**/api/auth/google/availability", (route) =>
      route.fulfill({ json: { google: "none", oneTap: false, reason: "unlisted", listed: { redirect: "unlisted", origin: "unlisted" }, hub: null } }),
    );
    let googleScript = 0;
    context.on("request", (r) => {
      if (r.url().startsWith("https://accounts.google.com/")) googleScript++;
    });
    await page.goto(`${APP}/`);
    await expect(page.locator("[data-signed-out]")).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
    await expect(page.getByText("Continue with Google")).toHaveCount(0);
    await expect(page.locator("[data-google-sign-in], [data-google-checking]")).toHaveCount(0);
    expect(googleScript, "Google's script is not even loaded").toBe(0);
  });

  test("a signed-in load asks nothing; an account the app does not admit is told why and still has the button", async ({ page, context, browser }) => {
    await arrange(context);
    let asked = 0;
    context.on("request", (r) => {
      if (r.url().includes("/api/auth/google/availability")) asked++;
    });
    const session = await mint({});
    await page.addInitScript(([k, t]) => localStorage.setItem(k, t), [TOKEN_KEY, session]);
    await page.goto(`${APP}/`);
    await expect(page.locator("[data-signed-out]")).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(asked, "someone already signed in is not asked about a sign-in button").toBe(0);

    // A personal Google account comes back through the hub: Google's token is genuine, the app admits work accounts only.
    const other = await browser.newContext();
    await arrange(other, { tamper: (nonce) => ({ nonce, hd: "", email: "someone@personal.test" }) });
    const theirs = await other.newPage();
    await theirs.goto(`${APP}/`);
    await theirs.locator('[data-google-sign-in="hub"] button').click();
    await theirs.waitForURL(`${HUB}/auth/google-hub?**`);
    await theirs.locator("[data-fake-google]").click();
    await theirs.waitForURL(`${APP}/`);
    await expect(theirs.getByText("is a personal Google account")).toBeVisible();
    await expect(theirs.locator("[data-signed-out]")).toBeVisible();
    await expect(theirs.locator('[data-google-sign-in="hub"] button'), "the way to try another account is still there").toBeVisible();
    expect(await storedToken(theirs)).toBeNull();
    await other.close();
  });

  test("the button is not drawn before the answer is known, and is the direct one where Google lists the address", async ({ page, context }) => {
    await arrange(context);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await context.route("**/api/auth/google/availability", async (route) => {
      await held;
      await route.fulfill({ json: { google: "direct", oneTap: true, reason: "listed", listed: { redirect: "listed", origin: "listed" }, hub: null } });
    });
    await page.goto(`${APP}/`);
    await expect(page.locator("[data-google-checking]")).toBeVisible();
    await expect(page.getByText("Continue with Google")).toHaveCount(0);
    release();
    await expect(page.locator('[data-google-sign-in="direct"] > button')).toBeVisible();
    await expect(page.locator("[data-google-checking]")).toHaveCount(0);
    // Google's own client is started here (One Tap); the button it draws stays out of sight and out of reach.
    await expect(page.locator("[data-fake-google]")).toBeHidden();
    // The emailed code stays the second door, behind its link.
    await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
  });
});
