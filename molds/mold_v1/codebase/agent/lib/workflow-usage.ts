/**
 * Run + token accounting for the workflows (the declared eve subagents).
 *
 * A subagent turn is not a single event: the runtime emits one `step.completed`
 * per model call, each carrying that call's usage, and one `turn.completed` at
 * the end. So a "run" here is ASSEMBLED, not written once — `turn.started`
 * opens the `automation_runs` row, every step ADDS its tokens to it, and
 * `turn.completed` closes it out with a duration. The row is keyed by
 * `run_key = <workflow id>:<session id>:<turn id>`; see `runKeyFor` for why the
 * session id is load-bearing and not decoration.
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
 * A MISS is remembered only briefly, a HIT for the life of the process.
 *
 * The row for a subagent that ships in a pack is created out of band, by
 * `npm run fde:seed-subagent-rows -- --org <id>` (docs/SUBAGENT_PACKS.md), which
 * runs AFTER the deploy that introduced the subagent. Caching the miss for ever
 * meant a warm instance that had already been delegated to once went on
 * returning null until it was recycled — so seeding the rows fixed nothing that
 * anyone could see, and the operator's run history stayed empty. A miss is
 * therefore provisional; a hit is not, because a row's id never changes.
 */
const NEGATIVE_TTL_MS = 60_000;
const missAt = new Map<string, number>();

/** Test seam: forget everything looked up so far. */
export function __resetWorkflowIdCache(): void {
  idCache.clear();
  missAt.clear();
}

/**
 * Resolve a workflow by NAME, and return its workspace with it.
 *
 * The usage row it feeds is workspace-scoped, and a name is not unique across
 * workspaces — two teams may each have a "daily-standup". Returning the id
 * alone meant the caller had no workspace to file the usage under.
 */
async function workflowIdFor(name: string): Promise<{ id: string; orgId: string } | null> {
  const cached = idCache.get(name);
  if (cached) return cached;
  if (cached === null) {
    const since = missAt.get(name) ?? 0;
    if (Date.now() - since < NEGATIVE_TTL_MS) return null;
    idCache.delete(name);
  }
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
  if (found === null) {
    missAt.set(name, Date.now());
    console.warn(
      `[workflow-usage] no workflows row named "${name}" in any workspace — this subagent's runs are not being recorded. Fix: npm run fde:seed-subagent-rows -- --org <org_id>`,
    );
  }
  return found;
}

/**
 * THE KEY OF ONE RUN — and why a turn id alone is not one.
 *
 * eve mints turn ids by COUNTING within a session: `turn_${sequence}`
 * (eve/dist/src/protocol/message.js). A delegated child session is created
 * fresh for every invocation, so its first turn is ALWAYS `turn_0`. That makes
 * `<workflow id>:<turn id>` the same string for every run a specialist ever
 * does, and because the step upsert is `onConflictDoUpdate` on `run_key`, run
 * number two did not appear — it silently ADDED its tokens to run number one.
 * Measured 2026-09-23 against a local Postgres carrying the real fail-closed
 * tenancy model: three separate invocations of one specialist left ONE row,
 * keyed `…:turn_0`.
 *
 * This is the defect agent/lib/unique-tool-call-ids.ts documents for tool-call
 * ids ("Some models do not mint random ids; they COUNT"), one level up: eve's
 * own ids are per-session counters, and anything that treats one as a global
 * identity collapses. The SESSION is the invocation, so its id goes in the key.
 * A caller with no session id keeps the old shape rather than inventing one.
 */
export function runKeyFor(
  workflowId: string,
  sessionId: string | undefined,
  turnId: string,
): string {
  return sessionId ? `${workflowId}:${sessionId}:${turnId}` : `${workflowId}:${turnId}`;
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
 * OPEN THIS TURN'S ROW, before the model has done anything.
 *
 * The run history used to be a side effect of token accounting: the row was
 * created by the first `step.completed` that carried usage, and `isEmpty(usage)`
 * returned early otherwise. So a turn whose provider reported no usage left NO
 * ROW AT ALL — not "a run with zero tokens", nothing — and `finishWorkflowRun`,
 * which only UPDATEs, had nothing to close. Two ordinary cases hit that: the
 * OpenAI-compatible provider this fleet runs on (agent/lib/model.ts) omits
 * `usage` on some streamed completions, and a child that dies before its first
 * model call never reports any. Measured 2026-09-23 on the operator's
 * workspace: `automation_runs` completely EMPTY, across six sessions in which
 * declared specialists were delegated to repeatedly — reported by them as "I
 * don't think subagents invoked in the thread are all maintained".
 *
 * A run is an INVOCATION, so it is recorded when the invocation starts. Tokens
 * are then added to a row that already exists, and `turn.completed` /
 * `turn.failed` / `session.failed` close it. `onConflictDoNothing` keeps this
 * idempotent across a replayed step.
 */
export async function openWorkflowRun(name: string, turnId: string, sessionId?: string): Promise<void> {
  try {
    if (!turnId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    await withOrgDb(wf.orgId, (tx) =>
      tx
        .insert(automationRuns)
        .values({
          orgId: wf.orgId,
          automationType: "workflow",
          automationId: wf.id,
          status: "running",
          startedAt: new Date(),
          runKey: runKeyFor(wf.id, sessionId, turnId),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        })
        // A step may replay; the row it opened stands, tokens and all.
        .onConflictDoNothing({ target: automationRuns.runKey }),
    );
  } catch (error) {
    console.error(`[workflow-usage] could not open the run for ${name}:`, error);
  }
}

/**
 * Add one model step's usage to this turn's run row, creating the row on the
 * first step of the turn.
 */
export async function recordWorkflowStep(
  name: string,
  turnId: string,
  usage: StepUsage | undefined,
  sessionId?: string,
): Promise<void> {
  try {
    if (isEmpty(usage) || !turnId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    const workflowId = wf.id;

    const runKey = runKeyFor(workflowId, sessionId, turnId);
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
 * Close out this turn's run row: a terminal status and how long it took.
 *
 * Every turn has a row to close, because `openWorkflowRun` writes it on
 * `turn.started` rather than waiting for a step that reports tokens. The
 * `status = "running"` predicate keeps this idempotent and stops a late step
 * from re-opening a closed run.
 */
export async function finishWorkflowRun(
  name: string,
  turnId: string,
  outcome: { status: "success" | "failed"; error?: string },
  sessionId?: string,
): Promise<void> {
  try {
    if (!turnId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    const runKey = runKeyFor(wf.id, sessionId, turnId);
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
