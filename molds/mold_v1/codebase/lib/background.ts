/**
 * WORK THAT OUTLIVES THE RESPONSE. A route that starts something long (an app refresh) answers at once and keeps
 * going here.
 *
 * Inside a Next.js request this is `after()`: the platform keeps the function alive for the work, up to the route's
 * `maxDuration` on Vercel, and for as long as it takes on a long-lived server (`next start`). Outside one (a test, a
 * script) there is no request to outlive, and the work simply runs on.
 *
 * Nothing here makes the work durable. What is durable is the record the work leaves before it starts (an app's
 * refresh marker and the session or run it opened) and the cron that finishes what a killed function could not
 * (lib/app-refresh.ts `collectAppRefreshes`). This only stops the request from waiting for it.
 */
import { after } from "next/server";

export function inBackground(task: () => Promise<unknown>, label = "background work"): void {
  const run = () =>
    task().catch((error) => {
      console.error(`[background] ${label} failed:`, error);
    });
  try {
    after(run);
  } catch {
    // Not in a request scope: nothing to outlive.
    void run();
  }
}
