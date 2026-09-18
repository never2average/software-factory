/**
 * End-to-end checks for the Workflows modal, driven with Playwright.
 *
 *   node scripts/test-workflows-ui.mjs [url]
 *
 * Reuses the PERSISTENT profile scripts/.browser-profile — the same one
 * ui-review.mjs uses — because every one of these screens is behind Google SSO
 * and this harness cannot log in for you. If the profile's session has expired
 * the run says so and stops rather than asserting against a sign-in page.
 *
 * Unlike ui-review.mjs (a review harness that asserts nothing), this ASSERTS,
 * exits non-zero on the first failure, and screenshots what it saw.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://fde-agent.vercel.app/?ops=workflows";
const SHOTS = "scripts/.shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const context = await chromium.launchPersistentContext("scripts/.browser-profile", {
  headless: true,
  viewport: { width: 1600, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // The whole suite is meaningless against a sign-in wall — say so and stop.
  const signedIn = await page
    .locator("text=Workflows")
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!signedIn) {
    console.error(
      "\nNot signed in: the persistent profile has no live session.\n" +
        "Run `node scripts/ui-review.mjs`, log in with Google once, then re-run this.",
    );
    await page.screenshot({ path: `${SHOTS}/wf-not-signed-in.png` });
    process.exit(2);
  }

  /* ---------------------------------------------------------------- the table */

  // Wait for the FETCH, not the first <tr>: the table renders a "Loading…" row
  // first, and asserting on that counted one row and passed for the wrong reason.
  const rows = page.locator("tbody tr");
  await page
    .locator("tbody tr", { hasText: "Loading" })
    .waitFor({ state: "detached", timeout: 20_000 })
    .catch(() => {});
  await page.locator("button[aria-haspopup='menu']").first().waitFor({ timeout: 15_000 });
  const rowCount = await rows.count();
  check("the table lists workflows", rowCount >= 7, `${rowCount} rows`);

  /* ------------------------------------------------------- the editor is the pane */

  // A plain click on a row only SELECTS it (the name is a deep link that does
  // not navigate unmodified); the panel is opened from the row menu, so drive it
  // the way a person does.
  await rows.first().locator("button[aria-haspopup='menu']").click();
  await page.locator("[role='menuitem']", { hasText: "Review" }).first().click();
  const tab = page.locator("aside[aria-label='Details'] span.font-mono").first();
  await tab.waitFor({ timeout: 10_000 });
  const tabName = (await tab.innerText()).trim();
  check("the open file is a TypeScript workflow", /\.workflow\.ts$/.test(tabName), tabName);

  const mdTabs = await page.locator("aside[aria-label='Details'] :text('.md')").count();
  check("the instructions.md tab is gone", mdTabs === 0, `${mdTabs} md tabs`);

  const code = page.locator("aside[aria-label='Details'] pre").first();
  const codeText = (await code.innerText()).trim();
  check("an empty script still previews the scaffold", codeText.length > 0, `${codeText.length} chars`);

  /* ------------------------------------------- the ... lines up with the dismiss × */

  const menuBtn = page.locator("aside[aria-label='Details'] button[aria-label='Workflow actions']");
  const closeBtn = page.locator("aside[aria-label='Details'] button[aria-label='Close panel']");
  const [mb, cb] = [await menuBtn.boundingBox(), await closeBtn.boundingBox()];
  const menuMid = mb.y + mb.height / 2;
  const closeMid = cb.y + cb.height / 2;
  check(
    "the ... and the × sit on one line",
    Math.abs(menuMid - closeMid) <= 1,
    `centres ${menuMid.toFixed(1)} vs ${closeMid.toFixed(1)}`,
  );

  /* ------------------------------------------------------------------- the menu */

  await menuBtn.click();
  const menu = page.locator("[role='menu']").first();
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
  check("Run workflow is offered", items.some((i) => i === "Run workflow"), items.join(" | "));
  check("Instructions override is offered", items.some((i) => i.startsWith("Instructions override")));
  check("Pause/Resume is offered", items.some((i) => /^(Pause|Resume) workflow$/.test(i)));
  check("Delete is offered", items.some((i) => i === "Delete workflow"));
  check("the View drawer is gone", !items.some((i) => i === "View"));
  check("the redundant Edit item is gone", !items.some((i) => i === "Edit"));
  check("the redundant Clear script item is gone", !items.some((i) => i.startsWith("Clear")));

  // Escape with a menu open must close the MENU only — it used to take the whole
  // panel with it, because Radix portals the menu outside the panel's escape trap.
  await page.keyboard.press("Escape");
  check(
    "esc closes the menu without closing the panel",
    await page.locator("aside[aria-label='Details']").isVisible(),
  );

  /* -------------------------------------------------------- the ⌘K inline agent */

  await code.click();
  await page.keyboard.press("Meta+k");
  // NOT [data-escape-trap] textarea: the CODE editor is an escape trap too, so
  // that matched the wrong field and reported the card as still open when it had
  // already closed. The prompt is the one labelled for the agent.
  const card = page.locator("aside[aria-label='Details'] textarea[aria-label='Instruct the agent']");
  const opened = await card.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
  check("⌘K opens the inline agent", opened);

  if (opened) {
    const box = await card.boundingBox();
    check("the prompt is narrow, not full-width", box.width < 420, `${Math.round(box.width)}px wide`);
    check("the prompt is tall enough to write in", box.height >= 80, `${Math.round(box.height)}px tall`);

    const paneBox = await page.locator("aside[aria-label='Details']").boundingBox();
    check(
      "it floats over the code, not pinned to the top of the pane",
      box.y > paneBox.y + 60,
      `card y=${Math.round(box.y)}, pane y=${Math.round(paneBox.y)}`,
    );

    const goBtn = page.locator("aside[aria-label='Details'] button[aria-label='Generate']");
    check("the Go button is disabled until something is typed", await goBtn.isDisabled());
    await card.fill("triage overdue tickets");
    check("the Go button wakes up once there is a prompt", await goBtn.isEnabled());

    // Escape dismisses the CARD and leaves the panel open — the bug that was.
    await page.keyboard.press("Escape");
    const gone = await card.waitFor({ state: "hidden", timeout: 3_000 }).then(() => true).catch(() => false);
    check("esc dismisses the card", gone);
    check(
      "esc does NOT close the whole panel",
      await page.locator("aside[aria-label='Details']").isVisible(),
    );

    // Click-away dismisses it too.
    await page.keyboard.press("Meta+k");
    await card.waitFor({ timeout: 5_000 });
    // Click the CODE, which is exactly what "away" means here.
    await page.locator("aside[aria-label='Details'] textarea:not([aria-label='Instruct the agent'])").first().click({ position: { x: 5, y: 5 } });
    const goneByClick = await card
      .waitFor({ state: "hidden", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    check("clicking away dismisses the card", goneByClick);
  }

  await page.screenshot({ path: `${SHOTS}/wf-final.png` });
} catch (e) {
  check("the suite ran to completion", false, e.message);
  await page.screenshot({ path: `${SHOTS}/wf-crash.png` }).catch(() => {});
} finally {
  await context.close();
}

console.log(
  `\n${results.length - failed}/${results.length} checks passed. Screenshots in ${SHOTS}/.`,
);
process.exit(failed > 0 ? 1 : 0);
