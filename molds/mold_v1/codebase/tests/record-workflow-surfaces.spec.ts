import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * A record's workflow on its screens (docs/WORKFLOW_ENGINE.md phase 7 "Surfaces"; app/_components/ops/record-workflow.tsx):
 * the REAL TodosPanel through /preview/record-areas?profile=workflow (the maker-checker review,
 * scripts/fixtures/record-workflows/review.json), every API call answered here, every request asserted.
 *
 *   - a card says which step the record waits on, who holds it (names, as the server shows them) and when it is due,
 *     red when it is past; the cards' lines are asked for in ONE call for the page;
 *   - the detail shows the next step, every step with its holders and due date, and the step timeline;
 *   - a supervisor (the server offers who may hold each step) hands a step to someone, and extends a due date; what
 *     the server refuses is shown with its sentence; a member is offered neither holder control;
 *   - a task's detail shows its workflow the same way;
 *   - a profile whose lifecycles run no workflow asks for nothing (no record-workflow call is made).
 */
type Seen = { reads: URLSearchParams[]; posts: { path: string; body: Record<string, unknown> }[] };

const row = (id: string, state: string) => ({
  id, label: `Release ${id}`, title: `Release ${id}`, displayName: null, owner: null, customer: "acme", customerLabel: "Acme Finance",
  // As the API answers a declared area: an own field under `values` and `custom` both.
  values: { deploymentId: id, environment: "prod", review_state: state }, custom: { review_state: state },
});

const WORKFLOW = {
  next: { id: "review", title: "Review", state: "open", active: true, holders: [{ name: "Cy Checker" }, { name: "someone with no name on the roster" }], due_on: "2026-05-09T09:00:00.000Z", overdue: false },
  finished: false,
  steps: [
    { id: "prepare", title: "Prepare", state: "completed", active: true, holders: [{ name: "Mara Maker" }], due_on: "2026-05-07T09:00:00.000Z", overdue: false },
    { id: "review", title: "Review", state: "open", active: true, holders: [{ name: "Cy Checker" }, { name: "someone with no name on the roster" }], due_on: "2026-05-09T09:00:00.000Z", overdue: false },
  ],
  timeline: [
    { at: "2026-05-04T09:00:00.000Z", who: "Mara Maker", step: null, what: "The workflow started", kind: "placed" },
    { at: "2026-05-04T10:00:00.000Z", who: "Mara Maker", step: "Prepare", what: "Evidence on Prepare: doc://evidence/1", kind: "evidence" },
    { at: "2026-05-04T10:00:00.000Z", who: "Mara Maker", step: "Prepare", what: "Prepare completed", kind: "decision" },
    { at: "2026-05-04T10:00:00.000Z", who: "the workflow", step: "Review", what: "Review opened", kind: "rule" },
  ],
};

async function mockApi(page: Page, opts: { supervisor: boolean; refuseDue?: string } = { supervisor: true }): Promise<Seen> {
  const seen: Seen = { reads: [], posts: [] };
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/ops/customers") return route.fulfill({ json: { items: [{ id: "acme", label: "Acme Finance" }] } });
    if (url.pathname === "/api/ops/deployments" && req.method() === "GET") return route.fulfill({ json: { items: [row("D-1", "in_review"), row("D-2", "drafting")] } });
    if (url.pathname === "/api/ops/todos" && req.method() === "GET") {
      return route.fulfill({ json: { items: [{ id: "6b0c1f0e-1111-4222-8333-944445555666", title: "Prepare the pack", notes: null, done: false, status: "open", priority: "normal", dueAt: null, containerType: null, containerId: null, containerLabel: null, linkType: null, linkId: null, linkLabel: null, createdBy: "b-maker@x.test", assignee: null, cycleId: null, parentId: null, archivedAt: null, createdAt: "2026-05-04T09:00:00.000Z", updatedAt: "2026-05-04T09:00:00.000Z", custom: { state: "in_review" } }] } });
    }
    if (url.pathname === "/api/ops/record-workflow" && req.method() === "GET") {
      seen.reads.push(url.searchParams);
      const refs = url.searchParams.get("refs");
      if (refs) {
        const list = JSON.parse(refs) as { id: string; customerId?: string }[];
        return route.fulfill({
          json: {
            items: list.map((r) => ({
              id: r.id,
              customerId: r.customerId ?? null,
              next: r.id === "D-1"
                ? { finished: false, step: "Review", holders: ["Cy Checker"], due_on: "2026-05-09T09:00:00.000Z", overdue: true }
                : r.id === "D-2"
                  ? { finished: false, step: "Prepare", holders: ["Mara Maker"], due_on: null, overdue: false }
                  : { finished: false, step: "Review", holders: ["Cy Checker"], due_on: null, overdue: false },
            })),
          },
        });
      }
      return route.fulfill({
        json: {
          area: url.searchParams.get("area"), key: "x", noun: "release", workflow: WORKFLOW,
          options: { ...(opts.supervisor ? { holders: { prepare: [{ id: "b-maker@x.test", name: "Mara Maker" }], review: [{ id: "c-checker@x.test", name: "Cy Checker" }, { id: "d-admin@x.test", name: "d-admin@x.test" }] } } : {}), extends: ["review"] },
        },
      });
    }
    if (url.pathname === "/api/ops/record-workflow/holder" || url.pathname === "/api/ops/record-workflow/due") {
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/due") && opts.refuseDue) return route.fulfill({ status: 422, json: { error: opts.refuseDue, errors: [opts.refuseDue], code: "DUE_ON_ALREADY_EXTENDED" } });
      const next = url.pathname.endsWith("/holder")
        ? { ...WORKFLOW, next: { ...WORKFLOW.next, holders: [{ id: "c-checker@x.test", name: "Cy Checker" }] }, timeline: [...WORKFLOW.timeline, { at: "2026-05-05T09:00:00.000Z", who: "d-admin@x.test", step: "Review", what: "Review now held by Cy Checker", kind: "holder" }] }
        : { ...WORKFLOW, next: { ...WORKFLOW.next, due_on: "2026-05-12T00:00:00.000Z" } };
      return route.fulfill({ json: { changed: true, workflow: next } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return seen;
}

test("a card says who holds the next step and when it is due; the lines come in one call for the page", async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto("/preview/record-areas?profile=workflow&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await panel.getByRole("button", { name: "Board" }).click();
  const cards = panel.getByTestId("record-card");
  await expect(cards).toHaveCount(2);
  const first = cards.filter({ hasText: "Release D-1" }).getByTestId("next-step");
  await expect(first).toHaveText("Review · Cy Checker · due 9 May 2026");
  await expect(first.getByTestId("next-step-due")).toHaveClass(/text-red-400/);
  await expect(cards.filter({ hasText: "Release D-2" }).getByTestId("next-step")).toHaveText("Prepare · Mara Maker");
  // The panel also asks for its tasks' lines (area "tasks"); the deployments' page comes in one call holding both.
  const batch = seen.reads.filter((q) => q.get("refs") && q.get("area") === "deployments");
  expect(batch.length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(batch.at(-1)?.get("refs") ?? "[]")).toEqual([{ id: "D-1", customerId: "acme" }, { id: "D-2", customerId: "acme" }]);
  // No record's own workflow is read for its card.
  expect(seen.reads.filter((q) => q.get("id"))).toHaveLength(0);
});

test("the detail: the next step, every step, the timeline; a supervisor hands a step over and extends a due date", async ({ page }) => {
  const seen = await mockApi(page, { supervisor: true });
  await page.goto("/preview/record-areas?profile=workflow&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await panel.getByRole("button", { name: "Board" }).click();
  await panel.getByTestId("record-card").filter({ hasText: "Release D-1" }).click();
  const wf = page.getByTestId("record-workflow");
  await expect(wf.getByTestId("workflow-next")).toContainText("Review");
  await expect(wf.getByTestId("workflow-next-holders")).toHaveText("Held by Cy Checker, someone with no name on the roster");
  await expect(wf.getByTestId("workflow-next-due")).toHaveText("Due 9 May 2026");
  await expect(wf.getByTestId("workflow-step")).toHaveCount(2);
  await expect(wf.locator('[data-step="prepare"] [data-testid="workflow-step-state"]')).toHaveText("Done");
  await expect(wf.getByTestId("workflow-timeline-entry")).toHaveCount(4);
  await expect(wf.getByTestId("workflow-timeline-entry").first()).toContainText("Review opened");
  const detail = seen.reads.filter((q) => q.get("id")).at(-1);
  expect([detail?.get("area"), detail?.get("id"), detail?.get("customerId")]).toEqual(["deployments", "D-1", "acme"]);

  await wf.getByLabel("Who holds Review").selectOption("c-checker@x.test");
  await wf.locator('[data-step="review"]').getByRole("button", { name: "Change holder" }).click();
  await expect(wf.getByTestId("workflow-next-holders")).toHaveText("Held by Cy Checker");
  await expect(wf.getByTestId("workflow-timeline-entry").first()).toContainText("Review now held by Cy Checker");
  expect(seen.posts.at(-1)).toEqual({ path: "/api/ops/record-workflow/holder", body: { area: "deployments", id: "D-1", customerId: "acme", step: "review", holders: ["c-checker@x.test"] } });

  await wf.getByLabel("New due date for Review").fill("2026-05-12");
  await wf.locator('[data-step="review"]').getByRole("button", { name: "Extend due date" }).click();
  await expect(wf.getByTestId("workflow-next-due")).toHaveText("Due 12 May 2026");
  expect(seen.posts.at(-1)).toEqual({ path: "/api/ops/record-workflow/due", body: { area: "deployments", id: "D-1", customerId: "acme", step: "review", due_on: "2026-05-12T00:00:00.000Z" } });
  // The preparation's date is the workflow's own: no extension is offered on it.
  await expect(wf.locator('[data-step="prepare"]').getByRole("button", { name: "Extend due date" })).toHaveCount(0);
});

test("a member is offered no holder control; a refused extension shows the rule's sentence", async ({ page }) => {
  await mockApi(page, { supervisor: false, refuseDue: '"Review" has already been extended once. No further extensions.' });
  await page.goto("/preview/record-areas?profile=workflow&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await panel.getByRole("button", { name: "Board" }).click();
  await panel.getByTestId("record-card").filter({ hasText: "Release D-1" }).click();
  const wf = page.getByTestId("record-workflow");
  await expect(wf.getByTestId("workflow-step")).toHaveCount(2);
  await expect(wf.getByRole("button", { name: "Change holder" })).toHaveCount(0);
  await wf.getByLabel("New due date for Review").fill("2026-05-20");
  await wf.locator('[data-step="review"]').getByRole("button", { name: "Extend due date" }).click();
  await expect(wf.getByTestId("workflow-error")).toHaveText('"Review" has already been extended once. No further extensions.');
  await expect(wf.getByTestId("workflow-next-due")).toHaveText("Due 9 May 2026");
});

test("a task's detail shows its workflow the same way, and its card the next step", async ({ page }) => {
  const seen = await mockApi(page, { supervisor: false });
  await page.goto("/preview/record-areas?profile=workflow&view=tasks");
  await expect(page.getByTestId("next-step").first()).toHaveText("Review · Cy Checker");
  await page.getByText("Prepare the pack").first().click();
  await expect(page.getByTestId("record-workflow").getByTestId("workflow-next")).toContainText("Review");
  const reads = seen.reads.map((q) => [q.get("area"), q.get("id") ?? "refs"]);
  expect(reads).toContainEqual(["tasks", "6b0c1f0e-1111-4222-8333-944445555666"]);
  expect(reads).toContainEqual(["tasks", "refs"]);
});

test("a profile whose lifecycles run no workflow makes no workflow call and draws nothing of it", async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto("/preview/record-areas?profile=filing&view=deployments");
  const panel = page.getByTestId("record-area-deployments");
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("next-step")).toHaveCount(0);
  await expect(page.getByTestId("record-workflow")).toHaveCount(0);
  expect(seen.reads).toHaveLength(0);
});
