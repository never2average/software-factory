/**
 * The orchestrator's entry (mold_v0-039): a host pack's own orchestrator (orchestrator/packs/<id>/main.ts, listed by
 * scripts/gen-packs.mjs in packs.generated.ts) when the build has one, else the deterministic worker (worker.ts), which
 * drives each claimed session to done without a model of its own.
 *   npx tsx orchestrator/main.ts
 */
import { ORCHESTRATOR_ENTRIES } from "./packs.generated.js";

const entry = ORCHESTRATOR_ENTRIES[0];
if (entry) await import(new URL(entry, import.meta.url).href);
else {
  const { claimLoop, runDeterministic } = await import("./worker.js");
  const { startIdleWatcher } = await import("./core/activity.js");
  startIdleWatcher();
  claimLoop((job, runner) => runDeterministic(job, runner), "worker")
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
