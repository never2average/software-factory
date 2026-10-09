/**
 * Durable workflow-run ownership and checkpointing.
 *
 * Each live driver owns a short lease. Journal writes and terminal state
 * transitions are accepted only from that lease, so a late serverless
 * invocation cannot overwrite the newer attempt that reclaimed the run.
 */
import "server-only";

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "@/lib/ops-db";
import { workflowRunJournal, workflowRuns } from "@/agent/lib/db/schema";
import type { Delegate } from "@/lib/workflow-runtime";
import type { StepDelegate } from "@/lib/workflow-delegate";

const DEFAULT_LEASE_MS = 75_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

function boundedMs(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function leaseMs(): number {
  return boundedMs("WORKFLOW_RUN_LEASE_MS", DEFAULT_LEASE_MS, 30_000);
}

function heartbeatMs(): number {
  return Math.min(
    boundedMs("WORKFLOW_RUN_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 5_000),
    Math.floor(leaseMs() / 2),
  );
}

function newWorkerId(kind = "request"): string {
  const location = process.env.VERCEL_REGION ?? process.env.VERCEL_ENV ?? "local";
  return `${kind}:${location}:${crypto.randomUUID()}`;
}

export class WorkflowRunLeaseUnavailableError extends Error {
  readonly code = "WORKFLOW_RUN_LEASE_UNAVAILABLE";
  constructor(readonly runId: string) {
    super(`Workflow run ${runId} is already owned, cancelled, or terminal.`);
    this.name = "WorkflowRunLeaseUnavailableError";
  }
}

export class WorkflowRunLeaseLostError extends Error {
  readonly code = "WORKFLOW_RUN_LEASE_LOST";
  constructor(readonly runId: string) {
    super(`Workflow run ${runId} is no longer owned by this execution.`);
    this.name = "WorkflowRunLeaseLostError";
  }
}

export interface WorkflowRunLease {
  runId: string;
  orgId: string;
  leaseToken: string;
  workerId: string;
  attempts: number;
  resumed: boolean;
}

/** One completed agent call, loaded from any earlier execution epoch. */
export interface JournalEntry {
  prompt: string;
  result: string;
}

export interface WorkflowJournal {
  completed: Map<number, JournalEntry>;
  attempt: number;
  record(entry: {
    callIndex: number;
    subagent?: string;
    prompt: string;
    result: string | null;
    status: "running" | "completed" | "failed";
    error?: string;
    sessionId?: string | null;
    childSessionId?: string | null;
  }): Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Add replay + retries to the execution owned by `lease`. */
export function makeDurableDelegate(
  base: StepDelegate,
  journal: WorkflowJournal,
  attempts = 3,
  signal?: AbortSignal,
): Delegate {
  return async (prompt, subagent, callIndex = 0, phase) => {
    if (signal?.aborted) throw signal.reason ?? new Error("Workflow run cancelled.");
    const cached = journal.completed.get(callIndex);
    if (cached && cached.prompt === prompt) return cached.result;

    let sessionId: string | null = null;
    let childSessionId: string | null = null;
    const pendingWrites: Promise<void>[] = [];
    const onSession = (info: { sessionId: string; childSessionId?: string }) => {
      sessionId = info.sessionId;
      if (info.childSessionId) childSessionId = info.childSessionId;
      pendingWrites.push(
        journal.record({
          callIndex,
          subagent,
          prompt,
          result: null,
          status: "running",
          sessionId,
          childSessionId,
        }),
      );
    };

    let text: string | null = null;
    let lastErr: unknown = null;
    for (let a = 0; a < Math.max(1, attempts); a++) {
      try {
        // callIndex is 0-based inside the journal (it keys the replay map); the
        // step is told its 1-based position, which is what an operator counts.
        text = await base(prompt, subagent, onSession, { call: callIndex + 1, phase });
        lastErr = null;
        break;
      } catch (error) {
        lastErr = error;
        if (signal?.aborted || error instanceof WorkflowRunLeaseLostError) break;
        if (a < attempts - 1) await sleep(1000 * 2 ** a, signal);
      }
    }
    await Promise.all(pendingWrites);
    if (lastErr !== null) {
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
      // A cancellation/lease loss is an ownership boundary, not a step failure.
      if (!signal?.aborted && !(lastErr instanceof WorkflowRunLeaseLostError)) {
        await journal.record({
          callIndex,
          subagent,
          prompt,
          result: null,
          status: "failed",
          error: message,
          sessionId,
          childSessionId,
        });
      }
      throw lastErr instanceof Error ? lastErr : new Error(message);
    }
    await journal.record({
      callIndex,
      subagent,
      prompt,
      result: text ?? "",
      status: "completed",
      sessionId,
      childSessionId,
    });
    return text ?? "";
  };
}

/** Load replay checkpoints and bind all new writes to one lease epoch. */
export async function loadWorkflowJournal(lease: WorkflowRunLease): Promise<WorkflowJournal> {
  const db = getOpsDb();
  const completed = new Map<number, JournalEntry>();
  if (db) {
    const rows = await withOrgRls(lease.orgId, (tx) =>
      tx
        .select()
        .from(workflowRunJournal)
        .where(
          and(
            eq(workflowRunJournal.orgId, lease.orgId),
            eq(workflowRunJournal.runId, lease.runId),
            eq(workflowRunJournal.status, "completed"),
          ),
        )
        .orderBy(asc(workflowRunJournal.attempt)),
    );
    // Later attempts win, but older completed calls remain replayable.
    for (const row of rows) {
      if (row.attempt <= lease.attempts) {
        completed.set(row.callIndex, { prompt: row.prompt, result: row.result ?? "" });
      }
    }
  }
  return {
    completed,
    attempt: lease.attempts,
    async record(entry) {
      const d = getOpsDb();
      if (!d) return;
      const rows = await withOrgRls(lease.orgId, (tx) =>
        tx.execute<{ run_id: string }>(sql`
        insert into workflow_run_journal (
          org_id, run_id, attempt, lease_token, call_index, subagent, prompt,
          result, status, error, session_id, child_session_id
        )
        select
          ${lease.orgId}, ${lease.runId}, ${lease.attempts}, ${lease.leaseToken},
          ${entry.callIndex}, ${entry.subagent ?? null}, ${entry.prompt},
          ${entry.result}, ${entry.status}, ${entry.error ?? null},
          ${entry.sessionId ?? null}, ${entry.childSessionId ?? null}
        from workflow_runs r
        where r.run_id = ${lease.runId}
          and r.org_id = ${lease.orgId}
          and r.status = 'running'
          and r.lease_token = ${lease.leaseToken}
          and r.lease_expires_at > now()
          and r.cancel_requested_at is null
        on conflict (run_id, attempt, call_index) do update set
          subagent = excluded.subagent,
          prompt = excluded.prompt,
          result = excluded.result,
          status = excluded.status,
          error = excluded.error,
          session_id = coalesce(excluded.session_id, workflow_run_journal.session_id),
          child_session_id = coalesce(excluded.child_session_id, workflow_run_journal.child_session_id)
        where workflow_run_journal.lease_token = excluded.lease_token
        returning run_id
      `),
      );
      if (rows.length === 0) throw new WorkflowRunLeaseLostError(lease.runId);
    },
  };
}

/** Mint a run or atomically acquire an existing resumable run. */
export async function startWorkflowRun(input: {
  orgId: string;
  runId?: string;
  workflowId?: string | null;
  workflowName: string;
  args?: unknown;
  createdBy?: string | null;
  workerId?: string;
}): Promise<WorkflowRunLease> {
  const db = getOpsDb();
  const runId = input.runId ?? `wfr_${crypto.randomUUID()}`;
  const leaseToken = crypto.randomUUID();
  const workerId = input.workerId ?? newWorkerId(input.createdBy ?? "request");
  const expiresAt = new Date(Date.now() + leaseMs());
  const argsJson = JSON.stringify(input.args ?? null);
  if (!db) {
    return { runId, orgId: input.orgId, leaseToken, workerId, attempts: 1, resumed: false };
  }

  const inserted = await withOrgRls(input.orgId, (tx) =>
    tx
    .insert(workflowRuns)
    .values({
      orgId: input.orgId,
      runId,
      workflowId: input.workflowId ?? null,
      workflowName: input.workflowName,
      args: input.args ?? null,
      status: "running",
      attempts: 1,
      leaseToken,
      leaseExpiresAt: expiresAt,
      workerId,
      lastHeartbeatAt: new Date(),
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: workflowRuns.runId })
    .returning({ runId: workflowRuns.runId }),
  );
  if (inserted.length > 0) {
    return { runId, orgId: input.orgId, leaseToken, workerId, attempts: 1, resumed: false };
  }

  const claimed = await withOrgRls(input.orgId, (tx) =>
    tx.execute<{ attempts: number }>(sql`
    update workflow_runs
    set lease_token = ${leaseToken},
        lease_expires_at = ${expiresAt},
        worker_id = ${workerId},
        last_heartbeat_at = now(),
        attempts = attempts + 1,
        error = null,
        updated_at = now()
    where run_id = ${runId}
      and org_id = ${input.orgId}
      and status = 'running'
      and workflow_id is not distinct from ${input.workflowId ?? null}
      and workflow_name = ${input.workflowName}
      and args is not distinct from ${argsJson}::jsonb
      and cancel_requested_at is null
      and (lease_token is null or lease_expires_at is null or lease_expires_at <= now())
    returning attempts
  `),
  );
  if (claimed.length === 0) throw new WorkflowRunLeaseUnavailableError(runId);
  return {
    runId,
    orgId: input.orgId,
    leaseToken,
    workerId,
    attempts: claimed[0].attempts,
    resumed: true,
  };
}

export type WorkflowRunFinish = {
  status: "running" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: string | null;
};

/** Terminal/release transition, guarded by the active lease token. */
export async function finishWorkflowRun(
  lease: WorkflowRunLease,
  output: WorkflowRunFinish,
): Promise<boolean> {
  const db = getOpsDb();
  if (!db) return true;
  const resultJson = JSON.stringify(output.result ?? null);
  const rows = await withOrgRls(lease.orgId, (tx) =>
    tx.execute<{ run_id: string }>(sql`
    update workflow_runs
    set status = case
          when cancel_requested_at is not null then 'cancelled'
          else ${output.status}
        end,
        result = ${resultJson}::jsonb,
        error = case
          when cancel_requested_at is not null
            then coalesce(cancel_reason, ${output.error ?? null}, 'Workflow run cancelled.')
          else ${output.error ?? null}
        end,
        lease_token = null,
        lease_expires_at = null,
        cancelled_at = case
          when cancel_requested_at is not null or ${output.status} = 'cancelled' then now()
          else cancelled_at
        end,
        updated_at = now()
    where org_id = ${lease.orgId}
      and run_id = ${lease.runId}
      and status = 'running'
      and lease_token = ${lease.leaseToken}
    returning run_id
  `),
  );
  return rows.length > 0;
}

export type HeartbeatResult =
  | { status: "active" }
  | { status: "cancel_requested"; reason: string | null }
  | { status: "lease_lost" };

export async function heartbeatWorkflowRun(lease: WorkflowRunLease): Promise<HeartbeatResult> {
  const db = getOpsDb();
  if (!db) return { status: "active" };
  const rows = await withOrgRls(lease.orgId, (tx) =>
    tx
    .update(workflowRuns)
    .set({
      leaseExpiresAt: new Date(Date.now() + leaseMs()),
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowRuns.orgId, lease.orgId),
        eq(workflowRuns.runId, lease.runId),
        eq(workflowRuns.status, "running"),
        eq(workflowRuns.leaseToken, lease.leaseToken),
      ),
    )
    .returning({ cancelRequestedAt: workflowRuns.cancelRequestedAt, cancelReason: workflowRuns.cancelReason }),
  );
  if (rows.length === 0) return { status: "lease_lost" };
  if (rows[0].cancelRequestedAt) {
    return { status: "cancel_requested", reason: rows[0].cancelReason };
  }
  return { status: "active" };
}

/** Keep a lease alive and expose a cooperative AbortSignal to runtime/delegate. */
export async function withWorkflowRunHeartbeat<T>(
  lease: WorkflowRunLease,
  execute: (control: { signal: AbortSignal; cancellationReason: () => string | null }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let reason: string | null = null;
  let ticking = false;
  const tick = async () => {
    if (ticking || controller.signal.aborted) return;
    ticking = true;
    try {
      const result = await heartbeatWorkflowRun(lease);
      if (result.status === "cancel_requested") {
        reason = result.reason;
        controller.abort(new Error(result.reason || "Workflow run cancelled."));
      } else if (result.status === "lease_lost") {
        controller.abort(new WorkflowRunLeaseLostError(lease.runId));
      }
    } catch {
      // A transient heartbeat failure must not kill the run. The finite lease
      // still prevents stale ownership if the process or DB stays unavailable.
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), heartbeatMs());
  try {
    // Close the claim-to-execute race: a cancel request that lands immediately
    // after acquisition is observed before QuickJS or a delegate starts.
    await tick();
    return await execute({ signal: controller.signal, cancellationReason: () => reason });
  } finally {
    clearInterval(timer);
  }
}

export interface StalledRun extends WorkflowRunLease {
  workflowId: string | null;
  workflowName: string;
  args: unknown;
}

/** Read-only backlog summary used when the cron has no service credential. */
export async function listStalledRuns(options: {
  stallMs: number;
  attemptsCap: number;
  limit?: number;
}): Promise<Array<Omit<StalledRun, keyof WorkflowRunLease> & { runId: string; orgId: string; attempts: number }>> {
  const db = getOpsDb();
  if (!db) return [];
  await finalizeAbandonedCancellations();
  await finalizeExhaustedRuns(options.attemptsCap, options.stallMs);
  /**
   * Per workspace, then merged — see acrossOrgsRls. "Every stalled run" spans
   * workspaces, so it cannot be asked from inside one; but a single unscoped
   * scan returns nothing the moment the policy fails closed. The limit is
   * applied per workspace and again after the merge, so it stays a global
   * ceiling rather than becoming one-per-workspace.
   */
  const limit = options.limit ?? 5;
  const rows = (
    await acrossOrgsRls<{
      run_id: string;
      org_id: string;
      workflow_id: string | null;
      workflow_name: string;
      args: unknown;
      attempts: number;
      updated_at: string;
    }>((tx) =>
      tx.execute(sql`
    select run_id, org_id, workflow_id, workflow_name, args, attempts, updated_at
    from workflow_runs
    where status = 'running'
      and cancel_requested_at is null
      and attempts < ${options.attemptsCap}
      and (
        (lease_token is null and updated_at < now() - make_interval(secs => ${options.stallMs / 1000}))
        or lease_expires_at <= now()
      )
    order by updated_at asc
    limit ${limit}
  `),
    )
  )
    .sort((x, y) => new Date(x.updated_at).getTime() - new Date(y.updated_at).getTime())
    .slice(0, limit);
  return rows.map((row) => ({
    runId: row.run_id,
    orgId: row.org_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    args: row.args,
    attempts: row.attempts,
  }));
}

/** Atomically lease stalled runs. SKIP LOCKED lets concurrent cron ticks share work. */
export async function claimStalledRuns(options: {
  stallMs: number;
  attemptsCap: number;
  limit?: number;
  workerId?: string;
}): Promise<StalledRun[]> {
  const db = getOpsDb();
  if (!db) return [];
  await finalizeAbandonedCancellations();
  await finalizeExhaustedRuns(options.attemptsCap, options.stallMs);
  const workerId = options.workerId ?? newWorkerId("resume-cron");
  // Per workspace, then merged and capped — same reasoning as listStalledRuns.
  // The claim is atomic within each workspace (for update skip locked), so two
  // ticks still never claim the same run.
  const claimLimit = options.limit ?? 5;
  const rows = (
    await acrossOrgsRls<{
      run_id: string;
      org_id: string;
      workflow_id: string | null;
      workflow_name: string;
      args: unknown;
      attempts: number;
      lease_token: string;
    }>((tx) =>
      tx.execute(sql`
    with candidates as (
      select run_id
      from workflow_runs
      where status = 'running'
        and cancel_requested_at is null
        and attempts < ${options.attemptsCap}
        and (
          (lease_token is null and updated_at < now() - make_interval(secs => ${options.stallMs / 1000}))
          or lease_expires_at <= now()
        )
      order by updated_at asc
      for update skip locked
      limit ${claimLimit}
    )
    update workflow_runs r
    set lease_token = gen_random_uuid()::text,
        lease_expires_at = now() + make_interval(secs => ${leaseMs() / 1000}),
        worker_id = ${workerId},
        last_heartbeat_at = now(),
        attempts = r.attempts + 1,
        error = null,
        updated_at = now()
    from candidates c
    where r.run_id = c.run_id
    returning r.run_id, r.org_id, r.workflow_id, r.workflow_name, r.args,
              r.attempts, r.lease_token
  `),
    )
  ).slice(0, claimLimit);
  return rows.map((row) => ({
    runId: row.run_id,
    orgId: row.org_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    args: row.args,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    workerId,
    resumed: true,
  }));
}

export interface CancellationRequestResult {
  status: "requested" | "already_requested" | "cancelled" | "not_running" | "not_found";
  sessionIds: string[];
  reason: string | null;
}

/** Persist cancellation before signalling Eve, scoped to the verified org. */
export async function requestWorkflowRunCancellation(input: {
  orgId: string;
  runId: string;
  requestedBy: string;
  reason?: string | null;
}): Promise<CancellationRequestResult> {
  const db = getOpsDb();
  if (!db) return { status: "not_found", sessionIds: [], reason: input.reason ?? null };
  const existing = await withOrgRls(input.orgId, (tx) =>
    tx
    .select({ status: workflowRuns.status, cancelRequestedAt: workflowRuns.cancelRequestedAt })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.orgId, input.orgId), eq(workflowRuns.runId, input.runId)))
    .limit(1),
  );
  if (!existing[0]) return { status: "not_found", sessionIds: [], reason: input.reason ?? null };
  if (existing[0].status !== "running") {
    return { status: "not_running", sessionIds: [], reason: input.reason ?? null };
  }
  const now = new Date();
  const requested = await withOrgRls(input.orgId, (tx) =>
    tx
    .update(workflowRuns)
    .set({
      status: sql`case
        when ${workflowRuns.leaseToken} is null
          or ${workflowRuns.leaseExpiresAt} is null
          or ${workflowRuns.leaseExpiresAt} <= now()
        then 'cancelled'
        else 'running'
      end`,
      cancelRequestedAt: now,
      cancelRequestedBy: input.requestedBy,
      cancelReason: input.reason ?? null,
      cancelledAt: sql`case
        when ${workflowRuns.leaseToken} is null
          or ${workflowRuns.leaseExpiresAt} is null
          or ${workflowRuns.leaseExpiresAt} <= now()
        then now()
        else ${workflowRuns.cancelledAt}
      end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowRuns.orgId, input.orgId),
        eq(workflowRuns.runId, input.runId),
        eq(workflowRuns.status, "running"),
      ),
    )
    .returning({ runId: workflowRuns.runId, status: workflowRuns.status }),
  );
  const sessions = await withOrgRls(input.orgId, (tx) =>
    tx
    .select({
      sessionId: workflowRunJournal.sessionId,
      childSessionId: workflowRunJournal.childSessionId,
    })
    .from(workflowRunJournal)
    .where(
      and(
        eq(workflowRunJournal.orgId, input.orgId),
        eq(workflowRunJournal.runId, input.runId),
        isNotNull(workflowRunJournal.sessionId),
      ),
    )
    .orderBy(asc(workflowRunJournal.attempt)),
  );
  return {
    status:
      requested[0]?.status === "cancelled"
        ? "cancelled"
        : existing[0].cancelRequestedAt || requested.length === 0
          ? "already_requested"
          : "requested",
    sessionIds: [
      ...new Set(
        sessions.flatMap((row) =>
          [row.sessionId, row.childSessionId].filter((id): id is string => Boolean(id)),
        ),
      ),
    ],
    reason: input.reason ?? null,
  };
}

/** A cancelled run whose owner disappeared must not remain requested forever. */
async function finalizeAbandonedCancellations(): Promise<void> {
  // Per workspace: an unscoped UPDATE finalizes nothing once the policy fails
  // closed, and a cancellation stuck in "requested" forever is invisible.
  await acrossOrgsRls(async (tx) => {
    await tx.execute(sql`
    update workflow_runs
    set status = 'cancelled',
        cancelled_at = coalesce(cancelled_at, now()),
        error = coalesce(cancel_reason, error, 'Workflow run cancelled.'),
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where status = 'running'
      and cancel_requested_at is not null
      and (lease_token is null or lease_expires_at is null or lease_expires_at <= now())
  `);
    return [];
  });
}

/** Attempts are a terminal backstop, not a way to leave an ownerless run live. */
async function finalizeExhaustedRuns(attemptsCap: number, stallMs: number): Promise<void> {
  await acrossOrgsRls(async (tx) => {
    await tx.execute(sql`
    update workflow_runs
    set status = 'failed',
        error = coalesce(error, 'Workflow run exhausted its retry attempts.'),
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where status = 'running'
      and cancel_requested_at is null
      and attempts >= ${attemptsCap}
      and (
        (lease_token is null and updated_at < now() - make_interval(secs => ${stallMs / 1000}))
        or lease_expires_at <= now()
      )
  `);
    return [];
  });
}
