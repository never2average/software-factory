import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * THE DEFAULT TASKS VIEW DOES NOT MOVE: the REAL TodosPanel through /preview/record-tasks under this build's own
 * (default) definition of a task, with the clock fixed and every API call answered here, rendered as DOM and compared
 * with the golden recorded before the task area learned to read its definition's views, filter presets, metrics, card
 * fields, words and lifecycle (scripts/fixtures/record-areas/ui/default-tasks.golden.json).
 *
 * The same DOM (tags, attributes, classes, text) under the same stylesheet is the same pixels, and a DOM golden holds
 * on any machine where a screenshot golden would differ by font hinting. Each state is also saved as a screenshot under
 * test-results/ for a person to look at. `UPDATE_GOLDEN=1` rewrites the golden (only ever from the commit before a
 * change that must not move the default view).
 *
 *   - the board (toolbar, columns, cards with their priority, due, assignee, container);
 *   - the table;
 *   - the Filter and Views menus as they open;
 *   - a task's detail.
 */
const GOLDEN = path.join(process.cwd(), "scripts", "fixtures", "record-areas", "ui", "default-tasks.golden.json");
const NOW = "2026-10-14T07:00:00.000Z";
const ME = "reviewer@example.com";
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, orgId: "o", title, notes: null, done: false, doneAt: null, status: "open", priority: "normal", dueAt: null,
  containerType: null, containerId: null, containerLabel: null, linkType: null, linkId: null, linkLabel: null,
  cycleId: null, parentId: null, createdBy: ME, assignee: null, archivedAt: null, createdAt: NOW, updatedAt: NOW, workflow: null,
  ...extra,
});
const ITEMS = () => [
  task("t1", "Chase the invoice", { status: "in_progress", priority: "high", dueAt: "2026-10-10T09:00:00.000Z", assignee: "ana@example.com", createdAt: "2026-10-01T07:00:00.000Z" }),
  task("t2", "Write the summary", { status: "open", priority: "low", dueAt: "2026-10-20T09:00:00.000Z", containerType: "deployment", containerId: "d1", containerLabel: "First one", createdAt: "2026-10-02T07:00:00.000Z" }),
  task("t3", "Plan the week", { status: "backlog", createdAt: "2026-10-03T07:00:00.000Z" }),
  task("t4", "Send the notes", { status: "done", done: true, doneAt: NOW, priority: "normal", assignee: ME, createdAt: "2026-10-04T07:00:00.000Z" }),
  task("t5", "Fix the build", { status: "blocked", priority: "high", dueAt: "2026-11-30T09:00:00.000Z", createdAt: "2026-10-05T07:00:00.000Z" }),
];

async function mockApi(page: Page) {
  const items = ITEMS();
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/ops/todos") return route.fulfill({ json: { items } });
    return route.fulfill({ json: { items: [] } });
  });
}

/** The panel as DOM: generated ids (React's useId, dnd-kit's) are the only thing a render may number differently. */
async function dom(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector("main")!.cloneNode(true) as HTMLElement;
    const ID = /«[^»]*»|:r[0-9a-z]+:|_r_[0-9a-z]+_|radix-[^\s"]+|DndDescribedBy-\d+|DndLiveRegion-\d+/g;
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      for (const a of Array.from(el.attributes)) {
        if (ID.test(a.value)) el.setAttribute(a.name, a.value.replace(ID, "ID"));
        ID.lastIndex = 0;
      }
    }
    return root.outerHTML.replace(/></g, ">\n<");
  });
}
/** An open menu (Radix renders it in a portal, outside <main>). */
async function menu(page: Page): Promise<string> {
  const el = page.getByRole("menu");
  await expect(el).toBeVisible();
  return (await el.evaluate((m) => m.outerHTML)).replace(/«[^»]*»|:r[0-9a-z]+:|_r_[0-9a-z]+_|radix-[^\s"]+/g, "ID").replace(/></g, ">\n<");
}

test("the default definition: the Tasks view is the golden one (board, table, menus, detail)", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await mockApi(page);
  await page.goto("/preview/record-tasks");
  await expect(page.getByText("Chase the invoice")).toBeVisible();
  const shot = async (name: string) => page.screenshot({ path: `test-results/task-area-default-${name}.png` });
  const got: Record<string, string> = {};

  got.board = await dom(page);
  await shot("board");
  await page.getByRole("button", { name: "Filter" }).click();
  got.filterMenu = await menu(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Views" }).click();
  got.viewsMenu = await menu(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.locator("table")).toBeVisible();
  got.table = await dom(page);
  await shot("table");
  await page.getByRole("button", { name: "Timeline" }).click();
  got.timeline = await dom(page);
  await page.getByRole("button", { name: "Board" }).click();
  await page.getByText("Chase the invoice").click();
  await expect(page.getByPlaceholder("Untitled task")).toHaveValue("Chase the invoice");
  got.detail = await dom(page);
  await shot("detail");

  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(path.dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
  for (const key of Object.keys(golden)) expect(got[key], `the default Tasks view's ${key} moved`).toBe(golden[key]);
  expect(Object.keys(got)).toEqual(Object.keys(golden));
});
