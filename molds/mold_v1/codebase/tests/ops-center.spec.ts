import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Ops Center modal's ways out, as a person meets them (the REAL OpsCenter through /preview/ops-center; every API
 * call answered here):
 *
 *   - there is no dismiss icon on the modal: a corner X collided with each panel's own detail-panel close;
 *   - Escape closes the modal when nothing inside it claims the key;
 *   - a click outside the modal (on the dimmed page around it) closes it;
 *   - Escape with a record's detail panel open closes the panel only, and a second Escape closes the modal.
 */
const NOW = "2026-10-05T07:00:00.000Z";
const WORKFLOW = {
  id: "00000000-0000-4000-8000-0000000000f1", name: "weekly-notes", description: "Writes the weekly notes.", trigger: "manual",
  customerId: null, steps: null, instructions: null, instructionsEnabled: false, script: "return 1;", notifyEmail: null, notifyEmails: null,
  enabled: true, availability: { available: true }, appSource: { ok: true, kind: "script" }, createdBy: "reviewer@example.com", createdAt: NOW, updatedAt: NOW,
};

async function mockApi(page: Page): Promise<void> {
  await page.route(/\/(api|eve)\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/ops/workflows") return route.fulfill({ json: { items: [WORKFLOW], libraryNote: null } });
    return route.fulfill({ json: { items: [] } });
  });
}

const modal = (page: Page) => page.getByRole("dialog");
const state = (page: Page) => page.getByTestId("ops-state");

async function openApps(page: Page) {
  await mockApi(page);
  await page.goto("/preview/ops-center?section=apps");
  // The list has loaded, so the page is hydrated and the modal's handlers are live.
  await expect(modal(page).getByText("No apps yet")).toBeVisible();
  await expect(state(page)).toHaveText("open");
}

test("the Ops Center has no dismiss icon", async ({ page }) => {
  await openApps(page);
  await expect(modal(page).getByRole("button", { name: /^close/i })).toHaveCount(0);
  await expect(modal(page).locator('[title^="Close"]')).toHaveCount(0);
  await expect(modal(page).locator("[data-slot='dialog-close']")).toHaveCount(0);
});

test("Escape closes the Ops Center when nothing inside it is open", async ({ page }) => {
  await openApps(page);
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);
  await expect(state(page)).toHaveText("closed");
});

test("a click outside the Ops Center closes it, and it opens again", async ({ page }) => {
  await openApps(page);
  const box = await modal(page).boundingBox();
  expect(box).not.toBeNull();
  // The dimmed page above the modal: outside the dialog, on Radix's overlay.
  await page.mouse.click(box!.x + box!.width / 2, Math.max(1, box!.y / 2));
  await expect(modal(page)).toHaveCount(0);
  await expect(state(page)).toHaveText("closed");
  await page.getByRole("button", { name: "Open the Ops Center" }).click();
  await expect(modal(page)).toBeVisible();
  await expect(state(page)).toHaveText("open");
});

test("Escape closes an open detail panel first, then the Ops Center", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/preview/ops-center?section=workflows&id=${WORKFLOW.id}`);
  const details = modal(page).locator("aside[aria-label='Details']");
  await expect(details).toBeVisible();
  // The panel's own close stays: it is the detail panel's, not the modal's.
  await expect(details.getByRole("button", { name: "Close panel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(modal(page)).toBeVisible();
  await expect(state(page)).toHaveText("open");
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);
  await expect(state(page)).toHaveText("closed");
});
