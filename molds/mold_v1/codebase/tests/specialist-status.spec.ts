import { expect, test, type Page } from "@playwright/test";

/**
 * A CHAT'S SPECIALISTS, AS THE PERSON SEES THEM (mold_v1-294..297), on /preview/control-panel?scene=status: the REAL
 * delegation cards, the stack of open requests beside the composer, and the REAL Control Panel, over a chat that called
 * nine specialists, five of one kind (app/preview/control-panel/status-scene.tsx has the table).
 *
 *   297  one icon per state (running, waiting on you, stuck, ready to report back, done, failed, stopped), each named
 *        for a screen reader and on hover, the same on the card and the rail row; no waiting sentence under a card;
 *        the running glyph is still for someone who asked for reduced motion
 *   295  every specialist has one name, the same on its card and its row; two of one kind read "Research",
 *        "Research 2", …
 *   296  what passes between the main agent and a specialist (an approval the person gave it, a note sent to it, the
 *        main agent's stop) sits on that specialist's card, never as a row of the thread; the open approval stays
 *        answerable in the stack
 *   294  the main agent's stop: the card turns to stopped and says the main agent's reason; its tool call is no row
 */
const scene = (page: Page) => page.getByTestId("status-scene");
const thread = (page: Page) => page.getByTestId("thread");
const rail = (page: Page) => page.getByTestId("rail");
const card = (page: Page, callId: string) => thread(page).locator(`[data-delegation="${callId}"]`);

async function open(page: Page) {
  // The panel's polls and any specialist stream: answered empty, never the network.
  await page.route(/\/api\/ops\//, (route) => route.fulfill({ status: 200, json: { ok: true, items: [], runs: [], labels: {} } }));
  await page.route(/\/eve\/v1\/session\//, (route) => route.fulfill({ status: 404, json: { error: "not here" } }));
  await page.goto("/preview/control-panel?scene=status");
  await expect(scene(page)).toBeVisible();
}

/** Each specialist: its call id, the name the chat gives it, and the state it is in. */
const EXPECTED = [
  // Its start failed, so the chat's stream never announced it: named after the announced ones, on the rail too.
  ["call_nostart", "Research 5", "failed", "Failed"],
  ["call_run", "Research", "running", "Running"],
  ["call_wait", "Research 2", "waiting", "Waiting on you"],
  ["call_stuck", "Browser", "stuck", "Stuck: no progress for 25 minutes"],
  ["call_ready", "Browser 2", "ready", "Ready to report back"],
  ["call_done", "Research 3", "done", "Done"],
  ["call_fail", "Evals", "failed", "Failed"],
  ["call_stop", "Follow-ups", "stopped", "Stopped"],
  ["call_mstop", "Research 4", "running", "Running"],
] as const;

test("297: each state has its own icon, named for a screen reader and on hover, on the card and on the rail row", async ({ page }) => {
  await open(page);
  const glyphs = new Set<string>();
  for (const [callId, name, state, label] of EXPECTED) {
    const c = card(page, callId);
    await expect(c, name).toHaveAttribute("data-specialist-state", state);
    const icon = c.getByRole("img", { name: label, exact: true });
    await expect(icon, `${name}'s icon`).toBeVisible();
    await expect(icon).toHaveAttribute("title", label);
    await expect(icon).toHaveAttribute("data-specialist-state", state);
    glyphs.add(await icon.locator("svg").getAttribute("class").then((cls) => (cls ?? "").split(" ").find((k) => k.startsWith("lucide-") && k !== "lucide") ?? ""));
    // The rail row of the same specialist: the same name, the same state, the same label.
    const row = rail(page).locator("li").filter({ has: page.locator("[data-specialist-name]", { hasText: new RegExp(`^${name}$`) }) });
    await expect(row, `${name}'s row`).toHaveCount(1);
    await expect(row.getByRole("img", { name: label, exact: true })).toHaveAttribute("data-specialist-state", state);
  }
  // Seven states, seven different glyphs (the two running ones share one).
  expect(glyphs.size, [...glyphs].join(", ")).toBe(7);
  // The icon is the only visible mark: no state word or pill beside it on a card's row or a rail row (a check mark AND
  // "Done" said it twice), and no sentence under a card.
  const WORDS = /\b(Done|Completed|Running|Failed|Stopped|Stuck|Waiting on you|Ready to report back|done)\b/;
  for (const [callId, name] of EXPECTED) {
    const header = (await card(page, callId).locator('button[title="Open in Control Panel"]').innerText()).trim();
    expect(header, `${name}'s card row`).not.toMatch(WORDS);
    const row = rail(page).locator("li").filter({ has: page.locator("[data-specialist-name]", { hasText: new RegExp(`^${name}$`) }) });
    expect((await row.innerText()).trim(), `${name}'s rail row`).not.toMatch(WORDS);
  }
  await expect(thread(page)).not.toContainText("Working in the Control Panel");
  await expect(thread(page)).not.toContainText("Still working in the Control Panel");
  await page.screenshot({ path: "test-results/specialist-status.png", fullPage: true });
});

test("297: the running glyph turns, and is still for someone who asked for reduced motion", async ({ page }) => {
  await open(page);
  const spin = () => card(page, "call_run").locator('[data-specialist-state="running"] svg').evaluate((el) => getComputedStyle(el).animationName);
  expect(await spin()).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(scene(page)).toBeVisible();
  expect(await spin()).toBe("none");
  // Nothing else moves at all.
  for (const callId of ["call_wait", "call_stuck", "call_ready", "call_done"]) {
    const name = await card(page, callId).locator("[role=img] svg").evaluate((el) => getComputedStyle(el).animationName);
    expect(name, callId).toBe("none");
  }
});

test("295: every specialist has one name, the same on its card and its row; five of one kind are told apart, the rail takes the chat's names", async ({ page }) => {
  await open(page);
  const cards = await thread(page).locator("[data-delegation] [data-specialist-name]").allTextContents();
  expect(cards).toEqual(EXPECTED.map(([, name]) => name));
  const rows = await rail(page).locator("li [data-specialist-name]").allTextContents();
  expect(rows).toEqual(EXPECTED.map(([, name]) => name));
  // The robot codenames the rail used to give runs are gone: no name but the chat's.
  await expect(rail(page)).not.toContainText("WALL-E");
  // The steering note and the approval on a card say the same name.
  await expect(card(page, "call_run").locator("[data-steering-note]")).toContainText("Steered Research");
});

test("296: an approval given to a specialist and a note sent to it sit on its card, not in the thread; the open approval stays answerable", async ({ page }) => {
  await open(page);
  // The approval the person gave Research: its one-line record on Research's card…
  const record = card(page, "call_run").locator('[data-relayed-approval] [data-answered-approval="allowed"]');
  await expect(record).toHaveCount(1);
  await expect(record).toContainText("Write file");
  // …and nowhere else in the thread: no row of its own between the messages.
  await expect(thread(page).locator("[data-answered-approval]")).toHaveCount(1);
  // The note sent to Research: on its card, with whether it has read it; no card of its own at the thread's tail.
  await expect(card(page, "call_run").locator("[data-steering-note]")).toContainText("Focus on FY24 only.");
  await expect(card(page, "call_run").locator("[data-steering-status]")).toHaveText("Waiting for its next step");
  await expect(thread(page).locator("[data-specialist-notes]")).toHaveCount(0);

  // Research 2's approval is open: its buttons are in the stack beside the composer, its card points there.
  const stack = page.locator("[data-pending-approvals]");
  await expect(stack.getByText("Publish the summary to the data room?")).toBeVisible();
  await expect(card(page, "call_wait").locator("[data-approval-below]")).toBeVisible();
  expect(await stack.evaluate((el) => Boolean(el.closest('[role="log"]')))).toBe(false);
  await stack.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => page.evaluate(() => window.__answers)).toEqual([{ requestId: "req_open", optionId: "approve" }]);
  // Answered: out of the stack, and the card is no longer waiting on the person.
  await expect(stack.getByText("Publish the summary to the data room?")).toHaveCount(0);
  await expect(card(page, "call_wait")).toHaveAttribute("data-specialist-state", "running");
});

test("294: the main agent stops Research 4 — the card turns to stopped and says why; the stop is no row of its own", async ({ page }) => {
  await open(page);
  await expect(card(page, "call_mstop")).toHaveAttribute("data-specialist-state", "running");
  await page.getByTestId("main-agent-stops").click();
  const stopped = card(page, "call_mstop");
  await expect(stopped).toHaveAttribute("data-specialist-state", "stopped");
  await expect(stopped.getByRole("img", { name: "Stopped", exact: true })).toBeVisible();
  await expect(stopped.locator("[data-stop-reason]")).toHaveText("Stopped by the main agent: The person asked for FY24 only.");
  // The main agent's reply says so in its own words; its tool call is not a row of the thread.
  await expect(thread(page)).toContainText("I stopped Research 4: you asked for FY24 only.");
  await expect(thread(page)).not.toContainText("Stop specialist");
  await expect(thread(page).locator("[data-delegation]")).toHaveCount(9);
  // The rail says it too.
  const row = rail(page).locator("li").filter({ has: page.locator("[data-specialist-name]", { hasText: /^Research 4$/ }) });
  await expect(row.getByRole("img", { name: "Stopped", exact: true })).toBeVisible();
  // The other specialists are untouched.
  await expect(card(page, "call_run")).toHaveAttribute("data-specialist-state", "running");
});
