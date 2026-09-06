import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the workspace-card visual checks. Boots `next dev` and
 * renders the auth-free preview at /preview/cards (see tests/cards.spec.ts).
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1400, height: 900 },
    // The app themes via @media (prefers-color-scheme: dark) — emulate it so the
    // preview screenshots match production's dark surfaces.
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/preview/cards",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
