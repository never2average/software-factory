import { expect, test, type Page } from "@playwright/test";

/**
 * Sent messages fold when long (chat.user_messages in the deployment profile).
 * Mounts the real AgentMessage through /preview/user-message.
 */
const bubble = (page: Page, id: string) => page.getByTestId(`msg-${id}`);
const toggle = (page: Page, id: string) => bubble(page, id).getByRole("button", { name: /show (more|less)/i });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    test("long sent messages fold; short ones and assistant replies do not", async ({ page }) => {
      await page.goto("/preview/user-message");
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
      await page.goto("/preview/user-message");
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
      await page.goto("/preview/user-message");
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
