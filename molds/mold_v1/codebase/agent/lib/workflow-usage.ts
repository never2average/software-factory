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
 * TWO THINGS CANNOT BE ASSEMBLED FROM THE CHILD'S TURN EVENTS, and each has its
 * own entry point below:
 *
 *   - a child that dies BEFORE `turn.started` emits no turn event at all, so
 *     nothing here ever fires. The parent is told, and records the invocation
 *     on the child's behalf — `recordFailedDelegation`;
 *   - a child that dies MID-TURN without a `turn.failed` leaves its row open
 *     for ever, because `session.failed` carries no turn id to close it by —
 *     `closeAbandonedWorkflowRuns`, driven by a cron.
 *
 * NOTE: like the other `#lib` modules this sticks to relative `.ts` specifiers
 * so it also runs under plain `node --experimental-strip-types`.
 */
import { and, eq, lt, sql } from "drizzle-orm";
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

/**
 * The turn id a delegated child's first turn ALWAYS has.
 *
 * The same fact `runKeyFor` is built on, used the other way round: eve mints
 * turn ids by counting within a session (`turn_${sequence}`,
 * eve/dist/src/protocol/message.js) and a delegated child session is created
 * fresh for every invocation, so its first turn is `turn_0` without exception.
 * That is what lets the PARENT write a row for a child that never got as far as
 * emitting `turn.started`: it can compute the exact run key that child's own
 * `openWorkflowRun` would have used.
 */
const FIRST_CHILD_TURN = "turn_0";

/**
 * The run key for an invocation named from the PARENT's side.
 *
 * Exported so the proof that a parent-written row and the child's own row are
 * THE SAME ROW is an equality a test can assert, rather than two call sites
 * that happen to agree today. `run_key` is unique, so as long as this is what
 * both sides compute, a double write is impossible by construction.
 */
export function delegatedRunKey(workflowId: string, childSessionId: string): string {
  return runKeyFor(workflowId, childSessionId, FIRST_CHILD_TURN);
}

/**
 * A failure message is a sentence in the operator's run feed, not a log.
 *
 * The real one measured on this defect is 1,282 bytes, because eve embeds the
 * entire failing command in it ("Sandbox bootstrap failed because sandbox.run
 * command exited with code 1:" followed by a 40-line heredoc — see
 * scripts/fixtures/subagent-delivery/child-fails.ndjson). The first line names
 * the cause; the rest turns one row of a run list into a wall of Python.
 */
const MAX_ERROR_CHARS = 400;

function briefly(message: string | undefined): string {
  const text = (message ?? "The specialist's session failed before it started.").trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/**
 * RECORD AN INVOCATION THE CHILD NEVER GOT TO RECORD ITSELF.
 *
 * Called from the PARENT's side (agent/hooks/delegation-runs.ts) when eve hands
 * back a `SUBAGENT_EXECUTION_FAILED` delegation result. Everything else in this
 * module is driven by the child's own turn events, and a child that dies during
 * bootstrap emits none — so before this, such an invocation left no row at all
 * and simply did not appear to have happened. Measured on the real runtime
 * (scripts/fixtures/subagent-delivery/child-fails.ndjson, recorded 2026-09-23):
 * `subagent.called` for "research", then straight to an `action.result` with
 * `isError: true`; not one turn event from the child in between.
 *
 * IT CANNOT DOUBLE-WRITE, and that is structural rather than careful. The row
 * is keyed on exactly the run key the child's own `openWorkflowRun` uses for
 * its first turn — `<workflow id>:<child session id>:turn_0` — and `run_key`
 * carries a UNIQUE constraint, so `onConflictDoNothing` makes the second writer
 * a no-op whichever one arrives first:
 *
 *   - child started, recorded its own row, then failed → its row stands, with
 *     its tokens, its duration and its own `turn.failed` status;
 *   - child never started → this is the only row, and it says so.
 *
 * The status is terminal and `durationMs` is deliberately left NULL: there was
 * no turn, so there is no duration to report and writing one would invent a
 * measurement. A run row with no duration reads as "we do not know", which is
 * the truth.
 */
export async function recordFailedDelegation(
  name: string,
  childSessionId: string,
  message?: string,
): Promise<void> {
  try {
    if (!name || !childSessionId) return;
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
          status: "failed",
          startedAt: new Date(),
          runKey: delegatedRunKey(wf.id, childSessionId),
          error: briefly(message),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        })
        // The child's own row wins if it exists: it is the better record.
        .onConflictDoNothing({ target: automationRuns.runKey }),
    );
  } catch (error) {
    console.error(`[workflow-usage] could not record a failed delegation to ${name}:`, error);
  }
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

/* -------------------------------------------------------------------------- */
/* A RUN THAT NOBODY EVER CLOSES                                              */
/* -------------------------------------------------------------------------- */

/**
 * The summary that marks an open run as WAITING rather than dead.
 *
 * A specialist that asks a question parks: its turn stays open and its row
 * stays `running` for as long as nobody answers — legitimately, possibly
 * overnight. That is not a rare shape. It is what #42 was about: across six
 * live sessions every declared specialist parked, and one session's whole tail
 * is `subagent.called → subagent.called → input.requested → turn.completed →
 * session.waiting`, twice over.
 *
 * So the sweeper below CANNOT be time alone, and this is the signal that tells
 * the two apart. It is a real sentence, not a flag, because it also answers the
 * question the run feed was silently getting wrong — an open run that is
 * waiting for a person now says so.
 *
 * `summary` is otherwise never written for a workflow run, which is why the
 * sweeper's predicate is the broader `summary IS NULL`: anything that has
 * annotated a run knows more about it than a clock does.
 */
export const AWAITING_ANSWER_SUMMARY = "Waiting for an answer in the chat.";

/**
 * HOW LONG AN OPEN RUN MUST BE UNTOUCHED BEFORE IT IS CERTAINLY DEAD.
 *
 * `session.failed` carries no `turnId` (eve's protocol), so a child that dies
 * mid-turn without a `turn.failed` leaves its row `running` for ever. Measured
 * on the live deployment 2026-09-23: workspace `icici-hfc` holds three
 * `automation_runs` rows and one of them has been `running` with nothing
 * watching it.
 *
 * The obvious fix — remembering the current turn id at module scope so
 * `session.failed` can close it — was declined, and rightly: a warm instance
 * serves more than one session, so the id it remembers may belong to a
 * different, LIVE run, and closing that is worse than leaving one open. Time
 * sidesteps the ambiguity entirely: it needs nothing remembered.
 *
 * THE NUMBER, from the longest a run can legitimately still be live:
 *
 *   · 5m30s  the longest real specialist run measured on the live deployment
 *            (`lodr-filings`, 2026-09-23);
 *   · 800s   the ceiling on ONE attempt of a turn. eve's build gives the
 *            function that runs a turn's steps `maxDuration: "max"`, which this
 *            repo pins at 800 where it controls it — see scripts/deploy.mjs and
 *            app/eve/v1/session/[...segments]/route.ts;
 *   · ×4     eve retries a failed turn step three times before giving up
 *            ("failed after 3 retries", measured verbatim in
 *            scripts/fixtures/subagent-delivery/child-fails.ndjson; the
 *            `attempt >= maxRetries + 1` branch in
 *            eve/dist/src/compiled/@workflow/core/runtime.js). The row is open
 *            and legitimately live across all four attempts.
 *
 * 4 × 800s = 53m20s is therefore the longest a `running` row can still be a
 * real run. 90 minutes clears that by 36 minutes and is 16× the longest run
 * anyone has actually observed. A parked run is excluded by the summary above
 * rather than by this interval, because no interval is long enough for a
 * question nobody has answered yet.
 */
export const ABANDONED_RUN_MS = 90 * 60 * 1000;

/**
 * What an abandoned run says once it is closed.
 *
 * The status is `failed` and not a fourth value: `automation_runs.status` is a
 * closed set of three that the API type mirrors exactly (`ApiRun` in
 * app/_components/ops/lib.ts, and every `status === …` in the run timeline), so
 * a new one would arrive as an unhandled string in every consumer. The
 * SENTENCE is what makes this distinguishable from a run that completed and
 * from one that genuinely failed — it says the run was never heard from again,
 * which is exactly what is known.
 */
export const ABANDONED_RUN_ERROR =
  "Abandoned: this run was never heard from again. The specialist's session ended without reporting an outcome, so the run was closed after 90 minutes with nothing touching it.";

/**
 * CLOSE THE RUNS THAT CANNOT STILL BE ALIVE. Driven by a cron — see
 * app/api/cron/close-abandoned-runs/route.ts, scheduled in vercel.json.
 *
 * Deliberately narrow, because every clause is something that must NOT be
 * closed:
 *
 *   automation_type = 'workflow'  only subagent runs are assembled from a
 *                                 stream of events and can therefore be left
 *                                 open. A schedule, a system cron and a
 *                                 connector sync each write their row once,
 *                                 when they finish.
 *   status = 'running'            never re-close a terminal row; that would
 *                                 rewrite a real outcome with a guess.
 *   started_at < cutoff           see ABANDONED_RUN_MS.
 *   summary IS NULL               not parked on a question — see
 *                                 AWAITING_ANSWER_SUMMARY. A parked run IS
 *                                 live, for as long as it takes.
 *
 * `durationMs` is left NULL on purpose. `now() - started_at` would report the
 * age of the row as if the specialist had worked for an hour and a half, which
 * is a measurement nobody made. Null reads as "unknown", which is the truth.
 *
 * Swept per workspace: "find every run nobody closed" is not a question one
 * workspace can answer, and an unscoped read returns nothing under the
 * fail-closed policy and looks exactly like "nothing to do" (the shape
 * `sweepIdleSessions` in agent/lib/browser.ts already uses).
 */
export async function closeAbandonedWorkflowRuns(options?: {
  readonly now?: Date;
  readonly olderThanMs?: number;
}): Promise<{ closed: number }> {
  try {
    const db = getDb();
    if (!db) return { closed: 0 };
    const now = options?.now ?? new Date();
    const olderThanMs = options?.olderThanMs ?? ABANDONED_RUN_MS;
    const cutoff = new Date(now.getTime() - olderThanMs);
    const closed = await acrossOrgDbs((tx) =>
      tx
        .update(automationRuns)
        .set({ status: "failed", error: ABANDONED_RUN_ERROR })
        .where(
          and(
            eq(automationRuns.automationType, "workflow"),
            eq(automationRuns.status, "running"),
            lt(automationRuns.startedAt, cutoff),
            sql`${automationRuns.summary} is null`,
          ),
        )
        .returning({ id: automationRuns.id }),
    );
    return { closed: closed.length };
  } catch (error) {
    console.error("[workflow-usage] could not sweep abandoned runs:", error);
    return { closed: 0 };
  }
}

/**
 * Mark a delegated run as WAITING for a person, so the sweeper leaves it alone.
 *
 * Called from the parent's side (agent/hooks/delegation-runs.ts) when eve
 * proxies a child's question onto the parent's stream. Parent-side because the
 * specialists that park in production ship in a pack and carry their own
 * `hooks/usage.ts`; the root agent's hooks do not, so this reaches all of them.
 *
 * Scoped to `status = "running"`: a question whose run has already ended
 * changes nothing, and a closed run must never be annotated as waiting.
 */
export async function markDelegationParked(name: string, childSessionId: string): Promise<void> {
  await setDelegationSummary(name, childSessionId, AWAITING_ANSWER_SUMMARY);
}

/**
 * The run is no longer waiting — the delegation came back.
 *
 * Clearing matters as much as setting it: a run that parked, was answered, and
 * then died mid-turn would otherwise keep the mark and be exempt from the
 * sweep for ever, which is the very leak this pair is here to close.
 */
export async function clearDelegationPark(name: string, childSessionId: string): Promise<void> {
  await setDelegationSummary(name, childSessionId, null);
}

async function setDelegationSummary(
  name: string,
  childSessionId: string,
  summary: string | null,
): Promise<void> {
  try {
    if (!name || !childSessionId) return;
    const db = getDb();
    if (!db) return;
    const wf = await workflowIdFor(name);
    if (!wf) return;
    await withOrgDb(wf.orgId, (tx) =>
      tx
        .update(automationRuns)
        .set({ summary })
        .where(
          and(
            eq(automationRuns.runKey, delegatedRunKey(wf.id, childSessionId)),
            eq(automationRuns.status, "running"),
          ),
        ),
    );
  } catch (error) {
    console.error(`[workflow-usage] could not mark the parked run for ${name}:`, error);
  }
}
