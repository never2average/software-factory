import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * What a panel offers is what the person's role may do (records.areas.<area>.permissions; agent/lib/
 * record-permissions.ts), and the declared metrics sit above an account area's list, counted by the server: the REAL
 * TodosPanel through /preview/record-areas, every API call answered here.
 *
 *   - a filing (profile=filing, the live packs' rule): a member is offered no delete and cannot edit the reviewer;
 *     an admin is offered both;
 *   - a programme (profile=permissions): a member is offered no "Add" and edits only the programme they own, never
 *     its risk; another's is read-only, its moves disabled; an engineer is offered "Add";
 *   - a task (profile=permissions): a member is offered no delete; an admin is;
 *   - an area that declares no permissions asks nobody's role and offers everything, as before;
 *   - the metrics strip shows the server's counts (GET /api/ops/record-metrics), flagged for attention, and asks
 *     again after a write; an area that declares none never asks.
 */
const ME = "reviewer@example.com";
const NOW = "2026-10-14T07:00:00.000Z";
type Seen = { roleAsks: number; metricAsks: string[]; patches: { id: string; body: Record<string, unknown> }[] };

async function mockApi(page: Page, opts: { role?: string; area: "deployments" | "implementations" | "tasks"; items: Record<string, unknown>[]; metrics?: Record<string, unknown>[] }): Promise<Seen> {
  const seen: Seen = { roleAsks: 0, metricAsks: [], patches: [] };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/ops/me/workspaces") {
      seen.roleAsks += 1;
      return route.fulfill({ json: { memberships: opts.role ? [{ orgId: "ws-a", role: opts.role }] : [], active: "ws-a", email: ME } });
    }
    if (url.pathname === "/api/ops/record-metrics") {
      seen.metricAsks.push(url.searchParams.get("area") ?? "");
      return route.fulfill({ json: { metrics: opts.metrics ?? [] } });
    }
    if (url.pathname === "/api/ops/customers") return route.fulfill({ json: { items: [{ id: "acme", label: "Acme Finance" }] } });
    const path = opts.area === "tasks" ? "/api/ops/todos" : `/api/ops/${opts.area}`;
    if (url.pathname === path && req.method() === "GET") return route.fulfill({ json: { items: opts.items } });
    const one = new RegExp(`^${path}/([^/]+)$`).exec(url.pathname);
    if (one && req.method() === "PATCH") {
      seen.patches.push({ id: decodeURIComponent(one[1]), body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}

const filing = (id: string, values: Record<string, unknown>) => ({
  id, label: `${values.runtime} · ${values.deployedVersion}`, title: `${values.runtime} · ${values.deployedVersion}`, displayName: null, owner: values.deployOwnerEmail ?? null,
  customer: "acme", customerLabel: "Acme Finance", values, custom: {},
});
const programme = (customer: string, label: string, owner: string) => ({
  id: customer, label, title: label, displayName: null, owner, customer, customerLabel: label,
  values: { implementationStage: "Discovery", implementationRiskLevel: "Green", implementationProgressPct: 40, implementationOwnerEmail: owner, targetGoLiveDate: "2026-12-31" }, custom: {},
});
const task = (id: string, title: string, assignee: string) => ({
  id, orgId: "o", title, notes: null, done: false, doneAt: null, status: "open", priority: "normal", dueAt: null,
  containerType: null, containerId: null, containerLabel: null, linkType: null, linkId: null, linkLabel: null,
  cycleId: null, parentId: null, createdBy: ME, assignee, archivedAt: null, createdAt: NOW, updatedAt: NOW, workflow: null, custom: { state: "not_started" },
});
/** The "…" menu of the open detail, opened; its items. */
async function actionsMenu(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

for (const [role, may] of [["member", false], ["admin", true]] as const) {
  test(`a filing, as ${role === "admin" ? "an admin" : "a member"}: delete and the reviewer are ${may ? "offered" : "not offered"}; the rest is editable`, async ({ page }) => {
    const seen = await mockApi(page, { role, area: "deployments", items: [filing("Q2-ALM", { runtime: "Periodic return", deployedVersion: "Q2 FY27", releaseStatus: "pending-approval", deployOwnerEmail: "ana@acme.test", due_date: "2026-10-31" })] });
    await page.goto("/preview/record-areas?profile=filing&view=deployments");
    const panel = page.getByTestId("record-area-deployments");
    await expect.poll(() => seen.roleAsks).toBeGreaterThan(0);
    // Anyone adds a filing (create "*").
    await expect(panel.getByRole("button", { name: "Add filing" })).toBeVisible();
    await panel.locator("tbody tr").first().locator('[data-col="account"]').click();
    const detail = page.getByTestId("record-detail");
    const reviewer = detail.locator('[data-record-field="approvedByEmail"] input');
    await expect(reviewer).toBeVisible();
    if (may) await expect(reviewer).toBeEnabled();
    else await expect(reviewer).toBeDisabled();
    await expect(detail.locator('[data-record-field="due_date"] input')).toBeEnabled();
    const menu = await actionsMenu(page);
    await expect(menu.getByText("Share link")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(may ? 1 : 0);
  });
}

test("a programme, as a member: no Add; their own is editable but not its risk; another's is read-only and cannot be moved", async ({ page }) => {
  await mockApi(page, { role: "member", area: "implementations", items: [programme("acme", "Mine", ME), programme("beta", "Theirs", "someone@else.test")] });
  await page.goto("/preview/record-areas?profile=permissions&view=implementations");
  const panel = page.getByTestId("record-area-implementations");
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /^Add/ })).toHaveCount(0);
  await panel.locator('[data-col="account"]', { hasText: "Mine" }).click();
  const detail = page.getByTestId("record-detail");
  await expect(detail.locator('[data-record-field="implementationProgressPct"] input')).toBeEnabled();
  await expect(detail.locator('[data-record-field="implementationStage"] select')).toBeEnabled();
  await expect(detail.locator('[data-record-field="implementationRiskLevel"] select')).toBeDisabled();
  await expect(detail.getByRole("textbox", { name: "Title" })).not.toHaveAttribute("readonly", "");
  await panel.locator('[data-col="account"]', { hasText: "Theirs" }).click();
  await expect(detail.locator('[data-record-field="implementationProgressPct"] input')).toBeDisabled();
  await expect(detail.locator('[data-record-field="implementationStage"] select')).toBeDisabled();
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveAttribute("readonly", "");
  for (const b of await detail.getByTestId("lifecycle-moves").getByRole("button").all()) await expect(b).toBeDisabled();
  const menu = await actionsMenu(page);
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(0);
});

test("a programme, as an engineer: Add is offered (create owner, admin, engineer)", async ({ page }) => {
  const seen = await mockApi(page, { role: "engineer", area: "implementations", items: [programme("acme", "Mine", ME)] });
  await page.goto("/preview/record-areas?profile=permissions&view=implementations");
  await expect.poll(() => seen.roleAsks).toBeGreaterThan(0);
  await expect(page.getByTestId("record-area-implementations").getByRole("button", { name: /^Add/ })).toBeVisible();
});

for (const [role, may] of [["member", false], ["admin", true]] as const) {
  test(`a task, as ${role === "admin" ? "an admin" : "a member"}: delete is ${may ? "" : "not "}offered`, async ({ page }) => {
    const seen = await mockApi(page, { role, area: "tasks", items: [task("t1", "Quarterly ALM return", ME)] });
    await page.goto("/preview/record-areas?profile=permissions&view=tasks");
    await expect.poll(() => seen.roleAsks).toBeGreaterThan(0);
    await page.getByText("Quarterly ALM return").click();
    const menu = await actionsMenu(page);
    await expect(menu.getByText("Share link")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(may ? 1 : 0);
  });
}

test("an area that declares no permissions asks nobody's role and offers delete, as before", async ({ page }) => {
  const seen = await mockApi(page, { area: "deployments", items: [filing("R1", { runtime: "Sector note", deployedVersion: "Q2", releaseStatus: "in-progress" })] });
  await page.goto("/preview/record-areas?profile=coverage&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await panel.locator("tbody tr").first().locator('[data-col="account"]').click();
  const menu = await actionsMenu(page);
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(1);
  expect(seen.roleAsks).toBe(0);
});

test("the metrics: the server's counts above the list, flagged for attention, asked again after a write", async ({ page }) => {
  const seen = await mockApi(page, {
    role: "admin",
    area: "deployments",
    items: [filing("Q2-ALM", { runtime: "Periodic return", deployedVersion: "Q2 FY27", releaseStatus: "in-progress", due_date: "2026-10-31" })],
    metrics: [
      { id: "overdue", label: "Overdue filings", value: 3, text: "3", attention: true, format: "count" },
      { id: "on-time-rate", label: "Filed on time", value: 50, text: "50%", attention: false, format: "percent" },
    ],
  });
  await page.goto("/preview/record-areas?profile=filing&view=deployments");
  const strip = page.getByTestId("record-metrics");
  await expect(strip.locator("[data-metric]")).toHaveCount(2);
  await expect(strip.locator('[data-metric="overdue"]')).toHaveText("Overdue filings3");
  await expect(strip.locator('[data-metric="overdue"]')).toHaveAttribute("data-attention", "true");
  await expect(strip.locator('[data-metric="on-time-rate"]')).toHaveText("Filed on time50%");
  await expect(strip.locator('[data-metric="on-time-rate"]')).not.toHaveAttribute("data-attention", "true");
  expect(new Set(seen.metricAsks)).toEqual(new Set(["deployments"]));
  const asked = seen.metricAsks.length;
  await page.getByTestId("record-area-deployments").locator("tbody tr").first().locator('[data-col="account"]').click();
  const due = page.getByTestId("record-detail").locator('[data-record-field="due_date"] input');
  await due.fill("2026-11-15");
  await due.blur();
  await expect.poll(() => seen.patches.length).toBe(1);
  await expect.poll(() => seen.metricAsks.length).toBeGreaterThan(asked);
});

test("an area that declares no metrics never asks for them and shows no strip", async ({ page }) => {
  const seen = await mockApi(page, { area: "implementations", items: [programme("acme", "Mine", ME)] });
  await page.goto("/preview/record-areas?profile=programme&view=implementations");
  await expect(page.getByTestId("record-area-implementations").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("record-metrics")).toHaveCount(0);
  expect(seen.metricAsks).toEqual([]);
});
