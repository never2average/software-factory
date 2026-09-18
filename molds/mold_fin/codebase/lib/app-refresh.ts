import { and, eq } from "drizzle-orm";
import { appVersions, apps, workflows } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "./ops-db";
import { makeDelegate } from "./workflow-delegate";
import {
  finishWorkflowRun,
  loadWorkflowJournal,
  makeDurableDelegate,
  startWorkflowRun,
  withWorkflowRunHeartbeat,
  type WorkflowRunLease,
} from "./workflow-journal";
import { runWorkflowScript } from "./workflow-runtime";
import { workflowDataFor } from "./workflow-data";
import { stripTypes } from "./workflow-ts";
import { cleanDashboardSpec } from "./dashboard-spec";

/**
 * Regenerating an APP's document. One engine, two sources:
 *
 *  • workflow — run the named workflow DURABLY (same machinery the Ops Center
 *    and run-cron-workflows use), and take its return value as the document.
 *    The run id is stored so the refresh can be opened as a chat.
 *  • prompt   — one agent call whose reply IS the document. The eve session id
 *    is stored for the same reason.
 *
 * Every path records lastError / lastRefreshAt and clears the refresh claim, so
 * a failure is visible in the UI rather than silently leaving stale content.
 */
export type OpsDb = NonNullable<ReturnType<typeof getOpsDb>>;
export type AppRow = typeof apps.$inferSelect;

/** What a workflow-backed app hands its script as `args`. */
function appArgs(app: AppRow): Record<string, unknown> {
  return {
    appId: app.id,
    appSlug: app.slug,
    appName: app.name,
    customerId: app.customerId ?? undefined,
  };
}

/** A workflow returns anything; a document needs Markdown. */
function toMarkdown(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "_The workflow returned nothing._";
  return ["```json", JSON.stringify(result, null, 2), "```"].join("\n");
}

/** Appended to a prompt-source app so the reply IS the dashboard spec. The
 *  default app-author subagent already knows the schema; this keeps a custom
 *  subagent honest and reminds the model the output is machine-parsed. */
const DASHBOARD_CONTRACT =
  "Return ONLY a JSON dashboard spec — an object { title, blocks: [...] } of " +
  "visual widgets (kpi, callout, funnel, kanban, timeline, chart, table). No " +
  "prose, no Markdown fence, no text before or after the JSON. It is parsed " +
  "with JSON.parse and rendered as a grid of components.";

async function storeContent(
  db: OpsDb,
  app: AppRow,
  actor: string,
  fields: { contentMd: string; lastRunId?: string | null; lastSessionId?: string | null },
): Promise<void> {
  const now = new Date();
  // Validate against the dashboard contract: if it's a spec, drop any block
  // that fails so what we store always renders. Non-spec (Markdown) passes
  // through untouched.
  const cleaned = cleanDashboardSpec(fields.contentMd);
  const contentMd = cleaned.content ?? fields.contentMd;
  await withOrgRls(app.orgId, (tx) =>
    tx
      .update(apps)
      .set({
        contentMd,
        contentUpdatedAt: now,
        lastRunId: fields.lastRunId ?? null,
        lastSessionId: fields.lastSessionId ?? null,
        lastError: null,
        lastRefreshAt: now,
        refreshingAt: null,
        updatedAt: now,
      })
      .where(eq(apps.id, app.id)),
  );
  // Archive this refresh so the document has a readable history.
  await withOrgRls(app.orgId, (tx) =>
    tx.insert(appVersions).values({
    // A version belongs to the same workspace as the app it archives.
    orgId: app.orgId,
    appId: app.id,
    contentMd: fields.contentMd,
    runId: fields.lastRunId ?? null,
    sessionId: fields.lastSessionId ?? null,
    createdBy: actor,
  }),
  );
}

export async function refreshApp(
  db: OpsDb,
  app: AppRow,
  bearer: string,
  /** Who asked — an operator's email, or "cron" for the scheduled refresh. */
  actor = "cron",
): Promise<{ ok: boolean; error?: string }> {
  let workflowLease: WorkflowRunLease | null = null;
  // Mark the app as refreshing NOW, so EVERY path (cron already claims it, but
  // the on-demand /api/ops/run trigger and the Apps-tab button did not) gives
  // the Control Panel a live "this app is running" signal. Cleared in
  // storeContent / the catch below.
  await withOrgRls(app.orgId, (tx) =>
    tx
      .update(apps)
      .set({ refreshingAt: new Date(), updatedAt: new Date() })
      .where(eq(apps.id, app.id)),
  ).catch(() => {});
  try {
    if (app.sourceKind === "workflow") {
      const name = app.workflow?.trim();
      if (!name) throw new Error("No workflow is set for this app.");
      // org_id is NOT NULL; the old fallback named a workspace that does not exist.
      const orgId = app.orgId;
      const [wf] = await withOrgRls(app.orgId, (tx) =>
        tx
          .select()
          .from(workflows)
          .where(and(eq(workflows.orgId, orgId), eq(workflows.name, name)))
          .limit(1),
      );
      if (!wf?.script) throw new Error(`Workflow "${name}" has no script.`);
      const { js, error } = stripTypes(wf.script);
      if (error) throw new Error(error);


      const runId = `wfr_${crypto.randomUUID()}`;
      const args = appArgs(app);
      workflowLease = await startWorkflowRun({
        orgId,
        runId,
        workflowId: wf.id,
        workflowName: wf.name,
        args,
        createdBy: `app:${app.slug}`,
      });
      const journal = await loadWorkflowJournal(workflowLease);
      let cancelled = false;
      let cancellationReason: string | null = null;
      const result = await withWorkflowRunHeartbeat(workflowLease, async (control) => {
        const outcome = await runWorkflowScript(js, {
          /**
           * Use the function's actual headroom.
           *
           * The runtime defaults to 240s while this route is allowed 300s, so a
           * minute of the budget was going unused and runs were failing 20s
           * short. Leave ~25s for the write-back and the response, or the
           * timeout moves from the workflow (which reports it) to the platform
           * (which does not).
           */
          wallClockMs: 275_000,
          // Read your own inputs — see lib/workflow-data.ts.
          data: workflowDataFor(orgId),
          delegate: makeDurableDelegate(
            makeDelegate(bearer, undefined, control.signal, { workflow: `app refresh: ${app.name}`, runId }),
            journal,
            3,
            control.signal,
          ),
          args,
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
      if (!result.ok) throw new Error(result.error ?? "The workflow did not finish.");
      await storeContent(db, app, actor, {
        contentMd: toMarkdown(result.result),
        lastRunId: runId,
      });
      return { ok: true };
    }

    // prompt source — one delegation to the app-author subagent (the generator
    // for documents), unless the app pins a different subagent. Its reply is the
    // document. Given a dashboard is a bigger single turn than a workflow step
    // (aggregating the data room into widgets), it gets a longer timeout — kept
    // under the 300s route maxDuration.
    const prompt = app.prompt?.trim();
    if (!prompt) throw new Error("No prompt is set for this app.");
    const delegate = makeDelegate(bearer, 250_000);
    let sessionId: string | null = null;
    const text = await delegate(
      `${prompt}\n\n${DASHBOARD_CONTRACT}`,
      app.subagent ?? "app-author",
      (info) => {
        sessionId = info.sessionId;
      },
    );
    await storeContent(db, app, actor, { contentMd: text, lastSessionId: sessionId });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (workflowLease) {
      await finishWorkflowRun(workflowLease, { status: "failed", error: message }).catch(() => false);
    }
    // A failed attempt is history too — record it so the version list shows
    // what was tried, not only what succeeded.
    await withOrgRls(app.orgId, (tx) =>
      tx
        .insert(appVersions)
        .values({ orgId: app.orgId, appId: app.id, error: message, createdBy: actor }),
    ).catch(() => {});
    await withOrgRls(app.orgId, (tx) =>
      tx
        .update(apps)
        .set({
          lastError: message,
          lastRefreshAt: new Date(),
          refreshingAt: null,
          updatedAt: new Date(),
        })
        .where(eq(apps.id, app.id)),
    );
    return { ok: false, error: message };
  }
}
