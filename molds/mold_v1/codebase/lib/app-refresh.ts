import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { AppSourceError, promptAppSource, sourceProblem, specialistBrief, workflowAppSource } from "./app-source.ts";
import { appVersions, apps, workflowRuns, workflows } from "@/agent/lib/db/schema";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "./ops-db";
import { followStepSession, makeDelegate, openStepSession, StepOutcomeError, StepSessionGone } from "./workflow-delegate";
import { bearerToken, type ServiceBearer } from "./service-identity";
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
import { SERVICE_SCOPE_HEADER } from "../agent/lib/service-scope.ts";

/**
 * Regenerating an APP's document. One engine, three sources (lib/app-source.ts decides which an app has, and whether
 * it can run at all):
 *
 *  • workflow, a script — run the named workflow DURABLY (same machinery the Ops Center and run-cron-workflows use),
 *    and take its return value as the document. The run id is stored so the refresh can be opened as a chat.
 *  • workflow, a specialist's row — the app's brief is delegated to that specialist and its reply IS the document.
 *  • prompt — one agent call whose reply IS the document.
 *
 * A REFRESH NEVER RUNS INSIDE THE REQUEST THAT ASKED FOR IT. A specialist that fetches filings and runs code takes
 * many minutes; run inside one serverless request it was killed at the route's limit (a 504 after 300 s), nothing
 * recorded that, and the app said "refreshing" for ever. So a refresh is three steps, each of which may happen in a
 * different process:
 *
 *   1. START (`startAppRefresh`, in the request, seconds). Claim the app (`refreshing_at`, atomically: a second
 *      Try again joins the refresh in progress and never starts another), write a PENDING version (no content, no
 *      error: who asked, when), and open the work on the agent: a durable eve session for a specialist or a prompt,
 *      a durable workflow run for a script. Its id goes on the app (`last_session_id` / `last_run_id`) and on the
 *      pending version at once, so the UI can follow it. The request answers 202.
 *   2. DRIVE (`driveAppRefresh`, after the response, `lib/background.ts`). Follow the session (or run the script)
 *      for as long as the platform lets this function live, and write the result if it arrives.
 *   3. COLLECT (`collectAppRefreshes`, the refresh-apps cron, every minute, on Vercel and on a server). Whatever a
 *      killed function did not finish: read each refreshing app's session from its first event (the stream is
 *      durable), or its workflow run's row (the resume-workflows cron re-drives the script), and write the result
 *      when there is one, however long after the person closed the tab.
 *
 * THE PENDING VERSION IS THE REFRESH'S TOKEN. Writing the result is "fill the pending version, then the app", and the
 * first is conditional on the version still being pending: the background driver and a cron tick that both read the
 * answer write it once.
 *
 * A MARKER NEVER OUTLIVES ITS WORK (`refreshVerdict`). One with no session or run recorded after a few minutes (the
 * function died before it could start one: a platform kill, a crash, a deploy), or one older than the longest a
 * refresh may take, is ended as a failure with a sentence saying so. Applied by the cron, by the list the UI reads,
 * and before every new start, so no app can say "refreshing" for ever.
 *
 * Every refresh runs as the platform's service identity, scoped to the app's workspace: it is the workspace's
 * document, written while nobody is watching. So a specialist that parks on a question or an approval fails at once
 * with the #114 sentence naming what it asked (lib/step-handback.ts), never a hang.
 */
export type OpsDb = NonNullable<ReturnType<typeof getOpsDb>>;
export type AppRow = typeof apps.$inferSelect;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bounds                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

function envMs(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A refresh with no session or run recorded this long after it was claimed never started: its request died. */
export const refreshStartGraceMs = (env?: Record<string, string | undefined>) => envMs("APP_REFRESH_START_GRACE_MS", 5 * 60_000, env);
/** The longest a refresh may take, start to document. Past it the refresh is stopped and recorded as failed. */
export const refreshMaxMs = (env?: Record<string, string | undefined>) => envMs("APP_REFRESH_MAX_MS", 60 * 60_000, env);
/**
 * How long the function that started a refresh keeps following it after answering. On Vercel the function lives at
 * most its route's `maxDuration` (300 s), so a little under; on a long-lived server, as long as a refresh may take.
 * The cron collects whatever is left either way.
 */
export const refreshBackgroundMs = (env: Record<string, string | undefined> = process.env) =>
  envMs("APP_REFRESH_BACKGROUND_MS", env.VERCEL ? 270_000 : refreshMaxMs(env), env);

/* ------------------------------------------------------------------------------------------------------------------ */
/* The rule                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RefreshVerdict =
  | { readonly state: "idle" }
  | { readonly state: "live" }
  | { readonly state: "expired"; readonly reason: "never-started" | "too-long"; readonly message: string };

/** "2026-10-05 12:01 UTC". */
function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Pure. Where a refresh marker stands, from what is recorded: the marker, whether a session or a run was recorded for
 * it, and the clock. `live` means leave it to its driver and the cron; `expired` carries the sentence the app shows.
 */
export function refreshVerdict(input: {
  readonly refreshingAt: Date | null;
  /** A session or a workflow run was recorded for this refresh. */
  readonly started: boolean;
  readonly now: Date;
  readonly graceMs?: number;
  readonly maxMs?: number;
}): RefreshVerdict {
  if (!input.refreshingAt) return { state: "idle" };
  const grace = input.graceMs ?? refreshStartGraceMs();
  const max = input.maxMs ?? refreshMaxMs();
  const age = input.now.getTime() - input.refreshingAt.getTime();
  if (!input.started && age > grace) {
    return {
      state: "expired",
      reason: "never-started",
      message: `The refresh begun ${when(input.refreshingAt)} stopped before it could start its work (the server ended it before anything was recorded), so the document was not updated. Try again.`,
    };
  }
  if (age > max) {
    return {
      state: "expired",
      reason: "too-long",
      message: `The refresh begun ${when(input.refreshingAt)} was still not finished after ${Math.round(max / 60_000)} minutes, so it was stopped and the document was not updated. Try again; if it keeps taking this long, give the app a narrower brief.`,
    };
  }
  return { state: "live" };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Records                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The version a refresh in progress writes into when it ends. */
export interface PendingRefresh {
  readonly versionId: string;
  readonly sessionId: string | null;
  readonly runId: string | null;
  /** Who asked: a person's email, "cron", or "agent". */
  readonly actor: string;
  readonly createdAt: Date;
}

type AppKey = Pick<AppRow, "id" | "orgId">;

/** The refresh in progress on this app, if one has written its pending version. */
export async function pendingRefresh(app: AppKey): Promise<PendingRefresh | null> {
  const [v] = await withOrgRls(app.orgId, (tx) =>
    tx
      .select({ id: appVersions.id, sessionId: appVersions.sessionId, runId: appVersions.runId, createdBy: appVersions.createdBy, createdAt: appVersions.createdAt })
      .from(appVersions)
      .where(and(eq(appVersions.orgId, app.orgId), eq(appVersions.appId, app.id), isNull(appVersions.contentMd), isNull(appVersions.error)))
      .orderBy(desc(appVersions.createdAt))
      .limit(1),
  );
  return v ? { versionId: v.id, sessionId: v.sessionId, runId: v.runId, actor: v.createdBy, createdAt: v.createdAt } : null;
}

/** A workflow returns anything; a document needs Markdown. */
function toMarkdown(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "_The workflow returned nothing._";
  return ["```json", JSON.stringify(result, null, 2), "```"].join("\n");
}

export type SettleOutcome = { readonly content: string } | { readonly error: string };

/**
 * Write a refresh's ending: fill its pending version, then the app. Conditional on the version still being pending,
 * so whichever of the background driver and a cron tick gets there first writes it, once. False when it was already
 * written (or expired).
 */
export async function settleRefresh(app: AppKey, pending: PendingRefresh, outcome: SettleOutcome): Promise<boolean> {
  const now = new Date();
  return withOrgRls(app.orgId, async (tx) => {
    const filled = await tx
      .update(appVersions)
      .set("content" in outcome ? { contentMd: outcome.content } : { error: outcome.error })
      .where(and(eq(appVersions.id, pending.versionId), eq(appVersions.orgId, app.orgId), isNull(appVersions.contentMd), isNull(appVersions.error)))
      .returning({ id: appVersions.id });
    if (filled.length === 0) return false;
    if ("content" in outcome) {
      // Validate against the dashboard contract: if it's a spec, drop any block that fails so what we store always
      // renders. Non-spec (Markdown) passes through untouched. The version keeps the bytes as they came.
      const cleaned = cleanDashboardSpec(outcome.content);
      await tx
        .update(apps)
        .set({
          contentMd: cleaned.content ?? outcome.content,
          contentUpdatedAt: now,
          lastRunId: pending.runId,
          lastSessionId: pending.sessionId,
          lastError: null,
          lastRefreshAt: now,
          refreshingAt: null,
          updatedAt: now,
        })
        .where(and(eq(apps.id, app.id), eq(apps.orgId, app.orgId)));
    } else {
      await tx
        .update(apps)
        .set({ lastError: outcome.error, lastRefreshAt: now, refreshingAt: null, updatedAt: now })
        .where(and(eq(apps.id, app.id), eq(apps.orgId, app.orgId)));
    }
    return true;
  });
}

/** Put the session or run a refresh opened on its pending version and on the app, the moment it exists. */
async function recordStarted(app: AppKey, pending: PendingRefresh, ids: { sessionId?: string; runId?: string }): Promise<PendingRefresh> {
  const sessionId = ids.sessionId ?? null;
  const runId = ids.runId ?? null;
  await withOrgRls(app.orgId, async (tx) => {
    await tx.update(appVersions).set({ sessionId, runId }).where(and(eq(appVersions.id, pending.versionId), eq(appVersions.orgId, app.orgId)));
    await tx
      .update(apps)
      .set({ lastSessionId: sessionId, lastRunId: runId, updatedAt: new Date() })
      .where(and(eq(apps.id, app.id), eq(apps.orgId, app.orgId), isNotNull(apps.refreshingAt)));
  });
  return { ...pending, sessionId, runId };
}

/**
 * End a marker the rule says has expired. With a pending version, through it (once); without one (the function died
 * before writing it, or the marker was set by the code before this one), on the app row itself, only while the marker
 * is the one that was judged.
 */
async function expireRefresh(app: AppRow, pending: PendingRefresh | null, message: string): Promise<boolean> {
  if (pending) return settleRefresh(app, pending, { error: message });
  const observed = app.refreshingAt;
  if (!observed) return false;
  const now = new Date();
  return withOrgRls(app.orgId, async (tx) => {
    const hit = await tx
      .update(apps)
      .set({ lastError: message, lastRefreshAt: now, refreshingAt: null, updatedAt: now })
      .where(
        and(
          eq(apps.id, app.id),
          eq(apps.orgId, app.orgId),
          gte(apps.refreshingAt, observed),
          lt(apps.refreshingAt, new Date(observed.getTime() + 1)),
        ),
      )
      .returning({ id: apps.id });
    if (hit.length === 0) return false;
    // A failed attempt is history too.
    await tx.insert(appVersions).values({ orgId: app.orgId, appId: app.id, error: message, createdBy: "web" });
    return true;
  });
}

/** Ask the agent to stop a session nobody will read again. Best effort. */
async function cancelSession(sessionId: string, bearer: ServiceBearer, orgId: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";
  if (!base) return;
  await fetch(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await bearerToken(bearer)}`, [SERVICE_SCOPE_HEADER]: orgId },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/**
 * Apply the rule to one workspace's refreshing apps, from the database alone (no agent call). What the app list does
 * on every read, so a marker left by a killed function ends the next time anybody looks, cron or not.
 */
export async function expireStaleRefreshes(orgId: string, now = new Date()): Promise<number> {
  const oldest = new Date(now.getTime() - Math.min(refreshStartGraceMs(), refreshMaxMs()));
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, orgId), isNotNull(apps.refreshingAt), lt(apps.refreshingAt, oldest), isNull(apps.deletedAt))),
  );
  let ended = 0;
  for (const app of rows) {
    const pending = await pendingRefresh(app);
    const verdict = refreshVerdict({ refreshingAt: app.refreshingAt, started: Boolean(pending?.sessionId || pending?.runId), now });
    if (verdict.state === "expired" && (await expireRefresh(app, pending, verdict.message))) ended++;
  }
  return ended;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 1. Start                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Appended to a prompt-source app so the reply IS the dashboard spec. The default app-author subagent already
 *  knows the schema; this keeps a custom subagent honest and reminds the model the output is machine-parsed. */
const DASHBOARD_CONTRACT =
  "Return ONLY a JSON dashboard spec — an object { title, blocks: [...] } of " +
  "visual widgets (kpi, callout, funnel, kanban, timeline, chart, table). No " +
  "prose, no Markdown fence, no text before or after the JSON. It is parsed " +
  "with JSON.parse and rendered as a grid of components.";

/** A refresh that has started, as the process that started it holds it: what `driveAppRefresh` needs. */
export type RefreshHandle =
  | { readonly kind: "session"; readonly app: AppRow; readonly pending: PendingRefresh & { readonly sessionId: string }; readonly specialist: string | null }
  | { readonly kind: "script"; readonly app: AppRow; readonly pending: PendingRefresh & { readonly runId: string }; readonly lease: WorkflowRunLease; readonly js: string; readonly args: Record<string, unknown> };

export type StartOutcome =
  /** Claimed and started: the session or run is recorded. Drive it (or leave it to the cron). */
  | { readonly status: "started"; readonly handle: RefreshHandle; readonly startedAt: Date; readonly sessionId: string | null; readonly runId: string | null }
  /** Another refresh of this app is in progress: joined, nothing started. */
  | { readonly status: "running"; readonly startedAt: Date | null; readonly sessionId: string | null; readonly runId: string | null }
  /** Nothing could be started; the app carries the error. `source`: what generates it cannot run as it is set. */
  | { readonly status: "failed"; readonly error: string; readonly cause?: "source" };

/** What a workflow-backed app hands its script as `args`. */
function appArgs(app: AppRow): Record<string, unknown> {
  return {
    appId: app.id,
    appSlug: app.slug,
    appName: app.name,
    customerId: app.customerId ?? undefined,
  };
}

export async function startAppRefresh(
  app: AppRow,
  opts: {
    /** The platform's service identity (a person's token only where the platform has none). */
    readonly bearer: ServiceBearer;
    /** Who asked — a person's email, "agent", or "cron" for the scheduled refresh. */
    readonly actor: string;
    /**
     * Start only the app's FIRST document: claimed only while it has none, has never been attempted, and nothing is
     * under way (lib/starter-apps.ts). Otherwise answered as `running` with nothing started.
     */
    readonly onlyIfFirst?: boolean;
  },
): Promise<StartOutcome> {
  // A marker its work outlived is ended first, so it cannot block this start (or make it "join" nothing).
  if (app.refreshingAt) {
    const before = await pendingRefresh(app);
    const verdict = refreshVerdict({ refreshingAt: app.refreshingAt, started: Boolean(before?.sessionId || before?.runId), now: new Date() });
    if (verdict.state === "expired") await expireRefresh(app, before, verdict.message);
  }

  const startedAt = new Date();
  const [claimed] = await withOrgRls(app.orgId, (tx) =>
    tx
      .update(apps)
      .set({ refreshingAt: startedAt, updatedAt: startedAt })
      .where(
        and(
          eq(apps.id, app.id),
          eq(apps.orgId, app.orgId),
          isNull(apps.refreshingAt),
          ...(opts.onlyIfFirst ? [isNull(apps.deletedAt), isNull(apps.contentUpdatedAt), isNull(apps.lastRefreshAt)] : []),
        ),
      )
      .returning(),
  );
  if (!claimed) {
    // Somebody else's refresh of this app is in progress: join it.
    const [now] = await withOrgRls(app.orgId, (tx) =>
      tx.select({ refreshingAt: apps.refreshingAt }).from(apps).where(and(eq(apps.id, app.id), eq(apps.orgId, app.orgId))).limit(1),
    );
    const live = await pendingRefresh(app);
    return { status: "running", startedAt: now?.refreshingAt ?? null, sessionId: live?.sessionId ?? null, runId: live?.runId ?? null };
  }

  const [version] = await withOrgRls(app.orgId, (tx) =>
    tx.insert(appVersions).values({ orgId: app.orgId, appId: app.id, createdBy: opts.actor }).returning({ id: appVersions.id, createdAt: appVersions.createdAt }),
  );
  let pending: PendingRefresh = { versionId: version.id, sessionId: null, runId: null, actor: opts.actor, createdAt: version.createdAt };

  try {
    if (claimed.sourceKind === "workflow") {
      const name = claimed.workflow?.trim();
      if (!name) throw new Error("No workflow is set for this app.");
      const [wf] = await withOrgRls(claimed.orgId, (tx) =>
        tx
          .select()
          .from(workflows)
          .where(and(eq(workflows.orgId, claimed.orgId), eq(workflows.name, name)))
          .limit(1),
      );
      // The same decision the create form and the picker made (lib/app-source.ts), asked again now: the workflow
      // may have been edited, removed, or its specialist left out of the profile since the app was saved.
      const source = workflowAppSource(wf, name);
      if (!source.ok) throw new AppSourceError(sourceProblem(source) ?? source.reason);

      if (source.kind === "specialist") {
        // A specialist's row: no script to run. Its specialist writes the document from the app's brief.
        const sessionId = await openStepSession({
          bearer: opts.bearer,
          prompt: specialistBrief(claimed),
          subagent: source.specialist,
          context: { workflow: `app refresh: ${claimed.name}`, customerId: claimed.customerId ?? undefined },
          orgId: claimed.orgId,
          visibility: "step",
        });
        pending = await recordStarted(claimed, pending, { sessionId });
        return {
          status: "started",
          handle: { kind: "session", app: claimed, pending: { ...pending, sessionId }, specialist: source.specialist ?? null },
          startedAt,
          sessionId,
          runId: null,
        };
      }

      const { js, error } = stripTypes(wf.script ?? "");
      if (error) throw new Error(error);
      const args = appArgs(claimed);
      const lease = await startWorkflowRun({
        orgId: claimed.orgId,
        runId: `wfr_${crypto.randomUUID()}`,
        workflowId: wf.id,
        workflowName: wf.name,
        args,
        createdBy: `app:${claimed.slug}`,
      });
      pending = await recordStarted(claimed, pending, { runId: lease.runId });
      return {
        status: "started",
        handle: { kind: "script", app: claimed, pending: { ...pending, runId: lease.runId }, lease, js, args },
        startedAt,
        sessionId: null,
        runId: lease.runId,
      };
    }

    // prompt source — one delegation to the app-author subagent (the generator for documents), unless the app pins
    // a different subagent. Its reply is the document.
    const prompt = claimed.prompt?.trim();
    if (!prompt) throw new Error("No prompt is set for this app.");
    const runsAs = promptAppSource(claimed.subagent);
    if (!runsAs.ok) throw new AppSourceError(sourceProblem(runsAs) ?? runsAs.reason);
    const sessionId = await openStepSession({
      bearer: opts.bearer,
      prompt: `${prompt}\n\n${DASHBOARD_CONTRACT}`,
      subagent: runsAs.specialist,
      orgId: claimed.orgId,
      visibility: "step",
    });
    pending = await recordStarted(claimed, pending, { sessionId });
    return { status: "started", handle: { kind: "session", app: claimed, pending: { ...pending, sessionId }, specialist: null }, startedAt, sessionId, runId: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await settleRefresh(claimed, pending, { error: message });
    // "source": the app's source cannot run as it is set (lib/app-source.ts). Not a failed generation: nothing was
    // attempted, and trying again changes nothing until the source does.
    return { status: "failed", error: message, ...(e instanceof AppSourceError ? { cause: "source" as const } : {}) };
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 2. Drive                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export type DriveOutcome = "refreshed" | "failed" | "running";

/** A session's answer, as the app's document, or why there is none. */
function sessionDocument(text: string, specialist: string | null): SettleOutcome {
  if (specialist && !text.trim()) {
    return {
      error: `The "${specialist}" specialist finished without a reply, so there is no document. Refresh again; if it stays empty, say what it should produce in the app's settings.`,
    };
  }
  return { content: text };
}

/** Follow one refresh's session for at most `budgetMs`, and write its ending if it has one. */
async function followRefreshSession(
  app: AppRow,
  pending: PendingRefresh & { readonly sessionId: string },
  specialist: string | null,
  bearer: ServiceBearer,
  budgetMs: number,
): Promise<DriveOutcome> {
  try {
    const r = await followStepSession({ sessionId: pending.sessionId, bearer, orgId: app.orgId, budgetMs, unattended: true });
    if (r.state === "running") return "running";
    const outcome = sessionDocument(r.text, specialist);
    await settleRefresh(app, pending, outcome);
    return "content" in outcome ? "refreshed" : "failed";
  } catch (e) {
    if (e instanceof StepSessionGone) {
      await settleRefresh(app, pending, { error: "The work this refresh started is no longer on the agent, so it cannot finish and the document was not updated. Try again." });
      return "failed";
    }
    if (e instanceof StepOutcomeError) {
      await settleRefresh(app, pending, { error: e.message });
      return "failed";
    }
    // The reader's trouble (the network, the agent briefly unavailable), not the step's: the cron reads it again.
    console.error(`[app-refresh] following ${pending.sessionId} for app ${app.id}:`, e);
    return "running";
  }
}

/**
 * Keep a started refresh going for at most `budgetMs`. A session is followed; a script is run (durably: if the
 * budget ends first, its run stays `running` and the resume-workflows cron re-drives it). Writes the ending when
 * there is one; "running" leaves it to the cron.
 */
export async function driveAppRefresh(handle: RefreshHandle, opts: { readonly bearer: ServiceBearer; readonly budgetMs: number }): Promise<DriveOutcome> {
  const { app } = handle;
  if (handle.kind === "session") return followRefreshSession(app, handle.pending, handle.specialist, opts.bearer, opts.budgetMs);

  const { lease, js, args, pending } = handle;
  try {
    const journal = await loadWorkflowJournal(lease);
    let cancelled = false;
    let cancellationReason: string | null = null;
    const result = await withWorkflowRunHeartbeat(lease, async (control) => {
      const outcome = await runWorkflowScript(js, {
        // Leave room for the write-back, or the timeout moves from the workflow (which reports it) to the platform.
        wallClockMs: Math.max(5_000, opts.budgetMs - 5_000),
        // Read your own inputs — see lib/workflow-data.ts.
        data: workflowDataFor(app.orgId),
        delegate: makeDurableDelegate(
          makeDelegate(opts.bearer, undefined, control.signal, { workflow: `app refresh: ${app.name}`, runId: lease.runId }, app.orgId, "step"),
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
    await finishWorkflowRun(lease, {
      status: cancelled ? "cancelled" : result.ok ? "completed" : result.timedOut ? "running" : "failed",
      result: result.ok ? result.result : undefined,
      error: cancelled ? cancellationReason ?? result.error : result.ok ? null : result.error,
    });
    if (result.ok && !cancelled) {
      await settleRefresh(app, pending, { content: toMarkdown(result.result) });
      return "refreshed";
    }
    // Out of wall clock with work left: the run is durable, the resume cron carries on, the collector writes it.
    if (result.timedOut && !cancelled) return "running";
    await settleRefresh(app, pending, { error: (cancelled ? cancellationReason : null) ?? result.error ?? "The workflow did not finish." });
    return "failed";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finishWorkflowRun(lease, { status: "failed", error: message }).catch(() => false);
    await settleRefresh(app, pending, { error: message });
    return "failed";
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 3. Collect                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface CollectOutcome {
  readonly app: string;
  readonly orgId: string;
  readonly status: DriveOutcome | "expired";
}

/** One refreshing app: end it by the rule, or read where its work stands and write its ending if it has one. */
async function collectOne(app: AppRow, bearer: ServiceBearer | null, followMs: number, now: Date): Promise<CollectOutcome["status"]> {
  const pending = await pendingRefresh(app);
  const verdict = refreshVerdict({ refreshingAt: app.refreshingAt, started: Boolean(pending?.sessionId || pending?.runId), now });
  if (verdict.state === "idle") return "running"; // ended between the list and this read: nothing to do
  if (verdict.state === "expired") {
    if (pending?.sessionId && bearer) await cancelSession(pending.sessionId, bearer, app.orgId);
    await expireRefresh(app, pending, verdict.message);
    return "expired";
  }
  if (!pending) return "running";
  if (pending.sessionId) {
    if (!bearer) return "running"; // nothing can read the agent: the rule still ends it in time
    const specialist = app.sourceKind === "workflow" ? (app.workflow?.trim() ?? null) : null;
    return followRefreshSession(app, { ...pending, sessionId: pending.sessionId }, specialist, bearer, followMs);
  }
  if (pending.runId) {
    const runId = pending.runId;
    const [run] = await withOrgRls(app.orgId, (tx) =>
      tx
        .select({ status: workflowRuns.status, result: workflowRuns.result, error: workflowRuns.error })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.orgId, app.orgId), eq(workflowRuns.runId, runId)))
        .limit(1),
    );
    if (!run) {
      await settleRefresh(app, pending, { error: "The workflow run this refresh started is gone, so it cannot finish and the document was not updated. Try again." });
      return "failed";
    }
    if (run.status === "completed") {
      await settleRefresh(app, pending, { content: toMarkdown(run.result) });
      return "refreshed";
    }
    if (run.status === "failed" || run.status === "cancelled") {
      await settleRefresh(app, pending, { error: run.error ?? `The workflow run ${run.status === "cancelled" ? "was cancelled" : "failed"}.` });
      return "failed";
    }
    return "running"; // the resume-workflows cron is driving it
  }
  return "running"; // started a moment ago; its session or run is about to be recorded
}

/**
 * The cron's half: every refreshing app, in every workspace, each in its own workspace's scope. Followed in parallel,
 * each for at most `followMs`, so one long refresh cannot hold up the others or the tick.
 */
export async function collectAppRefreshes(opts: {
  readonly bearer: ServiceBearer | null;
  readonly followMs: number;
  readonly now?: Date;
}): Promise<CollectOutcome[]> {
  const now = opts.now ?? new Date();
  const refreshing = await acrossOrgsRls((tx, orgId) =>
    tx
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, orgId), isNotNull(apps.refreshingAt), isNull(apps.deletedAt))),
  );
  return Promise.all(
    refreshing.map(async (app) => ({
      app: app.slug,
      orgId: app.orgId,
      status: await collectOne(app, opts.bearer, opts.followMs, now).catch((e) => {
        console.error(`[app-refresh] collecting app ${app.id}:`, e);
        return "running" as const;
      }),
    })),
  );
}
