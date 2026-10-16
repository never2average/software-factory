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
 *
 * The last test keeps SAVED COPIES (lib/child-copy.ts) in a store this spec plays for /api/ops/chat-snapshots
 * (`kind=child`), across a page reload: the second load shows each specialist's details from its copy, timed in the
 * page, and reads no specialist's stream from event 0.
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

test("a specialist whose transcript is still loading keeps its name and status, and the transcript's place shimmers (mold_v1-269)", async ({ page }) => {
  test.setTimeout(60_000);
  await fakeAgent(page);
  await open(page);
  // FIN_B's stream never answers (until Retry), so its transcript stays loading for as long as this test looks.
  await rowOf(page, "FIN_B").locator("button").first().click();
  const loading = rail(page).getByRole("status", { name: "Loading transcript" });
  await expect(loading).toBeVisible();
  // What is known stays: the specialist's name in the header, beside its status, and the brief it was given.
  await expect(rail(page).getByTitle("Back to the Control Panel").first()).toContainText("Research/");
  await expect(rail(page).getByText("Done", { exact: true })).toBeVisible();
  await expect(rail(page)).toContainText("BRIEF for call_fin_b");
  // What is not: transcript-shaped blocks, never the raw result text, and no bare "Loading…" sentence.
  expect(await loading.locator("[data-skeleton]").count()).toBeGreaterThanOrEqual(6);
  await expect(rail(page)).not.toContainText("B done");
  await expect(rail(page)).not.toContainText("Loading transcript…");
  const animation = () => loading.locator("[data-skeleton]").first().evaluate((el) => getComputedStyle(el).animationName);
  expect(await animation()).toBe("shimmer-sweep");
  // Under reduced motion the shimmer stands still: a muted block.
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation()).toBe("none");
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

test("a saved copy per specialist: on the second page load the details are there from the copy (goal 0.5 s, measured), and no stream is read from event 0", async ({ page }) => {
  test.setTimeout(150_000);
  const agent = await fakeAgent(page);
  // The copy store, as the route keeps it (never backwards), across both page loads.
  const copies = new Map<string, { cursor: number }>();
  const copyReads: { sid: string; at: number }[] = [];
  await page.route(/\/api\/ops\/chat-snapshots/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "POST" ? (request.postDataJSON() as { kind?: string; sessionId: string; cursor: number }) : null;
    const child = url.searchParams.get("kind") === "child" || body?.kind === "child";
    if (!child) return route.fulfill({ status: 200, json: { snapshot: null } });
    const sid = url.searchParams.get("session") ?? body?.sessionId ?? "";
    if (request.method() === "GET") {
      copyReads.push({ sid, at: Date.now() });
      return route.fulfill({ status: 200, json: { copy: copies.get(sid) ?? null } });
    }
    if (request.method() === "DELETE") {
      copies.delete(sid);
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    const prev = copies.get(sid);
    if (body && prev && prev.cursor > body.cursor) return route.fulfill({ status: 409, json: { ok: false, reason: "older" } });
    if (body) copies.set(sid, body);
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  // In the page, from the first moment: when the rail's seven rows appear, and when each row first shows its details.
  const DETAILS: Partial<Record<Sid, string>> = { FIN_A: "done · 3 calls", FIN_C: "done · 2 calls", FIN_D: "done · 2 calls", FIN_E: "done · 2 calls" };
  await page.addInitScript(
    ({ order, details }) => {
      const w = window as unknown as { __copyTimes: { rows: number | null; details: Record<string, number> } };
      w.__copyTimes = { rows: null, details: {} };
      const tick = () => {
        const rail = document.querySelector('[data-testid="rail"]');
        if (!rail) return;
        const rows = [...rail.querySelectorAll("li")].filter((li) => li.querySelector("button"));
        if (rows.length >= order.length && w.__copyTimes.rows === null) w.__copyTimes.rows = performance.now();
        rows.forEach((li, i) => {
          const want = details[order[i]];
          if (want && w.__copyTimes.details[order[i]] === undefined && (li.textContent ?? "").includes(want)) {
            w.__copyTimes.details[order[i]] = performance.now();
          }
        });
      };
      new MutationObserver(tick).observe(document, { subtree: true, childList: true, characterData: true });
    },
    { order: ORDER as string[], details: DETAILS as Record<string, string> },
  );

  // First load: today's harvest, which reads each finished specialist from 0 and stores its copy at its boundary.
  await open(page);
  await page.getByTestId("mark-ready").click();
  for (const sid of Object.keys(DETAILS) as Sid[]) await expect(rowOf(page, sid)).toContainText(DETAILS[sid] as string, { timeout: 60_000 });
  const copied: Sid[] = ["FIN_A", "FIN_C", "FIN_D", "FIN_E", "PARK"];
  await expect.poll(() => copied.filter((sid) => copies.has(`wrun_${sid}`)).length, { timeout: 15_000 }).toBe(copied.length);
  const firstLoad = agent.seen.length;
  expect(agent.seen.filter((s) => copied.includes(s.sid) && s.startIndex === 0).length, "the first load read each from 0, once").toBe(copied.length);
  console.log(`saved copies after the first load: ${copied.map((sid) => `${sid} ${JSON.stringify(copies.get(`wrun_${sid}`)).length} B (stream ${ndjson(STREAMS[sid]).length} B)`).join(", ")}`);

  // Second load: a reload of the page.
  await page.reload();
  await expect(rail(page).locator("li")).toHaveCount(7);
  for (const sid of Object.keys(DETAILS) as Sid[]) await expect(rowOf(page, sid)).toContainText(DETAILS[sid] as string, { timeout: 5_000 });
  const times = await page.evaluate(() => (window as unknown as { __copyTimes: { rows: number; details: Record<string, number> } }).__copyTimes);
  // The panel's own start: the moment its feeds were first asked for (its mount, once the page's script has
  // hydrated the server-rendered rows; in `next dev` that hydration alone is about a second, and is not the panel's).
  const asked = await page.evaluate(() =>
    Math.min(...performance.getEntriesByType("resource").filter((r) => /\/api\/ops\/chat-snapshots\?kind=child/.test(r.name)).map((r) => r.startTime)),
  );
  const sinceMount = Object.fromEntries(Object.entries(times.details).map(([sid, t]) => [sid, Math.round(t - asked)]));
  const sinceRows = Object.fromEntries(Object.entries(times.details).map(([sid, t]) => [sid, Math.round(t - times.rows)]));
  console.log(`second load, each specialist's details (ms) after the panel mounted: ${JSON.stringify(sinceMount)}; after the server-rendered rows painted: ${JSON.stringify(sinceRows)}`);
  expect(Number.isFinite(asked), "the panel asked for its saved copies").toBe(true);
  // THE GOAL is 0.5 s from the panel's mount, and the line above prints the measured figure on every run (109-675 ms
  // on a busy 8 GB machine running five checkouts). The ASSERTION is 2 s, deliberately: on a loaded CI runner `next
  // dev` and the browser can stall for hundreds of ms on their own, and a timing bound set at the goal fails for the
  // machine, not the code. What 2 s still separates is the thing that matters: without a copy the details come only
  // from a full read, which never starts before the chat is ready (asserted below) and then takes 13.6 s to over
  // 85 s live. The robust half of the claim is structural: zero reads from event 0, asserted below.
  console.log(`goal 0.5 s from mount: ${Object.values(sinceMount).every((ms) => ms < 500) ? "met" : "missed"} on this run`);
  for (const sid of Object.keys(DETAILS)) expect(sinceMount[sid], `${sid}: details within 2 s of the panel's mount (goal 0.5 s)`).toBeLessThan(2_000);
  // …before the conversation is up (the harvest has not even started), and from the copy alone.
  const second = agent.seen.slice(firstLoad);
  // FIN_B (stalled, so never copied) is left out: the FIRST page's one retry of it lands 10 s after its first request,
  // which on a fast run is after the snapshot above was taken.
  expect(second.filter((s) => s.sid.startsWith("FIN_") && s.sid !== "FIN_B"), "no finished specialist's stream read before the chat is ready").toHaveLength(0);
  expect(second.filter((s) => s.sid === "PARK").map((s) => s.startIndex), "the parked one reads from its stored index").toEqual([STREAMS.PARK.length - 1]);

  await page.getByTestId("mark-ready").click();
  await expect.poll(() => agent.seen.slice(firstLoad).filter((s) => s.sid.startsWith("FIN_") && s.sid !== "FIN_B").length, { timeout: 15_000 }).toBe(4);
  await page.waitForTimeout(2_000);
  const reads = agent.seen.slice(firstLoad).filter((s) => copied.includes(s.sid));
  expect(reads.filter((s) => s.startIndex === 0), "ZERO reads from event 0 for a specialist with a copy").toHaveLength(0);
  expect(reads.every((s) => s.startIndex === STREAMS[s.sid].length - 1), "each reads one event: the seam at its cursor - 1").toBe(true);
  for (const sid of Object.keys(DETAILS) as Sid[]) await expect(rowOf(page, sid)).toContainText(DETAILS[sid] as string);
  // The parked one can still be steered: its resume token came back from the seam read.
  await rowOf(page, "PARK").locator("button").first().click();
  await expect(rail(page).getByRole("textbox")).toBeVisible();
});
