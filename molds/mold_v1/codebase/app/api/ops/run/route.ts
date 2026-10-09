import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { errorMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apps, workflows } from "@/agent/lib/db/schema";
import { analyzeWorkflowScript } from "@/lib/workflow-validate";
import { driveAppRefresh, refreshBackgroundMs, startAppRefresh } from "@/lib/app-refresh";
import { inBackground } from "@/lib/background";
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
import { alignWorkflowArgs, coerceWorkflowArgs, validateWorkflowArgs } from "@/lib/workflow-args";
import { workflowAvailability } from "@/lib/workflow-availability";
import { stripTypes } from "@/lib/workflow-ts";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { noServiceBearerReason, serviceBearerFor } from "@/lib/service-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/ops/run — the ON-DEMAND internal trigger for a workflow run or an
 * app refresh, so the AGENT can fire one from a tool (`trigger_workflow` /
 * `run_app`) instead of only from the Apps-tab UI.
 *
 * AUTH mirrors the crons: guarded by `CRON_SECRET`, and the run reaches the
 * agent with THIS project's own Vercel OIDC service token (the agent trusts the
 * front-end's subject — see agent/channels/eve.ts) or, off Vercel with
 * SERVICE_AUTH=session-key, the service token it signs itself
 * (lib/service-identity.ts). The runtime + delegation machinery live here, on
 * the front-end, so the agent never has to bundle the sandbox or self-delegate.
 */

const bodySchema = z.strictObject({
  kind: z.enum(["workflow", "app"]),
  /** A workflow name / app name-or-slug (or a uuid) — whichever the caller has. */
  target: z.string().min(1),
  /** Who asked, for the run's provenance. */
  actor: z.string().min(1).optional(),
  /** Verified by the calling Eve tool from its session context. */
  orgId: z.string().min(1),
  /**
   * The payload the workflow runs with. An object, or JSON text — models emit
   * both. Validated against what the script actually reads before anything is
   * spent; see lib/workflow-args.ts.
   */
  args: z.unknown().optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const begun = Date.now();
  // This route is EXEMPT from the proxy's Google-identity gate (see proxy.ts) —
  // it is the sole auth for the endpoint, so it must fail CLOSED. A missing
  // secret is a misconfiguration, not an open door.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured, so the run trigger is disabled." },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const bearer = serviceBearerFor(request);
  if (!bearer) {
    return NextResponse.json(
      { error: `No service token available to reach the agent (${noServiceBearerReason()}).` },
      { status: 503 },
    );
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide { kind: 'workflow' | 'app', target }." }, { status: 400 });
  }
  const { kind, target, actor = "agent", orgId } = parsed.data;
  let workflowLease: WorkflowRunLease | null = null;

  try {
    if (kind === "app") {
      const [app] = await withOrgRls(orgId, (tx) =>
        tx
          .select()
          .from(apps)
          .where(
            and(
              eq(apps.orgId, orgId),
              UUID.test(target) ? eq(apps.id, target) : eq(apps.slug, target),
            ),
          )
          .limit(1),
      );
      const row =
        app ??
        (
          await withOrgRls(orgId, (tx) =>
            tx
              .select()
              .from(apps)
              .where(and(eq(apps.orgId, orgId), eq(apps.name, target)))
              .limit(1),
          )
        )[0];
      if (!row) return NextResponse.json({ error: `App "${target}" not found.` }, { status: 404 });
      // Started here, finished in the background and by the refresh-apps cron (lib/app-refresh.ts): a refresh can
      // take far longer than this request may live. A refresh already in progress is joined, never doubled.
      const outcome = await startAppRefresh(row, { bearer, actor });
      if (outcome.status === "failed") {
        return NextResponse.json(
          { kind, app: row.slug, ok: false, error: outcome.error, ...(outcome.cause ? { cause: outcome.cause } : {}) },
          { status: outcome.cause === "source" ? 409 : 500 },
        );
      }
      if (outcome.status === "started") {
        const handle = outcome.handle;
        inBackground(
          () => driveAppRefresh(handle, { bearer, budgetMs: Math.max(1_000, refreshBackgroundMs() - (Date.now() - begun)) }),
          `refresh of app ${row.id}`,
        );
      }
      return NextResponse.json(
        {
          kind,
          app: row.slug,
          ok: true,
          started: outcome.status === "started",
          joined: outcome.status === "running",
          startedAt: outcome.startedAt,
          sessionId: outcome.sessionId,
          runId: outcome.runId,
        },
        { status: 202 },
      );
    }

    // kind === "workflow"
    const [wf] = await withOrgRls(orgId, (tx) =>
      tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, orgId),
            UUID.test(target) ? eq(workflows.id, target) : eq(workflows.name, target),
          ),
        )
        .limit(1),
    );
    if (!wf) return NextResponse.json({ error: `Workflow "${target}" not found.` }, { status: 404 });
    if (!wf.enabled) return NextResponse.json({ error: "This workflow is paused." }, { status: 409 });
    const availability = workflowAvailability(wf);
    if (!availability.available) return NextResponse.json({ error: availability.reason }, { status: 409 });
    const script = wf.script?.trim();
    if (!script) return NextResponse.json({ error: "This workflow has no script yet." }, { status: 409 });
    const analysis = analyzeWorkflowScript(script);
    if (!analysis.ok) {
      return NextResponse.json(
        { error: analysis.issues.find((i) => i.level === "error")?.message ?? "The script is invalid." },
        { status: 400 },
      );
    }
    const { js, error: tsError } = stripTypes(script);
    if (tsError) return NextResponse.json({ error: tsError }, { status: 400 });

    /**
     * The payload is checked BEFORE a run is started or a token is spent.
     *
     * A run that silently ignores its arguments is the worst outcome
     * available: it succeeds, writes a plausible document about the wrong
     * scope, and nothing says the payload was dropped. "Run renewal-risk for
     * Acme" quietly assessing the whole book looks like it worked.
     */
    const coerced = coerceWorkflowArgs(parsed.data.args);
    if (coerced.error) return NextResponse.json({ error: coerced.error }, { status: 400 });
    // Keys the model wrote in the deployment's words go to the base key only where THIS script reads the base key.
    coerced.args = alignWorkflowArgs(script, coerced.args);
    const argsProblem = validateWorkflowArgs(script, coerced.args);
    if (argsProblem) {
      return NextResponse.json(
        {
          error: argsProblem.message,
          ...(argsProblem.expected ? { expects: argsProblem.expected } : {}),
        },
        { status: 400 },
      );
    }

    workflowLease = await startWorkflowRun({
      orgId,
      workflowId: wf.id,
      workflowName: wf.name,
      args: coerced.args,
      createdBy: actor,
    });
    const runId = workflowLease.runId;
    const journal = await loadWorkflowJournal(workflowLease);
    let cancelled = false;
    let cancellationReason: string | null = null;
    const result = await withWorkflowRunHeartbeat(workflowLease, async (control) => {
      const outcome = await runWorkflowScript(js, {
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(orgId),
        args: coerced.args,
        delegate: makeDurableDelegate(makeDelegate(bearer, undefined, control.signal, undefined, orgId, "step"), journal, 3, control.signal),
        signal: control.signal,
      });
      cancelled = control.signal.aborted;
      cancellationReason = control.cancellationReason();
      return outcome;
    });
    await finishWorkflowRun(workflowLease, {
      status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
      result: result.ok ? result.result : undefined,
      error: cancelled ? cancellationReason ?? result.error : result.ok ? null : result.error,
    });
    return NextResponse.json(
      {
        kind,
        workflow: wf.name,
        runId,
        ok: result.ok,
        timedOut: result.timedOut ?? false,
        cancelled,
        error: result.ok || cancelled ? null : result.error,
        cancelReason: cancelled ? cancellationReason ?? result.error : null,
        result: result.ok ? result.result : undefined,
      },
      { status: result.ok || result.timedOut || cancelled ? 200 : 500 },
    );
  } catch (e) {
    if (workflowLease) {
      await finishWorkflowRun(workflowLease, {
        status: "failed",
        error: errorMessage(e),
      });
    }
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
