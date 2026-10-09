import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";

/**
 * Every /preview/* page is opened once, in Chromium, before the first spec runs (playwright.config.ts `globalSetup`;
 * Playwright starts the webServer before it).
 *
 * WHY: `next dev` compiles a route on its first request, server side when the page is asked for and the client chunks
 * when a browser loads them. The webServer is ready once /preview/cards answers, so every OTHER preview page was
 * compiled inside the first test that opened it, on that test's 45 s budget. /preview/user-message (the real chat
 * message and the sandbox line) took 28 s to compile cold on a 4-core box, and the sandbox-line spec ran in 35 s idle
 * and 43.9 s beside the rest of the suite; under any other load on the box it timed out at its last step
 * (mold_v1-214/215). The budget is the spec's; compiling is the server's, and it happens here, once, before the clock
 * of any test starts. A warm server makes this a few seconds.
 *
 * Nothing here reaches beyond the page: every API and agent request a page makes while it loads is answered empty,
 * exactly as the specs answer what they do not test. A page that does not load is not an error here: the spec that
 * opens it says what is wrong.
 */
export default async function warmPreviews(config: FullConfig): Promise<void> {
  const root = config.configFile ? path.dirname(config.configFile) : process.cwd();
  const dir = path.join(root, "app", "preview");
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL || !existsSync(dir)) return;
  const pages = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "page.tsx")))
    .map((d) => d.name)
    .sort();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(/\/(api|eve)\//, (route) => route.fulfill({ status: 200, json: { ok: true, items: [] } }));
    for (const name of pages) {
      const started = Date.now();
      const res = await page.goto(new URL(`/preview/${name}`, baseURL).toString(), { waitUntil: "load", timeout: 180_000 }).catch((e: Error) => e);
      const said = res instanceof Error ? `did not load (${res.message.split("\n")[0]})` : `${res?.status() ?? "no response"}`;
      console.log(`warm-previews: /preview/${name} ${said} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
  }
}
