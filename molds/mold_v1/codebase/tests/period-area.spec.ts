import { expect, test, type Page, type Route } from "@playwright/test";
import { RECORD_AREAS } from "../agent/lib/record-areas.generated";
import { periodDeclared } from "../agent/lib/period-area";
import { periodAreaUi } from "../app/_components/ops/period-area-model";

/**
 * The periods drawn from their definition (profiles records.areas.periods in the record-area form; the record-areas
 * plan's PR 6): the REAL TodosPanel through /preview/record-areas?profile=period&view=sprints (a "Regulatory filing",
 * scripts/fixtures/record-areas/examples/filing-period.json), every API call answered here, every request the panel
 * makes asserted.
 *
 *   - the list: the definition's words, columns, choices with their tones, the contained tasks' completion (#185), the
 *     metrics, a filter on a choice and on the due date, the board by state, the month calendar;
 *   - the detail: the lifecycle's moves (a comment asked for where a transition needs one), the sections, own fields
 *     saved under `custom`, the contained tasks listed with how many are done;
 *   - the create form: the definition's fields, the validator's sentence under the field, the stored values sent;
 *   - THIS BUILD's own definitions: the period view is today's (no declared panel; the three states on the board), or,
 *     on a build that declares the periods (a pack's profile), the declared panel with its own words and states.
 */
const ME = "reviewer@example.com";
type Seen = { posts: Record<string, unknown>[]; patches: { id: string; body: Record<string, unknown> }[]; todoPatches: { id: string; body: Record<string, unknown> }[] };

const filing = (id: string, name: string, state: string, endsAt: string, extra: Record<string, unknown> = {}, custom: Record<string, unknown> = {}) => ({
  id, name, state, startsAt: "2026-10-01T00:00:00.000Z", endsAt, goal: null, lead: null, capacity: null, createdBy: ME, archivedAt: null,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", custom, ...extra,
});
const ITEMS = [
  filing("c1", "RBI · ALM return · Q2", "active", "2026-10-10T00:00:00.000Z", { lead: ME }, { regulator: "RBI", penalty_exposure: 250000 }),
  filing("c2", "SEBI · LODR · Q2", "review", "2026-10-20T00:00:00.000Z", { lead: "ana@example.com" }, { regulator: "SEBI" }),
  filing("c3", "MCA · Annual return", "closed", "2026-09-30T00:00:00.000Z", {}, { regulator: "MCA", filed_on: "2026-09-29", acknowledgement: "ACK-77" }),
];
const TODOS = [
  { id: "t1", title: "Collate ALM data", done: true, status: "done", cycleId: "c1", createdBy: ME, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", dueAt: null, priority: "normal", archivedAt: null },
  { id: "t2", title: "Board sign-off", done: false, status: "open", cycleId: "c1", createdBy: ME, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", dueAt: "2026-10-09T00:00:00.000Z", priority: "normal", archivedAt: null },
  { id: "t3", title: "Unrelated", done: false, status: "open", cycleId: null, createdBy: ME, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", dueAt: null, priority: "normal", archivedAt: null },
];

async function mockApi(page: Page, items: Record<string, unknown>[] = ITEMS): Promise<Seen> {
  const seen: Seen = { posts: [], patches: [], todoPatches: [] };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/ops/cycles" && req.method() === "GET") return route.fulfill({ json: { items } });
    if (url.pathname === "/api/ops/cycles" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      return route.fulfill({ status: 201, json: { item: { id: "new-1", ...body } } });
    }
    const one = /^\/api\/ops\/cycles\/([^/]+)$/.exec(url.pathname);
    if (one && req.method() === "PATCH") {
      seen.patches.push({ id: one[1], body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { item: items.find((c) => c.id === one[1]) } });
    }
    if (url.pathname === "/api/ops/todos" && req.method() === "GET") return route.fulfill({ json: { items: TODOS } });
    const todo = /^\/api\/ops\/todos\/([^/]+)$/.exec(url.pathname);
    if (todo && req.method() === "PATCH") {
      seen.todoPatches.push({ id: todo[1], body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { item: TODOS.find((t) => t.id === todo[1]) } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}
const headers = (page: Page) => page.locator("table thead th").evaluateAll((ths) => ths.map((t) => t.textContent?.trim() ?? ""));
const open = async (page: Page) => {
  await page.clock.setFixedTime(new Date("2026-10-15T07:00:00.000Z"));
  await page.goto("/preview/record-areas?profile=period&view=sprints");
  return page.getByTestId("period-area");
};

test("a regulatory filing: the table's words, tones and completion, the metrics, filters on a choice and a date", async ({ page }) => {
  await mockApi(page);
  const panel = await open(page);
  await expect(page.getByRole("button", { name: "Regulatory filings" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add filing" })).toBeVisible();
  expect(await headers(page)).toEqual(["Filing", "Regulator", "Filing status", "Due date", "Preparer", "Penalty exposure", "Tasks done"]);
  // The definition's default sort: due date, earliest first.
  await expect(panel.locator('tbody tr [data-col="name"]')).toHaveText(["MCA · Annual return", "RBI · ALM return · Q2", "SEBI · LODR · Q2"]);
  const rbi = panel.locator("tbody tr", { hasText: "RBI · ALM return" });
  await expect(rbi.locator('[data-col="state"]')).toHaveText("In preparation");
  await expect(rbi.locator('[data-col="state"] [data-tone]')).toHaveAttribute("data-tone", "amber");
  await expect(rbi.locator('[data-col="regulator"] [data-tone]')).toHaveAttribute("data-tone", "blue");
  await expect(rbi.locator('[data-col="penalty_exposure"]')).toHaveText("250,000 INR");
  await expect(rbi.locator('[data-col="lead"]')).toHaveText("reviewer");
  await expect(rbi.locator('[data-col="contains"]')).toHaveText("1/2");
  await expect(panel.locator("tbody tr", { hasText: "SEBI" }).locator('[data-col="state"]')).toHaveText("Awaiting sign-off");
  // The metrics: open ones, overdue (flagged), the exposure summed.
  const metrics = page.getByTestId("task-metrics");
  await expect(metrics.locator('[data-metric="open"]')).toContainText("2");
  await expect(metrics.locator('[data-metric="overdue"]')).toHaveAttribute("data-attention", "true");
  await expect(metrics.locator('[data-metric="overdue"]')).toContainText("1");
  await expect(metrics.locator('[data-metric="exposure"]')).toContainText("250,000 INR");
  // Filters from the definition.
  await panel.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "SEBI", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel.locator('tbody tr [data-col="name"]')).toHaveText(["SEBI · LODR · Q2"]);
  await panel.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "SEBI", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Overdue" }).click();
  await page.keyboard.press("Escape");
  await expect(panel.locator('tbody tr [data-col="name"]')).toHaveText(["RBI · ALM return · Q2"]);
});

test("a regulatory filing: the board's columns are its declared states, the calendar places each on its due day", async ({ page }) => {
  const seen = await mockApi(page);
  const panel = await open(page);
  await expect(panel.getByTestId("period-modes").getByRole("button")).toHaveText(["Table", "Board", "Calendar", "Timeline"]);
  await panel.getByTestId("period-modes").getByRole("button", { name: "Board" }).click();
  const labels = await panel.locator("[data-board-column] > div:first-child > span.font-medium").allInnerTexts();
  expect(labels).toEqual(["Draft", "In preparation", "Awaiting sign-off", "Filed", "Returned by regulator", "Missed"]);
  await expect(panel.locator('[data-board-column="review"]')).toContainText("SEBI · LODR · Q2");
  await expect(panel.locator('[data-board-column="active"]')).toContainText("1/2 tasks done");
  await panel.getByTestId("period-modes").getByRole("button", { name: "Calendar" }).click();
  const cal = page.getByTestId("period-calendar");
  await expect(cal.getByTestId("calendar-month")).toHaveText("October 2026");
  await expect(cal.locator('[data-day="2026-10-10"]')).toContainText("RBI · ALM return · Q2");
  await expect(cal.locator('[data-day="2026-10-20"]')).toContainText("SEBI · LODR · Q2");
  await cal.getByRole("button", { name: "Previous month" }).click();
  await expect(cal.locator('[data-day="2026-09-30"]')).toContainText("MCA · Annual return");
  await cal.getByTestId("calendar-item").first().click();
  await expect(page.getByTestId("period-detail")).toBeVisible();
  expect(seen.patches).toEqual([]);
});

test("a regulatory filing's detail: its moves, its sections and own fields, its contained tasks with how many are done", async ({ page }) => {
  const seen = await mockApi(page);
  const panel = await open(page);
  await panel.locator("tbody tr", { hasText: "RBI · ALM return" }).click();
  const detail = page.getByTestId("period-detail");
  await expect(detail.getByTestId("period-state")).toContainText("In preparation");
  await expect(detail.getByTestId("lifecycle-moves").getByRole("button")).toHaveText(["Send for sign-off", "Close as missed"]);
  for (const s of ["Filing", "Preparation", "Submission"]) await expect(detail.getByText(s, { exact: true })).toBeVisible();
  await expect(detail.locator('[data-record-field="regulator"] select option:checked')).toHaveText("RBI");
  await expect(detail.locator('[data-record-field="endsAt"] input')).toHaveValue("2026-10-10");
  await expect(detail.locator('[data-record-field="penalty_exposure"] input')).toHaveValue("250000");
  // The contained tasks (#185): listed under the period, with how many are done.
  await expect(detail.getByText("Obligations · 1/2")).toBeVisible();
  await expect(detail.getByTestId("period-task")).toHaveText(["Collate ALM data", "Board sign-off9 Oct"]);

  await detail.getByRole("button", { name: "Send for sign-off" }).click();
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "c1", body: { state: "review", actor: ME } });
  const ack = detail.locator('[data-record-field="acknowledgement"] input');
  await ack.fill("ACK-1");
  await ack.blur();
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1]).toEqual({ id: "c1", body: { custom: { acknowledgement: "ACK-1" }, actor: ME } });
  await detail.locator('[data-record-field="regulator"] select').selectOption("NHB");
  await expect.poll(() => seen.patches.length).toBe(3);
  expect(seen.patches[2]).toEqual({ id: "c1", body: { custom: { regulator: "NHB" }, actor: ME } });
  // A move whose transition needs a comment asks for one, and sends it as the move's `reason`.
  await detail.getByRole("button", { name: "Close as missed" }).click();
  const dialog = page.getByTestId("move-reason");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Data not received in time");
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => seen.patches.length).toBe(4);
  expect(seen.patches[3]).toEqual({ id: "c1", body: { state: "missed", reason: "Data not received in time", actor: ME } });
  // A contained task marked done in the task area's own states.
  await detail.getByTestId("period-task").nth(1).getByRole("button", { name: "Mark done" }).click();
  await expect.poll(() => seen.todoPatches.length).toBe(1);
  expect(seen.todoPatches[0]).toEqual({ id: "t2", body: { status: "done", actor: ME } });
});

test("a regulatory filing's create form: the definition's fields, the validator's sentence, the stored values sent", async ({ page }) => {
  const seen = await mockApi(page, []);
  const panel = await open(page);
  await expect(page.getByText("No filings yet. Add one, or ask the agent to raise this period's filings.")).toBeVisible();
  await panel.getByRole("button", { name: "Add filing" }).click();
  const form = page.getByTestId("period-create");
  await expect(form.getByText("New regulatory filing")).toBeVisible();
  expect(await form.locator("[data-record-field] > label > span").allInnerTexts()).toEqual(["Filing *", "Regulator", "Preparation opens", "Due date", "Preparer"]);
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect(form.locator('[data-record-field="name"]').getByRole("alert")).toHaveText('"Filing" (name) is required.');
  expect(seen.posts).toEqual([]);
  await form.locator('[data-record-field="name"] input').fill("NHB · Return · Q2");
  await form.locator('[data-record-field="regulator"] select').selectOption("NHB");
  await form.locator('[data-record-field="endsAt"] input').fill("2026-10-31");
  await form.locator('[data-record-field="lead"] input').fill("not an email");
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect(form.locator('[data-record-field="lead"]').getByRole("alert")).toContainText('"Preparer" (lead)');
  expect(seen.posts).toEqual([]);
  await form.locator('[data-record-field="lead"] input').fill(ME);
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0]).toEqual({ name: "NHB · Return · Q2", endsAt: "2026-10-31", lead: ME, custom: { regulator: "NHB" }, createdBy: ME });
});

// This build's OWN periods (no `?profile=`): drawn from the definition when the build declares the area for a team, as
// todos-panel.tsx decides (periodsDeclared); else today's view, its three stored states on the board.
const BUILD_DECLARES_PERIODS = periodDeclared(RECORD_AREAS) && RECORD_AREAS.periods.period?.mode !== "individual";

test("this build's own definitions: the period view is the one they define (today's three states, or the declared panel)", async ({ page }) => {
  const build = BUILD_DECLARES_PERIODS ? periodAreaUi(RECORD_AREAS) : null;
  // The row starts in the definition's own first state (today's view: "active", as it always did).
  const initial = build ? build.lifecycle?.initial ?? build.board?.columns[0]?.key ?? "active" : "active";
  await page.route(/\/(api|eve)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: { items: path === "/api/ops/cycles" ? [{ ...ITEMS[0], state: initial, custom: undefined }] : [] } });
  });
  await page.goto("/preview/record-areas?view=sprints");
  const boardLabels = () => page.locator("[data-board-column] > div:first-child > span.font-medium").allInnerTexts();
  if (!build) {
    await expect(page.getByTestId("period-area")).toHaveCount(0);
    await expect(page.getByText("RBI · ALM return · Q2").first()).toBeVisible();
    expect(await boardLabels()).toEqual(["Planning", "Active", "Closed"]);
    return;
  }
  // The declared panel, under the build's own word on the nav, its row shown.
  const panel = page.getByTestId("period-area");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button", { name: build.navLabel }).first()).toBeVisible();
  await expect(panel.getByText("RBI · ALM return · Q2").first()).toBeVisible();
  // Its board's columns are the definition's states in order, the row in its own state's column.
  if (build.board && build.modes.includes("kanban")) {
    await panel.getByTestId("period-modes").getByRole("button", { name: "Board" }).click();
    await expect.poll(boardLabels).toEqual(build.board.columns.map((c) => c.label));
    await expect(panel.locator(`[data-board-column="${initial}"]`)).toContainText("RBI · ALM return · Q2");
  }
});
