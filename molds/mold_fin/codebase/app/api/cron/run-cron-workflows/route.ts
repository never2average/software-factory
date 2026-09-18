import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  automationRuns,
  scheduleRules,
  systemCronOverrides,
  workflows,
} from "@/agent/lib/db/schema";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "@/lib/ops-db";
import { makeDelegate } from "@/lib/workflow-delegate";
import {
  finishWorkflowRun,
  loadWorkflowJournal,
  makeDurableDelegate,
  startWorkflowRun,
  withWorkflowRunHeartbeat,
  type WorkflowRunLease,
} from "@/lib/workflow-journal";
import { runWorkflowScript } from "@/lib/workflow-runtime";
import { workflowDataFor } from "@/lib/workflow-data";
import { stripTypes } from "@/lib/workflow-ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs the workflow a cron fire routed to. The agent's dispatcher records each
 * fire as an `automation_run` and posts to Slack; this Vercel Cron then finds
 * recent system-cron fires whose cron routes to a workflow (system_cron_overrides
 * .workflow) and haven't been run yet, and executes that workflow DURABLY —
 * stamping the resulting run id back onto the invocation so it can be opened as a
 * chat. The Slack post is untouched; this runs the workflow IN ADDITION.
 *
 * AUTH mirrors resume-workflows: the front-end's own Vercel OIDC service token
 * (the agent trusts this project's subject); CRON_SECRET guards the endpoint.
 */
const RECENT_MS = 15 * 60 * 1000;
const PER_TICK = 2;

function serviceBearer(request: NextRequest): string | null {
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
  const bearer = serviceBearer(request);

  // Recent cron / schedule fires not yet linked to a workflow run.
  /**
   * Fires span workspaces, so discovery sweeps per workspace and merges.
   *
   * A single unscoped scan works today only because the policy fails open; the
   * moment it fails closed it returns nothing and every cron silently stops
   * turning into a run — indistinguishable from "nothing fired".
   */
  const fires = (
    await acrossOrgsRls((tx) =>
      tx
        .select()
        .from(automationRuns)
        .where(
          and(
            inArray(automationRuns.automationType, ["system_cron", "schedule"]),
            isNull(automationRuns.workflowRunId),
            gt(automationRuns.startedAt, new Date(Date.now() - RECENT_MS)),
          ),
        )
        .orderBy(desc(automationRuns.startedAt))
        .limit(20),
    )
  )
    .sort((x, y) => (y.startedAt?.getTime() ?? 0) - (x.startedAt?.getTime() ?? 0))
    .slice(0, 20);

  const outcomes: Array<{ cron: string; runId?: string; status: string }> = [];
  let ran = 0;
  for (const fire of fires) {
    if (ran >= PER_TICK) break;
    // No fallback: org_id is NOT NULL, and the old default 'org-onfinance' is
    // not a workspace — a fire routed there would resolve no rule, no workflow
    // and no run, silently.
    const fireOrg = fire.orgId;
    // Which workflow does this fire route to? A system cron carries it on its
    // override row (keyed by name); a schedule rule carries it on the rule
    // itself (keyed by id).
    let wfName: string | undefined;
    if (fire.automationType === "schedule") {
      const [rule] = await withOrgRls(fireOrg, (tx) =>
        tx
        .select()
        .from(scheduleRules)
        .where(
          and(eq(scheduleRules.orgId, fireOrg), eq(scheduleRules.id, fire.automationId)),
        )
        .limit(1),
      );
      wfName = rule?.workflow?.trim() || undefined;
    } else {
      const [override] = await withOrgRls(fireOrg, (tx) =>
        tx
        .select()
        .from(systemCronOverrides)
        // Code-authored cron overrides are global definitions; the automation
        // fire supplies the tenant whose workflow name is resolved below.
        .where(eq(systemCronOverrides.name, fire.automationId))
        .limit(1),
      );
      wfName = override?.workflow?.trim() || undefined;
    }
    if (!wfName) continue;
    const [wf] = await withOrgRls(fireOrg, (tx) =>
      tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.orgId, fireOrg), eq(workflows.name, wfName)))
      .limit(1),
    );
    if (!wf?.script) continue;

    // Claim this fire atomically so two ticks never double-run it.
    const runId = `wfr_${crypto.randomUUID()}`;
    const claimed = await withOrgRls(fireOrg, (tx) =>
      tx
      .update(automationRuns)
      .set({ workflowRunId: runId })
      .where(and(eq(automationRuns.id, fire.id), isNull(automationRuns.workflowRunId)))
      .returning({ id: automationRuns.id }),
    );
    if (claimed.length === 0) continue;

    if (!bearer) {
      // Claimed but can't run without the service token — report and move on.
      outcomes.push({ cron: fire.automationId, runId, status: "no-service-token" });
      ran++;
      continue;
    }
    let lease: WorkflowRunLease | null = null;
    try {
      const { js, error } = stripTypes(wf.script);
      if (error) {
        outcomes.push({ cron: fire.automationId, runId, status: "failed" });
        ran++;
        continue;
      }
      lease = await startWorkflowRun({
        orgId: fireOrg,
        runId,
        workflowId: wf.id,
        workflowName: wf.name,
        args: null,
        createdBy: `cron:${fire.automationId}`,
      });
      const journal = await loadWorkflowJournal(lease);
      let cancelled = false;
      let cancellationReason: string | null = null;
      const result = await withWorkflowRunHeartbeat(lease, async (control) => {
        const outcome = await runWorkflowScript(js, {
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(fireOrg),
          delegate: makeDurableDelegate(makeDelegate(bearer, undefined, control.signal), journal, 3, control.signal),
          args: null,
          signal: control.signal,
        });
        cancelled = control.signal.aborted;
        cancellationReason = control.cancellationReason();
        return outcome;
      });
      await finishWorkflowRun(lease, {
        status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
        result: result.ok ? result.result : undefined,
        error: cancelled ? cancellationReason ?? result.error : result.ok ? null : result.error,
      });
      outcomes.push({
        cron: fire.automationId,
        runId,
        status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (lease) await finishWorkflowRun(lease, { status: "failed", error: message });
      outcomes.push({ cron: fire.automationId, runId, status: "failed" });
    }
    ran++;
  }
  return NextResponse.json({ scanned: fires.length, ran, outcomes });
}
