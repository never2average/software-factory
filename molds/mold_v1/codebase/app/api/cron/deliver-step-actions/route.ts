import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "@/lib/ops-db";
import { deliverStepActions, fairShare, productionStepActionDeps, recordsWithStepActions, type StepActionRunner } from "@/lib/record-workflow-actions";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The SAFETY NET under a record workflow's step actions (lib/record-workflow-actions.ts). The door that made a step
 * change delivers what it fired the moment its transaction commits; this catches what that missed (a function frozen
 * mid-delivery, a failed attempt due again, a claim whose deliverer died) once a minute. A record with nothing due is
 * not touched, nor one whose action waits out its backoff or is being delivered right now. Nothing here sends an
 * email: an email action is the app's own notification, an agent action a task.
 *
 * Guarded by CRON_SECRET, and fail-closed without it, like every cron here.
 *
 * tenancy-ok: cross-workspace by design, through `acrossOrgsRls` (one scoped pass per workspace); every read and
 * write inside it, and each delivery, is scoped to that workspace.
 */
const PER_TICK = 20;
const runIn: StepActionRunner = (org, fn) => withOrgRls(org, fn as never);

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured, so this cron is disabled." }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!getOpsDb()) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  // Each workspace's records with an action DUE now, longest waiting first; the tick shared out one record of each
  // workspace in turn, so one workspace's backlog never keeps another's waiting.
  const now = new Date();
  const due = await acrossOrgsRls(async (tx, orgId) => [(await recordsWithStepActions(tx as never, orgId, PER_TICK, now)).map((r) => ({ orgId, ...r }))]);
  const work = fairShare(due, PER_TICK);
  const outcomes: Array<{ area: string; delivered: number; failed: number; error?: string }> = [];
  const deps = productionStepActionDeps(runIn);
  for (const w of work) {
    try {
      const r = await deliverStepActions(w.orgId, w.area, w.key, deps, { product: PRODUCT_NAME });
      outcomes.push({ area: w.area, delivered: r.filter((o) => o.ok).length, failed: r.filter((o) => !o.ok).length });
    } catch (e) {
      outcomes.push({ area: w.area, delivered: 0, failed: 0, error: e instanceof Error ? e.message.slice(0, 80) : "unknown" });
    }
  }
  return NextResponse.json({ checked: outcomes.length, outcomes });
}
