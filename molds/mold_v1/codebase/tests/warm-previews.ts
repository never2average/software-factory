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
 * The same holds for the pages and routes that are not previews: tests/google-hub.spec.ts opens the app itself (`/`,
 * the whole client behind the sign-in) and the sign-in hub's routes, and two of its failures were first compiles
 * (mold_v1-292):
 *   - `/` was compiled inside that spec's first test, beside the other worker's specs, and on a busy 4-core box its
 *     first load did not finish inside the test's 120 s (page.goto: net::ERR_ABORTED when the test was torn down).
 *   - The app asks its hub `/api/auth/google-hub/status` before it offers the hub's button, with 4 s to answer
 *     (lib/google-sign-in-mode.ts), and remembers the answer for a minute. The first ask compiled that route, took
 *     longer than 4 s, and for the next minute the app said "direct" instead of "hub": the spec's first test failed its
 *     "this is the server playwright.config.ts started" check and the next waited for a hub button never drawn.
 * So they are compiled here too: the routes by an OPTIONS request, then the app's page in the browser (its client
 * chunks with it). A route handler compiles on any method, and Next answers OPTIONS itself (204, the methods the
 * route takes) without running the route's own code. A GET would run it: the availability route would ask the hub
 * and remember the answer for a minute, so a status route still slow here would store the very "direct" answer this
 * warm-up exists to prevent. With OPTIONS nothing is asked and nothing is remembered, however slow the first compile.
 *
 * Nothing here reaches beyond the page: every API and agent request a page makes while it loads is answered empty,
 * exactly as the specs answer what they do not test. A page that does not load is not an error here: the spec that
 * opens it says what is wrong.
 */
const APP_PAGES = ["/"];
const ROUTES = ["/api/auth/google-hub/status", "/api/auth/google/availability", "/auth/google-hub", "/api/auth/google-hub/callback"];
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
    for (const at of ROUTES) {
      const started = Date.now();
      const res = await page.request
        .fetch(new URL(at, baseURL).toString(), { method: "OPTIONS", maxRedirects: 0, timeout: 180_000 })
        .catch((e: Error) => e);
      const said = res instanceof Error ? `did not answer (${res.message.split("\n")[0]})` : `${res.status()}`;
      console.log(`warm-previews: OPTIONS ${at} ${said} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    for (const at of APP_PAGES) {
      const started = Date.now();
      const res = await page.goto(new URL(at, baseURL).toString(), { waitUntil: "load", timeout: 180_000 }).catch((e: Error) => e);
      const said = res instanceof Error ? `did not load (${res.message.split("\n")[0]})` : `${res?.status() ?? "no response"}`;
      console.log(`warm-previews: ${at} ${said} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
  }
}
