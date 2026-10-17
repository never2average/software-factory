import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { redefinedAreas } from "./build-definitions";

/**
 * The two account record areas drawn from their definition (profiles records.areas.deployments / .implementations in
 * the record-area form): the REAL TodosPanel through /preview/record-areas, every API call answered here, every request
 * the panel makes asserted.
 *
 *   - "Regulatory filing" (the record-areas design's worked example (a)): the table's columns and words, choices with
 *     their tones, a computed field, the filters and sorts asked of the SERVER, the board's columns, the detail's
 *     sections and lifecycle moves, the create form checked by the validator the API runs;
 *   - "Compliance programme" (implementations): own fields the legacy form lacks (a multi-pick, files, money, a yes/no)
 *     on the form and the detail, saved under `custom`;
 *   - the DEFAULT definitions: today's lists, the DOM byte for byte the one upstream main rendered
 *     (tests/fixtures/record-area-legacy-dom.json, recorded at fc2ea3e with RECORD_LEGACY_DOM=1).
 */
const ME = "reviewer@example.com";
type Seen = { gets: URLSearchParams[]; posts: Record<string, unknown>[]; patches: { id: string; body: Record<string, unknown> }[] };

async function mockApi(page: Page, area: "deployments" | "implementations", items: Record<string, unknown>[]): Promise<Seen> {
  const seen: Seen = { gets: [], posts: [], patches: [] };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/ops/customers") return route.fulfill({ json: { items: [{ id: "acme", label: "Acme Finance" }, { id: "beta", label: "Beta Housing" }] } });
    if (url.pathname === `/api/ops/${area}` && req.method() === "GET") {
      seen.gets.push(url.searchParams);
      return route.fulfill({ json: { items } });
    }
    if (url.pathname === `/api/ops/${area}` && req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      return route.fulfill({ status: 201, json: { item: { id: String(body.deploymentId ?? body.customerId) }, created: true } });
    }
    const one = new RegExp(`^/api/ops/${area}/([^/]+)$`).exec(url.pathname);
    if (one && req.method() === "PATCH") {
      seen.patches.push({ id: decodeURIComponent(one[1]), body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}
const lastWhere = (seen: Seen) => JSON.parse(seen.gets.at(-1)?.get("where") ?? "null");
const headers = (page: Page) => page.locator("table thead th").evaluateAll((ths) => ths.map((t) => t.textContent?.trim() ?? ""));

const filing = (id: string, customer: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, label: `${values.runtime} · ${values.deployedVersion}`, title: `${values.runtime} · ${values.deployedVersion}`, displayName: null, owner: values.deployOwnerEmail ?? null,
  customer, customerLabel: customer === "acme" ? "Acme Finance" : "Beta Housing", values, custom: {}, ...extra,
});

test("a regulatory filing: the table, its words and tones, the computed timeliness, filters and sorts asked of the server", async ({ page }) => {
  const items = [
    filing("Q2-ALM", "acme", { runtime: "Periodic return", deployedVersion: "Q2 FY27", releaseStatus: "in-progress", due_date: "2026-10-01", timeliness: "Overdue", penalty_exposure: "Late fee", deployOwnerEmail: "ana@acme.test" }),
    filing("Q1-ALM", "beta", { runtime: "Periodic return", deployedVersion: "Q1 FY27", releaseStatus: "deployed", due_date: "2026-07-31", lastDeployAt: "2026-07-30", timeliness: "On time" }),
  ];
  const seen = await mockApi(page, "deployments", items);
  await page.goto("/preview/record-areas?profile=filing&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  // The nav names the area in the example's word (the build's own areas are listed beside it, and may share it).
  await expect(page.getByRole("button", { name: "Regulatory filings" }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add filing" })).toBeVisible();
  await expect(panel.locator("table")).toBeVisible();
  const account = (await headers(page))[0];
  expect(await headers(page)).toEqual([account, "Type", "Period", "Due date", "Status", "Timeliness", "Penalty exposure", "Preparer"]);
  const first = panel.locator("tbody tr").first();
  await expect(first.locator('[data-col="account"]')).toHaveText("Acme Finance");
  await expect(first.locator('[data-col="releaseStatus"]')).toHaveText("In preparation");
  await expect(first.locator('[data-col="releaseStatus"] [data-tone]')).toHaveAttribute("data-tone", "amber");
  await expect(first.locator('[data-col="timeliness"] [data-tone]')).toHaveAttribute("data-tone", "red");
  await expect(first.locator('[data-col="timeliness"]')).toHaveText("Overdue");
  await expect(first.locator('[data-col="deployOwnerEmail"]')).toHaveText("ana");

  // The list is asked of the server: the definition's default sort, then the picks of the Filter menu.
  expect(seen.gets.at(-1)?.get("sort")).toBe("due_date");
  expect(lastWhere(seen)).toEqual({});
  await panel.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Filed", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Overdue" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => JSON.stringify(lastWhere(seen))).toContain("category");
  expect(lastWhere(seen)).toMatchObject({ releaseStatus: { in: ["deployed"], category: ["backlog", "open", "active", "blocked"] }, due_date: { lt: expect.any(String) } });
  await panel.getByRole("button", { name: "Views" }).click();
  await page.getByRole("menuitemradio", { name: /Penalty exposure|Status/ }).first().click();
  await expect.poll(() => seen.gets.at(-1)?.get("sort")).toBe("releaseStatus");
  await panel.locator("input[type=search], input").first().fill("ALM");
  await expect.poll(() => seen.gets.at(-1)?.get("q")).toBe("ALM");
});

test("a regulatory filing: the board's columns are its states in order, the detail's sections and lifecycle moves", async ({ page }) => {
  const items = [filing("Q2-ALM", "acme", { runtime: "Periodic return", deployedVersion: "Q2 FY27", releaseStatus: "in-progress", due_date: "2026-10-01", timeliness: "Overdue", deployOwnerEmail: "ana@acme.test" }, { custom: { due_date: "2026-10-01" } })];
  const seen = await mockApi(page, "deployments", items);
  await page.goto("/preview/record-areas?profile=filing&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await panel.getByTestId("record-modes").getByRole("button", { name: "Board" }).click();
  const labels = await panel.locator("[data-board-column] > div:first-child > span.font-medium").allInnerTexts();
  expect(labels).toEqual(["In preparation", "Awaiting sign-off", "Filed", "Revised / refiled", "Missed"]);
  await expect(panel.locator('[data-board-column="in-progress"]')).toContainText("Periodic return · Q2 FY27");
  await expect(panel.locator('[data-board-column="in-progress"]')).toContainText("Overdue");

  await panel.getByText("Periodic return · Q2 FY27").click();
  const detail = page.getByTestId("record-detail");
  for (const s of ["Filing", "Sign-off", "Basis"]) await expect(detail.getByText(s, { exact: true })).toBeVisible();
  await expect(detail.locator('[data-record-value="timeliness"]')).toHaveText("Overdue");
  await expect(detail.locator('[data-record-field="releaseStatus"] select option:checked')).toHaveText("In preparation");
  // The moves the transitions allow from here (a role-limited one is the API's to refuse, and says so).
  await expect(detail.getByTestId("lifecycle-moves").getByRole("button")).toHaveText(["Send for sign-off", "Mark missed"]);
  await detail.getByRole("button", { name: "Send for sign-off" }).click();
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "Q2-ALM", body: { customerId: "acme", releaseStatus: "pending-approval", actor: ME } });
  const due = detail.locator('[data-record-field="due_date"] input');
  await expect(due).toHaveValue("2026-10-01");
  await due.fill("2026-10-15");
  await due.blur();
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1]).toEqual({ id: "Q2-ALM", body: { customerId: "acme", custom: { due_date: "2026-10-15" }, actor: ME } });
});

test("a regulatory filing's create form: the definition's fields, {me}, the validator's sentences, the stored values sent", async ({ page }) => {
  const seen = await mockApi(page, "deployments", []);
  await page.goto("/preview/record-areas?profile=filing&view=deployments");
  await expect(page.getByText("No regulatory filings yet — hit Add filing.")).toBeVisible();
  await page.getByTestId("record-area-deployments").getByRole("button", { name: "Add filing" }).click();
  const form = page.getByTestId("record-create");
  const fieldLabels = await form.locator("[data-record-field] > label > span").allInnerTexts();
  expect(fieldLabels.slice(1)).toEqual(["Filing id *", "Filing type *", "Period *", "Due date *", "Preparer", "Source requirement"]);
  await expect(form.locator('[data-record-field="deployOwnerEmail"] input')).toHaveValue(ME);
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect(form.locator('[data-record-field="runtime"]').getByRole("alert")).toHaveText('"Filing type" (runtime) is required.');
  await expect(form.locator('[data-record-field="due_date"]').getByRole("alert")).toHaveText('"Due date" (due_date) is required.');
  expect(seen.posts).toEqual([]);
  await form.locator('[data-record-field="account"] select').selectOption("acme");
  await form.locator('[data-record-field="deploymentId"] input').fill("bad id!");
  await form.locator('[data-record-field="runtime"] select').selectOption({ label: "Periodic return" });
  await form.locator('[data-record-field="deployedVersion"] input').fill("Q2 FY27");
  await form.locator('[data-record-field="due_date"] input').fill("2026-10-31");
  await form.locator('[data-record-field="source_requirement"] input').fill("https://rbi.example/circular#4");
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect(form.locator('[data-record-field="deploymentId"]').getByRole("alert")).toContainText("is not in the expected form");
  expect(seen.posts).toEqual([]);
  await form.locator('[data-record-field="deploymentId"] input').fill("Q2FY27-ALM-return");
  await form.getByRole("button", { name: "Add filing" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0]).toEqual({
    customerId: "acme",
    runtime: "Periodic return",
    deployedVersion: "Q2 FY27",
    deployOwnerEmail: ME,
    custom: { due_date: "2026-10-31", source_requirement: "https://rbi.example/circular#4" },
    deploymentId: "Q2FY27-ALM-return",
    actor: ME,
  });
});

test("a compliance programme: own fields the legacy form lacks (multi-pick, files, money, yes/no) on the form and the detail", async ({ page }) => {
  const items = [
    {
      id: "acme", label: "Gap assessment · RBI", title: "Gap assessment · RBI", displayName: null, owner: ME, customer: "acme", customerLabel: "Acme Finance",
      values: { implementationStage: "Discovery", implementationRiskLevel: "Red", implementationProgressPct: 40, regulators: ["RBI"], evidence: ["acme/evidence/gap.pdf"], budget: 125000, board_approved: false, implementationOwnerEmail: ME },
      custom: { regulators: ["RBI"], evidence: ["acme/evidence/gap.pdf"], budget: 125000, board_approved: false },
    },
  ];
  const seen = await mockApi(page, "implementations", items);
  await page.goto("/preview/record-areas?profile=programme&view=implementations");
  const panel = page.getByTestId("record-area-implementations");
  await expect(page.getByRole("button", { name: "Compliance programmes" })).toBeVisible();
  const account = (await headers(page))[0];
  expect(await headers(page)).toEqual([account, "Phase", "Risk", "Regulators", "Budget", "Target date", "Programme lead"]);
  await expect(panel.locator('[data-col="budget"]')).toHaveText("125,000 INR");
  await expect(panel.locator('[data-col="implementationRiskLevel"] [data-tone]')).toHaveAttribute("data-tone", "red");
  expect(seen.gets.at(-1)?.get("sort")).toBe("targetGoLiveDate");

  await panel.locator('[data-col="account"]', { hasText: "Acme Finance" }).click();
  const detail = page.getByTestId("record-detail");
  await expect(detail.getByText("Scope and evidence", { exact: true })).toBeVisible();
  await detail.locator('[data-record-field="regulators"]').getByLabel("SEBI").check();
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ id: "acme", body: { customerId: "acme", custom: { regulators: ["RBI", "SEBI"] }, actor: ME } });
  await detail.locator('[data-record-field="board_approved"] input[type=checkbox]').check();
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1].body).toEqual({ customerId: "acme", custom: { board_approved: true }, actor: ME });
  await expect(detail.locator('[data-record-field="evidence"] textarea')).toHaveValue("acme/evidence/gap.pdf");

  await panel.getByRole("button", { name: "Add programme" }).click();
  const form = page.getByTestId("record-create");
  await form.locator('[data-record-field="account"] select').selectOption("beta");
  await form.locator('[data-record-field="regulators"]').getByLabel("NHB").check();
  await form.locator('[data-record-field="budget"] input').fill("-5");
  await form.getByRole("button", { name: "Add programme" }).click();
  await expect(form.locator('[data-record-field="budget"]').getByRole("alert")).toHaveText('"Budget" (budget) must be at least 0.');
  await form.locator('[data-record-field="budget"] input').fill("50000");
  await form.getByRole("button", { name: "Add programme" }).click();
  await expect.poll(() => seen.posts.length).toBe(1);
  expect(seen.posts[0]).toEqual({ customerId: "beta", implementationStage: "Kickoff", custom: { regulators: ["NHB"], budget: "50000" }, actor: ME });
});

/* ------------------------------------------------- an own lifecycle field on rows that hold no own values */

test("an own lifecycle field on rows with no own values: empty everywhere, in no board column, grouped under the empty bucket, the screen never breaks", async ({ page }) => {
  const broke: string[] = [];
  page.on("pageerror", (e) => broke.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /unhandled render error|Cannot read properties/.test(m.text())) broke.push(m.text());
  });
  const row = (id: string, extra: Record<string, unknown>) => ({ id, label: id, title: id, displayName: null, owner: null, customer: "acme", customerLabel: "Acme Finance", ...extra });
  const items = [
    // No `values` at all and `custom` null: an answer in the shape of a build that declares no area.
    row("item-1", { custom: null }),
    // Its values without the stage, and no `custom`: a record written before the profile declared its own fields.
    row("item-2", { values: { deployedVersion: "Second" } }),
    // One with its stage, as the API answers a declared area.
    row("item-3", { values: { deployedVersion: "Third", stage: "working", size: 2 }, custom: { stage: "working", size: 2 } }),
  ];
  await mockApi(page, "deployments", items);
  await page.goto("/preview/record-areas?profile=own-state&view=deployments");
  const panel = page.getByTestId("record-area-deployments");

  // The board (the definition's default view): its columns are the stage's choices, and only the row with one is on it.
  const labels = panel.locator("[data-board-column] > div:first-child > span.font-medium");
  await expect(labels).toHaveText(["Queued", "Working", "Finished"]);
  await expect(panel.locator('[data-board-column="working"]')).toContainText("item-3");
  await expect(panel.getByTestId("record-card")).toHaveCount(1);

  // The table: a row that holds no stage shows it empty.
  await panel.getByTestId("record-modes").getByRole("button", { name: "Table" }).click();
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('[data-col="stage"]')).toHaveText("—");
  await expect(rows.nth(1).locator('[data-col="stage"]')).toHaveText("—");
  await expect(rows.nth(2).locator('[data-col="stage"]')).toHaveText("Working");
  await expect(rows.nth(2).locator('[data-col="stage"] [data-tone]')).toHaveAttribute("data-tone", "amber");

  // Grouped by the stage: the two with none under the empty bucket, last.
  await panel.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Stage", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("group-header")).toHaveText([/^Working\s*1$/, /^—\s*2$/]);

  // The detail of a row with no stage: the control empty, no move offered from a state it is not in.
  await panel.getByTestId("group-section").nth(1).locator('[data-col="account"]').first().click();
  const detail = page.getByTestId("record-detail");
  await expect(detail.locator('[data-record-field="stage"] select')).toHaveValue("");
  await expect(detail.getByTestId("lifecycle-moves")).toHaveCount(0);
  expect(broke).toEqual([]);
});

/* ----------------------------------------------------------------------------- the default definitions */

const LEGACY_DOM = fileURLToPath(new URL("./fixtures/record-area-legacy-dom.json", import.meta.url));
const legacyRows = {
  deployments: [
    { id: "DEP-1", label: "acme · prod · 1.2.0", displayName: null, owner: ME, status: "deployed", health: "healthy", env: "prod", version: "1.2.0", customer: "acme", customerLabel: "Acme Finance", uptime: 99.9, errorRate: 0.1, lastDeployAt: "2026-09-01T00:00:00.000Z", fields: {}, custom: {} },
    { id: "DEP-2", label: "beta · staging · 0.9.0", displayName: null, owner: null, status: "in-progress", health: "degraded", env: "staging", version: "0.9.0", customer: "beta", customerLabel: "Beta Housing", uptime: null, errorRate: null, lastDeployAt: null, fields: {}, custom: {} },
  ],
  implementations: [
    { id: "acme", label: "acme · Discovery", displayName: null, owner: ME, stage: "Discovery", risk: "Red", progress: 40, customer: "acme", customerLabel: "Acme Finance", solutionName: null, goLiveDate: "2026-12-01", fields: {}, custom: {}, readiness: {} },
  ],
} as const;
/** The panel's markup, its generated ids made stable (a counter per render, not what the code draws). */
// The side nav is left out: it lists the other tabs (the period's among them, a word only the profile spells).
const normalised = (html: string) => html.replace(/<nav\b[\s\S]*?<\/nav>/, "<nav/>").replace(/(id|for|aria-controls|aria-labelledby|aria-describedby)="[^"]*:r[0-9a-z]+:[^"]*"/g, '$1="<id>"').replace(/:r[0-9a-z]+:/g, "<id>");

// "Today's two lists" can only be graded on a build whose own definitions of the two areas ARE the default's: the page
// draws them from this build's profile (no `?profile=`), so on a build that redefines or declares either area (a pack's
// profile) its own screen is drawn by design, not the recorded one. The base app's CI runs it; such a build skips it
// with the reason, and its declared screen is graded by the tests above (rows with no own values included).
const REDEFINED_ACCOUNT_AREAS = redefinedAreas(["deployments", "implementations"]);

test("the default definitions: today's two lists, their markup byte for byte the one upstream main rendered", async ({ page }) => {
  test.skip(REDEFINED_ACCOUNT_AREAS.length > 0, `this build's profile redefines ${REDEFINED_ACCOUNT_AREAS.join(", ")}; today's lists are graded on a build whose definitions of them are the default's`);
  const recorded: Record<string, string> = process.env.RECORD_LEGACY_DOM === "1" ? {} : JSON.parse(readFileSync(LEGACY_DOM, "utf8"));
  const now: Record<string, string> = {};
  // Today's cards count days to a date: the clock is fixed so the markup is the same on any day.
  await page.clock.setFixedTime(new Date("2026-10-14T07:00:00.000Z"));
  for (const area of ["deployments", "implementations"] as const) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route(/\/(api|eve)\//, (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: { items: path === `/api/ops/${area}` ? legacyRows[area] : [] } });
    });
    await page.goto(`/preview/record-areas?view=${area}`);
    await expect(page.getByTestId(`record-area-${area}`)).toHaveCount(0);
    await expect(page.getByText("Acme Finance").first()).toBeVisible();
    for (const mode of ["Board", "Table", "Timeline"]) {
      await page.getByRole("button", { name: mode, exact: true }).first().click();
      now[`${area}:${mode}`] = normalised(await page.locator("main").innerHTML());
    }
  }
  if (process.env.RECORD_LEGACY_DOM === "1") {
    writeFileSync(LEGACY_DOM, `${JSON.stringify(now, null, 1)}\n`);
    return;
  }
  for (const k of Object.keys(recorded)) expect(now[k], k).toBe(recorded[k]);
  expect(Object.keys(now).sort()).toEqual(Object.keys(recorded).sort());
});
