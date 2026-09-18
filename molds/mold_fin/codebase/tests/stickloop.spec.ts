import { expect, test } from "@playwright/test";

/**
 * Reproduction probe for the streaming React #185 ("Maximum update depth
 * exceeded") crash. Loads the /preview/stickloop harness (content grows every
 * frame inside the chat's use-stick-to-bottom wrapper) and fails if React's
 * update-depth error fires — confirming the loop lives in the scroll wrapper.
 */
test("streaming content does not blow React update depth", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/preview/stickloop");
  // Let the content grow for the full streaming window.
  await page.waitForTimeout(7000);

  const depthErrors = errors.filter(
    (e) => /maximum update depth/i.test(e) || /react error #?185/i.test(e) || /error #185/i.test(e),
  );
  // Print everything so the run is legible whether it repros or not.
  console.log(`captured ${errors.length} error line(s); ${depthErrors.length} update-depth`);
  for (const e of depthErrors.slice(0, 3)) console.log("  #185:", e.slice(0, 200));

  expect(depthErrors, `update-depth errors:\n${depthErrors.join("\n")}`).toHaveLength(0);
});
