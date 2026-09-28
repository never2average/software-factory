/**
 * THE SERVICE WORKER (public/sw.js), in a real Chromium with notifications granted — no app build, no secret.
 *
 * Serves the real sw.js next to a small page that answers the worker's questions the way the app does
 * (app/_components/desktop-notify.ts `installNotificationBridge`), delivers pushes through the DevTools protocol
 * (ServiceWorker.deliverPushMessage: exactly what arrives after the browser decrypted a push), and checks:
 *
 *  1. a pushed payload is shown: the chat title, the preview, one tag per event, the chat's link in its data;
 *  2. a payload with previews turned off (no body) shows a fixed line for its kind, never content;
 *  3. the same event twice (a re-sent push, or the push AND a hidden tab's own notice) is ONE notification;
 *  4. the chat the person is looking at (a focused, visible tab showing it) is not notified;
 *  5. a click brings the app's tab forward on THAT chat (`open-chat` with its session), and with no tab open,
 *     opens the chat's own link.
 *
 * Run: npm run test:push-sw   (needs Chromium: npx playwright install chromium)
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
};

const SW = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const PAGE = `<!doctype html><title>push test</title><body>
<script>
  window.__msgs = [];
  window.__viewing = null;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const m = e.data || {};
    window.__msgs.push(m);
    if (m.type === "which-chat") e.ports[0].postMessage({ sessionId: window.__viewing });
  });
  window.__ready = navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
</script></body>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(SW);
  } else {
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// The full Chromium in new headless mode: the headless SHELL has no notification service (permission reads
// "denied" whatever is granted). `npx playwright install chromium` installs both.
const browser = await chromium.launch({ channel: "chromium" });
try {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => window.__ready);
  const cdp = await ctx.newCDPSession(page);
  let registrationId = null;
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
    for (const r of e.registrations) if (r.scopeURL.startsWith(ORIGIN)) registrationId = r.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  for (let i = 0; i < 50 && !registrationId; i++) await page.waitForTimeout(100);
  check("the page registers /sw.js", Boolean(registrationId));

  const pushed = async (payload) => {
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: ORIGIN, registrationId, data: JSON.stringify(payload) });
    await page.waitForTimeout(700);
  };
  const shown = () =>
    page.evaluate(async () =>
      (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })),
    );
  const clear = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));

  console.log("1. A push is shown:");
  const reply = { v: 1, kind: "reply", title: "Quarterly review", body: "The Q3 filing shows margins improving…", tag: "wrun_1:turn_3:reply", url: "/?chatSession=wrun_1", sessionId: "wrun_1" };
  await pushed(reply);
  let list = await shown();
  check("title, preview and tag as sent", list.length === 1 && list[0].title === "Quarterly review" && list[0].body === reply.body && list[0].tag === reply.tag, list);
  check("the notification knows which chat it is about", list[0]?.data?.url === "/?chatSession=wrun_1" && list[0]?.data?.sessionId === "wrun_1");

  console.log("\n2. Previews off:");
  await pushed({ v: 1, kind: "input", title: "Board pack", tag: "wrun_2:turn_1:input", url: "/?chatSession=wrun_2", sessionId: "wrun_2" });
  list = await shown();
  const input = list.find((n) => n.tag === "wrun_2:turn_1:input");
  check("the title alone arrives; the line under it names the kind of event, not its content", input?.title === "Board pack" && input?.body === "The agent needs your answer.", input);

  console.log("\n3. One event, one notification:");
  await pushed(reply);
  await page.evaluate(async (p) => (await navigator.serviceWorker.ready).active.postMessage({ type: "show", payload: p }), reply);
  await page.waitForTimeout(500);
  list = await shown();
  check("a re-sent push and a hidden tab's own notice for the same event are ONE notification", list.filter((n) => n.tag === reply.tag).length === 1, list.map((n) => n.tag));

  console.log("\n4. The chat on screen is not notified:");
  await clear();
  await page.bringToFront();
  const focused = await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus());
  await page.evaluate(() => (window.__viewing = "wrun_9"));
  await pushed({ v: 1, kind: "reply", title: "On screen", body: "…", tag: "wrun_9:turn_1:reply", url: "/?chatSession=wrun_9", sessionId: "wrun_9" });
  list = await shown();
  const asked = await page.evaluate(() => window.__msgs.filter((m) => m.type === "which-chat").length);
  if (focused && asked > 0) {
    check("a focused, visible tab showing that chat: no notification", !list.some((n) => n.tag === "wrun_9:turn_1:reply"), list);
  } else {
    // Headless Chromium may not report the window as focused; then the worker never asks and must show it.
    check("an unfocused tab is not \"looking\": the push is shown", list.some((n) => n.tag === "wrun_9:turn_1:reply"), { focused, asked });
  }
  await pushed({ v: 1, kind: "reply", title: "Another chat", body: "…", tag: "wrun_8:turn_1:reply", url: "/?chatSession=wrun_8", sessionId: "wrun_8" });
  list = await shown();
  check("another chat is still notified while that one is on screen", list.some((n) => n.tag === "wrun_8:turn_1:reply"));

  console.log("\n5. A click opens that chat:");
  await page.evaluate(() => (window.__msgs = []));
  await page.evaluate(async () => (await navigator.serviceWorker.ready).active.postMessage({ type: "open-notification", tag: "wrun_8:turn_1:reply" }));
  await page.waitForTimeout(700);
  const opened = await page.evaluate(() => window.__msgs.filter((m) => m.type === "open-chat"));
  check("the app's open tab is told to open THAT chat", opened.length === 1 && opened[0].sessionId === "wrun_8" && opened[0].url === `${ORIGIN}/?chatSession=wrun_8`, opened);
  check("…and the clicked notification is closed", !(await shown()).some((n) => n.tag === "wrun_8:turn_1:reply"));
  // No tab of the app open: the click opens the chat's own link. (clients.openWindow needs a real click's user
  // activation, which no test can produce, so the worker's call is observed rather than performed.)
  const [worker] = ctx.serviceWorkers();
  const openedUrl = await worker.evaluate(async () => {
    let asked = null;
    const real = self.clients.matchAll.bind(self.clients);
    self.clients.matchAll = async () => [];
    self.clients.openWindow = async (url) => {
      asked = url;
      return null;
    };
    await openChat({ url: "/?chatSession=wrun_7", sessionId: "wrun_7" });
    self.clients.matchAll = real;
    return asked;
  });
  check("with no tab open, a click opens the chat's own link", openedUrl === `${ORIGIN}/?chatSession=wrun_7`, openedUrl);
  // A payload naming another origin (tampered, or a bug) never takes the person off this app.
  const evil = await worker.evaluate(async () => {
    const asked = [];
    const real = self.clients.matchAll.bind(self.clients);
    self.clients.matchAll = async () => [];
    self.clients.openWindow = async (url) => (asked.push(url), null);
    await openChat({ url: "https://evil.example/phish", sessionId: "wrun_7" });
    await openChat({ url: "//evil.example/x", sessionId: "wrun_7" });
    await openChat({ url: "javascript:alert(1)", sessionId: "wrun_7" });
    self.clients.matchAll = real;
    return asked;
  });
  check("a click only ever opens a page of this app (another origin opens the app's home)", evil.length === 3 && evil.every((u) => u === `${ORIGIN}/`), evil);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
