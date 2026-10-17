import "server-only";

/**
 * Work periods at the ops API: what the routes share so the deployment profile's `work_periods` (agent/lib/
 * work-periods.ts) means the same thing at every door.
 *
 *   mode "off"          every cycles route answers 404 (`periodsNotFound`), a task write that names a period is
 *                       refused and a task read does not carry one (`guardTaskRequest`, `withoutPeriod`);
 *   mode "individual"   a task in a period is one person's: writing somebody else's needs the caller to be in that
 *                       person's reporting chain on the roster (agent/lib/work-period-store.ts taskWriteRefusal);
 *   mode "team"         nothing here changes a request or an answer.
 */
import { NextRequest, NextResponse } from "next/server";
import { WORK_PERIODS, type WorkPeriods } from "@/agent/lib/work-periods";
import { taskWriteRefusal } from "@/agent/lib/work-period-store";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import type { RecordAreas } from "@/agent/lib/record-areas";
import { prepareTaskWrite, taskLifecycleEnforced } from "@/agent/lib/task-area";
import { permissionsDeclared } from "@/agent/lib/record-permissions";
import { areaView, type AreaRow } from "@/agent/lib/record-areas";
import type { RecordRole } from "@/agent/lib/record-areas.generated";
import { needsEnteredBy, storedStateOf } from "@/agent/lib/record-lifecycle";
import { recursOnDone } from "@/agent/lib/task-recurrence";
import { stageStateOf, storedTask, whoEntered } from "@/agent/lib/record-lifecycle-store";
import { lifecycleConflictResponse, type TaskLifecycleOutcome } from "@/lib/record-lifecycle-server";
import { verifyOpsAuth } from "@/lib/ops-auth";

/** The answer of a route that does not exist in this deployment: the same body Next gives an unknown path's API. */
export function periodsNotFound(wp: WorkPeriods = WORK_PERIODS): NextResponse | null {
  return wp.enabled ? null : NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** The signed-in person's email, lower case, or null. */
export async function callerEmail(request: NextRequest): Promise<string | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  return identity?.email ? identity.email.toLowerCase() : null;
}

/** What the task service is told about periods: the word its activity feed names a period by. Nothing under "off". */
export function periodHeaders(wp: WorkPeriods = WORK_PERIODS): Record<string, string> {
  if (!wp.enabled) return {};
  const w = wp.label.singular;
  return { "x-period-label": encodeURIComponent(w ? w[0].toUpperCase() + w.slice(1) : w) };
}

/**
 * A task write (POST a new one with `taskId` null, PATCH an existing one), checked before it is forwarded. Returns a
 * response to send instead, or the body text to forward.
 *
 * First against the deployment's definition of a task (records.areas.tasks; agent/lib/task-area.ts): a body it
 * refuses is a 400 with the reasons, and nothing reaches the task-workflow service. The default definition sends a
 * valid body on exactly as it came; a redefined one sends the checked body (its own fields as `custom`, the status
 * its state's category maps to). Then the work periods' rules below.
 *
 * When the tasks' lifecycle is enforced ("warn" or "strict"; agent/lib/record-lifecycle.ts), an update is checked
 * against the stored task as the caller's role (`who.role`), with its `reason` as the comment and, for a four-eyes move,
 * who entered the stored state: under "strict" a move that breaks a rule is a 409 (the sentence, the broken rules, the
 * allowed moves) and reaches nothing; otherwise `lifecycle` carries the move for the route to write to the activity
 * feed once the service took it (lib/record-lifecycle-server.ts afterTaskWrite: and, under "warn", into the answer's
 * `warnings`). A recurring task's stored row goes the same way, for the next occurrence. Under "off" (the default) with
 * no recurrence nothing more is read and the answer is what it was.
 */
export async function guardTaskRequest(
  request: NextRequest,
  orgId: string,
  taskId: string | null,
  wp: WorkPeriods = WORK_PERIODS,
  areas: RecordAreas = RECORD_AREAS,
  who: { role?: RecordRole } = {},
): Promise<{ response: NextResponse } | { body: string | undefined; lifecycle?: TaskLifecycleOutcome }> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return { body: undefined };
  let text = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: text }; // the service answers a body it cannot read
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body: text };
  // {me} on a redefined task is the signed-in person (the default definition fills nothing in).
  const enforced = taskLifecycleEnforced(areas);
  // A recurring task (records.areas.tasks.recurrence) needs the stored task too: completing it creates the next one.
  const recurs = recursOnDone(areas);
  // Who may (records.areas.tasks.permissions) reads the caller and the stored task (an `own` rule); a refusal is a 403.
  const perms = permissionsDeclared("tasks", areas);
  const me = areas.tasks.redefined || enforced || recurs || perms ? (await callerEmail(request)) ?? "" : "";
  const lifecycleInputs = enforced || recurs || perms ? await taskLifecycleInputs(orgId, taskId, parsed as Record<string, unknown>, areas) : {};
  const prepared = prepareTaskWrite(taskId ? "update" : "create", parsed as Record<string, unknown>, { actor: me, role: who.role, ...lifecycleInputs }, areas);
  if (!prepared.ok) {
    if (prepared.conflict) return { response: lifecycleConflictResponse(prepared.conflict) };
    return { response: NextResponse.json({ error: prepared.errors.join(" "), errors: prepared.errors }, { status: prepared.forbidden ? 403 : 400 }) };
  }
  const reason = (parsed as { reason?: unknown }).reason;
  const lifecycle = prepared.lifecycle || (recurs && lifecycleInputs.before)
    ? { check: prepared.lifecycle ?? null, before: lifecycleInputs.before ?? null, actor: me, comment: typeof reason === "string" ? reason : null, areas }
    : undefined;
  if (prepared.body) {
    parsed = prepared.body;
    text = JSON.stringify(prepared.body);
  }
  const guarded = await periodRules(request, orgId, taskId, wp, parsed, text);
  return "body" in guarded && lifecycle ? { ...guarded, lifecycle } : guarded;
}

/** The stored task, the state a requested stage stands for, and who entered the stored state (a four-eyes move). */
async function taskLifecycleInputs(orgId: string, taskId: string | null, body: Record<string, unknown>, areas: RecordAreas): Promise<{ before?: AreaRow | null; stageState?: string | null; enteredBy?: string | null }> {
  if (!taskId || !getOpsDb()) return {};
  const v = areaView("tasks", areas);
  const lc = v.lifecycle!;
  return withOrgRls(orgId, async (tx) => {
    const before = await storedTask(tx, orgId, taskId);
    if (!before) return {};
    const stageState = !lc.own && typeof body.stageId === "string" ? await stageStateOf(tx, orgId, v, taskId, body.stageId) : null;
    const from = storedStateOf(v, before);
    const by = from !== null && needsEnteredBy(v, from) ? await whoEntered(tx, orgId, { type: "task", id: taskId }, v, before, from) : null;
    return { before, stageState, enteredBy: by };
  });
}

/** The work periods' rules for a task write (see the file's header), on the body as it will be sent. */
async function periodRules(
  request: NextRequest,
  orgId: string,
  taskId: string | null,
  wp: WorkPeriods,
  parsed: unknown,
  text: string,
): Promise<{ response: NextResponse } | { body: string | undefined }> {
  if (wp.team) return { body: text };
  const patch = parsed as { cycleId?: unknown; assignee?: unknown };
  if (!wp.enabled) {
    // "cycleId: null" clears nothing a person can see; anything else names a feature this deployment does not have.
    if (patch.cycleId != null) return { response: NextResponse.json({ error: "cycleId is not used here" }, { status: 400 }) };
    if ("cycleId" in patch) {
      const { cycleId: _drop, ...rest } = parsed as Record<string, unknown>;
      return { body: JSON.stringify(rest) };
    }
    return { body: text };
  }
  // mode individual
  if (!getOpsDb()) return { body: text };
  const actor = await callerEmail(request);
  if (!actor) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const refused = await withOrgRls(orgId, (tx) =>
    taskWriteRefusal(tx, orgId, actor, taskId, {
      ...(typeof patch.cycleId === "string" || patch.cycleId === null ? { cycleId: patch.cycleId as string | null } : {}),
      ...(typeof patch.assignee === "string" || patch.assignee === null ? { assignee: patch.assignee as string | null } : {}),
    }, wp),
  );
  if (refused) return { response: NextResponse.json({ error: refused }, { status: refused.startsWith("No ") ? 404 : 403 }) };
  return { body: text };
}

/** A task (or a list of them) as a deployment without periods answers it: no `cycleId`. */
export function withoutPeriod<T>(payload: T): T {
  const strip = (row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const { cycleId: _drop, ...rest } = row as Record<string, unknown>;
    return rest;
  };
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  return { ...p, ...(Array.isArray(p.items) ? { items: p.items.map(strip) } : {}), ...(p.item ? { item: strip(p.item) } : {}) } as T;
}
