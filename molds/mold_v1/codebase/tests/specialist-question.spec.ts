import { expect, test, type Page } from "@playwright/test";

/**
 * "A subagent's question does not keep context of the subagent tag or ID… Instead, it just writes it as a user input
 * in the main chat thread" (mold_v1-234).
 *
 * A RECORDED stream (the real eve runtime, patched: beta asks "Which fiscal year should I use?") rendered by the chat's
 * own pieces at /preview/specialist-question: the question card names who is asking, the composer says whom it is
 * answering, the reply sits on the specialist's card ("Reply to Beta", never a main-thread bubble), the specialist's
 * progress shows on the same card, and all of it comes back the same after a reload, from what the chat persisted.
 */
const root = (page: Page) => page.getByTestId("specialist-question");
/** Beta's delegation card, by the name the chat gives it (mold_v1-295: the name, not "Beta subagent"). */
const betaCard = (page: Page) => root(page).locator("[data-delegation]").filter({ has: page.locator("[data-specialist-name]", { hasText: /^Beta$/ }) });

async function fresh(page: Page, query = "") {
  await page.goto(`/preview/specialist-question${query}`);
  await page.evaluate(() => {
    window.localStorage.removeItem("preview.specialist-question");
    window.localStorage.removeItem("preview.specialist-question.fallback");
  });
  await page.reload();
  await expect(root(page)).toHaveAttribute("data-stage", "live");
}

async function expectAnsweredCard(page: Page, progress: RegExp) {
  const thread = root(page).locator("[data-specialist-thread]");
  await expect(thread).toHaveCount(1);
  await expect(thread).toContainText("Beta asked:");
  await expect(thread).toContainText("Which fiscal year should I use?");
  const reply = thread.locator("[data-specialist-reply]");
  await expect(reply).toContainText("Reply to Beta");
  await expect(reply).toContainText("Use FY25, not FY26");
  await expect(thread.locator("[data-specialist-progress]")).toHaveText(progress);
  // Not the person's own message in the main thread: no "Your answer" bubble, no user-side bubble with the reply.
  await expect(root(page).locator("[data-your-answer]")).toHaveCount(0);
  await expect(root(page).getByTestId("msg-user").filter({ hasText: "Use FY25" })).toHaveCount(0);
}

test("a specialist's question is labelled, the composer says whom it answers, and the reply threads under it", async ({ page }) => {
  await fresh(page);

  // The question card says who is asking, by the registry's display name (never a raw id).
  const card = root(page).locator("[data-specialist-question]");
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-specialist-asking]")).toHaveText("Beta is asking you");
  await expect(card).toHaveAccessibleName("Beta is asking you");
  await expect(card).toContainText("Which fiscal year should I use?");
  await expect(card.getByRole("button", { name: "FY26" })).toBeVisible();

  // The composer: "Answering Beta", with the main chat one tap away, and back.
  const label = root(page).locator("[data-answering]");
  await expect(label).toContainText("Answering Beta");
  const picker = label.getByRole("radiogroup", { name: "Who your message goes to" });
  await expect(picker.getByRole("radio", { name: /Beta/ })).toHaveAttribute("aria-checked", "true");
  await picker.getByRole("radio", { name: "Main chat" }).click();
  await expect(label).toContainText("To the main chat. It is sent once Beta has its answer and hands back.");
  await expect(picker.getByRole("radio", { name: "Main chat" })).toHaveAttribute("aria-checked", "true");
  await picker.getByRole("radio", { name: /Beta/ }).click();
  await expect(label).toContainText("Answering Beta");
  await page.screenshot({ path: "test-results/specialist-question-asking.png", fullPage: true });

  // Typed text answers beta: the question becomes the same card with the reply threaded under it.
  await page.getByRole("textbox", { name: "Message" }).fill("Use FY25, not FY26");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(root(page).locator("[data-specialist-question]")).toHaveCount(0);
  await expect(root(page).locator("[data-specialist-answered]")).toHaveCount(1);
  await expectAnsweredCard(page, /Beta is working on your reply/);
  // Beta still works: the row stays, now offering a note to it, with the main chat picked by default.
  await expect(label).toContainText("To the main chat.");
  await page.screenshot({ path: "test-results/specialist-question-answered.png", fullPage: true });

  // The run is one click away from the card.
  await root(page).locator("[data-specialist-answered]").getByRole("button", { name: "Open its run" }).click();
  await expect(root(page).locator("[data-opened]")).toContainText("call_");

  // Reload: rebuilt from the persisted marker and the stream, the same card.
  await page.reload();
  await expect(root(page)).toHaveAttribute("data-stage", "live");
  await expect(root(page).locator("[data-specialist-answered]")).toHaveCount(1);
  await expectAnsweredCard(page, /Beta is working on your reply/);

  // Beta hands back: the thread moves under beta's delegation card, finished, and stays there after a reload.
  await root(page).getByTestId("hand-back").click();
  await expect(root(page)).toHaveAttribute("data-stage", "done");
  await expect(root(page).locator("[data-specialist-answered]")).toHaveCount(0);
  await expectAnsweredCard(page, /Beta finished/);
  const delegation = betaCard(page);
  await expect(delegation.locator("[data-specialist-thread]")).toHaveCount(1);
  await page.reload();
  await expect(root(page)).toHaveAttribute("data-stage", "done");
  await expectAnsweredCard(page, /Beta finished/);
  await page.screenshot({ path: "test-results/specialist-question-history.png", fullPage: true });
});

test("a message to the main chat is not taken as the answer", async ({ page }) => {
  await fresh(page);
  const label = root(page).locator("[data-answering]");
  await label.getByRole("radio", { name: "Main chat" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Also, what is the status of the rollout?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(root(page).locator("[data-held]")).toContainText("what is the status");
  await expect(root(page).locator("[data-specialist-question]")).toHaveCount(1);
  await expect(root(page).locator("[data-specialist-thread]")).toHaveCount(0);
});

test("a note to a running specialist: sent from the composer, read at its next step, kept after a reload", async ({ page }) => {
  await fresh(page);
  // Answer beta's question; beta then works on, and can take a note.
  await root(page).locator("[data-specialist-question]").getByRole("button", { name: "FY26" }).click();
  const label = root(page).locator("[data-answering]");
  await label.getByRole("radio", { name: "Beta" }).click();
  await expect(label).toContainText("Note to Beta. It reads it at its next step and carries on.");
  await page.getByRole("textbox", { name: "Message" }).fill("Focus on FY24 only");
  await page.getByRole("button", { name: "Send" }).click();
  // The note sits on beta's card while beta works (mold_v1-296: a relay to a specialist is no row of the thread).
  await expect(root(page).locator("[data-specialist-notes]")).toHaveCount(0);
  const note = betaCard(page).locator("[data-relayed-notes] [data-steering-note]");
  await expect(note).toContainText("Steered Beta");
  await expect(note).toContainText("Focus on FY24 only");
  await expect(note.locator("[data-steering-status]")).toHaveText("Waiting for its next step");
  // Not a main-thread message.
  await expect(root(page).getByTestId("msg-user").filter({ hasText: "Focus on FY24" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/specialist-steer-pending.png", fullPage: true });

  await root(page).getByTestId("next-step").click();
  await expect(note.locator("[data-steering-status]")).toHaveText("Read at its next step");
  await page.reload();
  await expect(root(page).locator("[data-steering-note]")).toContainText("Focus on FY24 only");
  await expect(root(page).locator("[data-steering-status]")).toHaveText("Read at its next step");

  // Beta hands back: the note stays with beta's delegation card, and beta is no longer a target.
  await root(page).getByTestId("hand-back").click();
  const delegation = betaCard(page);
  await expect(delegation.locator("[data-steering-note]")).toContainText("Focus on FY24 only");
  await expect(root(page).locator("[data-specialist-notes]")).toHaveCount(0);
  await expect(root(page).locator("[data-answering]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/specialist-steer-history.png", fullPage: true });
});

test("a note that was never read says so once the specialist has finished", async ({ page }) => {
  await fresh(page);
  await root(page).locator("[data-specialist-question]").getByRole("button", { name: "FY26" }).click();
  await root(page).locator("[data-answering]").getByRole("radio", { name: "Beta" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Skip the annex");
  await page.getByRole("button", { name: "Send" }).click();
  await root(page).getByTestId("hand-back").click();
  const status = betaCard(page).locator("[data-steering-status]");
  await expect(status).toHaveText("Not read: Beta finished first. Ask the main agent instead.");
});

test("a question nobody can attribute keeps today's rendering", async ({ page }) => {
  await fresh(page, "?fallback=1");
  await expect(root(page).locator("[data-specialist-question]")).toHaveCount(0);
  await expect(root(page).getByText("Which fiscal year should I use?")).toBeVisible();
  await expect(root(page).locator("[data-answering]")).toHaveCount(0);
  await root(page).getByRole("button", { name: "FY26" }).click();
  await expect(root(page).locator("[data-your-answer]")).toContainText("FY26");
  await expect(root(page).locator("[data-specialist-thread]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/specialist-question-unattributed.png", fullPage: true });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });

  test("the card, the reply and the composer row fit the screen and stay usable", async ({ page }) => {
    await fresh(page);
    const width = async () => page.evaluate(() => document.documentElement.scrollWidth);
    await expect(root(page).locator("[data-specialist-asking]")).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(375);
    const toggle = root(page).locator("[data-answering]").getByRole("radio", { name: "Main chat" });
    const box = await toggle.boundingBox();
    expect(box?.height ?? 0, "the switch is a comfortable tap target").toBeGreaterThanOrEqual(32);
    await root(page).locator("[data-specialist-question]").getByRole("button", { name: "FY26" }).tap();
    await expect(root(page).locator("[data-specialist-reply]")).toContainText("FY26");
    await expect(root(page).locator("[data-specialist-reply]")).toContainText("Reply to Beta");
    expect(await width()).toBeLessThanOrEqual(375);
    await page.screenshot({ path: "test-results/specialist-question-phone.png", fullPage: true });
  });
});
