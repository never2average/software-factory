import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { ABANDONED_RUN_MS, closeAbandonedWorkflowRuns } from "@/agent/lib/workflow-usage";
import { getOpsDb } from "@/lib/ops-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Closes subagent runs that nobody will ever close.
 *
 * A specialist's `automation_runs` row is opened on the child's `turn.started`
 * and closed on `turn.completed` / `turn.failed`. A child that dies mid-turn
 * emits neither: eve's `session.failed` carries no `turnId`, so there is
 * nothing to close the row BY, and it stays `running` for ever. Measured on the
 * live deployment 2026-09-23 — workspace `icici-hfc` holds three rows and one
 * of them is still `running` with nothing watching it.
 *
 * The obvious alternative, remembering the open turn id at module scope so
 * `session.failed` can close it, was declined because a warm instance serves
 * several sessions and the id it remembers may belong to a LIVE run. A clock
 * needs nothing remembered, so it cannot make that mistake. See
 * `ABANDONED_RUN_MS` in agent/lib/workflow-usage.ts for the interval and the
 * measurements behind it, and `AWAITING_ANSWER_SUMMARY` for why a run parked on
 * a question is never swept however old it is.
 *
 * AUTH mirrors every other cron here: CRON_SECRET, FAIL CLOSED. This endpoint
 * needs no service identity of its own — it calls nothing and only writes to
 * rows it can prove are dead — so unlike resume-workflows there is no OIDC
 * token to degrade without.
 *
 * tenancy-ok: the sweep is cross-workspace BY CONSTRUCTION and is already
 * scoped where it counts. `closeAbandonedWorkflowRuns` runs its update once per
 * workspace inside `withOrgDb(orgId)`; a single unscoped statement would match
 * nothing under the fail-closed policy and look exactly like "nothing to close".
 */
export async function GET(request: NextRequest) {
  // FAIL CLOSED. `if (secret && …)` skips the check when CRON_SECRET is unset,
  // and it is set on Production ONLY — which left every preview deployment
  // exposing the other crons unauthenticated.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured, so this cron is disabled." },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { closed } = await closeAbandonedWorkflowRuns();
  return NextResponse.json({ closed, olderThanMs: ABANDONED_RUN_MS });
}
