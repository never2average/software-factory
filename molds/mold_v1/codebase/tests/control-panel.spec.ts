import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page, type Route } from "@playwright/test";
import { specialistStream } from "../scripts/fixtures/child-feed/make-stream.mjs";

/**
 * THE CONTROL PANEL ON A CHAT OPEN, IN A BROWSER (/preview/control-panel; lib/child-feed.ts).
 *
 * Measured on the live app before this (onfinance_hfc, 2026-10-13): every open of a chat with specialists re-read
 * each specialist's whole raw stream from event 0 (9.4 MB to over 147 MB), at mount, all at once, one panel update
 * per network read, with no deadline on the 6 of 12 streams that never answered, and again on every remount. Here
 * the real Cockpit runs against seven fake specialists whose streams this spec answers:
 *
 *   FIN_A  finished, large (about 2,300 events, 28 MB of cumulative reasoning deltas)
 *   FIN_B  finished, stalled: no response headers, ever (until Retry)
 *   FIN_C  finished, slow: headers after 4 s (under the 10 s deadline, so it must load)
 *   FIN_D, FIN_E  finished, small
 *   RUN    running; its first read fails (503), the next one works
 *   PARK   running and parked on a question (the parent shows it): its resume token is on its own stream
 */

const make = (o: Parameters<typeof specialistStream>[0]): string[] => specialistStream(o);
const ndjson = (lines: readonly string[]) => lines.map((l) => `${l}\n`).join("");

const STREAMS = {
  FIN_A: make({ seed: 11, steps: 3, reasoningChars: 24_000 }),
  FIN_B: make({ seed: 12, steps: 2, reasoningChars: 1_000 }),
  FIN_C: make({ seed: 13, steps: 2, reasoningChars: 1_000 }),
  FIN_D: make({ seed: 14, steps: 2, reasoningChars: 1_000 }),
  FIN_E: make({ seed: 15, steps: 2, reasoningChars: 1_000 }),
  RUN: make({ seed: 16, steps: 2, reasoningChars: 1_000, end: "running" }),
  PARK: make({ seed: 17, steps: 1, reasoningChars: 500, token: "eve:park-token" }),
};
type Sid = keyof typeof STREAMS;

interface Seen {
  readonly sid: Sid;
  readonly startIndex: number;
  readonly at: number;
  done: boolean;
}

/**
 * A real streaming answer for a specialist: its lines a couple at a time, a few milliseconds apart, the way the live
 * app delivered them (about one event per network read). `route.fulfill` hands the browser a body in one piece,
 * which hides the cost being measured.
 */
async function trickleServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const sid = decodeURIComponent(url.pathname.split("/")[4] ?? "").replace(/^wrun_/, "") as Sid;
    const lines = (STREAMS[sid] ?? []).slice(Number(url.searchParams.get("startIndex") ?? 0));
    res.writeHead(200, { "content-type": "application/x-ndjson", "x-eve-session-delegation": "1" });
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i >= lines.length) return; // a live tail: stays open
      res.write(ndjson(lines.slice(i, i + 2)));
      i += 2;
      setTimeout(tick, 2);
    };
    tick();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Answer every specialist stream as its row in the table above says, and record what was asked. */
async function fakeAgent(page: Page, trickle?: { origin: string; sids: readonly Sid[] }) {
  const seen: Seen[] = [];
  const t0 = Date.now();
  const hang = () => new Promise<void>(() => {});
  let stallFinB = true;
  await page.route(/\/api\/ops\//, (route) => route.fulfill({ status: 200, json: { ok: true, items: [], labels: {} } }));
  await page.route(/\/eve\/v1\/session\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    const sid = decodeURIComponent(parts[4] ?? "").replace(/^wrun_/, "") as Sid;
    if (route.request().method() !== "GET" || parts[5] !== "stream" || !(sid in STREAMS)) {
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    const startIndex = Number(url.searchParams.get("startIndex") ?? 0);
    const rec: Seen = { sid, startIndex, at: Date.now() - t0, done: false };
    seen.push(rec);
    const lines = STREAMS[sid].slice(startIndex);
    const send = async (delegated = "1") => {
      rec.done = true;
      await route
        .fulfill({ status: 200, headers: { "content-type": "application/x-ndjson", "x-eve-session-delegation": delegated }, body: ndjson(lines) })
        .catch(() => {});
    };
    // A live read past the end is the open tail of a running stream: it stays open.
    if (startIndex > 0 && lines.length === 0) return hang();
    if (trickle?.sids.includes(sid)) {
      rec.done = true;
      return route.continue({ url: `${trickle.origin}${url.pathname}${url.search}` }).catch(() => {});
    }
    switch (sid) {
      case "FIN_B":
        if (stallFinB) return hang();
        return send();
      case "FIN_C":
        await new Promise((r) => setTimeout(r, 4_000));
        return send();
      case "RUN":
        if (seen.filter((s) => s.sid === "RUN").length === 1) {
          rec.done = true;
          return route.fulfill({ status: 503, body: "busy" }).catch(() => {});
        }
        return send();
      default:
        return send();
    }
  });
  return {
    seen,
    finished: () => seen.filter((s) => s.sid.startsWith("FIN_")),
    unstallFinB: () => {
      stallFinB = false;
    },
  };
}

const rail = (page: Page) => page.getByTestId("rail");
/** The rail row of a specialist, by its position in the chat. */
const row = (page: Page, i: number) => rail(page).locator("li").filter({ has: page.locator("button") }).nth(i);
const ORDER: Sid[] = ["FIN_A", "FIN_B", "FIN_C", "FIN_D", "FIN_E", "RUN", "PARK"];
const rowOf = (page: Page, sid: Sid) => row(page, ORDER.indexOf(sid));

async function open(page: Page) {
  await page.goto("/preview/control-panel");
  await expect(rail(page).locator("li")).toHaveCount(7);
}

test("finished specialists wait for the conversation, a few at a time; running and parked ones attach at once, and the parked one can be steered", async ({ page }) => {
  test.setTimeout(90_000);
  const agent = await fakeAgent(page);
  await open(page);
  await page.waitForTimeout(2_000);
  expect(agent.finished(), "no finished specialist is read before the conversation is up").toHaveLength(0);
  expect(agent.seen.map((s) => s.sid)).toEqual(expect.arrayContaining(["RUN", "PARK"]));

  // The parked specialist is steerable before the chat is ready: its feed attached at once.
  await rowOf(page, "PARK").locator("button").first().click();
  const composer = rail(page).getByRole("textbox");
  await expect(composer).toBeVisible();
  await composer.fill("Use FY25");
  await composer.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__steers ?? [])).toEqual([{ callId: "call_park", text: "Use FY25" }]);
  await rail(page).getByTitle("Back to the Control Panel").click();

  await page.getByTestId("mark-ready").click();
  let most = 0;
  for (let i = 0; i < 40; i++) {
    most = Math.max(most, agent.finished().filter((s) => !s.done).length);
    await page.waitForTimeout(100);
  }
  expect(most, "at most 3 finished specialists are read at once").toBeLessThanOrEqual(3);
  for (const sid of ["FIN_A", "FIN_C", "FIN_D", "FIN_E"] as Sid[]) {
    await expect(rowOf(page, sid)).toContainText(sid === "FIN_A" ? "done · 3 calls" : "done · 2 calls", { timeout: 30_000 });
  }
});

test("the panel updates a bounded number of times while a large specialist is read", async ({ page }) => {
  test.setTimeout(90_000);
  const server = await trickleServer();
  await fakeAgent(page, { origin: server.origin, sids: ["FIN_A"] });
  await open(page);
  await page.getByTestId("mark-ready").click();
  await expect(rowOf(page, "FIN_A")).toContainText("done · 3 calls", { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  // Every render of the panel since the page loaded: its mount, the specialists attaching, and the reads.
  const renders = await page.evaluate(() => window.__cockpitRenders?.() ?? 0);
  console.log(`control panel renders while ${STREAMS.FIN_A.length} events (${(ndjson(STREAMS.FIN_A).length / 1e6).toFixed(1)} MB) and 6 more specialists were read: ${renders}`);
  await server.close();
  expect(renders, "the census sees the panel").toBeGreaterThan(0);
  // Before: about one render per network read (132 and 166 for half as many events). After: a flush per 250 ms, about
  // 50 to 60 here, counted twice by React's development double render; the bound leaves room for a loaded machine.
  expect(renders).toBeLessThanOrEqual(100);
});

test("a stalled specialist is shown unavailable after the deadline, with Retry, and Retry loads it", async ({ page }) => {
  test.setTimeout(90_000);
  const agent = await fakeAgent(page);
  await open(page);
  await page.getByTestId("mark-ready").click();
  // A slow one (4 s to headers) is not a stalled one.
  await expect(rowOf(page, "FIN_C")).toContainText("done · 2 calls", { timeout: 15_000 });
  await expect(rowOf(page, "FIN_B")).toContainText("details unavailable", { timeout: 30_000 });
  expect(agent.seen.filter((s) => s.sid === "FIN_B").length, "retried once before giving up").toBe(2);
  agent.unstallFinB();
  await rowOf(page, "FIN_B").getByRole("button", { name: "Retry" }).click();
  await expect(rowOf(page, "FIN_B")).toContainText("done · 2 calls", { timeout: 10_000 });
});

test("a running specialist whose read fails is retried, never shown as ended", async ({ page }) => {
  test.setTimeout(60_000);
  const agent = await fakeAgent(page);
  await open(page);
  await expect.poll(() => agent.seen.filter((s) => s.sid === "RUN").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(rowOf(page, "RUN")).toContainText("2 tool calls done · thinking…", { timeout: 10_000 });
  await rowOf(page, "RUN").locator("button").first().click();
  await expect(rail(page)).not.toContainText("predates live session tracking");
  await expect(rail(page).getByRole("button", { name: "Cancel run" })).toBeVisible();
});

test("a remount, and leaving for another chat and coming back, read nothing again for finished specialists", async ({ page }) => {
  test.setTimeout(90_000);
  const agent = await fakeAgent(page);
  await open(page);
  await page.getByTestId("mark-ready").click();
  for (const sid of ["FIN_A", "FIN_C", "FIN_D", "FIN_E"] as Sid[]) {
    await expect(rowOf(page, sid)).toContainText(/done · [23] calls/, { timeout: 60_000 });
  }
  const finished = () => agent.finished().filter((s) => s.sid !== "FIN_B").length;
  const settled = finished();

  await page.getByTestId("remount").click();
  await expect(rail(page).locator("li")).toHaveCount(7);
  await page.waitForTimeout(3_000);
  expect(finished(), "a remount makes no request for a finished specialist").toBe(settled);
  await expect(rowOf(page, "FIN_D")).toContainText("done · 2 calls");

  await page.getByTestId("switch-chat").click();
  await expect(page.getByTestId("other-chat")).toBeVisible();
  await page.waitForTimeout(2_000);
  await page.getByTestId("switch-chat").click();
  await expect(rail(page).locator("li")).toHaveCount(7);
  await page.waitForTimeout(3_000);
  expect(finished(), "leaving and coming back makes no request for a finished specialist").toBe(settled);
  await expect(rowOf(page, "FIN_A")).toContainText("done · 3 calls");
});
