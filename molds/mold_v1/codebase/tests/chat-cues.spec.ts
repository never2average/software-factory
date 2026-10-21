import { expect, test } from "@playwright/test";

/**
 * The chat's cues on the REAL components (mold_v1-287/289), over /preview/user-message's "cues" section: a delegation
 * card that settles with the completed mark and is announced, the tab title's mark while the page is hidden, and a
 * specialist's answered approval folded to one line that opens on click. The same cues in the real shell — the main
 * turn's completed mark, the chat list's done marker, the typing line, the shared queue and the approvals stack beside
 * the composer — are in tests/chat-open.spec.ts ("the chat's cues").
 */
const cues = (page: import("@playwright/test").Page) => page.getByTestId("cues");

test("287: a delegation that finishes on screen settles with the completed mark, briefly, and is announced", async ({ page }) => {
  await page.goto("/preview/user-message");
  const card = page.getByTestId("cue-delegation").locator("[data-delegation]");
  // The status is one icon, named for a screen reader and on hover (mold_v1-297), never a word beside it.
  await expect(card.getByRole("img", { name: "Running", exact: true })).toBeVisible();
  await expect(card).not.toHaveAttribute("data-just-completed", "");
  await page.getByTestId("cue-finish").click();
  const done = card.getByRole("img", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await expect(done).toHaveAttribute("title", "Done");
  // One mark: the settled icon and the brief wash, with no "Done" or "Completed" text beside it.
  await expect(card).not.toContainText("Done");
  await expect(card).not.toContainText("Completed");
  await expect(card).toHaveAttribute("data-just-completed", "");
  await expect(cues(page).locator("[data-completion-announcer]")).toHaveText(/completed$/);
  await expect(cues(page).locator("[data-completion-announcer]")).toHaveAttribute("aria-live", "polite");
  // A brief highlight: it goes, the completed mark stays.
  await expect(card).not.toHaveAttribute("data-just-completed", "", { timeout: 6_000 });
  await expect(card.getByRole("img", { name: "Done", exact: true })).toBeVisible();
});

test("287: the highlight does not animate for someone who asked for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/preview/user-message");
  await page.getByTestId("cue-finish").click();
  const card = page.getByTestId("cue-delegation").locator("[data-delegation]");
  await expect(card).toHaveAttribute("data-just-completed", "");
  const property = await card.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(property, "no transition under reduced motion").toBe("none");
});

test("287: the tab title is marked while the page is hidden, and cleared when the person comes back", async ({ page }) => {
  await page.goto("/preview/user-message");
  const title = await page.title();
  // The person is elsewhere: the page is hidden.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
  });
  await page.getByTestId("cue-tab").dispatchEvent("click");
  await expect.poll(() => page.title()).toBe(`✓ ${title}`);
  // Marked once, however many things finish.
  await page.getByTestId("cue-tab").dispatchEvent("click");
  await expect.poll(() => page.title()).toBe(`✓ ${title}`);
  // Back.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.title()).toBe(title);
});

test("289: an answered approval is one line — who, what, the outcome, the time — and opens on click", async ({ page }) => {
  await page.goto("/preview/user-message");
  const allowed = page.getByTestId("cue-approval-approve").locator('[data-answered-approval="allowed"]');
  await expect(allowed).toBeVisible();
  await expect(allowed).toContainText("You");
  await expect(allowed).toContainText("Allowed");
  await expect(allowed.locator("time")).toHaveText(/\d{1,2}:\d{2}/);
  expect((await allowed.boundingBox())?.height ?? 999, "one line").toBeLessThan(40);
  // Not a "Your answer: Yes" bubble in the middle of the conversation.
  await expect(page.getByTestId("cue-approval-approve").locator("[data-your-answer]")).toHaveCount(0);
  await expect(allowed.locator("[data-answered-approval-detail]")).toHaveCount(0);
  const toggle = allowed.getByRole("button");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(allowed.locator("[data-answered-approval-detail]")).toContainText("Write notes/summary.md?");
  await toggle.click();
  await expect(allowed.locator("[data-answered-approval-detail]")).toHaveCount(0);

  // A specialist's approval as the parent stream carries it: one step row, with its outcome, that opens on click.
  const denied = page.getByTestId("cue-approval-deny").locator('[data-answered-approval="denied"]');
  await expect(denied).toContainText("Denied");
  await expect(denied).toContainText("You");
  expect((await denied.boundingBox())?.height ?? 999, "one line").toBeLessThan(44);
  await denied.getByRole("button", { name: "Expand" }).click();
  await expect(denied).toContainText("notes/summary.md");
});
