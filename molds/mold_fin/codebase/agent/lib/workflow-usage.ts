/**
 * Run + token accounting for the workflows (the declared eve subagents).
 *
 * A subagent turn is not a single event: the runtime emits one `step.completed`
 * per model call, each carrying that call's usage, and one `turn.completed` at
 * the end. So a "run" here is ASSEMBLED, not written once — every step upserts
 * the same `automation_runs` row (keyed by `run_key = <workflow id>:<turn id>`)
 * and ADDS its tokens to the running totals; `turn.completed` closes the row
 * out with a duration.
 *
 * The workflow row is looked up by NAME (the subagent id) because that is all a
 * hook knows about itself, and `automation_runs.automation_id` stores the
 * workflow's uuid so the Ops Center's run feed — which is keyed by row id —
 * finds these runs without a special case.
 *
 * EVERYTHING here is best-effort and never throws. This matters more than usual:
 * eve treats a thrown hook as a real failure and escalates it to `turn.failed`,
 * so a bookkeeping bug here would take down the subagent's actual work. No DB,
 * no matching workflow row, or a query error all end in a console line and a
 * silent return.
 *
 * NOTE: like the other `#lib` modules this sticks to relative `.ts` specifiers
 * so it also runs under plain `node --experimental-strip-types`.
 */
import { and, eq, sql } from "drizzle-orm";
import { acrossOrgDbs, getDb, withOrgDb } from "./db/index.ts";
import { automationRuns, workflows } from "./db/schema.ts";

export interface StepUsage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * The workflow row id for a subagent id, or null when no row carries that name.
 * Cached for the life of the process: the Ops Center can edit a workflow's
 * fields, but a row's id never changes, and a renamed/deleted row simply stops
 * matching on the next cold start.
 */
const idCache = new Map<string, { id: string; orgId: string } | null>();

/**
 * Resolve a workflow by NAME, and return its workspace with it.
 *
 * The usage row it feeds is workspace-scoped, and a name is not unique across
 * workspaces — two teams may each have a "daily-standup". Returning the id
 * alone meant the caller had no workspace to file the usage under.
 */
async function workflowIdFor(name: string): Promise<{ id: string; orgId: string } | null> {
  const cached = idCache.get(name);
  if (cached !== undefined) return cached;
  const db = getDb();
  if (!db) return null;
  // A name is not unique across workspaces and the caller has only the name,
  // so this sweeps: cross-workspace by construction, scoped per workspace.
  const rows = await acrossOrgDbs((tx) =>
    tx
      .select({ id: workflows.id, orgId: workflows.orgId })
      .from(workflows)
      .where(eq(workflows.name, name))
      .limit(1),
  );
  const found = rows[0] ? { id: rows[0].id, orgId: rows[0].orgId } : null;
  idCache.set(name, found);
  return found;
}

/** Sum of the token fields — used only to decide whether a step is worth writing. */
function isEmpty(usage: StepUsage | undefined): boolean {
  if (!usage) return true;
  return (
    !usage.inputTokens &&
    !usage.outputTokens &&
    !usage.cacheReadTokens &&
    !usage.cacheWriteTokens &&
    !usage.costUsd
  );
}

/**
 * Add one model step's usage to this turn's run row, creating the row on the
 * first step of the turn.
 */
export async function recordWorkflowStep(
  name: string,
  turnId: string,
  usage: StepUsage | undefined,
): Promise<void> {
  try {
    if (isEmpty(usage) || !turnId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    const workflowId = wf.id;

    const runKey = `${workflowId}:${turnId}`;
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cacheRead = usage?.cacheReadTokens ?? 0;
    const cacheWrite = usage?.cacheWriteTokens ?? 0;
    const cost = usage?.costUsd ?? 0;

    await withOrgDb(wf.orgId, (tx) =>
      tx
      .insert(automationRuns)
      .values({
        orgId: wf.orgId,
        automationType: "workflow",
        automationId: workflowId,
        // The turn is still going; `turn.completed` closes it out.
        status: "running",
        startedAt: new Date(),
        runKey,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: cost,
      })
      .onConflictDoUpdate({
        target: automationRuns.runKey,
        // ADD, don't overwrite: every step of the turn lands on this row.
        set: {
          inputTokens: sql`coalesce(${automationRuns.inputTokens}, 0) + ${input}`,
          outputTokens: sql`coalesce(${automationRuns.outputTokens}, 0) + ${output}`,
          cacheReadTokens: sql`coalesce(${automationRuns.cacheReadTokens}, 0) + ${cacheRead}`,
          cacheWriteTokens: sql`coalesce(${automationRuns.cacheWriteTokens}, 0) + ${cacheWrite}`,
          costUsd: sql`coalesce(${automationRuns.costUsd}, 0) + ${cost}`,
        },
      }),
    );
  } catch (error) {
    console.error(`[workflow-usage] could not record a step for ${name}:`, error);
  }
}

/**
 * Close out this turn's run row: a terminal status and how long it took. A turn
 * whose steps reported no usage has no row, and nothing is written.
 */
export async function finishWorkflowRun(
  name: string,
  turnId: string,
  outcome: { status: "success" | "failed"; error?: string },
): Promise<void> {
  try {
    if (!turnId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    const runKey = `${wf.id}:${turnId}`;
    await withOrgDb(wf.orgId, (tx) =>
      tx
      .update(automationRuns)
      .set({
        status: outcome.status,
        error: outcome.error ?? null,
        // Wall-clock from the turn's first recorded step to now.
        durationMs: sql`greatest(0, extract(epoch from (now() - ${automationRuns.startedAt})) * 1000)::int`,
      })
      .where(and(eq(automationRuns.runKey, runKey), eq(automationRuns.status, "running"))),
    );
  } catch (error) {
    console.error(`[workflow-usage] could not close the run for ${name}:`, error);
  }
}
