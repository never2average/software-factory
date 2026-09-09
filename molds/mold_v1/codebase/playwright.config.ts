import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the auth-free /preview/* harnesses (tests/cards.spec.ts,
 * tests/stickloop.spec.ts). Boots `next dev` bound to the loopback interface
 * only: the factory's testing lanes run this on a host with no firewall, and
 * `next dev` on its own listens on every interface.
 *
 * tests/task-workflow-stress has its own config and runs against a live
 * service; it is excluded here so `playwright test` stays offline.
 */
const HOST = "127.0.0.1";
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/task-workflow-stress/**"],
  timeout: 45_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    viewport: { width: 1400, height: 900 },
    // The app themes via @media (prefers-color-scheme: dark) — emulate it so the
    // preview screenshots match production's dark surfaces.
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --hostname ${HOST} --port ${PORT}`,
    url: `${BASE}/preview/cards`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
