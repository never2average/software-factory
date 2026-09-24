import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { workflows } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { makeDelegate } from "@/lib/workflow-delegate";
import {
  finishWorkflowRun,
  claimStalledRuns,
  listStalledRuns,
  loadWorkflowJournal,
  makeDurableDelegate,
  withWorkflowRunHeartbeat,
} from "@/lib/workflow-journal";
import { runWorkflowScript } from "@/lib/workflow-runtime";
import { workflowDataFor } from "@/lib/workflow-data";
import { stripTypes } from "@/lib/workflow-ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Continuation driver for durable workflow runs — the thing that beats the 300s
 * function wall. A Vercel Cron hits this every few minutes; it finds runs stuck
 * in `running` past the stall window (a prior invocation timed out) and RE-DRIVES
 * each: the journal replays completed agent() calls instantly and execution
 * continues from the first unfinished one, until the run completes, fails, or
 * times out again (another tick picks it up), capped by `attempts`.
 *
 * AUTH: re-driving calls the agent, which requires a trusted identity. A cron has
 * no human token, so it presents the FRONT-END'S OWN Vercel-minted OIDC token
 * (VERCEL_OIDC_TOKEN) — a service identity Vercel injects and rotates per
 * invocation, with nothing stored. The agent's vercelOidc() verifier trusts this
 * project's subject (agent/channels/eve.ts). If the token is absent (OIDC
 * federation off) this endpoint only REPORTS the backlog — users can still resume
 * manually (POST the run route with the durable runId). The endpoint itself is
 * guarded by CRON_SECRET when set (Vercel sends it on cron calls).
 */
const STALL_MS = 6 * 60 * 1000; // a run untouched for 6m is stuck
const ATTEMPTS_CAP = 6;
const PER_TICK = 2; // re-drive at most this many per tick (each has its own 300s)

/**
 * The service bearer for re-driving: the front-end's own Vercel OIDC token. No
 * secret, no expiry management — Vercel injects a fresh one per invocation as the
 * `x-vercel-oidc-token` request header (this is where it lives at RUNTIME;
 * process.env.VERCEL_OIDC_TOKEN is only populated in local dev via `vercel env
 * pull`). Null when OIDC federation is off, degrading this endpoint to
 * report-only.
 */
function resumeBearer(request: NextRequest): string | null {
  return request.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN ?? null;
}

export async function GET(request: NextRequest) {
  // FAIL CLOSED. This was `if (secret && …)`, which skips the check entirely
  // when CRON_SECRET is unset — and it is set on Production ONLY, so every
  // preview deployment exposed this endpoint unauthenticated. A missing
  // secret is a misconfiguration, not an open door (same shape as
  // /api/ops/run, which already got this right).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured, so this cron is disabled." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const bearer = resumeBearer(request);
  if (!bearer) {
    const stalled = await listStalledRuns({
      stallMs: STALL_MS,
      attemptsCap: ATTEMPTS_CAP,
      limit: PER_TICK,
    });
    return NextResponse.json({
      stalled: stalled.length,
      resumed: 0,
      note: "No VERCEL_OIDC_TOKEN (OIDC federation off) — enable it to auto-resume; users can resume manually meanwhile.",
      runIds: stalled.map((s) => s.runId),
    });
  }

  const stalled = await claimStalledRuns({
    stallMs: STALL_MS,
    attemptsCap: ATTEMPTS_CAP,
    limit: PER_TICK,
    workerId: `resume-cron:${process.env.VERCEL_REGION ?? "local"}:${crypto.randomUUID()}`,
  });
  const outcomes: Array<{ runId: string; status: string; attempt: number; workerId: string }> = [];
  for (const s of stalled) {
    try {
      if (!s.workflowId) {
        await finishWorkflowRun(s, { status: "failed", error: "no workflow id on run" });
        outcomes.push({ runId: s.runId, status: "failed", attempt: s.attempts, workerId: s.workerId });
        continue;
      }
      // The stalled run carries its own workspace; claimStalledRuns already
      // swept per workspace (lib/workflow-journal.ts), so this lookup just
      // needs to happen in the run's scope rather than none.
      const workflowId = s.workflowId;
      const [wf] = await withOrgRls(s.orgId, (tx) =>
        tx
          .select()
          .from(workflows)
          .where(and(eq(workflows.orgId, s.orgId), eq(workflows.id, workflowId)))
          .limit(1),
      );
      if (!wf?.script) {
        await finishWorkflowRun(s, { status: "failed", error: "workflow or script gone" });
        outcomes.push({ runId: s.runId, status: "failed", attempt: s.attempts, workerId: s.workerId });
        continue;
      }
      const { js, error } = stripTypes(wf.script);
      if (error) {
        await finishWorkflowRun(s, { status: "failed", error });
        outcomes.push({ runId: s.runId, status: "failed", attempt: s.attempts, workerId: s.workerId });
        continue;
      }
      const journal = await loadWorkflowJournal(s);
      let cancelled = false;
      let cancellationReason: string | null = null;
      const result = await withWorkflowRunHeartbeat(s, async (control) => {
        const outcome = await runWorkflowScript(js, {
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(s.orgId),
          delegate: makeDurableDelegate(makeDelegate(bearer, undefined, control.signal, undefined, s.orgId), journal, 3, control.signal),
          args: s.args,
          signal: control.signal,
        });
        cancelled = control.signal.aborted;
        cancellationReason = control.cancellationReason();
        return outcome;
      });
      await finishWorkflowRun(s, {
        status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
        result: result.ok ? result.result : undefined,
        error: cancelled ? cancellationReason ?? result.error : result.ok ? null : result.error,
      });
      outcomes.push({
        runId: s.runId,
        status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
        attempt: s.attempts,
        workerId: s.workerId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finishWorkflowRun(s, { status: "failed", error: message });
      outcomes.push({ runId: s.runId, status: "failed", attempt: s.attempts, workerId: s.workerId });
    }
  }
  return NextResponse.json({ stalled: stalled.length, resumed: outcomes.length, outcomes });
}
