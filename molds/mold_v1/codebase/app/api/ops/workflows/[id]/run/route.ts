import { NextRequest, NextResponse } from "next/server";
import { errorMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { automationRuns, workflows } from "@/agent/lib/db/schema";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { customerFromArgs, makeDelegate } from "@/lib/workflow-delegate";
import { runWorkflowScript } from "@/lib/workflow-runtime";
import { workflowDataFor } from "@/lib/workflow-data";
import {
  finishWorkflowRun,
  loadWorkflowJournal,
  makeDurableDelegate,
  startWorkflowRun,
  withWorkflowRunHeartbeat,
  WorkflowRunLeaseUnavailableError,
  type WorkflowRunLease,
} from "@/lib/workflow-journal";
import { stripTypes } from "@/lib/workflow-ts";
import { analyzeWorkflowScript } from "@/lib/workflow-validate";
import { alignWorkflowArgs, coerceWorkflowArgs, validateWorkflowArgs } from "@/lib/workflow-args";
import { workflowAvailability } from "@/lib/workflow-availability";
import { orgContextForRequest } from "@/lib/org-context";
import { mintSessionToken } from "@/lib/auth-session";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A workflow delegates to the model; give it room, but never unbounded.
export const maxDuration = 300;

/**
 * Run a workflow script.
 *
 * The script executes in the QuickJS sandbox (lib/workflow-runtime.ts) — no
 * filesystem, no network, no host objects — and its `agent()` calls are the only
 * thing that reaches the outside world, through the caller's OWN credentials
 * (lib/workflow-delegate.ts). A workflow can therefore never do something the
 * operator who ran it could not do themselves.
 *
 * The run is recorded in `automation_runs` like every other automation, so it
 * shows up in the same run-history feed.
 */
const bodySchema = z.strictObject({
  args: z.unknown().optional(),
  actor: z.string().min(1).optional(),
  // Pass an existing durable run id to RESUME: completed agent() calls replay
  // from the journal and execution continues from the first unfinished one.
  runId: z.string().regex(/^wfr_[A-Za-z0-9-]{8,64}$/).optional(),
  /**
   * Execute the script for real but STUB every agent() call — no model tokens,
   * no side effects, no run recorded. See the dry-run block below for what this
   * does and does not tell you.
   */
  dryRun: z.boolean().optional(),
});

const uuidSchema = z.uuid();

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (org instanceof Response) return org;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }

  // The run borrows the CALLER's identity to talk to the agent. No bearer, no
  // run — a workflow must not be a way to act without being signed in.
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) {
    return NextResponse.json(
      { error: "Sign in to run a workflow — the run uses your own credentials to reach the agent." },
      { status: 401 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const actor = parsed.data.actor ?? "web";

  const [workflow] = await withOrgRls(org.orgId, (tx) =>
    tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.orgId, org.orgId), eq(workflows.id, id)))
      .limit(1),
  );
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (!workflow.enabled) {
    return NextResponse.json({ error: "This workflow is paused." }, { status: 409 });
  }
  const script = workflow.script?.trim();
  if (!script) {
    return NextResponse.json({ error: "This workflow has no script yet." }, { status: 409 });
  }
  const availability = workflowAvailability({ name: workflow.name, script });
  if (!availability.available) return NextResponse.json({ error: availability.reason }, { status: 409 });

  // Refuse a script the validator rejects, even though the sandbox would also
  // deny it — an operator should never watch a run start and then die on
  // something that was knowable before it began.
  const analysis = analyzeWorkflowScript(script);
  if (!analysis.ok) {
    return NextResponse.json(
      { error: analysis.issues.find((i) => i.level === "error")?.message ?? "The script is invalid." },
      { status: 400 },
    );
  }

  /**
   * And the same for the PAYLOAD, in the same spirit as the check above: an
   * operator should not watch a run start and then find it assessed the wrong
   * scope because a key was misspelled. This route accepted args and never
   * looked at them, so `{"customer": …}` for a script reading `customerId` ran
   * happily and unscoped.
   */
  const coerced = coerceWorkflowArgs(parsed.data.args);
  if (coerced.error) return NextResponse.json({ error: coerced.error }, { status: 400 });
  coerced.args = alignWorkflowArgs(script, coerced.args);
  const argsProblem = validateWorkflowArgs(script, coerced.args);
  if (argsProblem) {
    return NextResponse.json(
      { error: argsProblem.message, ...(argsProblem.expected ? { expects: argsProblem.expected } : {}) },
      { status: 400 },
    );
  }

  // The sandbox runs JavaScript; the operator writes TypeScript. Erase the types
  // before execution — analyzeWorkflowScript() above validated this same output.
  const { js, error: tsError } = stripTypes(script);
  if (tsError) return NextResponse.json({ error: tsError }, { status: 400 });

  /* ---------------------------- DRY RUN --------------------------------- *
   * A workflow's cost is its agent() calls, and the thing you actually want to
   * know before paying it is how many there will be and what they will say.
   * Static validation cannot tell you: fan-out comes from loops and array
   * lengths that only exist at runtime.
   *
   * So this runs the REAL script in the REAL sandbox and swaps only the
   * delegate — every agent() returns instantly with a placeholder while the
   * call is recorded. Control flow, loops, phases, parallel()/pipeline() fan-out
   * and any plain-JS error all behave exactly as they would in a live run, for
   * zero tokens.
   *
   * WHERE IT LIES, stated in the response rather than buried here: a branch
   * that depends on what an agent RETURNED will take the stub's path, not the
   * real one. `if (findings.length > 0)` sees the placeholder. So the plan is
   * exact for straight-line and data-driven fan-out, and indicative where the
   * script reasons about its own results.
   *
   * Nothing is recorded — no durable run, no automation_runs row, no audit.
   * A dry run that left traces would pollute the very history you use to judge
   * whether the real one worked.
   */
  if (parsed.data.dryRun) {
    const planned: { call: number; subagent: string | null; prompt: string }[] = [];
    const dryResult = await runWorkflowScript(js, {
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(org.orgId),
      args: coerced.args,
      delegate: async (prompt: string, subagent?: string, callIndex?: number) => {
        planned.push({
          call: (callIndex ?? planned.length) + 1,
          subagent: subagent ?? null,
          // Enough to review the instruction without dumping the whole context.
          prompt: prompt.length > 600 ? `${prompt.slice(0, 600)}…` : prompt,
        });
        return `[dry run — ${subagent ?? "agent"} was not called]`;
      },
    });
    const bySubagent = planned.reduce<Record<string, number>>((m, p) => {
      const k = p.subagent ?? "(default)";
      return { ...m, [k]: (m[k] ?? 0) + 1 };
    }, {});
    return NextResponse.json({
      dryRun: true,
      ok: dryResult.ok,
      error: dryResult.error,
      agentCalls: planned.length,
      bySubagent,
      phases: dryResult.events.filter((e) => e.kind === "phase").map((e) => e.text),
      planned,
      note:
        "No model was called, nothing was recorded, and no run appears in the history. " +
        "Branches that depend on what an agent RETURNS took the stub's path, so the call " +
        "count is exact for data-driven fan-out and indicative where the script reasons " +
        "about its own results.",
    });
  }

  // Durable run: mint (or resume) the run id and load its checkpoint journal so
  // completed agent() calls replay instead of re-delegating.
  let lease: WorkflowRunLease;
  try {
    lease = await startWorkflowRun({
      orgId: org.orgId,
      runId: parsed.data.runId,
      workflowId: id,
      workflowName: workflow.name,
      args: coerced.args,
      createdBy: actor,
    });
  } catch (error) {
    if (error instanceof WorkflowRunLeaseUnavailableError) {
      return NextResponse.json(
        { error: "This run is active, cancelled, or already terminal and cannot be resumed." },
        { status: 409 },
      );
    }
    throw error;
  }
  const durableRunId = lease.runId;
  const { resumed } = lease;
  const journal = await loadWorkflowJournal(lease);

  const startedAt = new Date();
  const [run] = await withOrgRls(org.orgId, (tx) =>
    tx
      .insert(automationRuns)
      .values({
        orgId: org.orgId,
        automationType: "workflow",
        automationId: id,
        status: "running",
        startedAt,
        summary: resumed ? `Resumed by ${actor}` : `Run started by ${actor}`,
      })
      .returning({ id: automationRuns.id }),
  );

  /**
   * The token the STEPS use, which is not necessarily the one the operator sent.
   *
   * A step used to forward the caller's bearer verbatim, so the agent
   * re-resolved the workspace from their identity — and for an operator in two
   * workspaces that is decided by whichever they last clicked, not by the run.
   * A run belongs to one workspace; the token says so, and the agent verifies
   * membership before honouring it.
   *
   * Falls back to the caller's own bearer when we cannot mint (no signing key,
   * no email): the run still works, exactly as before.
   */
  const identityEmail = (await verifyOpsAuth(request.headers.get("authorization")))?.email;
  let stepBearer = bearer;
  if (identityEmail) {
    try {
      stepBearer = await mintSessionToken(identityEmail, { org: org.orgId });
    } catch {
      /* keep the caller's bearer — no worse than before this existed */
    }
  }

  try {
    let cancelled = false;
    let cancellationReason: string | null = null;
    const result = await withWorkflowRunHeartbeat(lease, async (control) => {
      const outcome = await runWorkflowScript(js, {
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(org.orgId),
        // Every step is told which workflow and run it belongs to. Without it a
        // step opens a fresh session knowing only its prompt, which is why an
        // opened step read as blank.
        delegate: makeDurableDelegate(
          makeDelegate(stepBearer, undefined, control.signal, {
            workflow: workflow.name,
            runId: durableRunId,
            // This run's args win over the workflow's standing scope: a
            // team-wide workflow run for one account is the common case.
            customerId: customerFromArgs(coerced.args) ?? workflow.customerId ?? undefined,
          }, org.orgId, "step"),
          journal,
          3,
          control.signal,
        ),
        args: coerced.args,
        signal: control.signal,
      });
      cancelled = control.signal.aborted;
      cancellationReason = control.cancellationReason();
      return outcome;
    });

    const durationMs = Date.now() - startedAt.getTime();
    const steps = result.agentCalls === 1 ? "1 step" : `${result.agentCalls} steps`;
    // Durable state: completed / resumable (timed out) / failed.
    await finishWorkflowRun(lease, {
      status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
      result: result.ok ? result.result : undefined,
      error: cancelled ? cancellationReason ?? result.error : result.ok ? null : result.error,
    });
    const invocationStatus = result.ok ? "success" : "failed";
    const summary = cancelled
      ? `Cancelled after ${steps} — ${actor}`
      : result.ok
      ? `Ran ${steps} — ${resumed ? "resumed" : "started"} by ${actor}`
      : result.timedOut
        ? `Timed out after ${steps} — will resume (${actor})`
        : `Failed after ${steps} — ${actor}`;
    await withOrgRls(org.orgId, (tx) =>
      tx
        .update(automationRuns)
        .set({ status: invocationStatus, durationMs, error: result.error, summary })
        .where(eq(automationRuns.id, run.id)),
    );

    await recordOpsAudit(db, {
      automationType: "workflow",
      automationId: id,
      actor,
      event: result.ok
        ? `Ran the script (${steps})`
        : cancelled
          ? `Cancelled the script after ${steps} (run ${durableRunId})`
        : result.timedOut
          ? `Script timed out after ${steps} — resumable (run ${durableRunId})`
          : `Script run failed: ${result.error}`,
      orgId: org.orgId,
    });

    return NextResponse.json({
      runId: run.id,
      durableRunId,
      resumable: !result.ok && result.timedOut,
      cancelled,
      ok: result.ok,
      error: cancelled ? null : result.error,
      cancelReason: cancelled ? cancellationReason ?? result.error : null,
      events: result.events,
      result: result.result,
      durationMs,
    });
  } catch (e) {
    const message = errorMessage(e);
    await finishWorkflowRun(lease, { status: "failed", error: message });
    await withOrgRls(org.orgId, (tx) =>
      tx
        .update(automationRuns)
        .set({
          status: "failed",
          durationMs: Date.now() - startedAt.getTime(),
          error: message,
          summary: `Failed — ${actor}`,
        })
        .where(eq(automationRuns.id, run.id)),
    );
    return NextResponse.json({ error: message, durableRunId }, { status: 500 });
  }
}
