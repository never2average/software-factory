import { expect, test, type Page, type Route } from "@playwright/test";
import { SNAPSHOT_VERSION, buildSnapshot } from "../lib/chat-snapshot";

/**
 * Reopening a chat, in the REAL chat shell (/preview/chat-open mounts app/_components/chat-shell.tsx), with every
 * request it makes answered here, on this test's timing:
 *
 *   1. a SLOW, EMPTY seam read leaves the painted chat untouched: no shimmer over it, the saved copy is not deleted,
 *      no full replay; the read is tried once more and the copy kept. (Before: the shimmer came back, the copy was
 *      deleted, and the conversation was replayed from event zero.)
 *   2. a click on chat B while chat A's saved copy is still on its way: B stays on screen. (Before: A landed on top of
 *      B when its copy arrived.)
 *   3. a seam the stream positively disagrees with: the transcript is replaced by the full replay, behind the painted
 *      chat, without the shimmer. (Before: the shimmer came back and the replay was fetched but never shown.)
 *   4. …and while the person is typing, the replacement waits for the draft rather than throwing it away.
 *   5. the chat being LEFT is unmounted while the next opens from the server, so its reads (the Control Panel's
 *      specialist streams among them) stop instead of competing under the shimmer;
 *   6. a long conversation lands at the bottom at once, not by scrolling through its history (/preview/scroll-open).
 *   7. a chat whose first turn is still running, held by this browser (no resume token yet), opens from this browser
 *      with no request for the saved copy or a replay, and its live reader resumes at the copy's absolute index.
 *      (Before: the saved copy, then a replay that read the running turn until it fell silent.)
 */

const EMAIL = "preview@example.test";
const CHATS_KEY = `workspace-chats:${EMAIL}:default`;
const LAST_KEY = `workspace-last-chat:${EMAIL}:default`;

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { ...data, sequence: seq++ },
  meta: { at: "2026-10-14T10:00:00.000Z" },
});

/** A parked conversation of `turns` question-and-answer turns, each answer naming `label`. */
function conversation(label: string, turns = 2): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [ev("session.started")];
  for (let i = 1; i <= turns; i++) {
    const turnId = `${label}-t${i}`;
    const text = `${label} answer ${i}.`;
    out.push(
      ev("turn.started", { turnId }),
      ev("message.received", { turnId, message: `${label} question ${i}` }),
      ev("step.started", { turnId, stepIndex: 0 }),
      ev("message.appended", { turnId, stepIndex: 0, messageDelta: text, messageSoFar: text }),
      ev("message.completed", { turnId, stepIndex: 0, message: text, finishReason: "stop" }),
      ev("step.completed", { turnId, stepIndex: 0 }),
      ev("turn.completed", { turnId }),
      ev("session.waiting", { continuationToken: `tok-${label}-${i}` }),
    );
  }
  return out;
}

const ndjson = (events: readonly unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const marker = (index: number) => ({ type: "ops.replay.end", data: { index, parked: true, done: false, drained: true } });

interface Chat {
  readonly id: string;
  readonly title: string;
  readonly sessionId: string;
  /** Held in this browser: a local open. Absent: the open goes to the server (the events were pruned for quota). */
  readonly local?: readonly unknown[];
  readonly streamIndex: number;
  /** No resume token stored (a first turn persisted while it was still running). */
  readonly noToken?: boolean;
}

/** Seed this browser's chat list before the page's own scripts run. */
async function seed(page: Page, chats: readonly Chat[], last?: string) {
  const list = chats.map((c, i) => ({
    id: c.id,
    clientKey: c.id,
    title: c.title,
    session: c.noToken
      ? { sessionId: c.sessionId, streamIndex: c.streamIndex }
      : { sessionId: c.sessionId, continuationToken: `tok-${c.id}`, streamIndex: c.streamIndex },
    ...(c.local ? { events: c.local } : {}),
    updatedAt: Date.now() - i * 1000,
  }));
  await page.addInitScript(
    ({ chatsKey, lastKey, list, last }) => {
      window.localStorage.setItem(chatsKey, JSON.stringify(list));
      if (last) window.localStorage.setItem(lastKey, last);
    },
    { chatsKey: CHATS_KEY, lastKey: LAST_KEY, list, last },
  );
}

/**
 * Watch the loading shimmer and the transcript from the first byte of the page: every time either appears or goes,
 * with the time. "The shimmer came back over a painted chat" is then a fact read off the log, not a sampled guess.
 */
async function watch(page: Page, paintedText: string) {
  await page.addInitScript((mark) => {
    const w = window as unknown as { __paneLog: { t: number; shimmer: boolean; painted: boolean }[] };
    w.__paneLog = [];
    let last = "";
    const look = () => {
      const shimmer = Boolean(document.querySelector('[aria-label="Loading conversation"]'));
      const painted = Boolean(document.body?.textContent?.includes(mark));
      const key = `${shimmer}|${painted}`;
      if (key !== last) {
        last = key;
        w.__paneLog.push({ t: performance.now(), shimmer, painted });
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  }, paintedText);
}

/** Did the shimmer show at any moment after the transcript had first been painted? */
async function shimmerAfterPaint(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const log = (window as unknown as { __paneLog: { shimmer: boolean; painted: boolean }[] }).__paneLog;
    const first = log.findIndex((e) => e.painted && !e.shimmer);
    return first >= 0 && log.slice(first + 1).some((e) => e.shimmer);
  });
}

interface Calls {
  snapshotGets: string[];
  deletes: string[];
  seamReads: number;
  fullReplays: number;
  replayReads: { session: string; start: number }[];
}

/**
 * Answer the shell's requests. `snapshot` and `replay` decide the body and the delay for each; the chat list's server
 * copy is unavailable (so the seeded list stands), and everything else the page asks for is refused.
 */
async function serve(
  page: Page,
  opts: {
    snapshot: (session: string) => { body: unknown; delayMs?: number } | null;
    replay: (session: string, start: number) => { body: string; delayMs?: number };
  },
): Promise<Calls> {
  const calls: Calls = { snapshotGets: [], deletes: [], seamReads: 0, fullReplays: 0, replayReads: [] };
  const later = async (ms: number | undefined, fn: () => Promise<void>) => {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    try {
      await fn();
    } catch {
      /* the page cancelled the request meanwhile: that is a result, not an error */
    }
  };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/api/ops/chat-sessions" && req.method() === "GET") {
      return route.fulfill({ status: 503, json: { error: "unavailable in this test" } });
    }
    if (path === "/api/ops/chat-snapshots") {
      const session = url.searchParams.get("session") ?? "";
      if (req.method() === "DELETE") {
        calls.deletes.push(session);
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      if (req.method() === "GET") {
        calls.snapshotGets.push(session);
        const answer = opts.snapshot(session);
        return later(answer?.delayMs, () => route.fulfill({ status: 200, json: { snapshot: answer?.body ?? null } }));
      }
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (path === "/api/ops/chat-replay") {
      const session = url.searchParams.get("session") ?? "";
      const start = Number(url.searchParams.get("startIndex") ?? "0");
      calls.replayReads.push({ session, start });
      if (start === 0) calls.fullReplays += 1;
      else calls.seamReads += 1;
      const answer = opts.replay(session, start);
      return later(answer.delayMs, () =>
        route.fulfill({ status: 200, contentType: "application/x-ndjson", body: answer.body }),
      );
    }
    if (path === "/api/ops/me/workspaces") {
      return route.fulfill({ status: 200, json: { memberships: [], invites: [], active: null } });
    }
    // Everything else the page reaches for (the account list, notifications, presence, the agent's warm-up) is
    // not this test's business: refused, which every caller handles as "not available".
    return route.fulfill({ status: 404, json: { error: "not in this test" } });
  });
  return calls;
}

const lastOpen = (page: Page) =>
  page.evaluate(() => {
    const opens = (window as unknown as { __chatOpens?: Record<string, unknown>[] }).__chatOpens ?? [];
    return JSON.parse(JSON.stringify(opens.at(-1) ?? null)) as Record<string, unknown> | null;
  });

test.describe("reopening a chat", () => {
  test.describe.configure({ timeout: 90_000 });

  test("a slow, empty seam read leaves the painted chat untouched", async ({ page }) => {
    const SAVED = conversation("Saved");
    const N = SAVED.length;
    const snapshot = { ...buildSnapshot({ eveSessionId: "sess-a", streamIndex: N, events: SAVED })!, version: SNAPSHOT_VERSION };
    await seed(page, [{ id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: N }], "chat-a");
    await watch(page, "Saved answer 2.");
    const calls = await serve(page, {
      snapshot: () => ({ body: snapshot }),
      // The seam read is slow and comes back with the end marker alone: the race the live reads lost.
      replay: (_s, start) =>
        start === 0
          ? { body: ndjson([...conversation("Replayed"), marker(99)]) }
          : { body: ndjson([marker(start)]), delayMs: 1_500 },
    });

    await page.goto("/preview/chat-open");
    await expect(page.getByText("Saved answer 2.")).toBeVisible({ timeout: 60_000 });
    // Both seam reads (the first and the background retry) have been answered.
    await expect.poll(() => calls.seamReads, { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(1_500);

    expect(await shimmerAfterPaint(page), "the shimmer came back over the painted chat").toBe(false);
    expect(calls.deletes, "the saved copy was deleted").toEqual([]);
    expect(calls.fullReplays, "the conversation was replayed from event zero").toBe(0);
    await expect(page.getByText("Saved answer 2.")).toBeVisible();
    await expect(page.getByText("Replayed answer 2.")).toHaveCount(0);

    const open = await lastOpen(page);
    expect(open?.route).toBe("snapshot");
    expect(open?.seam).toBe("empty");
    expect(open?.seamReads).toBe(2);
    expect(open?.shimmerReturned).toBe(false);
    expect(typeof open?.paintMs).toBe("number");
  });

  test("a click on another chat wins over a slow open of the first", async ({ page }) => {
    const ALPHA = conversation("Alpha");
    const BRAVO = conversation("Bravo");
    const snapshotA = { ...buildSnapshot({ eveSessionId: "sess-a", streamIndex: ALPHA.length, events: ALPHA })!, version: SNAPSHOT_VERSION };
    await seed(page, [
      { id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: ALPHA.length },
      { id: "chat-b", title: "Bravo chat", sessionId: "sess-b", streamIndex: BRAVO.length, local: BRAVO },
    ]);
    const failed: string[] = [];
    page.on("requestfailed", (r) => failed.push(new URL(r.url()).pathname));
    const calls = await serve(page, {
      // Alpha's saved copy takes 2.5 s.
      snapshot: (s) => (s === "sess-a" ? { body: snapshotA, delayMs: 2_500 } : null),
      replay: (_s, start) => ({ body: ndjson([marker(start)]) }),
    });

    await page.goto("/preview/chat-open");
    await page.getByRole("button", { name: /Alpha chat/ }).click({ timeout: 60_000 });
    await expect.poll(() => calls.snapshotGets.length, { timeout: 15_000 }).toBe(1);
    await page.getByRole("button", { name: /Bravo chat/ }).click();
    await expect(page.getByText("Bravo answer 2.")).toBeVisible();
    // Long enough for Alpha's saved copy to have landed, if anything were still listening for it.
    await page.waitForTimeout(4_000);

    await expect(page.getByText("Bravo answer 2.")).toBeVisible();
    await expect(page.getByText("Alpha answer 2.")).toHaveCount(0);
    expect(calls.replayReads.filter((r) => r.session === "sess-a"), "the abandoned open read its seam").toEqual([]);
    const open = await lastOpen(page);
    expect(open?.chatId).toBe("chat-b");
    expect(open?.route).toBe("local");
  });

  test("the chat being left stops (it is unmounted) while the next one opens from the server", async ({ page }) => {
    const ALPHA = conversation("Alpha");
    const BRAVO = conversation("Bravo");
    const snapshotA = { ...buildSnapshot({ eveSessionId: "sess-a", streamIndex: ALPHA.length, events: ALPHA })!, version: SNAPSHOT_VERSION };
    // Bravo is on screen (this browser holds it); Alpha has to come from the server, slowly.
    await seed(
      page,
      [
        { id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: ALPHA.length },
        { id: "chat-b", title: "Bravo chat", sessionId: "sess-b", streamIndex: BRAVO.length, local: BRAVO },
      ],
      "chat-b",
    );
    await serve(page, {
      snapshot: (s) => (s === "sess-a" ? { body: snapshotA, delayMs: 3_000 } : null),
      replay: (_s, start) => ({ body: ndjson([marker(start)]) }),
    });
    await page.goto("/preview/chat-open");
    await expect(page.getByText("Bravo answer 2.")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /Alpha chat/ }).click();
    // While Alpha's saved copy is on its way, Bravo is gone from the page, not just covered by the shimmer.
    await expect(page.getByLabel("Loading conversation")).toBeVisible();
    await expect(page.getByText("Bravo answer 2.")).toHaveCount(0, { timeout: 1_000 });
    await expect(page.getByText("Alpha answer 2.")).toBeVisible({ timeout: 15_000 });
  });

  test("a seam the stream disagrees with is replaced behind the painted chat, without the shimmer", async ({ page }) => {
    const SAVED = conversation("Saved");
    const N = SAVED.length;
    const REPLAYED = conversation("Replayed", 3);
    const snapshot = { ...buildSnapshot({ eveSessionId: "sess-a", streamIndex: N, events: SAVED })!, version: SNAPSHOT_VERSION };
    await seed(page, [{ id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: N }], "chat-a");
    await watch(page, "Saved answer 2.");
    const calls = await serve(page, {
      snapshot: () => ({ body: snapshot }),
      replay: (_s, start) =>
        start === 0
          ? { body: ndjson([...REPLAYED, marker(REPLAYED.length)]), delayMs: 800 }
          : // A different event where the saved copy ends: positive evidence the copy is not this stream's.
            { body: ndjson([ev("session.started", { other: true }), marker(start + 1)]) },
    });

    await page.goto("/preview/chat-open");
    await expect(page.getByText("Saved answer 2.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Replayed answer 3.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Saved answer 2.")).toHaveCount(0);

    expect(await shimmerAfterPaint(page), "the shimmer came back over the painted chat").toBe(false);
    expect(calls.deletes).toEqual(["sess-a"]);
    expect(calls.fullReplays).toBe(1);
    const open = await lastOpen(page);
    expect(open?.route).toBe("snapshot-discarded");
    expect(open?.seam).toBe("mismatch");
    expect(open?.mountCauses).toEqual(["open", "seam-replace"]);
  });

  test("…and waits for a draft in the composer rather than throwing it away", async ({ page }) => {
    const SAVED = conversation("Saved");
    const N = SAVED.length;
    const REPLAYED = conversation("Replayed", 3);
    const snapshot = { ...buildSnapshot({ eveSessionId: "sess-a", streamIndex: N, events: SAVED })!, version: SNAPSHOT_VERSION };
    await seed(page, [{ id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: N }], "chat-a");
    const calls = await serve(page, {
      snapshot: () => ({ body: snapshot }),
      replay: (_s, start) =>
        start === 0
          ? { body: ndjson([...REPLAYED, marker(REPLAYED.length)]), delayMs: 2_500 }
          : { body: ndjson([ev("session.started", { other: true }), marker(start + 1)]), delayMs: 300 },
    });

    await page.goto("/preview/chat-open");
    await expect(page.getByText("Saved answer 2.")).toBeVisible({ timeout: 60_000 });
    const composer = page.locator('textarea[name="message"]');
    await composer.fill("a draft I am still writing");
    await expect.poll(() => calls.fullReplays, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(4_000);
    // The replacement is ready, and it waits: the draft and the chat under it are as they were.
    await expect(composer).toHaveValue("a draft I am still writing");
    await expect(page.getByText("Saved answer 2.")).toBeVisible();

    await composer.fill("");
    await expect(page.getByText("Replayed answer 3.")).toBeVisible({ timeout: 10_000 });
  });

  test("a running chat this browser holds opens from it, with no request, and resumes at its own index", async ({ page }) => {
    // Alpha's FIRST turn is still running: no park yet, so no resume token; this browser persisted it a moment ago.
    const turnId = "alpha-t1";
    const RUNNING = [
      ev("session.started"),
      ev("turn.started", { turnId }),
      ev("message.received", { turnId, message: "Alpha question 1" }),
      ev("step.started", { turnId, stepIndex: 0 }),
      ev("message.appended", { turnId, stepIndex: 0, messageDelta: "Alpha is still ", messageSoFar: "Alpha is still " }),
      ev("message.appended", { turnId, stepIndex: 0, messageDelta: "writing.", messageSoFar: "Alpha is still writing." }),
    ];
    const BRAVO = conversation("Bravo");
    await seed(
      page,
      [
        { id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: 0, local: RUNNING, noToken: true },
        { id: "chat-b", title: "Bravo chat", sessionId: "sess-b", streamIndex: BRAVO.length, local: BRAVO },
      ],
      "chat-b",
    );
    const calls = await serve(page, {
      snapshot: () => null,
      replay: (_s, start) => ({ body: ndjson([...RUNNING.slice(start), marker(RUNNING.length)]) }),
    });
    const liveReads: { session: string; start: number }[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      const m = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(url.pathname);
      if (m) liveReads.push({ session: decodeURIComponent(m[1]), start: Number(url.searchParams.get("startIndex") ?? "-1") });
    });

    await page.goto("/preview/chat-open");
    await expect(page.getByText("Bravo answer 2.")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /Alpha chat/ }).click();
    await expect(page.getByText("Alpha is still writing.")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_500);

    expect(calls.snapshotGets, "asked the server for a saved copy").toEqual([]);
    expect(calls.replayReads, "replayed the running turn from the server").toEqual([]);
    const open = await lastOpen(page);
    expect(open?.chatId).toBe("chat-a");
    expect(open?.route).toBe("running");
    // The chat's own live reader carries the turn on, from exactly where this browser's copy ends.
    await expect.poll(() => liveReads.filter((r) => r.session === "sess-a").length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(liveReads.filter((r) => r.session === "sess-a")[0].start).toBe(RUNNING.length);
  });

  test("a long conversation opens at the bottom, without scrolling through its history", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __scroll: { top: number; max: number }[] };
      w.__scroll = [];
      const tick = () => {
        const el = document.querySelector('[role="log"] > div') as HTMLElement | null;
        if (el) w.__scroll.push({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight });
        if (w.__scroll.length < 300) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto("/preview/scroll-open");
    await expect(page.getByTestId("last-turn")).toBeAttached({ timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __scroll: unknown[] }).__scroll.length), { timeout: 20_000 }).toBeGreaterThan(150);
    const samples = await page.evaluate(() => (window as unknown as { __scroll: { top: number; max: number }[] }).__scroll);

    const first = samples.findIndex((s) => s.max > 20_000);
    const frames = samples
      .slice(Math.max(0, first - 2), first + 12)
      .map((s) => `${Math.round(s.top)}/${Math.round(s.max)}`)
      .join(" ");
    expect(first, "the transcript is taller than 20,000 px").toBeGreaterThanOrEqual(0);
    const settled = samples[Math.min(first + 2, samples.length - 1)];
    expect(settled.max - settled.top, `within 70 px of the bottom two frames after it is painted; frames (top/max): ${frames}`).toBeLessThanOrEqual(70);
    const between = samples.slice(first).filter((s) => s.top > 0 && s.max - s.top > 70);
    expect(between.length, `frames spent part-way down: ${between.length}; frames (top/max): ${frames}`).toBe(0);
    await expect(page.getByTestId("last-turn")).toBeInViewport();
  });
});
