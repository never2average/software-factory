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
    /**
     * `after`: the answer is held until it settles, so it arrives after something the test does, however slow the
     * machine. A fixed delay is a race against the page: on a busy box (a `next dev` rebuild mid-test) a click the
     * test made inside the delay reached the page after it (mold_v1-292).
     */
    snapshot: (session: string) => { body: unknown; delayMs?: number; after?: Promise<unknown> } | null;
    replay: (session: string, start: number) => { body: string; delayMs?: number };
  },
): Promise<Calls> {
  const calls: Calls = { snapshotGets: [], deletes: [], seamReads: 0, fullReplays: 0, replayReads: [] };
  const later = async (ms: number | undefined, fn: () => Promise<void>, after?: Promise<unknown>) => {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (after) await after;
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
        return later(answer?.delayMs, () => route.fulfill({ status: 200, json: { snapshot: answer?.body ?? null } }), answer?.after);
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
    // Alpha's saved copy takes 2.5 s, and is held until Bravo is on screen: the click on Bravo always comes while it is
    // on its way. With the 2.5 s alone, a click the page handled late (a `next dev` rebuild mid-test) let Alpha's open
    // finish first, legitimately, and read its seam (mold_v1-292).
    let bravoShown = () => {};
    const bravoOnScreen = new Promise<void>((r) => (bravoShown = r));
    const calls = await serve(page, {
      snapshot: (s) => (s === "sess-a" ? { body: snapshotA, delayMs: 2_500, after: bravoOnScreen } : null),
      replay: (_s, start) => ({ body: ndjson([marker(start)]) }),
    });

    await page.goto("/preview/chat-open");
    await page.getByRole("button", { name: /Alpha chat/ }).click({ timeout: 60_000 });
    await expect.poll(() => calls.snapshotGets.length, { timeout: 15_000 }).toBe(1);
    await page.getByRole("button", { name: /Bravo chat/ }).click();
    await expect(page.getByText("Bravo answer 2.")).toBeVisible();
    bravoShown();
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
    // Alpha's saved copy takes 3 s, and is held until the test has seen Bravo gone under the shimmer (the same race as
    // above: a late-handled click must not let the copy land first).
    let leftSeen = () => {};
    const left = new Promise<void>((r) => (leftSeen = r));
    await serve(page, {
      snapshot: (s) => (s === "sess-a" ? { body: snapshotA, delayMs: 3_000, after: left } : null),
      replay: (_s, start) => ({ body: ndjson([marker(start)]) }),
    });
    await page.goto("/preview/chat-open");
    await expect(page.getByText("Bravo answer 2.")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /Alpha chat/ }).click();
    // While Alpha's saved copy is on its way, Bravo is gone from the page, not just covered by the shimmer.
    await expect(page.getByLabel("Loading conversation")).toBeVisible();
    await expect(page.getByText("Bravo answer 2.")).toHaveCount(0, { timeout: 1_000 });
    leftSeen();
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

/**
 * THE CHAT'S CUES IN THE REAL SHELL (mold_v1-287..290), every request answered here:
 *
 *   287  a turn that ends while the chat is on screen shows the completed mark and is announced; a chat LEFT while its
 *        turn runs is marked done in the chat list when it finishes, until it is opened;
 *   288  in a shared chat, another person's typing shows beside the composer and goes when it stops; your own keystrokes
 *        send a typing beat about once a second;
 *   289  an approval still open sits at the bottom, beside the composer, below the conversation; an answered one is a
 *        one-line row in the thread;
 *   290  a participant who is not the chat's author can send while someone else's message runs: the composer stays
 *        open, both messages go to the chat's queue (never dropped, never refused), and the queue is run when free.
 */
test.describe("the chat's cues", () => {
  test.describe.configure({ timeout: 90_000 });

  const RUNNING_TURN = "alpha-t1";
  const running = () => [
    ev("session.started"),
    ev("turn.started", { turnId: RUNNING_TURN }),
    ev("message.received", { turnId: RUNNING_TURN, message: "Alpha question 1" }),
    ev("step.started", { turnId: RUNNING_TURN, stepIndex: 0 }),
    ev("message.appended", { turnId: RUNNING_TURN, stepIndex: 0, messageDelta: "Alpha is still ", messageSoFar: "Alpha is still " }),
    ev("message.appended", { turnId: RUNNING_TURN, stepIndex: 0, messageDelta: "writing.", messageSoFar: "Alpha is still writing." }),
  ];
  const rest = () => [
    ev("message.completed", { turnId: RUNNING_TURN, stepIndex: 0, message: "Alpha is still writing. Done now.", finishReason: "stop" }),
    ev("step.completed", { turnId: RUNNING_TURN, stepIndex: 0 }),
    ev("turn.completed", { turnId: RUNNING_TURN }),
    ev("session.waiting", { continuationToken: "tok-alpha-done" }),
  ];

  test("287: a turn that finishes on screen shows the completed mark and is announced", async ({ page }) => {
    const RUNNING = running();
    await seed(page, [{ id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: 0, local: RUNNING, noToken: true }], "chat-a");
    await serve(page, { snapshot: () => null, replay: (_s, start) => ({ body: ndjson([...RUNNING.slice(start), marker(RUNNING.length)]) }) });
    // The chat's live reader resumes where this browser's copy ends, and the turn finishes.
    await page.route(/\/eve\/v1\/session\/sess-a\/stream/, (route) =>
      route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson(rest()) }),
    );
    await page.goto("/preview/chat-open");
    await expect(page.getByText("Done now.")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-completion-cue]")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-completion-announcer]")).toHaveText("Reply completed");
    // Brief: it goes again.
    await expect(page.locator("[data-completion-cue]")).toHaveCount(0, { timeout: 10_000 });
  });

  for (const end of ["done", "needs-you"] as const) {
    test(`287: a chat left while its turn runs is marked "${end}" in the list when it comes to rest, until opened`, async ({ page }) => {
      const RUNNING = running();
      const BRAVO = conversation("Bravo");
      // How the turn comes to rest: with an answer, or stopped on an approval (which must never read as "done").
      const ending =
        end === "done"
          ? rest()
          : [
              ev("input.requested", { turnId: RUNNING_TURN, requests: [{ requestId: "req-a", prompt: "Run it?", display: "confirmation", options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }], action: { kind: "tool-call", callId: "call-a", toolName: "write_file", input: {} } }] }),
              ev("turn.completed", { turnId: RUNNING_TURN }),
              ev("session.waiting", { continuationToken: "tok-alpha-parked" }),
            ];
      await seed(
        page,
        [
          { id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: 0, local: RUNNING, noToken: true },
          { id: "chat-b", title: "Bravo chat", sessionId: "sess-b", streamIndex: BRAVO.length, local: BRAVO },
        ],
        "chat-a",
      );
      await serve(page, { snapshot: () => null, replay: (_s, start) => ({ body: ndjson([...RUNNING.slice(start), marker(RUNNING.length)]) }) });
      let finished = false;
      let tailReads = 0;
      await page.route(/\/eve\/v1\/session\/sess-a\/stream/, (route) => {
        const start = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
        if (start < 0) {
          tailReads += 1;
          // Still writing for the first reads after the person leaves; then the turn rests.
          const all = finished ? [...RUNNING, ...ending] : RUNNING;
          return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson(all.slice(start)) });
        }
        // The live reader of the open chat: as in the test above, refused — the turn is still going, unseen.
        return route.fallback();
      });
      await page.goto("/preview/chat-open");
      await expect(page.getByText("Alpha is still writing.")).toBeVisible({ timeout: 60_000 });
      const title = await page.title();
      // The row is titled by the chat's first message once it has been opened.
      const alphaRow = page.getByRole("button", { name: /Alpha (chat|question 1)/ });
      await page.getByRole("button", { name: /Bravo chat/ }).click();
      await expect(page.getByText("Bravo answer 2.")).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => tailReads, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect(alphaRow.locator("[data-chat-ended]")).toHaveCount(0);
      // The person is elsewhere when it comes to rest.
      await page.evaluate(() => Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true }));
      finished = true;
      const marker_ = alphaRow.locator("[data-chat-ended]");
      await expect(marker_).toHaveAttribute("data-chat-ended", end, { timeout: 15_000 });
      await expect(marker_).toHaveText(end === "done" ? "Done" : "Needs you");
      // The tab's ✓ is for an answer only.
      expect(await page.title()).toBe(end === "done" ? `✓ ${title}` : title);
      await alphaRow.click();
      await expect(page.locator("[data-chat-ended]")).toHaveCount(0);
    });
  }

  test("289: an open approval sits at the bottom beside the composer; an answered one is one line in the thread", async ({ page }) => {
    const approval = (requestId: string, callId: string, turnId: string) =>
      ev("input.requested", {
        turnId,
        requests: [
          {
            requestId,
            prompt: `Run ${callId}?`,
            display: "confirmation",
            allowFreeform: false,
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            action: { kind: "tool-call", callId, toolName: "write_file", input: { path: `${callId}.md` } },
          },
        ],
      });
    const call = (callId: string, turnId: string) =>
      ev("actions.requested", { turnId, stepIndex: 0, actions: [{ kind: "tool-call", callId, toolName: "write_file", input: { path: `${callId}.md` } }] });
    const EVENTS = [
      ev("session.started"),
      ev("turn.started", { turnId: "t1" }),
      ev("message.received", { turnId: "t1", message: "Write the first file" }),
      ev("step.started", { turnId: "t1", stepIndex: 0 }),
      call("call-one", "t1"),
      ev("step.completed", { turnId: "t1", stepIndex: 0, finishReason: "tool-calls" }),
      approval("req-one", "call-one", "t1"),
      ev("turn.completed", { turnId: "t1" }),
      ev("session.waiting", { continuationToken: "tok-1" }),
      ev("turn.started", { turnId: "t2" }),
      ev("step.started", { turnId: "t2", stepIndex: 0 }),
      ev("action.result", { turnId: "t2", stepIndex: 0, status: "completed", result: { kind: "tool-result", callId: "call-one", toolName: "write_file", output: "ok" } }),
      ev("message.completed", { turnId: "t2", stepIndex: 0, message: "First file written.", finishReason: "stop" }),
      ev("step.completed", { turnId: "t2", stepIndex: 0 }),
      ev("turn.completed", { turnId: "t2" }),
      ev("session.waiting", { continuationToken: "tok-2" }),
      ev("turn.started", { turnId: "t3" }),
      ev("message.received", { turnId: "t3", message: "Now the second" }),
      ev("step.started", { turnId: "t3", stepIndex: 0 }),
      call("call-two", "t3"),
      ev("step.completed", { turnId: "t3", stepIndex: 0, finishReason: "tool-calls" }),
      approval("req-two", "call-two", "t3"),
      ev("turn.completed", { turnId: "t3" }),
      ev("session.waiting", { continuationToken: "tok-3" }),
    ];
    const answered = { type: "client.input.responded", data: { responses: [{ requestId: "req-one", optionId: "approve" }] } };
    await seed(page, [{ id: "chat-a", title: "Alpha chat", sessionId: "sess-a", streamIndex: EVENTS.length, local: [...EVENTS, answered] }], "chat-a");
    await serve(page, { snapshot: () => null, replay: (_s, start) => ({ body: ndjson([...EVENTS.slice(start), marker(EVENTS.length)]) }) });
    await page.goto("/preview/chat-open");
    await expect(page.getByText("First file written.")).toBeVisible({ timeout: 60_000 });

    const dock = page.locator("[data-pending-approvals]");
    await expect(dock).toBeVisible();
    await expect(dock.getByText("Run call-two?")).toBeVisible();
    await expect(dock.getByRole("button", { name: "Yes" })).toBeEnabled();
    // Below the conversation, above the message box — not in the scrolling thread.
    expect(await dock.evaluate((el) => Boolean(el.closest('[role="log"]')))).toBe(false);
    const dockBox = await dock.boundingBox();
    const logBox = await page.locator('[role="log"]').boundingBox();
    const boxBox = await page.locator('textarea[name="message"]').boundingBox();
    expect(dockBox && logBox && dockBox.y >= logBox.y + logBox.height - 1, "the stack is below the thread").toBe(true);
    expect(dockBox && boxBox && dockBox.y + dockBox.height <= boxBox.y + 1, "and above the message box").toBe(true);
    // The answered one is not in the stack: it is one line in the thread, with its outcome, opening on click.
    await expect(dock.getByText("Run call-one?")).toHaveCount(0);
    const record = page.locator('[role="log"] [data-answered-approval="allowed"]');
    await expect(record).toHaveCount(1);
    await expect(record).toContainText("Allowed");
    await expect(record).toContainText("You");
    expect((await record.boundingBox())?.height ?? 999).toBeLessThan(48);
  });

  test("288 + 290: in a shared chat, typing shows and expires, and a participant's messages are queued, never refused", async ({ page }) => {
    const THREAD = "11111111-2222-4333-8444-555555555555";
    const SHARED = conversation("Shared");
    await seed(page, [], undefined);
    await serve(page, { snapshot: () => null, replay: (_s, start) => ({ body: ndjson([...SHARED.slice(start), marker(SHARED.length)]) }) });
    const state = {
      typingUntil: 0,
      turnHolder: "ana@example.test" as string | null,
      queue: [{ id: "q-ana", author: "Ana Ray", mine: false, text: "Ana's message", state: "sending" }] as Record<string, unknown>[],
      beats: [] as { typing?: boolean; at: number }[],
      sends: [] as { message?: string; id?: string; drain?: boolean }[],
    };
    await page.route(/\/api\/ops\/threads(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        json: {
          items: [
            { id: THREAD, eveSessionId: "sess-s", title: "Shared plan", ownerEmail: "ana@example.test", role: "participant", clientEvents: [], updatedAt: new Date().toISOString() },
          ],
        },
      }),
    );
    // The shared chat's transcript, through the membership-checked proxy.
    await page.route(new RegExp(`/api/ops/threads/${THREAD}/stream`), (route) =>
      route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson([...SHARED, marker(SHARED.length)]) }),
    );
    await page.route(new RegExp(`/api/ops/threads/${THREAD}/presence`), async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { typing?: boolean };
      state.beats.push({ typing: body.typing, at: Date.now() });
      return route.fulfill({
        status: 200,
        json: {
          online: [
            { email: "ana@example.test", name: "Ana Ray", guest: false, typing: Date.now() < state.typingUntil },
            { name: null, guest: true, typing: false },
          ],
          turnHolder: state.turnHolder,
          queue: state.queue,
        },
      });
    });
    await page.route(new RegExp(`/api/ops/threads/${THREAD}/messages`), async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { message?: string; id?: string; drain?: boolean };
      state.sends.push(body);
      if (body.drain) return route.fulfill({ status: 200, json: { outcome: "busy", heldBy: null } });
      state.queue.push({ id: body.id, author: "Preview", mine: true, text: body.message, state: "queued" });
      return route.fulfill({ status: 202, json: { queued: true, id: body.id, ahead: state.queue.length - 1 } });
    });

    await page.goto("/preview/chat-open");
    await page.getByRole("button", { name: /Shared plan/ }).click();
    await expect(page.getByText("Shared answer 2.")).toBeVisible({ timeout: 60_000 });

    // 288: Ana types; the line shows her name, and goes about four seconds after she stops.
    state.typingUntil = Date.now() + 4_000;
    const line = page.locator('[data-typing-line="on"]');
    await expect(line).toHaveText("Ana Ray is typing…", { timeout: 10_000 });
    await expect(line).toHaveCount(0, { timeout: 12_000 });
    // A guest reads along and is shown as a guest, never by name or address.
    await expect(page.locator("[data-presence-stack]")).toHaveAttribute("title", /Guest/);

    // 290: Ana's message is running. The composer is open; nothing calls it a lock.
    await expect(page.locator("[data-turn-holder]")).toHaveText("Ana Ray's message is running…");
    const composer = page.locator('textarea[name="message"]');
    await expect(composer).toBeEnabled();
    await expect(page.getByText(/someone else is typing/i)).toHaveCount(0);

    // Typing sends a beat about once a second, not per keystroke.
    const before = state.beats.filter((b) => b.typing === true).length;
    const t0 = Date.now();
    await composer.pressSequentially("First from me", { delay: 120 });
    const typed = state.beats.filter((b) => b.typing === true).length - before;
    const seconds = (Date.now() - t0) / 1000;
    expect(typed, `typing beats over ${seconds.toFixed(1)} s`).toBeGreaterThan(0);
    expect(typed).toBeLessThanOrEqual(Math.ceil(seconds) + 1);
    await composer.press("Enter");
    await expect.poll(() => state.sends.filter((s) => s.message).length).toBe(1);
    // A second message while the first waits: sent too (it used to be dropped without a word).
    await composer.fill("Second from me");
    await composer.press("Enter");
    await expect.poll(() => state.sends.filter((s) => s.message).length).toBe(2);
    expect(state.sends.filter((s) => s.message).map((s) => s.message)).toEqual(["First from me", "Second from me"]);
    // Sending closed this person's typing window at once.
    expect(state.beats.some((b) => b.typing === false)).toBe(true);

    const items = page.locator("[data-shared-queue-item]");
    await expect(items).toHaveCount(3, { timeout: 10_000 });
    await expect(items.nth(0)).toContainText("Ana Ray");
    await expect(items.nth(0)).toContainText("Ana's message");
    await expect(items.nth(1)).toContainText("You");
    await expect(items.nth(1)).toContainText("First from me");
    await expect(items.nth(2)).toContainText("Second from me");
    await expect(composer).toBeEnabled();

    // Ana's turn ends: the thread is free and the next message is first in line — this page runs the queue.
    state.queue = state.queue.slice(1);
    state.turnHolder = null;
    await expect.poll(() => state.sends.filter((s) => s.drain).length, { timeout: 15_000 }).toBeGreaterThan(0);
  });
});
