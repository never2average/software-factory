import { expect, test, type Page } from "@playwright/test";

/**
 * Sent messages fold when long (chat.user_messages in the deployment profile).
 * Mounts the real AgentMessage through /preview/user-message.
 */
const bubble = (page: Page, id: string) => page.getByTestId(`msg-${id}`);
const toggle = (page: Page, id: string) => bubble(page, id).getByRole("button", { name: /show (more|less)/i });

/**
 * The page, hydrated. The fold's button is drawn by the page's own script after it measures the message, so it is
 * the sign the page is live. `page.goto` returns at the load event and `next dev` hydrates after it: about half a
 * second on a quiet machine, past the 5 s an assertion waits beside another worker's specs on a busy one (the fade
 * test failed there with the button "not found", mold_v1-292). Generous here, as in tests/dictation.spec.ts; every
 * check after it keeps its own budget.
 */
async function open(page: Page) {
  await page.goto("/preview/user-message");
  await expect(toggle(page, "long")).toBeVisible({ timeout: 30_000 });
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    test("long sent messages fold; short ones and assistant replies do not", async ({ page }) => {
      await open(page);
      await expect(toggle(page, "long")).toHaveText(/show more/i);

      await expect(toggle(page, "short")).toHaveCount(0);
      await expect(toggle(page, "a-long")).toHaveCount(0); // an equally long ASSISTANT message

      for (const id of ["long", "table", "chips", "newest"]) {
        const button = toggle(page, id);
        await expect(button).toHaveAttribute("aria-expanded", "false");
        const region = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
        const box = await region.boundingBox();
        expect(box?.height ?? 0, `${id} is folded to about six lines`).toBeLessThan(200);
        expect(box?.height ?? 0).toBeGreaterThan(80);
      }
      // Attachment chips stay visible above a folded message.
      await expect(bubble(page, "chips").getByText("Q4-results.pdf")).toBeVisible();
      await expect(bubble(page, "chips").getByText("investor-deck.pptx")).toBeVisible();
    });

    test("expands from the keyboard WHILE the reply streams, per message, and folds again", async ({ page }) => {
      await open(page);
      const button = toggle(page, "newest");
      const region = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
      const folded = (await region.boundingBox())?.height ?? 0;

      const streamed = await bubble(page, "a-stream").innerText();
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(button).toHaveText(/show less/i);
      expect((await region.boundingBox())?.height ?? 0).toBeGreaterThan(folded * 3);
      // Still streaming underneath, and the message stays open as it does.
      await expect.poll(async () => (await bubble(page, "a-stream").innerText()).length).toBeGreaterThan(streamed.length);
      await expect(button).toHaveAttribute("aria-expanded", "true");
      // Per message: its neighbours did not move.
      await expect(toggle(page, "long")).toHaveAttribute("aria-expanded", "false");

      await page.keyboard.press("Space");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      expect(Math.round((await region.boundingBox())?.height ?? 0)).toBe(Math.round(folded));
    });

    test("the fade is the bubble's colour, not the page's", async ({ page }, testInfo) => {
      await open(page);
      await expect(toggle(page, "long")).toBeVisible();
      const colours = await bubble(page, "long").evaluate((root) => {
        const fade = root.querySelector('[data-folded="true"] [aria-hidden="true"]') as HTMLElement;
        let el: HTMLElement | null = fade;
        let bubbleBg = "";
        while (el && !bubbleBg) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && el !== fade) bubbleBg = bg;
          el = el.parentElement;
        }
        // Resolve --primary to the same notation the browser reports for the bubble.
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--primary)";
        root.appendChild(probe);
        const primary = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { image: getComputedStyle(fade).backgroundImage, bubbleBg, primary, page: getComputedStyle(document.body).backgroundColor };
      });
      expect(colours.bubbleBg).toBe(colours.primary);
      expect(colours.bubbleBg).not.toBe(colours.page);
      expect(colours.image).toContain("linear-gradient");
      await bubble(page, "long").screenshot({ path: testInfo.outputPath(`user-message-${colorScheme}.png`) });
    });
  });
}

test("a delegation whose brief is still streaming keeps the specialist's name and status; only the summary shimmers (mold_v1-269)", async ({ page }) => {
  await page.goto("/preview/user-message");
  const card = bubble(page, "a-delegating");
  await expect(card.getByText("Research subagent")).toBeVisible();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  const brief = card.getByRole("status", { name: "Loading the brief" });
  await expect(brief).toBeVisible();
  await expect(brief.locator("[data-skeleton]")).toHaveCount(1);
});

/**
 * A reply that streams faster than the screen draws keeps growing (mold_v1-292). The preview's reply gains a sentence
 * every 150 ms; here every animation frame comes 1 s after it is asked for, as on a busy machine. When each new
 * chunk cancelled the frame the reveal had asked for, no frame ever ran and the reply stayed frozen mid-word for as
 * long as the stream kept coming (seen as the keyboard test above failing under load, its reply stuck at 33
 * characters for 5 s).
 *
 * The spec counts the frames that actually ran, not only the text length: on a loaded machine the 150 ms timer can
 * drift past a short frame delay now and then, which let the old code run one frame per drift and grow the text
 * anyway. A 1 s frame is far longer than any drift, and at least 5 of the reveal's own frames must run while the
 * stream keeps going.
 */
test("a reply streaming faster than the screen draws still grows", async ({ page }) => {
  await page.addInitScript(() => {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let last = 0;
    (window as unknown as { framesRan: number }).framesRan = 0;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = ++last;
      // Count only the reveal's own frames, not other components': useSmoothText asks for its `tick`, which the dev
      // server names "useSmoothText.useEffect.tick". Renaming it makes this count 0 and the spec fail, never pass.
      const reveal = /(^|\.)tick$/.test(cb.name);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          if (reveal) (window as unknown as { framesRan: number }).framesRan += 1;
          cb(performance.now());
        }, 1_000),
      );
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
    };
  });
  await open(page);
  const reply = bubble(page, "a-stream");
  await expect(reply).toContainText("Streaming sentence 1.");
  const first = (await reply.innerText()).length;
  const framesRan = () => page.evaluate(() => (window as unknown as { framesRan: number }).framesRan);
  const framesBefore = await framesRan();
  await expect.poll(framesRan, { timeout: 15_000 }).toBeGreaterThanOrEqual(framesBefore + 5);
  await expect.poll(async () => (await reply.innerText()).length, { timeout: 10_000 }).toBeGreaterThan(first + 40);
  await expect(reply).toContainText("Streaming sentence 3.", { timeout: 10_000 });
});
