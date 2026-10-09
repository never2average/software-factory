/**
 * Headed browser for reviewing the Ops Center UI.
 *
 * Launches Chromium with a PERSISTENT profile (scripts/.browser-profile) so a
 * login survives between runs, opens the app, and then takes instructions from
 * a command file — so the person at the keyboard can log in, and the review can
 * carry on driving the SAME authenticated session afterwards.
 *
 *   node scripts/ui-review.mjs [url]
 *
 * Commands: append one JSON object per line to scripts/.ui-cmd
 *   {"do":"goto","url":"…"}
 *   {"do":"click","selector":"…"}        CSS or Playwright text= / role= selector
 *   {"do":"shot","name":"ops-secrets"}   → scripts/.shots/<name>.png
 *   {"do":"shot","name":"…","selector":"…"}   just that element
 *   {"do":"eval","js":"…"}               returns JSON.stringify of the result
 *
 * Every result is appended to scripts/.ui-log as JSON. This is a review harness,
 * not a test: it asserts nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://agent-workspace.vercel.app/";
const CMD = "scripts/.ui-cmd";
const LOG = "scripts/.ui-log";
const SHOTS = "scripts/.shots";

mkdirSync(SHOTS, { recursive: true });
writeFileSync(CMD, "");
writeFileSync(LOG, "");

const context = await chromium.launchPersistentContext("scripts/.browser-profile", {
  headless: false,
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded" });

const say = (entry) => appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
say({ ready: true, url: page.url() });
console.log(`[ui-review] ${url} is open. Log in if asked; the window stays up.`);

async function run(cmd) {
  switch (cmd.do) {
    case "goto":
      await page.goto(cmd.url, { waitUntil: "domcontentloaded" });
      return { url: page.url() };
    case "click":
      await page.click(cmd.selector, { timeout: 8000 });
      // Let any panel/modal settle before the next command screenshots it.
      await page.waitForTimeout(cmd.wait ?? 600);
      return { clicked: cmd.selector };
    case "shot": {
      const path = `${SHOTS}/${cmd.name}.png`;
      const target = cmd.selector ? page.locator(cmd.selector).first() : page;
      await target.screenshot({ path });
      return { shot: path };
    }
    case "eval":
      return { result: await page.evaluate(cmd.js) };
    default:
      return { error: `unknown command ${cmd.do}` };
  }
}

// Poll the command file; each new line is executed once.
let done = 0;
setInterval(async () => {
  if (!existsSync(CMD)) return;
  const lines = readFileSync(CMD, "utf8").split("\n").filter(Boolean);
  while (done < lines.length) {
    const raw = lines[done++];
    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch {
      say({ cmd: raw, error: "bad JSON" });
      continue;
    }
    try {
      say({ cmd, ...(await run(cmd)) });
    } catch (e) {
      say({ cmd, error: String(e).split("\n")[0] });
    }
  }
}, 400);

await new Promise(() => {});
