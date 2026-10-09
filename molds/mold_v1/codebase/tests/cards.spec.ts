import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DEPLOYMENT_PROFILE } from "../lib/deployment-profile.generated";

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

  // The period cards render (title + burndown), matching the implementation layout.
  // recharts' ResponsiveContainer draws its <svg> only after its ResizeObserver
  // has measured the card, so wait for the first chart before counting them.
  await expect(page.getByTestId("period-cards")).toBeVisible();
  const periodCharts = page.getByTestId("period-cards").locator("svg.recharts-surface");
  await expect(periodCharts.first()).toBeVisible();
  expect(await periodCharts.count()).toBeGreaterThanOrEqual(1);

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
  await page.getByTestId("period-cards").screenshot({ path: "test-results/period-cards.png" });
  await page.getByTestId("impl-board").screenshot({ path: "test-results/impl-board.png" });
});

/**
 * Work periods under each mode a deployment profile can choose (profiles/*.json `work_periods.mode`), rendered from
 * the same components and the same view list the Todos workspace uses (lib/work-periods-ui.ts).
 *   team        the period view is offered, a period is a card with a burndown (above);
 *   individual  the period view is offered under the profile's word, and a period groups by person: the signed-in
 *               person first, each with their own progress, goal and items, and no burndown;
 *   off         the period view is not offered at all.
 */
// "This build" is the build's OWN profile (profiles/*.json merged, lib/deployment-profile.generated.ts), not the
// default's: a deployment's profile may choose another mode (a pack's profile chose individual), and the spec read
// "team" off a build that rightly said "individual" (mold_v1-214/215). The default profile's own mode is read from its
// file, so on the default build this is the same assertion as before, and on any other build it is graded too.
const BUILD_MODE = DEPLOYMENT_PROFILE.work_periods.mode;
const DEFAULT_MODE: string = JSON.parse(readFileSync("profiles/00-default.json", "utf8")).work_periods.mode;

test("work periods follow the profile's mode", async ({ page }) => {
  await page.goto("/preview/cards");
  const views = async (key: string) =>
    page.getByTestId(`period-nav-${key}`).getByTestId("period-nav-entry").evaluateAll((els) => els.map((e) => e.getAttribute("data-view")));

  // The default profile is mode team.
  expect(DEFAULT_MODE).toBe("team");
  // Team: the period view first, then everything else.
  expect(await views("team")).toEqual(["sprints", "tasks", "deployments", "implementations"]);
  // This build renders its own profile's mode, offers exactly the views of that mode's row, and the period view (when
  // the mode has one) reads the profile's word for a period.
  await expect(page.getByTestId("period-nav-this-build")).toHaveAttribute("data-mode", BUILD_MODE);
  expect(await views("this-build")).toEqual(await views(BUILD_MODE));
  if (BUILD_MODE !== "off") {
    const heading = (await page.getByTestId("period-cards").locator("h2").innerText()).trim().toLowerCase();
    expect((await page.getByTestId("period-nav-this-build").getByTestId("period-nav-entry").first().innerText()).trim().toLowerCase()).toBe(heading);
  }

  // Off: no period view, and nothing else moved.
  expect(await views("off")).toEqual(["tasks", "deployments", "implementations"]);

  // Individual: offered, in the profile's word.
  expect(await views("individual")).toEqual(["sprints", "tasks", "deployments", "implementations"]);
  await expect(page.getByTestId("period-nav-individual").getByTestId("period-nav-entry").first()).toHaveText("Weeks");

  // Individual: grouped by person, the signed-in person first, each with their own progress; no burndown.
  const people = page.getByTestId("period-people");
  const blocks = people.getByTestId("period-person");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toHaveAttribute("data-person", "priya@example.com");
  await expect(blocks.first()).toContainText("My targets");
  await expect(blocks.first()).toContainText("1/4 targets done");
  await expect(blocks.first().getByTestId("period-item")).toHaveCount(3);
  await expect(blocks.first().getByPlaceholder("Add a target…")).toBeVisible();
  await expect(blocks.first().getByText("Goal for the week")).toBeVisible();
  // Somebody else's block is read-only: their progress and items, no goal field and nothing to add.
  await expect(blocks.nth(1)).toHaveAttribute("data-person", "arjun@example.com");
  await expect(blocks.nth(1)).toContainText("1/1 target done");
  await expect(blocks.nth(1).getByPlaceholder("Add a target…")).toHaveCount(0);
  await expect(people.getByTestId("period-person-row").first()).toContainText("My targets");
  await expect(people.locator("svg.recharts-surface")).toHaveCount(0);
  await expect(people).not.toContainText(/lead|capacity/i);
  await people.screenshot({ path: "test-results/period-people.png" });
});

/**
 * THE SANDBOX LINE (mold_v1-194): while a command of this chat waits for a free sandbox under the server's running
 * cap, the chat says where in line it is, live, and the line clears when the sandbox opens. Rendered from the real
 * hook and line below the transcript at /preview/user-message, with the agent's answers given here. A build without the cap (Vercel)
 * never asks.
 */
test("sandbox line: shows the place in line live, clears when the sandbox opens; silent without the cap", async ({ page }) => {
  const answers = [[{ position: 3, waitedS: 4 }], [{ position: 2, waitedS: 9 }], [{ position: 1, waitedS: 14 }, { position: 5, waitedS: 1 }], []];
  const asked: string[] = [];
  let i = 0;
  await page.route("**/eve/v1/session/*/sandbox-wait", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4] ?? "");
    asked.push(id);
    const waits = answers[Math.min(i, answers.length - 1)];
    // Each answer is held for a few polls, so every state is on screen long enough to be seen.
    if (asked.filter((a) => a === "capped").length % 3 === 0) i += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, waits }) });
  });
  await page.goto("/preview/user-message");

  const capped = page.getByTestId("chat-capped");
  const line = capped.getByTestId("sandbox-wait");
  await expect(line).toHaveText("Waiting for a free sandbox (3rd in line)…");
  await expect(line).toHaveAttribute("role", "status");
  await expect(line).toHaveText("Waiting for a free sandbox (2nd in line)…");
  // Two of this chat's commands wait: the one nearest the front is said.
  await expect(line).toHaveText("Waiting for a free sandbox (next in line)…");
  // The sandbox opened: the line is gone, "Working…" is back.
  await expect(line).toHaveCount(0);
  await expect(capped.getByTestId("no-wait")).toBeVisible();

  // Without the cap: not one request, and no line.
  await expect(page.getByTestId("chat-uncapped").getByTestId("sandbox-wait")).toHaveCount(0);
  expect(asked.filter((a) => a === "uncapped")).toHaveLength(0);
  expect(asked.filter((a) => a === "capped").length).toBeGreaterThan(3);

  // The turn is over: the chat stops asking.
  await page.getByTestId("toggle-active").click();
  await page.waitForTimeout(400);
  const after = asked.length;
  await page.waitForTimeout(1_000);
  expect(asked.length).toBe(after);
  await page.screenshot({ path: "test-results/sandbox-wait.png" });
});
