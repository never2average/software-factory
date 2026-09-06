/**
 * Release idle remote browsers from the agent deployment.
 *
 * This schedule intentionally lives with BROWSERBASE_API_KEY. The web project
 * must never mark a provider session closed without first asking the owning
 * provider to release it. `sweepIdleSessions` is idempotent and retries failed
 * or crash-interrupted releases.
 */
import { defineSchedule } from "eve/schedules";
import { sweepIdleSessions } from "#lib/browser.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    waitUntil(
      sweepIdleSessions()
        .then(({ released, failed }) => {
          console.log(`[browser-sweep] released=${released} failed=${failed}`);
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[browser-sweep] failed: ${detail}`);
        }),
    );
  },
});
