/**
 * The specialist sweep's clock (mold_v1-196): every 5 minutes, every workspace in its own scope, the main threads that
 * delegated within SPECIALIST_SWEEP_LOOKBACK_H and still have a delegation outstanding (mold_v1-199: a finished thread
 * is not read again; agent/lib/sweep-ledger.ts `sweepCandidates`). A delegation that went quiet — frozen, finished with its result never
 * handed back, stopped or crashed without a report — is settled once; one waiting on a person for longer than
 * SPECIALIST_SWEEP_WAITING_H is surfaced. What and why: agent/lib/specialist-sweep.ts. SPECIALIST_SWEEP=off turns it off.
 *
 * It lives with the agent because it acts through the agent's runtime (eve's `delegationSweep`). On Vercel this is a
 * Vercel Cron Job; a self-hosted `eve start` runs it itself. `eve dev` never fires schedules on cadence: trigger it with
 * `POST /eve/v1/dev/schedules/sweep-specialists`.
 *
 * tenancy-ok: workspaces are listed from the control plane (`orgs`, no RLS); every read and write of a workspace's rows
 * runs in that workspace's scope (agent/lib/sweep-ledger.ts).
 */
import { defineSchedule } from "eve/schedules";
import { agentSystemGateDb } from "#lib/session-owner-backfill.js";
import { sweepAllWorkspaces } from "#lib/specialist-sweep-run.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    // One line every pass, also when there is nothing to do (sweepPassLine): the journal shows the sweep is alive.
    waitUntil(sweepAllWorkspaces(agentSystemGateDb(), { budgetMs: 240_000 }));
  },
});
