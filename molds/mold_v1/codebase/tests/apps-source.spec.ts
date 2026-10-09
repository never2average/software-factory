import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Apps panel, as a person meets it (the REAL AppsPanel through /preview/apps; every API call answered here):
 *
 *   - the picker offers a specialist's row as a source and marks it; a row that cannot generate an app is shown,
 *     cannot be picked, and says why;
 *   - an app made from a specialist asks "What should it produce?" and sends that brief;
 *   - a create the API refuses is said IN the form, which stays open with what was typed;
 *   - an app whose refresh failed shows the error with what to do, and "Try again" refreshes the same app;
 *   - an app whose source cannot run says so, with what to do, before anyone refreshes.
 *
 * The API's own behaviour (what is refused, what a refresh stores) is scripts/test-app-source-db.mjs.
 */
const NOW = "2026-10-05T07:00:00.000Z";
const app = (over: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000001", slug: "a", name: "An app", description: null, sourceKind: "workflow", workflow: "ledger-reader", prompt: null, subagent: null,
  customerId: null, refreshCron: null, contentMd: null, contentUpdatedAt: null, lastRunId: null, lastSessionId: null, lastError: null, lastRefreshAt: null, enabled: true,
  createdBy: "reviewer@example.com", createdAt: NOW, updatedAt: NOW, source: { ok: true, kind: "specialist", specialist: "ledger-reader" }, ...over,
});
const WORKFLOWS = [
  { id: "w1", name: "ledger-reader", description: "Reads ledgers.", trigger: "on delegation", script: null, enabled: true, availability: { available: true }, appSource: { ok: true, kind: "specialist", specialist: "ledger-reader" } },
  { id: "w2", name: "kpi-table", description: "Build the KPI table.", trigger: "manual", script: "return 1;", enabled: true, availability: { available: true }, appSource: { ok: true, kind: "script" } },
  { id: "w3", name: "weekly-notes", description: "A draft with no script yet.", trigger: "on delegation", script: null, enabled: true, availability: { available: true }, appSource: { ok: false, kind: "none", reason: '"weekly-notes" has no script and is not one of this workspace\'s specialists, so there is nothing to run.', fix: "Give it a script under Workflows, or pick a workflow that has one." } },
  { id: "w4", name: "left-out", description: "Not part of this workspace.", trigger: "manual", script: "x", enabled: true, availability: { available: false, reason: "n/a" }, appSource: { ok: false, kind: "script", reason: "n/a", fix: "n/a" } },
];

interface State {
  apps: Record<string, unknown>[];
  posts: Record<string, unknown>[];
  refreshes: string[];
  refuseCreate: string | null;
  refresh: (id: string, state: State) => { status: number; body: Record<string, unknown> };
}
async function mockApi(page: Page, init: Partial<State>): Promise<State> {
  const state: State = { apps: [], posts: [], refreshes: [], refuseCreate: null, refresh: () => ({ status: 200, body: { ok: true } }), ...init };
  await page.route("**/api/ops/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const refresh = /^\/api\/ops\/apps\/([^/]+)\/refresh$/.exec(path);
    if (refresh && req.method() === "POST") {
      state.refreshes.push(refresh[1]);
      const out = state.refresh(refresh[1], state);
      return route.fulfill({ status: out.status, json: out.body });
    }
    if (/^\/api\/ops\/apps\/[^/]+\/versions$/.test(path)) return route.fulfill({ json: { items: [] } });
    if (path === "/api/ops/apps" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.posts.push(body);
      if (state.refuseCreate) return route.fulfill({ status: 400, json: { error: state.refuseCreate } });
      const item = app({ id: "00000000-0000-4000-8000-0000000000aa", slug: "new", ...body });
      state.apps.push(item);
      return route.fulfill({ status: 201, json: { item } });
    }
    if (path === "/api/ops/apps") return route.fulfill({ json: { items: state.apps } });
    if (path === "/api/ops/workflows") return route.fulfill({ json: { items: WORKFLOWS, libraryNote: null } });
    return route.fulfill({ json: { items: [] } });
  });
  return state;
}

async function openCreate(page: Page) {
  await page.goto("/preview/apps");
  // The list has loaded, so the page is hydrated and the button has its handler.
  await expect(page.getByText("No apps yet")).toBeVisible();
  await page.getByRole("button", { name: /add app/i }).click();
  await expect(page.getByRole("heading", { name: "New app" })).toBeVisible();
  await page.getByPlaceholder("Portfolio health digest").fill("Balance sheet of the companies");
  await page.getByRole("radio", { name: /^Workflow / }).click();
  await expect(page.getByRole("button", { name: "Create app" })).toBeDisabled(); // nothing picked yet
}

test("the picker offers a specialist, marks it, and will not pick a row that cannot generate an app", async ({ page }) => {
  const seen = await mockApi(page, {});
  await openCreate(page);
  await page.getByRole("button", { name: "Workflow or specialist" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(3); // the row this workspace cannot use is not offered
  await expect(menu.getByText("None — the orchestrator runs it")).toHaveCount(0);
  const specialist = menu.getByRole("menuitemcheckbox", { name: /ledger-reader/ });
  await expect(specialist).toContainText("specialist");
  const draft = menu.getByRole("menuitemcheckbox", { name: /weekly-notes/ });
  await expect(draft).toHaveAttribute("data-disabled", "");
  await expect(draft).toContainText("Cannot generate an app:");
  await expect(draft).toContainText("has no script and is not one of this workspace's specialists");

  await specialist.click();
  const brief = page.getByPlaceholder(/What this specialist should write each refresh/);
  await expect(brief).toBeVisible();
  await brief.fill("Total assets, borrowings and net worth of every covered company.");
  await page.getByRole("button", { name: "Create app" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ name: "Balance sheet of the companies", sourceKind: "workflow", workflow: "ledger-reader", prompt: "Total assets, borrowings and net worth of every covered company." });
});

test("a create the API refuses is said in the form, which stays open", async ({ page }) => {
  const sentence = 'There is no workflow named "ledger-reader" in this workspace. Pick a workflow that has a script, or one of this workspace\'s specialists.';
  const seen = await mockApi(page, { refuseCreate: sentence });
  await openCreate(page);
  await page.getByRole("button", { name: "Workflow or specialist" }).click();
  await page.getByRole("menuitemcheckbox", { name: /ledger-reader/ }).click();
  await page.getByRole("button", { name: "Create app" }).click();
  const refused = page.locator("[data-app-create-error]");
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("The app was not created.");
  await expect(refused).toContainText(sentence);
  await expect(page.getByRole("heading", { name: "New app" })).toBeVisible();
  await expect(page.getByPlaceholder("Portfolio health digest")).toHaveValue("Balance sheet of the companies");
  expect(seen.apps).toHaveLength(0);
});

test("a failed app shows its error with what to do, and Try again refreshes the same app", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000002";
  const seen = await mockApi(page, {
    apps: [app({ id, name: "Balance sheet of the companies", lastError: 'Workflow "annual-report-format" has no script.', lastRefreshAt: NOW })],
    refresh: (_id, state) => {
      state.apps = [app({ id, name: "Balance sheet of the companies", contentMd: "# Balance sheet\n\nTotal assets 1,240", contentUpdatedAt: NOW, lastRefreshAt: NOW, lastError: null })];
      return { status: 200, body: { ok: true } };
    },
  });
  await page.goto(`/preview/apps?id=${id}`);
  await expect(page.locator("[data-app-problem]")).toHaveText("failed");
  const error = page.locator("[data-app-refresh-error]");
  await expect(error).toContainText("The last refresh failed.");
  await expect(error).toContainText('Workflow "annual-report-format" has no script.');
  await expect(error).toContainText("Nothing has been generated yet. Try again; if it fails the same way, change what generates this app.");
  await error.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => seen.refreshes).toEqual([id]);
  await expect(page.getByRole("heading", { name: "Balance sheet", exact: true })).toBeVisible();
  await expect(page.locator("[data-app-refresh-error]")).toHaveCount(0);
  await expect(page.locator("[data-app-problem]")).toHaveCount(0);
});

test("a refresh that fails shows the new error on the open app", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000003";
  await mockApi(page, {
    apps: [app({ id, name: "KPI table", workflow: "kpi-table", source: { ok: true, kind: "script" }, lastError: "The agent failed this step: old", lastRefreshAt: NOW })],
    refresh: (_id, state) => {
      state.apps = [app({ id, name: "KPI table", workflow: "kpi-table", source: { ok: true, kind: "script" }, lastError: "The agent failed this step: the model timed out", lastRefreshAt: NOW })];
      return { status: 500, body: { ok: false, error: "The agent failed this step: the model timed out" } };
    },
  });
  await page.goto(`/preview/apps?id=${id}`);
  await page.locator("[data-app-refresh-error]").getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-app-refresh-error]")).toContainText("the model timed out");
});

test("an app whose source cannot run says why and what to do before anyone refreshes", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000004";
  await mockApi(page, {
    apps: [app({ id, name: "Notes board", workflow: "weekly-notes", source: { ok: false, kind: "none", reason: '"weekly-notes" has no script and is not one of this workspace\'s specialists, so there is nothing to run.', fix: "Give it a script under Workflows, or pick a workflow that has one." } })],
  });
  await page.goto(`/preview/apps?id=${id}`);
  await expect(page.locator("[data-app-problem]")).toHaveText("cannot refresh");
  const problem = page.locator("[data-app-source-problem]");
  await expect(problem).toContainText("This app cannot refresh as it is set.");
  await expect(problem).toContainText("has no script and is not one of this workspace's specialists");
  await expect(problem).toContainText("Give it a script under Workflows, or pick a workflow that has one.");
  await problem.getByRole("button", { name: "Change what generates it" }).click();
  // The settings open on the picker, which shows what the app is set to now.
  await expect(page.getByRole("button", { name: "Workflow", exact: true })).toContainText("weekly-notes");
});
