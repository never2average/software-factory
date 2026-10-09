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
 */
export async function guardTaskRequest(
  request: NextRequest,
  orgId: string,
  taskId: string | null,
  wp: WorkPeriods = WORK_PERIODS,
): Promise<{ response: NextResponse } | { body: string | undefined }> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return { body: undefined };
  const text = await request.text();
  if (wp.team) return { body: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: text }; // the service answers a body it cannot read
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body: text };
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
