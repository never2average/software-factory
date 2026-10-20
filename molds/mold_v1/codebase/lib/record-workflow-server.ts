import "server-only";

/**
 * A TASK WRITE WHEN THE TASKS' LIFECYCLE RUNS A WORKFLOW, at the ops API (app/api/ops/todos/**; docs/WORKFLOW_ENGINE.md
 * "Runtime"). A task is written by the task-workflow service, not in this app's database, so no transaction, connection
 * or lock is held across that call. The record and its instance are kept together by a reserved move
 * (lib/record-workflow-moves.ts, "A record written elsewhere"):
 *
 *   a. a short transaction: the task's workflow lock, the stored task and what its lifecycle reads, its instance and
 *      the step rules; then the usual checks (guardTaskRequest) with nothing held; a refusal reaches nothing;
 *   b. a short transaction: the move reserved on the instance, if the task and its instance are still what (a) read
 *      (else a 409 that changes nothing);
 *   c. the service's write, with nothing held and a time limit;
 *   d. a short transaction: the TASK'S ACTUAL STATE settles the reservation: it reached the target, the step moves; it
 *      did not, the reservation is released. The answer says what happened: the service's own answer when it agrees
 *      with the task's state; when the service failed or timed out, whether the move was made after all. When (d)
 *      fails, the answer says the task moved and that its workflow follows on the next read (the reservation stays and
 *      the next read settles it the same way).
 *   A create attaches the new task's instance in its own short transaction once the service made it; if that fails, or
 *   the service named no id, the answer says so and the instance is attached on the task's first move.
 *   Then, as for every task write, the move in the activity feed and a recurring task's next occurrence
 *   (lib/record-lifecycle-server.ts afterTaskWrite).
 *
 * `evidence` in the body is the move's evidence (no field of a task), taken out before the body is checked or sent. A
 * deployment whose tasks run no workflow never comes here: the routes keep today's path.
 */
import { NextRequest, NextResponse } from "next/server";
import type { OrgContext } from "@/lib/org-context";
import { withOrgRls } from "@/lib/ops-db";
import { storedTask } from "@/agent/lib/record-lifecycle-store";
import { areaView, type AreaRow } from "@/agent/lib/record-areas";
import { proxyTaskWorkflow } from "@/lib/task-workflow-service";
import { callerEmail, guardTaskRequest, taskLifecycleInputsIn, type TaskLifecycleInputs } from "@/lib/work-periods-server";
import { afterTaskWrite } from "@/lib/record-lifecycle-server";
import {
  attachCreatedRecord,
  lockRecordWorkflow,
  openRecordWorkflow,
  RECORD_SERVICE_TIMEOUT_MS,
  recordWorkflowBound,
  reserveRecordMove,
  RecordWorkflowBusy,
  settleReservedMove,
  takeEvidence,
  workflowRefusal,
  type RecordWorkflowSession,
} from "@/lib/record-workflow-moves";

/** Does a task write at this method go through the tasks' workflow? (A create or a change, when the lifecycle runs one.) */
export function taskWorkflowWrite(method: string): boolean {
  return (method === "POST" || method === "PATCH") && recordWorkflowBound("tasks");
}

/** POST /api/ops/todos (`taskId` null) or PATCH /api/ops/todos/:id, through the tasks' workflow (see the header). */
export async function forwardWorkflowTask(request: NextRequest, ctx: OrgContext, taskId: string | null, path: string): Promise<Response> {
  const noun = areaView("tasks").noun;
  const text = await request.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const isObject = Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  const { body, evidence } = isObject ? takeEvidence(parsed as Record<string, unknown>) : { body: null, evidence: null };
  const forwarded = new NextRequest(request.url, { method: request.method, headers: request.headers, body: body ? JSON.stringify(body) : text });
  const me = (await callerEmail(request)) ?? "";
  const comment = typeof body?.reason === "string" ? body.reason : null;
  const readTask = (tx: Parameters<typeof storedTask>[0]) => () => (taskId ? storedTask(tx, ctx.orgId, taskId) : Promise.resolve(null));
  const stopped = (e: unknown) => {
    const r = workflowRefusal(e, noun);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  };

  // a. Under the lock: the task as it is now, what its lifecycle reads, its instance and the step rules.
  let opened: { inputs: TaskLifecycleInputs; session: RecordWorkflowSession | null } = { inputs: {}, session: null };
  if (taskId) {
    try {
      opened = await withOrgRls(ctx.orgId, async (tx) => {
        await lockRecordWorkflow(tx, ctx.orgId, "tasks", taskId);
        const inputs = await taskLifecycleInputsIn(tx, ctx.orgId, taskId, body ?? {});
        // A task that is not this workspace's is the service's own 404: no workflow is read for it.
        const session = inputs.before ? await openRecordWorkflow(tx, ctx.orgId, "tasks", { entityId: taskId, before: inputs.before, actor: me, comment, evidence }) : null;
        return { inputs, session };
      });
    } catch (e) {
      return stopped(e);
    }
  } else {
    opened = { inputs: {}, session: null };
  }
  const create = !taskId;
  // A create's step rules: the instance it would start with (nothing stored, nothing locked).
  const createSession = create ? await withOrgRls(ctx.orgId, (tx) => openRecordWorkflow(tx, ctx.orgId, "tasks", { entityId: null, before: null, actor: me, comment, evidence })) : null;
  // While another mover's reserved move is pending, its step is about to change: the step rules are not asked (a move
  // is answered "being moved" below, never refused against a step about to change).
  const gate = opened.session?.busy ? undefined : (opened.session ?? createSession)?.gate;
  const guarded = await guardTaskRequest(forwarded, ctx.orgId, taskId, undefined, undefined, { role: ctx.role, ...(gate ? { workflow: gate } : {}), ...(taskId ? { inputs: opened.inputs } : {}) });
  if ("response" in guarded) return guarded.response;
  const check = guarded.lifecycle?.check ?? null;
  // Another mover's reserved move is not settled yet: a move now would be checked against a step about to change. A
  // write that moves nothing goes on.
  if (opened.session?.busy && check) return stopped(new RecordWorkflowBusy());

  // b. The move reserved on the instance, if nothing changed since (a).
  let moveId: string | null = null;
  if (taskId && opened.session) {
    try {
      moveId = (await withOrgRls(ctx.orgId, (tx) => reserveRecordMove(tx, opened.session!, { entityId: taskId, check, readRecord: readTask(tx), deliver: (org, fn) => withOrgRls(org, fn as never) }))).id;
    } catch (e) {
      return stopped(e);
    }
  }

  // c. The service's write, nothing held.
  const response = await proxyTaskWorkflow(forwarded, ctx, path, guarded.body, { timeoutMs: RECORD_SERVICE_TIMEOUT_MS });
  const payload = response.ok ? ((await response.clone().json().catch(() => null)) as { item?: AreaRow & { id?: unknown } } | null) : null;

  // d. The task's actual state settles the reservation; the answer says what happened.
  if (taskId && moveId) {
    let settled: Awaited<ReturnType<typeof settleReservedMove>> | null = null;
    try {
      settled = await withOrgRls(ctx.orgId, (tx) => settleReservedMove(tx, ctx.orgId, "tasks", { entityId: taskId, moveId: moveId!, readRecord: readTask(tx), deliver: (org, fn) => withOrgRls(org, fn as never) }));
    } catch (error) {
      console.error(`[record-workflow] could not settle the move of task ${taskId}:`, error);
    }
    if (!response.ok) {
      // The service refused, failed or did not answer. Its refusal stands when the task did not move; when it moved
      // after all (a write that landed before a timeout), the answer says so.
      if (settled?.outcome === "applied") {
        const error = `The task service did not confirm the change, but it was made: this ${noun} now reads "${settled.state}", and its workflow step followed. Read it again before changing it.`;
        return NextResponse.json({ error, errors: [error], moved: true }, { status: 502 });
      }
      if (!settled) {
        const error = `The task service did not confirm the change, and it could not be checked whether it was made. Read this ${noun} again: its workflow follows what it reads.`;
        return NextResponse.json({ error, errors: [error], moved: null }, { status: 502 });
      }
      return response;
    }
    if (!settled) {
      const done = await afterTaskWrite(response, ctx.orgId, taskId, guarded.lifecycle);
      return withWorkflowNote(done, `This ${noun} was changed, but its workflow step could not be updated just now; it follows on the next read of this ${noun}.`);
    }
    return afterTaskWrite(response, ctx.orgId, taskId, guarded.lifecycle);
  }

  if (create && response.ok) {
    const id = typeof payload?.item?.id === "string" ? payload.item.id : null;
    let attached = false;
    if (id) {
      try {
        attached = Boolean(await withOrgRls(ctx.orgId, (tx) => attachCreatedRecord(tx, ctx.orgId, "tasks", { entityId: id, actor: me, check, comment, evidence, readRecord: () => storedTask(tx, ctx.orgId, id), deliver: (org, fn) => withOrgRls(org, fn as never) })));
      } catch (error) {
        console.error(`[record-workflow] could not attach the workflow of task ${id}:`, error);
      }
    }
    const done = await afterTaskWrite(response, ctx.orgId, null, guarded.lifecycle);
    return attached ? done : withWorkflowNote(done, `This ${noun} was created; its workflow is attached on its first move.`);
  }
  return afterTaskWrite(response, ctx.orgId, taskId, guarded.lifecycle);
}

/** The answer with a note about the record's workflow beside the service's item (`workflow_note`). */
async function withWorkflowNote(response: Response, note: string): Promise<Response> {
  const payload = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload || !response.ok) return response;
  return NextResponse.json({ ...payload, workflow_note: note }, { status: response.status });
}
