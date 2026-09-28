#!/usr/bin/env node
/**
 * A SIGNED-IN PERSON'S FIRST SCREEN COMES FROM THIS BROWSER, AT ONCE, AND SAYS WHEN IT IS STILL CHECKING.
 *
 * Opening the app painted the sign-in card (even for someone signed in), then an empty sidebar, then a new chat,
 * and only then asked the server for anything: the reads waited for every script to download and run, two of them
 * were made twice, one waited for another, and the agent's cold start was paid by the first message. This renders
 * the PRODUCTION build (`npm run build` first) with `next start` and Chromium, signed in with a locally made token
 * and the ops API faked with a slow chat list, and holds:
 *
 *   - the first paint (before any script) is the app's frame, never the sign-in card; signed out, it is the card;
 *   - the chat the person last had open, and the sidebar, show from this browser's cache before the server's list
 *     has answered, with a quiet "updating" that goes once it has; a chat deleted elsewhere is not kept open;
 *   - each first-screen read is requested once, and before the app's JavaScript has run;
 *   - the agent is warmed once per tab when the composer mounts, and not again on a reload.
 *
 *   npm run check:first-screen                 (needs Chromium: npx playwright install chromium)
 *   npm run check:first-screen -- --dir <d>    a built checkout other than this one
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { MOCKS } from "./lib/rendered-text.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const DIR = argAfter("--dir") ?? ROOT;
const require = createRequire(join(ROOT, "package.json"));
const { STARTUP_READS } = await import(join(ROOT, "lib/startup-fetch.ts"));
const { PREWARM_PATH } = await import(join(ROOT, "lib/agent-prewarm.ts"));
const { STORAGE_KEYS } = await import(join(ROOT, "lib/browser-storage.ts"));

const failures = [];
const passes = [];
const check = (name, ok, detail = "") => (ok ? passes : failures).push(ok ? name : `${name}${detail ? `: ${detail}` : ""}`);

if (!existsSync(join(DIR, ".next/BUILD_ID"))) {
  console.error(`${DIR}/.next is not a production build: run \`npm run build\` first.`);
  process.exit(1);
}

const EMAIL = "reviewer@example.com";
const ORG = "o1";
const LIST_DELAY_MS = 2500;
const at = () => new Date(Date.now() - 60_000).toISOString();
function transcript(reply) {
  const m = { at: at() };
  return [
    { type: "session.started", data: { runtime: {} }, meta: m },
    { type: "turn.started", data: { sequence: 1, turnId: "turn_1" }, meta: m },
    { type: "message.received", data: { sequence: 1, turnId: "turn_1", message: "What changed?", parts: [{ type: "text", text: "What changed?" }] }, meta: m },
    { type: "step.started", data: { sequence: 1, turnId: "turn_1", stepIndex: 0 }, meta: m },
    { type: "message.completed", data: { sequence: 1, turnId: "turn_1", stepIndex: 0, finishReason: "stop", message: reply }, meta: m },
    { type: "step.completed", data: { sequence: 1, turnId: "turn_1", stepIndex: 0, finishReason: "stop", usage: {} }, meta: m },
    { type: "turn.completed", data: { sequence: 1, turnId: "turn_1" }, meta: m },
    { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "ct_1" }, meta: m },
  ];
}
const CHATS = [1, 2, 3].map((i) => ({
  id: `chat-${i}`,
  clientKey: `new-first-${i}`,
  title: `First screen chat ${i}`,
  preview: `preview ${i}`,
  messageCount: 2,
  customers: [],
  session: { sessionId: `sess_${i}`, continuationToken: `ct_${i}`, streamIndex: 8 },
  events: transcript(`Cached answer ${i}. FIRST-SCREEN-${i}`),
  updatedAt: Date.now() - i * 3_600_000,
}));
const listItems = (chats) => chats.map((c) => ({ id: c.id, clientKey: c.clientKey, title: c.title, preview: c.preview, messageCount: 2, eveSessionId: c.session.sessionId, continuationToken: c.session.continuationToken, updatedAt: c.updatedAt }));

async function main() {
  const { chromium } = require("@playwright/test");
  const port = await new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port: p } = s.address(); s.close(() => res(p)); }); s.on("error", rej); });
  const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: true });
  // Its own process group: `next start` runs the server as a child, and killing only the parent can leave it behind.
  const stop = (sig) => { try { process.kill(-server.pid, sig); } catch { /* already gone */ } };
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/onboard`)).status < 500) break; } catch { /* not up yet */ }
      if (i > 240 || server.exitCode !== null) throw new Error(`next start did not come up:\n${log.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.launch();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64({ email: EMAIL, name: "Reviewer", kind: "email-session", exp: Math.floor(Date.now() / 1000) + 7200 })}.x`;

    /** A signed-in context whose chat list answers after LIST_DELAY_MS with `serverChats`. */
    const signedIn = async ({ serverChats = CHATS, last = "chat-2", signedOut = false } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(
        ({ t, chatsKey, chats, lastKey, last: l, signedOut: out }) => {
          if (sessionStorage.getItem("seeded")) return;
          sessionStorage.setItem("seeded", "1");
          if (out) return;
          localStorage.setItem("workspace-google-token", t);
          localStorage.setItem("workspace-active-org", "o1");
          localStorage.setItem(chatsKey, chats);
          if (l) localStorage.setItem(lastKey, l);
        },
        { t: token, chatsKey: `${STORAGE_KEYS.chats}:${EMAIL}:${ORG}`, chats: JSON.stringify(CHATS), lastKey: `${STORAGE_KEYS.lastChat}:${EMAIL}:${ORG}`, last, signedOut },
      );
      const requests = [];
      const mocks = { ...MOCKS(), "/api/ops/chat-sessions": { items: listItems(serverChats) } };
      await ctx.route(/\/(api|eve)\//, async (route) => {
        const u = new URL(route.request().url());
        requests.push({ path: u.pathname, method: route.request().method(), at: Date.now() });
        if (u.pathname === PREWARM_PATH) return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"status":"ready"}' });
        if (u.pathname.startsWith("/eve/")) return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" });
        if (u.pathname === "/api/ops/chat-snapshots" || u.pathname === "/api/ops/chat-replay") return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        if (u.pathname === "/api/ops/chat-sessions" && route.request().method() === "GET") await new Promise((r) => setTimeout(r, LIST_DELAY_MS));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mocks[u.pathname] ?? { items: [], ok: true }) }).catch(() => {});
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      return { ctx, page, requests };
    };
    const visible = (page, sel) => page.locator(sel).filter({ visible: true }).count();
    /** Each part reports on its own: one that cannot run fails by name and the rest still run. */
    const section = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        check(name, false, String(e.message ?? e).split("\n")[0]);
      }
    };

    // 1. The first paint, before any script: the frame, never the card. Scripts are held back to look at it.
    await section("first paint", async () => {
      const { ctx, page } = await signedIn();
      await page.route(/\/_next\/static\/chunks\/.*\.js/, () => {}); // never answered: the page stays pre-script
      await page.goto(base + "/", { waitUntil: "domcontentloaded" });
      check("signed in, first paint shows the app's frame", (await visible(page, "[data-session-frame]")) === 1);
      check("signed in, first paint never shows the sign-in card", (await visible(page, "[data-signed-out]")) === 0);
      await ctx.close();
      const out = await signedIn({ signedOut: true });
      await out.page.goto(base + "/", { waitUntil: "load" });
      await out.page.locator("[data-signed-out]").filter({ visible: true }).first().waitFor();
      check("signed out, the sign-in card shows and the frame does not", (await visible(out.page, "[data-session-frame]")) === 0);
      await out.ctx.close();
    });

    // 2–4. The last chat from cache, before the list; one request per read, before the app runs; one warm-up.
    await section("last chat from cache", async () => {
      const { ctx, page, requests } = await signedIn();
      const t0 = Date.now();
      await page.goto(base + "/", { waitUntil: "commit" });
      await page.getByText("FIRST-SCREEN-2").first().waitFor();
      const shownAt = Date.now() - t0;
      const listAnswered = requests.some((r) => r.path === "/api/ops/chat-sessions") ? requests.find((r) => r.path === "/api/ops/chat-sessions").at - t0 + LIST_DELAY_MS : Infinity;
      check("the last chat shows from the cache before the server's list answers", shownAt < listAnswered, `shown at ${shownAt} ms, list answers at ${listAnswered} ms`);
      check("the sidebar lists the cached chats at once", (await page.getByText("First screen chat 3").count()) > 0);
      check("the sidebar says it is updating while the list is out", (await visible(page, "[data-testid=chat-list-updating]")) === 1);
      await page.locator("[data-testid=chat-list-updating]").waitFor({ state: "detached", timeout: LIST_DELAY_MS + 5000 }).then(
        () => check("…and stops once the list is in", true),
        () => check("…and stops once the list is in", false, "still updating"),
      );
      const appRanAt = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/_next/static/chunks/")).reduce((m, e) => Math.max(m, e.responseEnd), 0));
      const firstStart = await page.evaluate((reads) => Object.fromEntries(reads.map((u) => [u, performance.getEntriesByType("resource").find((e) => new URL(e.name).pathname === u)?.startTime ?? null])), STARTUP_READS);
      for (const u of STARTUP_READS) {
        const n = requests.filter((r) => r.path === u && r.method === "GET").length;
        check(`${u} is requested once on load`, n === 1, `requested ${n} times`);
        check(`${u} starts before the app's scripts have all arrived`, firstStart[u] !== null && firstStart[u] < appRanAt, `started at ${firstStart[u]?.toFixed(0)} ms, scripts done at ${appRanAt.toFixed(0)} ms`);
      }
      const warm = () => requests.filter((r) => r.path === PREWARM_PATH).length;
      check("the agent is warmed once when the composer mounts", warm() === 1, `${warm()} warm-ups`);
      await page.reload({ waitUntil: "load" });
      await page.getByText("FIRST-SCREEN-2").first().waitFor();
      await page.waitForTimeout(1000);
      check("…and not again on a reload in the same tab", warm() === 1, `${warm()} warm-ups`);
      await ctx.close();
    });

    // 5. A last chat deleted on another device is not kept open once the list says so.
    await section("a last chat deleted elsewhere", async () => {
      const { ctx, page } = await signedIn({ serverChats: CHATS.filter((c) => c.id !== "chat-2") });
      await page.goto(base + "/", { waitUntil: "load" });
      await page.getByText("FIRST-SCREEN-2").first().waitFor();
      await page.getByText("FIRST-SCREEN-2").first().waitFor({ state: "detached", timeout: LIST_DELAY_MS + 8000 }).then(
        () => check("a last chat deleted elsewhere closes when the list arrives", true),
        () => check("a last chat deleted elsewhere closes when the list arrives", false, "still open"),
      );
      await ctx.close();
    });

    // 6. No last chat: a new chat, with the cached sidebar.
    await section("no last chat", async () => {
      const { ctx, page } = await signedIn({ last: null });
      await page.goto(base + "/", { waitUntil: "load" });
      await page.locator("textarea").first().waitFor();
      await page.getByText("First screen chat 1").first().waitFor();
      check("with no last chat, a new chat opens beside the cached list", (await page.getByText("FIRST-SCREEN-", { exact: false }).count()) === 0);
      await ctx.close();
    });
  } finally {
    await browser?.close();
    stop("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    stop("SIGKILL");
  }
}

try {
  await main();
} catch (e) {
  failures.push(`could not run: ${e.message}`);
}
console.log(`check:first-screen: ${passes.length} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
if (failures.length) process.exit(1);
