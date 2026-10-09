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
/**
 * The port is 3000 unless PLAYWRIGHT_PORT says otherwise. On a machine that runs more than one checkout (the
 * factory's lanes beside a local CI run) every run asked for 3000 and adopted whatever answered there: a run reused
 * another run's `next dev`, that run tore its server down, and the first got net::ERR_CONNECTION_REFUSED mid-test.
 * A run that names its own port starts its own server and never adopts one (`reuseExistingServer` is off for it);
 * with the variable unset nothing changes: port 3000, and a server already there is reused, as before.
 */
const OWN_PORT = process.env.PLAYWRIGHT_PORT?.trim() ?? "";
if (OWN_PORT !== "" && !(/^\d{1,5}$/.test(OWN_PORT) && Number(OWN_PORT) >= 1 && Number(OWN_PORT) <= 65_535)) {
  throw new Error(`PLAYWRIGHT_PORT must be a port number (1 to 65535), or unset for 3000; it is "${OWN_PORT}".`);
}
const PORT = OWN_PORT === "" ? 3000 : Number(OWN_PORT);
const BASE = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/task-workflow-stress/**"],
  // Every /preview/* page compiled once before the first spec, so a spec's 45 s is the spec's own and not `next dev`
  // compiling the route it opens first (tests/warm-previews.ts; mold_v1-214/215).
  globalSetup: "./tests/warm-previews.ts",
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
    reuseExistingServer: OWN_PORT === "",
    timeout: 180_000,
  },
});
