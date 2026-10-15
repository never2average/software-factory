import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Tasks view honours EVERYTHING its definition declares (profiles records.areas.tasks): the REAL TodosPanel
 * through /preview/record-tasks?profile=obligation-like, an obligation-like area as a pack declares it
 * (scripts/fixtures/record-areas/ui/obligation-like.json over the compiled worked example), every API call answered
 * here and every write asserted. One card per thing the definition declares:
 *
 *   1. views: only the declared ones are offered (board and table; no timeline);
 *   2. filter presets: overdue, due in 7 days, due in 30 days, in the toolbar's Filter, and the declared field filters;
 *   3. metrics: each declared count, with its attention flag (raised only when the count is not zero);
 *   4. cards: the fields the definition puts on a card (an own field among them);
 *   5. placeholders and words: the area's own, never the default's "Untitled task";
 *   6. warnings: a lifecycle warning the API returns (WriteWarning) is a toast that blocks nothing, and so is the next
 *      occurrence a recurring task's completion created (`next`);
 *   7. moves: under a strict lifecycle the board greys out the columns a card may not move to (its role's too), the
 *      reason in a tooltip, and a drop there sends nothing;
 *   8. a move whose transition needs a comment asks for the reason (board drop and detail) and sends it as `reason`.
 *
 * The default definition's view is held by tests/task-area-default.spec.ts (a DOM golden) and tests/task-area.spec.ts.
 */
const NOW = "2026-10-14T07:00:00.000Z";
const ME = "reviewer@example.com";
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, orgId: "o", title, notes: null, done: false, doneAt: null, status: "open", priority: "normal", dueAt: null,
  containerType: null, containerId: null, containerLabel: null, linkType: null, linkId: null, linkLabel: null,
  cycleId: null, parentId: null, createdBy: ME, assignee: null, archivedAt: null, createdAt: NOW, updatedAt: NOW, workflow: null,
  ...extra,
});
const day = (d: string) => `${d}T09:00:00.000Z`;
const ITEMS = () => [
  // Overdue (four days ago) and awaiting review.
  task("t1", "Quarterly ALM return", { status: "in_progress", priority: "high", dueAt: day("2026-10-10"), assignee: "ana@example.com", custom: { state: "evidence_submitted", department: "Finance", frequency: "Quarterly" } }),
  // Due in four days.
  task("t2", "Board KYC policy review", { status: "open", dueAt: day("2026-10-18"), assignee: ME, custom: { state: "not_started", department: "Risk" } }),
  // Due in 22 days.
  task("t3", "Annual audit plan", { status: "in_progress", dueAt: day("2026-11-05"), custom: { state: "in_progress", department: "Legal" } }),
  // Past its date, but complied: not overdue.
  task("t4", "Monthly return", { status: "done", done: true, dueAt: day("2026-10-01"), custom: { state: "closed", department: "Finance" } }),
  // No due date.
  task("t5", "Train the new joiners", { status: "open", custom: { state: "not_started", department: "HR" } }),
  // Awaiting review, and its owner is the person signed in.
  task("t6", "Fire drill report", { status: "in_progress", assignee: ME, custom: { state: "evidence_submitted", department: "Operations", evidence: ["a/b.pdf"] } }),
];

type Seen = { posts: Record<string, unknown>[]; patches: { id: string; body: Record<string, unknown> }[] };
async function mockApi(page: Page, opts: { warnings?: unknown[]; next?: unknown } = {}) {
  const items: Record<string, unknown>[] = ITEMS();
  const seen: Seen = { posts: [], patches: [] };
  await page.clock.setFixedTime(new Date(NOW));
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/ops/todos" && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      const item = task("t-new", String(body.title), { custom: body.custom ?? {} });
      items.unshift(item);
      return route.fulfill({ status: 201, json: { item, ...(opts.warnings ? { warnings: opts.warnings } : {}), ...(opts.next ? { next: opts.next } : {}) } });
    }
    const one = /^\/api\/ops\/todos\/([^/]+)$/.exec(path);
    if (one && req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.patches.push({ id: one[1], body });
      const row = items.find((t) => t.id === one[1]) as Record<string, unknown>;
      if (body.custom) row.custom = { ...(row.custom as object), ...(body.custom as object) };
      for (const [k, v] of Object.entries(body)) if (k !== "custom" && k !== "actor") row[k] = v;
      return route.fulfill({ json: { item: row, ...(opts.warnings ? { warnings: opts.warnings } : {}), ...(opts.next ? { next: opts.next } : {}) } });
    }
    if (path === "/api/ops/todos") return route.fulfill({ json: { items } });
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}
const open = async (page: Page, query = "") => {
  await page.goto(`/preview/record-tasks?profile=obligation-like${query}`);
  await expect(page.getByText("Quarterly ALM return")).toBeVisible();
};
const column = (page: Page, key: string) => page.locator(`[data-board-column="${key}"]`);
const board = (page: Page) => page.locator("[data-board-column]");
const viewButtons = (page: Page) => page.locator('button[title="Board"], button[title="Table"], button[title="Timeline"]');

test("1. views: only the declared views are offered, the declared default first", async ({ page }) => {
  await mockApi(page);
  await open(page);
  await expect(viewButtons(page)).toHaveText(["Board", "Table"]);
  await expect(page.getByRole("button", { name: "Timeline" })).toHaveCount(0);
  await expect(board(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.locator("table")).toContainText("Quarterly ALM return");
});

test("2. filter presets: overdue, due in 7 days, due in 30 days from the toolbar; the declared field filters too", async ({ page }) => {
  await mockApi(page);
  await open(page);
  const cards = page.getByTestId("task-title");
  await expect(cards).toHaveCount(6);
  await page.getByRole("button", { name: "Filter" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Due");
  await menu.getByRole("menuitemcheckbox", { name: "Overdue" }).click();
  await page.keyboard.press("Escape");
  await expect(cards).toHaveText(["Quarterly ALM return"]);

  await page.getByRole("button", { name: "Filter · 1" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Overdue" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Due in 7 days" }).click();
  await page.keyboard.press("Escape");
  await expect(cards).toHaveText(["Board KYC policy review"]);

  await page.getByRole("button", { name: "Filter · 1" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Due in 7 days" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Due in 30 days" }).click();
  await page.keyboard.press("Escape");
  await expect(cards).toHaveText(["Board KYC policy review", "Annual audit plan"]);

  // A declared field filter: the department, its values as the rows carry them.
  await page.getByRole("button", { name: "Filter · 1" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Due in 30 days" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Finance" }).click();
  await page.keyboard.press("Escape");
  await expect(cards).toHaveText(["Quarterly ALM return", "Monthly return"]);
});

test("3. metrics: each declared count, the attention flag on the one that asks for it", async ({ page }) => {
  await mockApi(page);
  await open(page);
  const overdue = page.locator('[data-metric="overdue"]');
  const review = page.locator('[data-metric="awaiting-review"]');
  await expect(overdue).toHaveText(/Overdue obligations\s*1/);
  await expect(overdue).toHaveAttribute("data-attention", "true");
  await expect(review).toHaveText(/Evidence awaiting review\s*2/);
  await expect(review).not.toHaveAttribute("data-attention", "true");
});

test("4. cards: the fields the definition puts on a card, an own field among them", async ({ page }) => {
  await mockApi(page);
  await open(page);
  await expect(column(page, "evidence_submitted").locator('[data-card-field="department"]')).toHaveText(["Finance", "Operations"]);
  await expect(column(page, "not_started").locator('[data-card-field="department"]')).toHaveText(["Risk", "HR"]);
  await expect(column(page, "evidence_submitted").locator('[data-card-field="department"]').first()).toHaveAttribute("title", "Department: Finance");
  // The built-in meta stay where the definition lists them: the due date and the owner beside the department.
  await expect(column(page, "evidence_submitted")).toContainText("due 4d ago");
});

test("5. placeholders and words: the area's own, never the default's", async ({ page }) => {
  await mockApi(page);
  await open(page);
  await expect(page.getByPlaceholder("Search obligations…")).toBeVisible();
  await page.getByRole("button", { name: "Add obligation" }).click();
  const form = page.getByTestId("task-create");
  await expect(form.locator('[data-record-field="title"] input')).toHaveAttribute("placeholder", "Untitled obligation");
  await expect(page.getByPlaceholder("Untitled task")).toHaveCount(0);
  await form.getByRole("button", { name: "Cancel" }).click();
  await page.getByText("Quarterly ALM return").click();
  await expect(page.getByPlaceholder("Untitled obligation")).toHaveValue("Quarterly ALM return");
  await expect(page.getByPlaceholder("What must be done, in its own terms…")).toBeVisible();
  await expect(page.getByPlaceholder("Add sub-obligation…")).toBeVisible();
});

test("6. warnings: a lifecycle warning from the API is a toast that blocks nothing", async ({ page }) => {
  const message = 'Moving from "Not started" to "Under review" breaks the lifecycle: "Not started" cannot move to "Under review".';
  const warning = { code: "lifecycle_rule_broken", message, field: "state", from: "not_started", to: "under_review", broken: [{ rule: "transition", message: "it cannot" }], allowed: [] };
  const seen = await mockApi(page, { warnings: [warning] });
  await open(page);
  await page.getByText("Board KYC policy review").click();
  await page.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Under review" });
  await expect.poll(() => seen.patches.length).toBe(1);
  const toast = page.getByTestId("task-warnings");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toContainText(message);
  // The move went through and the panel still works with the toast up.
  await expect(column(page, "under_review")).toContainText("Board KYC policy review");
  await page.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Complied" });
  await expect.poll(() => seen.patches.length).toBe(2);
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);
});

test("6b. next occurrence: a recurring task's completion says the next one was created, and when it is due", async ({ page }) => {
  const seen = await mockApi(page, { next: { id: "t-next", title: "Quarterly ALM return", dueAt: "2026-11-14T09:00:00.000Z" } });
  await open(page);
  await page.getByText("Annual audit plan").click();
  await page.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "Under review" });
  await expect.poll(() => seen.patches.length).toBe(1);
  await expect(page.getByTestId("task-warnings")).toContainText('Next one created: "Quarterly ALM return", due 14 Nov.');
});

async function startDrag(page: Page, title: string) {
  // The last drag's overlay copy of the card is gone (its drop animation ends) before the next drag starts.
  const card = page.getByTestId("task-title").filter({ hasText: title });
  await expect(card).toHaveCount(1);
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 25, { steps: 5 });
}
async function dropOn(page: Page, key: string) {
  const box = (await column(page, key).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 8 });
  await page.mouse.up();
}

test("7. moves: under a strict lifecycle the board greys out the moves it forbids, with the reason, and sends nothing", async ({ page }) => {
  // Every column on screen, so a drag and a drop land where they are aimed.
  await page.setViewportSize({ width: 2700, height: 900 });
  const seen = await mockApi(page);
  await open(page, "&enforce=strict&role=member");
  await startDrag(page, "Board KYC policy review");
  // From "Not started": Start is allowed; Submit evidence needs the evidence; nothing leads to the rest.
  await expect(column(page, "in_progress")).not.toHaveAttribute("data-move-blocked", /.*/);
  await expect(column(page, "evidence_submitted")).toHaveAttribute("data-move-blocked", "true");
  await expect(column(page, "evidence_submitted")).toHaveAttribute("title", /needs "Evidence"/);
  await expect(column(page, "under_review")).toHaveAttribute("title", /"Not started" cannot move to "Under review"/);
  await expect(column(page, "closed")).toHaveAttribute("data-move-blocked", "true");
  // A role-limited move, for a member: refused here too (the API stays the authority).
  await expect(column(page, "not_applicable")).toHaveAttribute("title", /only owner or admin may make it/);
  await dropOn(page, "under_review");
  await page.waitForTimeout(300);
  expect(seen.patches).toEqual([]);
  await expect(column(page, "not_started")).toContainText("Board KYC policy review");
  await expect(column(page, "under_review")).not.toHaveAttribute("data-move-blocked", /.*/);

  await startDrag(page, "Board KYC policy review");
  await dropOn(page, "in_progress");
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "t2", body: { custom: { state: "in_progress" }, actor: ME } });

  // `not_by`: the owner may not take their own work for review; another person may.
  await startDrag(page, "Fire drill report");
  await expect(column(page, "under_review")).toHaveAttribute("title", /not by the owner/i);
  await dropOn(page, "under_review");
  await startDrag(page, "Quarterly ALM return");
  await expect(column(page, "under_review")).not.toHaveAttribute("data-move-blocked", /.*/);
  await expect(column(page, "closed")).toHaveAttribute("data-move-blocked", "true");
  await dropOn(page, "under_review");
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1]).toEqual({ id: "t1", body: { custom: { state: "under_review" }, actor: ME } });
});

test("7b. moves: the same board under warn offers every column", async ({ page }) => {
  await page.setViewportSize({ width: 2700, height: 900 });
  await mockApi(page);
  await open(page);
  await startDrag(page, "Board KYC policy review");
  await expect(page.locator("[data-move-blocked]")).toHaveCount(0);
  await page.mouse.up();
});

test("8. a move that needs a comment asks why, from the board and from the detail, and sends it as the reason", async ({ page }) => {
  await page.setViewportSize({ width: 2700, height: 900 });
  const seen = await mockApi(page);
  await open(page, "&enforce=strict&role=owner");
  // As an owner, "Not applicable" is a move there is, with a comment: offered, and the drop asks.
  await startDrag(page, "Board KYC policy review");
  await expect(column(page, "not_applicable")).not.toHaveAttribute("data-move-blocked", /.*/);
  await dropOn(page, "not_applicable");
  const dialog = page.getByTestId("move-reason");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('"Board KYC policy review" from Not started to Not applicable needs a comment saying why.');
  await expect(dialog.getByRole("button", { name: "Move" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(seen.patches).toEqual([]);

  await startDrag(page, "Board KYC policy review");
  await dropOn(page, "not_applicable");
  await dialog.getByLabel("Reason").fill("Repealed by the new rules");
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "t2", body: { custom: { state: "not_applicable" }, reason: "Repealed by the new rules", actor: ME } });

  // The detail's state choice asks the same.
  await page.getByText("Quarterly ALM return").click();
  await page.locator("label", { hasText: /^Status/ }).locator("select").selectOption({ label: "In progress" });
  await expect(dialog).toContainText("Ask for more evidence");
  await dialog.getByLabel("Reason").fill("The scan is unreadable");
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1]).toEqual({ id: "t1", body: { custom: { state: "in_progress" }, reason: "The scan is unreadable", actor: ME } });
});

test("8b. the detail under strict, for a member: a role-limited state cannot be chosen", async ({ page }) => {
  await mockApi(page);
  await open(page, "&enforce=strict&role=member");
  await page.getByText("Board KYC policy review").click();
  const status = page.locator("label", { hasText: /^Status/ }).locator("select");
  // (Playwright reads an <option>'s enabled state from its <select>: the attribute is what the browser honours.)
  await expect(status.locator('option[value="not_applicable"]')).toHaveAttribute("disabled", "");
  await expect(status.locator('option[value="not_applicable"]')).toHaveAttribute("title", /only owner or admin may make it/);
  await expect(status.locator('option[value="in_progress"]')).not.toHaveAttribute("disabled", /.*/);
});
