import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Starter apps in the Apps panel, as a person meets them (the REAL AppsPanel through /preview/apps; every API call
 * answered here). A starter app is one the workspace was created with (its deployment's library), with no document:
 *
 *   - the list marks it "starter" and says it is written when first opened, not "never";
 *   - opening it asks for its FIRST document once (`POST …/refresh?first=1`), says what is happening while it is
 *     written, and then shows the document;
 *   - one that another person is already writing is not asked for again: the panel says so and looks again;
 *   - a paused one is not written by opening it, and says so;
 *   - an app a person made is untouched by all of this: no badge, no automatic refresh.
 *
 * What the server does with that request (one generation however many ask) is scripts/test-starter-apps-db.mjs.
 */
const NOW = "2026-10-05T07:00:00.000Z";
const ID = "00000000-0000-4000-8000-0000000000b1";
const app = (over: Record<string, unknown>) => ({
  id: ID, slug: "balance-sheets", name: "Balance sheets of the companies", description: "Total assets, borrowings and net worth of every covered company.",
  sourceKind: "workflow", workflow: "ledger-reader", prompt: "One table.", subagent: null, customerId: null, refreshCron: "0 6 * * 1", contentMd: null, contentUpdatedAt: null,
  lastRunId: null, lastSessionId: null, lastError: null, lastRefreshAt: null, refreshingAt: null, enabled: true, starterKey: "desk-research/balance-sheets",
  createdBy: "system", createdAt: NOW, updatedAt: NOW, source: { ok: true, kind: "specialist", specialist: "ledger-reader" }, ...over,
});

interface State {
  apps: Record<string, unknown>[];
  refreshes: string[];
  refresh: (query: string, state: State) => Promise<{ status: number; body: Record<string, unknown> }> | { status: number; body: Record<string, unknown> };
}
async function mockApi(page: Page, init: Partial<State>): Promise<State> {
  const state: State = { apps: [], refreshes: [], refresh: () => ({ status: 200, body: { ok: true } }), ...init };
  await page.route("**/api/ops/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (/^\/api\/ops\/apps\/[^/]+\/refresh$/.test(url.pathname) && req.method() === "POST") {
      state.refreshes.push(url.search);
      const out = await state.refresh(url.search, state);
      return route.fulfill({ status: out.status, json: out.body });
    }
    if (/^\/api\/ops\/apps\/[^/]+\/versions$/.test(url.pathname)) return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/ops/apps") return route.fulfill({ json: { items: state.apps } });
    return route.fulfill({ json: { items: [] } });
  });
  return state;
}

test("the list marks a starter app and says when its document is written", async ({ page }) => {
  await mockApi(page, {
    apps: [
      app({}),
      app({ id: "00000000-0000-4000-8000-0000000000b2", name: "Our own board", starterKey: null, createdBy: "reviewer@example.com", refreshCron: null }),
      app({ id: "00000000-0000-4000-8000-0000000000b3", name: "Morning brief", starterKey: "desk-research/morning-brief", refreshingAt: new Date().toISOString() }),
    ],
  });
  await page.goto("/preview/apps");
  const starter = page.locator("tr", { hasText: "Balance sheets of the companies" });
  await expect(starter.locator("[data-app-starter]")).toHaveText("starter");
  await expect(starter).toContainText("written when first opened");
  const own = page.locator("tr", { hasText: "Our own board" });
  await expect(own.locator("[data-app-starter]")).toHaveCount(0);
  await expect(own).toContainText("never");
  // One whose first document is under way (its library said "on_create", or somebody has just opened it).
  await expect(page.locator("tr", { hasText: "Morning brief" })).toContainText("being written");
});

test("opening a starter app writes its first document, once, and says so while it does", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const seen = await mockApi(page, {
    apps: [app({})],
    refresh: async (_q, state) => {
      await held;
      state.apps = [app({ contentMd: "# Balance sheets\n\nTotal assets 1,240", contentUpdatedAt: NOW, lastRefreshAt: NOW })];
      return { status: 200, body: { ok: true, started: true } };
    },
  });
  await page.goto(`/preview/apps?id=${ID}`);
  const first = page.locator("[data-app-first-document]");
  await expect(first).toContainText("This app came with the workspace and has not been written yet.");
  await expect(first).toContainText("Total assets, borrowings and net worth of every covered company.");
  await expect(page.locator("[data-app-first-document-writing]")).toContainText("Its first document is being written now.");
  await expect.poll(() => seen.refreshes).toEqual(["?first=1"]);
  release();
  await expect(page.getByRole("heading", { name: "Balance sheets", exact: true })).toBeVisible();
  await expect(first).toHaveCount(0);
  // It has its document: nothing asks again.
  await page.waitForTimeout(500);
  expect(seen.refreshes).toEqual(["?first=1"]);
});

test("a starter app somebody else is already writing is not asked for again", async ({ page }) => {
  const seen = await mockApi(page, { apps: [app({ refreshingAt: new Date().toISOString() })] });
  await page.goto(`/preview/apps?id=${ID}`);
  await expect(page.locator("[data-app-first-document-writing]")).toContainText("Its first document is being written now.");
  await page.waitForTimeout(600);
  expect(seen.refreshes).toEqual([]);
});

test("an attempt that died long ago does not block it: opening it asks again", async ({ page }) => {
  const seen = await mockApi(page, {
    apps: [app({ refreshingAt: "2026-10-01T07:00:00.000Z" })],
    refresh: (_q, state) => {
      state.apps = [app({ contentMd: "# Balance sheets", contentUpdatedAt: NOW, lastRefreshAt: NOW })];
      return { status: 200, body: { ok: true, started: true } };
    },
  });
  await page.goto(`/preview/apps?id=${ID}`);
  await expect(page.getByRole("heading", { name: "Balance sheets", exact: true })).toBeVisible();
  expect(seen.refreshes).toEqual(["?first=1"]);
});

test("a paused starter app is not written by opening it", async ({ page }) => {
  const seen = await mockApi(page, { apps: [app({ enabled: false })] });
  await page.goto(`/preview/apps?id=${ID}`);
  await expect(page.locator("[data-app-first-document]")).toContainText("It is paused. Resume it to have it written.");
  await page.waitForTimeout(600);
  expect(seen.refreshes).toEqual([]);
});

test("a first document that fails shows the error and Try again, like any app", async ({ page }) => {
  const seen = await mockApi(page, {
    apps: [app({})],
    refresh: (query, state) => {
      if (query === "?first=1") {
        state.apps = [app({ lastError: "The specialist did not answer.", lastRefreshAt: NOW })];
        return { status: 500, body: { ok: false, started: true, error: "The specialist did not answer." } };
      }
      state.apps = [app({ contentMd: "# Balance sheets", contentUpdatedAt: NOW, lastRefreshAt: NOW })];
      return { status: 200, body: { ok: true } };
    },
  });
  await page.goto(`/preview/apps?id=${ID}`);
  const error = page.locator("[data-app-refresh-error]");
  await expect(error).toContainText("The specialist did not answer.");
  await expect(page.locator("[data-app-first-document]")).toHaveCount(0);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Balance sheets", exact: true })).toBeVisible();
  expect(seen.refreshes).toEqual(["?first=1", ""]);
});

test("an app a person made is never refreshed by opening it", async ({ page }) => {
  const seen = await mockApi(page, { apps: [app({ starterKey: null, createdBy: "reviewer@example.com" })] });
  await page.goto(`/preview/apps?id=${ID}`);
  await expect(page.getByText("No document yet — refresh to generate it.")).toBeVisible();
  await expect(page.locator("[data-app-first-document]")).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(seen.refreshes).toEqual([]);
});
