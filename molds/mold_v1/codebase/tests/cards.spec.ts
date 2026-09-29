import { expect, test } from "@playwright/test";

/**
 * Visual + structural checks for the redesigned workspace list cards, against
 * the auth-free preview at /preview/cards. Verifies the cards render, carry the
 * expected content, respond to selection, and captures screenshots.
 */
test("workspace cards render and select", async ({ page }) => {
  await page.goto("/preview/cards");

  // Both boards present.
  await expect(page.getByTestId("tasks-board")).toBeVisible();
  await expect(page.getByTestId("impl-board")).toBeVisible();

  // Task cards: at least the six mocked titles render.
  const titles = page.getByTestId("task-title");
  await expect(titles.first()).toBeVisible();
  expect(await titles.count()).toBeGreaterThanOrEqual(6);

  // A known task title is present.
  await expect(page.getByText("Wire the circular scraper into the assistant's data layer")).toBeVisible();

  // Deployment cards render as cards (not a table).
  await expect(page.getByTestId("deploy-grid")).toBeVisible();
  expect(await page.getByTestId("deploy-title").count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByText("2.3.1")).toBeVisible();

  // Sprint cards render (title + burndown), matching the implementation layout.
  // recharts' ResponsiveContainer draws its <svg> only after its ResizeObserver
  // has measured the card, so wait for the first chart before counting them.
  await expect(page.getByTestId("sprint-cards")).toBeVisible();
  const sprintCharts = page.getByTestId("sprint-cards").locator("svg.recharts-surface");
  await expect(sprintCharts.first()).toBeVisible();
  expect(await sprintCharts.count()).toBeGreaterThanOrEqual(1);

  // Implementation cards: the four customers render.
  for (const c of ["Example Bank", "Example Housing Finance", "Example Mutual Bank", "Example Asset Manager"]) {
    await expect(page.getByTestId("impl-customer").filter({ hasText: c })).toBeVisible();
  }

  // Selection: clicking a card toggles its selected styling (border-foreground/30).
  const secondTask = page.getByTestId("t-0-1");
  await secondTask.click();
  await expect(secondTask).toHaveClass(/border-foreground\/30/);

  // Each implementation card renders a burndown chart (recharts <svg>).
  const charts = page.getByTestId("impl-board").locator("svg.recharts-surface");
  await expect(charts.first()).toBeVisible();
  expect(await charts.count()).toBeGreaterThanOrEqual(4);

  // Screenshots for the record.
  await page.screenshot({ path: "test-results/cards-full.png", fullPage: true });
  await page.getByTestId("tasks-board").screenshot({ path: "test-results/tasks-board.png" });
  await page.getByTestId("deploy-grid").screenshot({ path: "test-results/deploy-grid.png" });
  await page.getByTestId("sprint-cards").screenshot({ path: "test-results/sprint-cards.png" });
  await page.getByTestId("impl-board").screenshot({ path: "test-results/impl-board.png" });
});
