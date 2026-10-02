#!/usr/bin/env node
/**
 * A WORKSPACE THE SERVER REFUSES IS SAID IN PLAIN WORDS, WITH THE PERSON'S OWN WORKSPACES TO OPEN.
 *
 * The server no longer answers a request that names a workspace the caller is not a member of (or one that does not
 * exist) from the caller's own workspace: it refuses it, 403 `workspace_refused` (lib/org-context.ts,
 * scripts/test-named-workspace-http-db.mjs). The console names its tab's workspace on every call, so a remembered
 * choice that is no longer the person's — or a link that names someone else's workspace — now meets that refusal on
 * every read. This renders the PRODUCTION build (`npm run build` first) with `next start` and Chromium, signed in with
 * a locally made token and the ops API faked to refuse exactly as the server does, and holds:
 *
 *   - a remembered workspace that is refused shows "You are not a member of this workspace" and the person's own
 *     workspaces; never the console with another workspace's records, never a blank page;
 *   - nothing loops: once refused, the page asks for nothing more by itself;
 *   - choosing one of their workspaces opens the console in it (the switcher's own path), and the refused one is
 *     not adopted again — including when it came from a link's `?org=`;
 *   - the settings page (/workspace) does the same; when their list cannot be loaded, or they have no workspace of
 *     their own, the page still says so and offers a way on;
 *   - a GUEST of one shared chat (its link names a workspace they are not a member of) still sees that chat and no
 *     refusal; someone the chat is not shared with gets the plain message instead of an empty chat.
 *
 *   npm run check:workspace-refused                 (needs Chromium: npx playwright install chromium)
 *   npm run check:workspace-refused -- --dir <d>    a built checkout other than this one
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { MOCKS } from "./lib/rendered-text.mjs";
import { freePort, waitForNextStart } from "./lib/own-listener.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const DIR = argAfter("--dir") ?? ROOT;
const require = createRequire(join(ROOT, "package.json"));
const { STORAGE_KEYS } = await import(join(ROOT, "lib/browser-storage.ts"));

const failures = [];
const passes = [];
const check = (name, ok, detail = "") => (ok ? passes : failures).push(ok ? name : `${name}${detail ? `: ${detail}` : ""}`);

if (!existsSync(join(DIR, ".next/BUILD_ID"))) {
  console.error(`${DIR}/.next is not a production build: run \`npm run build\` first.`);
  process.exit(1);
}

const EMAIL = "reviewer@example.com";
const OWN = "o1"; // the person's own workspace ("Research" in the mocks)
const REFUSED = "testing"; // exists, not theirs — or does not exist: the server answers the same
const SENTENCE = "You are not a member of this workspace";
const REFUSAL = { error: `${SENTENCE}.`, code: "workspace_refused" };
/** Routes about the CALLER, not a workspace: they answer whatever the request names. */
const ABOUT_ME = new Set(["/api/ops/orgs", "/api/ops/me/workspaces", "/api/ops/me/workspaces/active"]);
const at = () => new Date(Date.now() - 60_000).toISOString();
const GUEST_TEXT = "GUEST-CHAT-ANSWER";
const transcript = () => {
  const m = { at: at() };
  return [
    { type: "session.started", data: { runtime: {} }, meta: m },
    { type: "turn.started", data: { sequence: 1, turnId: "turn_1" }, meta: m },
    { type: "message.received", data: { sequence: 1, turnId: "turn_1", message: "What changed?", parts: [{ type: "text", text: "What changed?" }] }, meta: m },
    { type: "step.started", data: { sequence: 1, turnId: "turn_1", stepIndex: 0 }, meta: m },
    { type: "message.completed", data: { sequence: 1, turnId: "turn_1", stepIndex: 0, finishReason: "stop", message: `Shared answer. ${GUEST_TEXT}` }, meta: m },
    { type: "step.completed", data: { sequence: 1, turnId: "turn_1", stepIndex: 0, finishReason: "stop", usage: {} }, meta: m },
    { type: "turn.completed", data: { sequence: 1, turnId: "turn_1" }, meta: m },
    { type: "session.completed", data: {}, meta: m },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
};

async function main() {
  const { chromium } = require("@playwright/test");
  const port = await freePort();
  const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: true });
  // Its own process group: `next start` runs the server as a child, and killing only the parent can leave it behind.
  const stop = (sig) => { try { process.kill(-server.pid, sig); } catch { /* already gone */ } };
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForNextStart({ server, port, log: () => log });
    browser = await chromium.launch();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64({ email: EMAIL, name: "Reviewer", kind: "email-session", exp: Math.floor(Date.now() / 1000) + 7200 })}.x`;

    /**
     * A signed-in tab whose browser remembers workspace `stored`. The fake ops API refuses any request that names a
     * workspace other than the person's own, as the server does; `mine` is what `me/workspaces` answers (null: 500),
     * and `stream` is the status of a chat stream opened by a link.
     */
    const tab = async ({ stored = REFUSED, mine = "own", stream = 404 } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(
        ({ t, tokenKey, orgKey, stored: s }) => {
          if (sessionStorage.getItem("seeded")) return;
          sessionStorage.setItem("seeded", "1");
          localStorage.setItem(tokenKey, t);
          if (s) localStorage.setItem(orgKey, s);
        },
        { t: token, tokenKey: STORAGE_KEYS.token, orgKey: STORAGE_KEYS.activeOrg, stored },
      );
      const requests = [];
      const mocks = MOCKS();
      const memberships = mine === "own" ? mocks["/api/ops/me/workspaces"] : { memberships: [], invites: [], active: null };
      const orgs = mine === "none" ? { items: [] } : mocks["/api/ops/orgs"];
      await ctx.route(/\/(api|eve)\//, async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const named = u.searchParams.get("org") || req.headers()["x-ops-org"] || null;
        const entry = { path: u.pathname, method: req.method(), named, at: Date.now(), body: req.postData() };
        requests.push(entry);
        const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).catch(() => {});
        if (u.pathname.startsWith("/eve/")) {
          if (u.pathname.endsWith("/stream")) return stream === 200 ? route.fulfill({ status: 200, contentType: "application/x-ndjson", body: transcript() }).catch(() => {}) : json(404, { error: "Session not found.", ok: false });
          return json(200, { ok: true, status: "ready" });
        }
        if (u.pathname === "/api/ops/me/workspaces") return mine === null ? json(500, { error: "unavailable" }) : json(200, memberships);
        if (u.pathname === "/api/ops/orgs") return json(200, orgs);
        if (u.pathname === "/api/ops/me/workspaces/active") {
          const asked = JSON.parse(req.postData() || "{}").orgId;
          return asked === OWN && mine === "own" ? json(200, { ok: true, orgId: OWN }) : json(404, { error: "You have no workspace with that id." });
        }
        if (!ABOUT_ME.has(u.pathname) && u.pathname.startsWith("/api/ops/") && named && named !== OWN) {
          entry.refused = true;
          return json(403, REFUSAL);
        }
        if (u.pathname.startsWith("/api/ops/threads/")) return json(404, { error: "Thread not found" });
        if (u.pathname === "/api/ops/chat-snapshots" || u.pathname === "/api/ops/chat-replay") return json(404, {});
        return json(200, mocks[u.pathname] ?? { items: [], ok: true });
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
      return { ctx, page, requests, errors };
    };
    const visible = (page, sel) => page.locator(sel).filter({ visible: true }).count();
    const refusalShown = (page) => page.locator("[data-workspace-refused]").filter({ visible: true }).first().waitFor();
    const stored = (page) => page.evaluate((k) => ({ session: sessionStorage.getItem(k), local: localStorage.getItem(k) }), STORAGE_KEYS.activeOrg);
    /** Each part reports on its own: one that cannot run fails by name and the rest still run. */
    const section = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        check(name, false, String(e.message ?? e).split("\n")[0]);
      }
    };

    // 1. The remembered workspace is refused: the plain message and the person's own workspaces; no loop; a way on.
    await section("a remembered workspace that is refused", async () => {
      const { ctx, page, requests, errors } = await tab();
      await page.goto(base + "/", { waitUntil: "load" });
      await refusalShown(page);
      check("a refused workspace shows the plain sentence", (await page.getByText(SENTENCE).filter({ visible: true }).count()) > 0);
      check("…and offers the person's own workspace by name", (await visible(page, `[data-own-workspace="${OWN}"]`)) === 1 && (await page.locator(`[data-own-workspace="${OWN}"]`).innerText()).includes("Research"));
      check("…instead of the console (no composer, no sidebar)", (await visible(page, "textarea")) === 0);
      check("…and nothing of any workspace's records is on the page", (await page.getByText("Acme Housing").count()) === 0);
      check("…and the page did not crash", errors.length === 0 && (await page.getByText("Application error").count()) === 0, errors.join(" | "));
      // No error loop: once refused, the page asks for nothing more by itself (the console polls; this page does not).
      await page.waitForTimeout(1500);
      const settled = requests.length;
      await page.waitForTimeout(4000);
      check("once refused, the page makes no further requests by itself (no retry loop)", requests.length === settled, `${requests.length - settled} more requests in 4 s: ${requests.slice(settled).map((r) => r.path).join(", ")}`);
      const refusedCount = requests.filter((r) => r.refused).length;
      check("…and the refusal was met a handful of times, not hammered", refusedCount > 0 && refusedCount <= 12, `${refusedCount} refused requests`);
      const before = requests.length;
      await Promise.all([page.waitForEvent("load"), page.locator(`[data-own-workspace="${OWN}"]`).click()]);
      await page.locator("textarea").first().waitFor();
      check("choosing their own workspace opens the console in it", (await visible(page, "[data-workspace-refused]")) === 0 && (await visible(page, "textarea")) > 0);
      const chosen = requests.find((r) => r.path === "/api/ops/me/workspaces/active" && r.method === "POST");
      check("…through the switcher's own call, naming that workspace", Boolean(chosen) && JSON.parse(chosen.body || "{}").orgId === OWN && chosen.named === OWN, JSON.stringify(chosen));
      const s = await stored(page);
      check("…which this tab and new tabs now remember", s.session === OWN && s.local === OWN, JSON.stringify(s));
      await page.waitForTimeout(1500);
      const after = requests.slice(before).filter((r) => r.path.startsWith("/api/ops/") && !ABOUT_ME.has(r.path));
      check("…and every request from then on names it; none is refused", after.length > 0 && after.every((r) => r.named === OWN && !r.refused), JSON.stringify(after.filter((r) => r.named !== OWN || r.refused).slice(0, 3)));
      await ctx.close();
    });

    // 2. The refused workspace came from a link's `?org=`: choosing their own drops it, and a reload does not re-adopt it.
    await section("a link that names a refused workspace", async () => {
      const { ctx, page } = await tab({ stored: OWN });
      await page.goto(`${base}/?org=${REFUSED}`, { waitUntil: "load" });
      await refusalShown(page);
      check("a link naming a workspace that is not theirs shows the plain sentence, not their own workspace under its name", (await visible(page, "textarea")) === 0 && (await page.getByText("Acme Housing").count()) === 0);
      await Promise.all([page.waitForEvent("load"), page.locator(`[data-own-workspace="${OWN}"]`).click()]);
      await page.locator("textarea").first().waitFor();
      check("choosing their own workspace leaves the link's workspace behind (the address no longer names it)", !new URL(page.url()).searchParams.has("org"), page.url());
      await page.reload({ waitUntil: "load" });
      await page.locator("textarea").first().waitFor();
      check("…and a reload stays in their own workspace", (await visible(page, "[data-workspace-refused]")) === 0 && (await stored(page)).session === OWN);
      await ctx.close();
    });

    // 3. The settings page says the same; and when their own workspaces cannot be loaded there is still a way on.
    await section("the settings page", async () => {
      const own = await tab();
      await own.page.goto(base + "/workspace", { waitUntil: "load" });
      await refusalShown(own.page);
      check("the settings page shows the plain sentence and the person's own workspace", (await own.page.getByText(SENTENCE).filter({ visible: true }).count()) > 0 && (await visible(own.page, `[data-own-workspace="${OWN}"]`)) === 1);
      check("…and none of the workspace's settings", (await own.page.getByText("switch workspace from the sidebar").count()) === 0 && (await own.page.getByRole("link", { name: "Back to chat" }).count()) === 0);
      await own.ctx.close();
      const down = await tab({ mine: null });
      await down.page.goto(base + "/workspace", { waitUntil: "load" });
      await refusalShown(down.page);
      await down.page.getByText("could not be loaded").first().waitFor();
      check("when their workspaces cannot be loaded, it still says what happened and offers a retry and a way on (never blank)", (await down.page.getByText(SENTENCE).filter({ visible: true }).count()) > 0 && (await down.page.getByRole("button", { name: "Try again" }).count()) === 1 && (await down.page.getByRole("button", { name: "Continue without it" }).count()) === 1);
      await down.ctx.close();
    });

    // 4. A guest of one shared chat is not a member of the workspace its link names — and still reads the chat.
    await section("a guest of one shared chat", async () => {
      const guest = await tab({ stored: null, mine: "none", stream: 200 });
      await guest.page.goto(`${base}/?chatSession=sess_guest&org=${REFUSED}`, { waitUntil: "load" });
      await guest.page.getByText(GUEST_TEXT).first().waitFor();
      check("a guest opens the chat its link shares with them", true);
      await guest.page.waitForTimeout(1500);
      check("…and is not shown the refusal: the lists that are refused for a guest are simply empty", (await visible(guest.page, "[data-workspace-refused]")) === 0 && guest.requests.some((r) => r.refused), `${guest.requests.filter((r) => r.refused).length} refused`);
      check("…with no error on the page", guest.errors.length === 0, guest.errors.join(" | "));
      await guest.ctx.close();
      const stranger = await tab({ stored: OWN, mine: "own", stream: 404 });
      await stranger.page.goto(`${base}/?chatSession=sess_guest&org=${REFUSED}`, { waitUntil: "load" });
      await refusalShown(stranger.page);
      check("someone the chat is not shared with gets the plain sentence, not an empty chat", (await stranger.page.getByText(SENTENCE).filter({ visible: true }).count()) > 0 && (await visible(stranger.page, "textarea")) === 0);
      check("…and their own workspace to open", (await visible(stranger.page, `[data-own-workspace="${OWN}"]`)) === 1);
      await stranger.ctx.close();
      // Someone in NO workspace whose link no longer shares the chat (a withdrawn invite): the sentence and a way on.
      const lapsed = await tab({ stored: null, mine: "none", stream: 404 });
      await lapsed.page.goto(`${base}/?chatSession=sess_guest&org=${REFUSED}`, { waitUntil: "load" });
      await refusalShown(lapsed.page);
      check("with no workspace of their own, it says so and offers to continue", (await lapsed.page.getByText("not a member of any workspace yet").count()) > 0 && (await lapsed.page.getByRole("button", { name: "Continue", exact: true }).count()) === 1);
      await lapsed.page.getByRole("button", { name: "Continue", exact: true }).click();
      await lapsed.page.waitForURL((u) => !u.searchParams.has("org"));
      let s = null;
      for (let i = 0; i < 20 && !s; i++) s = await stored(lapsed.page).catch(() => null) ?? (await lapsed.page.waitForTimeout(250), null);
      check("…and continuing forgets the refused workspace and leaves the link behind", s !== null && s.session === null && s.local === null, JSON.stringify(s));
      await lapsed.ctx.close();
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
console.log(`check:workspace-refused: ${passes.length} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
if (failures.length) process.exit(1);
