import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * "The thinking stream continues above the subagent segment even though it
 * should be below the subagent section."
 *
 * Renders RECORDED eve streams (scripts/fixtures/event-order) through the
 * chat's own reducer and the real AgentMessage at /preview/event-order, and
 * reads the DOM: the orchestrator's thinking after a delegation must sit AFTER
 * the specialist's card, both frozen mid-stream (a live turn) and fully folded
 * (a reopened thread). The reducer-level half is scripts/test-chat-event-order.mjs.
 */
const events = (fixture: string) =>
  readFileSync(`scripts/fixtures/event-order/${fixture}.ndjson`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; data?: { reasoningSoFar?: string } });

/** The transcript's thinking blocks and delegation cards, top to bottom, by DOM position. */
async function layout(page: Page) {
  return page.getByTestId("event-order").evaluate((root) => {
    const found: { el: Element; kind: string }[] = [];
    for (const el of root.querySelectorAll('button[title="Open in Control Panel"]')) found.push({ el, kind: "card" });
    for (const el of root.querySelectorAll("button")) {
      if (/^(Thinking|Thought for)/.test(el.textContent?.trim() ?? "")) found.push({ el, kind: "thinking" });
    }
    found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return found.map((f) => f.kind);
  });
}

/** Open every thinking block and return its text (trigger + content), top to bottom. */
async function thinkingTexts(page: Page) {
  const triggers = page.getByTestId("event-order").locator("button").filter({ hasText: /^(Thinking|Thought for)/ });
  const n = await triggers.count();
  const texts: string[] = [];
  for (let i = 0; i < n; i++) {
    await triggers.nth(i).click();
    // The trigger's parent is the block (a Collapsible root holding trigger and content).
    const block = triggers.nth(i).locator("xpath=..");
    await expect(block).toHaveAttribute("data-state", "open");
    texts.push((await block.innerText()).replace(/\s+/g, " ").trim());
  }
  return texts;
}

async function open(page: Page, fixture: string, upto?: number) {
  const all = events(fixture).length;
  await page.goto(`/preview/event-order?fixture=${fixture}${upto ? `&upto=${upto}` : ""}`);
  await expect(page.getByTestId("event-order")).toHaveAttribute("data-applied", String(upto ?? all), { timeout: 20_000 });
}

test("live: the orchestrator's next thinking streams BELOW the specialist card", async ({ page }) => {
  const list = events("reasoning-around-subagent");
  // Freeze on the first delta of the thinking that follows the specialist's result.
  const at = list.findIndex((e) => e.type === "reasoning.appended" && e.data?.reasoningSoFar?.startsWith("ORCH-THINK-2")) + 1;
  expect(at).toBeGreaterThan(0);
  await open(page, "reasoning-around-subagent", at);
  expect(await layout(page)).toEqual(["thinking", "card", "thinking"]);
  // The block below the card is the one streaming, and it holds the NEW thinking.
  const card = page.locator('button[title="Open in Control Panel"]');
  await expect(card).toContainText("Completed");
  const texts = await thinkingTexts(page);
  expect(texts[0]).toContain("ORCH-THINK-1");
  expect(texts[1]).toContain("ORCH-THINK-2");
  await page.screenshot({ path: "test-results/event-order-live.png", fullPage: true });
});

test("reopened: every part renders in the order it happened", async ({ page }) => {
  await open(page, "text-before-subagent");
  expect(await layout(page)).toEqual(["thinking", "card", "thinking"]);
  const root = page.getByTestId("event-order");
  // The sentence written before delegating is above the card, the answer below it.
  const order = await root.evaluate((el) => {
    const textNode = (needle: string) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes(needle)) return n;
      return null;
    };
    const nodes = [textNode("PRE-DELEGATION"), el.querySelector('button[title="Open in Control Panel"]'), textNode("FINAL-ANSWER")];
    if (nodes.some((n) => !n)) return nodes.map((n) => Boolean(n));
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return [before(nodes[0] as Node, nodes[1] as Node), before(nodes[1] as Node, nodes[2] as Node)];
  });
  expect(order).toEqual([true, true]);
  const texts = await thinkingTexts(page);
  expect(texts[0]).toContain("ORCH-THINK-1");
  expect(texts[1]).toContain("ORCH-THINK-2");
  await page.screenshot({ path: "test-results/event-order-reopened.png", fullPage: true });
});
