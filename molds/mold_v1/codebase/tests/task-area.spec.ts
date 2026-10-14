import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Tasks view as the deployment defines a task (profiles records.areas.tasks): the REAL TodosPanel through
 * /preview/record-tasks, every API call answered here and every write asserted.
 *
 *   - under a REDEFINED task (the record-areas design's worked example: a compliance obligation), the board's columns
 *     are its own states in order, a card sits in the column of its own state (`custom.state`, not the stored status),
 *     its priority reads in the definition's word, the detail moves it by its state and saves its own fields under
 *     `custom`, and the create form asks for the required fields, checks them with the validator the API runs and
 *     sends the stored values;
 *   - under the DEFAULT definition, the view is today's: six status columns, "New task", a move writes `status`.
 */
const NOW = "2026-10-14T07:00:00.000Z";
const ME = "reviewer@example.com";
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, orgId: "o", title, notes: null, done: false, doneAt: null, status: "open", priority: "normal", dueAt: null,
  containerType: null, containerId: null, containerLabel: null, linkType: null, linkId: null, linkLabel: null,
  cycleId: null, parentId: null, createdBy: ME, assignee: null, archivedAt: null, createdAt: NOW, updatedAt: NOW, workflow: null,
  ...extra,
});

async function mockApi(page: Page, items: Record<string, unknown>[]) {
  const seen = { posts: [] as Record<string, unknown>[], patches: [] as { id: string; body: Record<string, unknown> }[] };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/ops/todos" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      const item = task("t-new", String(body.title), { custom: body.custom ?? {} });
      items.unshift(item);
      return route.fulfill({ status: 201, json: { item } });
    }
    const one = /^\/api\/ops\/todos\/([^/]+)$/.exec(path);
    if (one && req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.patches.push({ id: one[1], body });
      const row = items.find((t) => t.id === one[1]) as Record<string, unknown>;
      if (body.custom) row.custom = { ...(row.custom as object), ...(body.custom as object) };
      for (const [k, v] of Object.entries(body)) if (k !== "custom" && k !== "actor") row[k] = v;
      return route.fulfill({ json: { item: row } });
    }
    if (path === "/api/ops/todos") return route.fulfill({ json: { items } });
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}
const columns = (page: Page) => page.locator("[data-board-column]");
const columnLabels = (page: Page) => columns(page).locator("> div:first-child > span.font-medium").allInnerTexts();
const column = (page: Page, key: string) => page.locator(`[data-board-column="${key}"]`);
const formLabels = (page: Page) => page.getByTestId("task-create").locator("[data-record-field] > label > span").allInnerTexts();

test("a redefined task: its states are the board, a card sits in its own state's column, the detail moves it by state", async ({ page }) => {
  const items = [
    task("t1", "Quarterly ALM return", { status: "in_progress", priority: "high", custom: { state: "evidence_submitted", frequency: "Quarterly", department: "Finance" } }),
    task("t2", "Board KYC policy review", { status: "open", custom: { state: "not_started" } }),
  ];
  const seen = await mockApi(page, items);
  await page.goto("/preview/record-tasks?profile=obligation");
  await expect(page.getByRole("button", { name: "Obligations" })).toBeVisible();
  await expect(columns(page)).toHaveCount(6);
  expect(await columnLabels(page)).toEqual(["Not started", "In progress", "Evidence submitted", "Under review", "Complied", "Not applicable"]);
  await expect(column(page, "evidence_submitted")).toContainText("Quarterly ALM return");
  await expect(column(page, "in_progress")).not.toContainText("Quarterly ALM return");
  await expect(column(page, "not_started")).toContainText("Board KYC policy review");
  await expect(column(page, "evidence_submitted")).toContainText("Critical");

  await page.getByText("Quarterly ALM return").click();
  const status = page.locator("label", { hasText: /^Status/ }).locator("select");
  await expect(status).toHaveValue("evidence_submitted");
  await expect(page.locator("label", { hasText: /^Criticality/ }).locator("select option")).toHaveText(["Critical", "Standard", "Low"]);
  await status.selectOption({ label: "Under review" });
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "t1", body: { custom: { state: "under_review" }, actor: ME } });
  await expect(column(page, "under_review")).toContainText("Quarterly ALM return");

  // An own field on the detail: the definition's control, saved under custom.
  const dept = page.locator('[data-record-field="department"] select');
  await expect(dept).toHaveValue("Finance");
  await dept.selectOption("Risk");
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1]).toEqual({ id: "t1", body: { custom: { department: "Risk" }, actor: ME } });
  const ref = page.locator('[data-record-field="obligation_ref"] input');
  await ref.fill("42");
  await ref.blur();
  await expect(page.locator('[data-record-field="obligation_ref"]').getByRole("alert")).toHaveText('"Obligation id" (obligation_ref) is not in the expected form (^OBL-[0-9]{4,}$).');
  expect(seen.patches).toHaveLength(2);
});

test("a redefined task's create form: its fields, its defaults, the validator's sentences, the stored values sent", async ({ page }) => {
  const seen = await mockApi(page, []);
  await page.goto("/preview/record-tasks?profile=obligation");
  await expect(page.getByText("No obligations yet — hit Add obligation.")).toBeVisible();
  await page.getByRole("button", { name: "Add obligation" }).click();
  const form = page.getByTestId("task-create");
  await expect(form.getByRole("heading", { name: "New obligation" })).toBeVisible();
  expect(await formLabels(page)).toEqual(["Obligation *", "Due *", "Owner *", "Frequency", "Department", "Obligation id", "Circular clause"]);
  await expect(form.locator('[data-record-field="assignee"] input')).toHaveValue(ME);
  await form.getByRole("button", { name: "Add obligation" }).click();
  await expect(form.locator('[data-record-field="title"]').getByRole("alert")).toHaveText('"Obligation" (title) is required.');
  await expect(form.locator('[data-record-field="dueAt"]').getByRole("alert")).toHaveText('"Due" (dueAt) is required.');
  expect(seen.posts).toEqual([]);

  await form.locator('[data-record-field="title"] input').fill("Half-yearly ALM return");
  await form.locator('[data-record-field="dueAt"] input').fill("2026-10-31");
  await form.locator('[data-record-field="frequency"] select').selectOption({ label: "Half-yearly" });
  await form.locator('[data-record-field="obligation_ref"] input').fill("OBL-42");
  await form.getByRole("button", { name: "Add obligation" }).click();
  await expect(form.locator('[data-record-field="obligation_ref"]').getByRole("alert")).toContainText("is not in the expected form");
  expect(seen.posts).toEqual([]);
  await form.locator('[data-record-field="obligation_ref"] input').fill("OBL-0042");
  await form.getByRole("button", { name: "Add obligation" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0]).toEqual({
    title: "Half-yearly ALM return",
    dueAt: "2026-10-31T09:00:00.000Z",
    assignee: ME,
    custom: { frequency: "Half-yearly", obligation_ref: "OBL-0042" },
    createdBy: ME,
  });
  // The new one opens, in its initial state's column.
  await expect(page.getByPlaceholder("Untitled obligation")).toHaveValue("Half-yearly ALM return");
  await expect(column(page, "not_started")).toContainText("Half-yearly ALM return");
});

test("the default definition: today's Tasks view, six status columns, New task, a move writes the status", async ({ page }) => {
  const items = [task("t1", "Chase the invoice", { status: "in_progress", priority: "high" })];
  const seen = await mockApi(page, items);
  await page.goto("/preview/record-tasks");
  await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
  expect(await columnLabels(page)).toEqual(["Backlog", "Open", "In progress", "Blocked", "Done", "Cancelled"]);
  await expect(column(page, "in_progress")).toContainText("Chase the invoice");
  await expect(column(page, "in_progress")).toContainText("high");
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await page.getByText("Chase the invoice").click();
  await expect(page.locator("label", { hasText: /^Priority/ }).locator("select option")).toHaveText(["Low", "Normal", "High"]);
  await page.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Done" });
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "t1", body: { status: "done", actor: ME } });
  await expect(page.locator("[data-record-field]")).toHaveCount(0);
});
