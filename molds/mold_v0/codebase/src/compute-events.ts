import { getDb } from "./db.js";
import { LAUNCH_ERROR } from "./error-classes.js";

/**
 * Compute history (sql/migrations/0001_baseline.sql `compute_events`): what the autoscaler did to sandboxes, read by the admin Compute
 * page. Failed launches and reaps are also on their orchestrator_sandboxes row; worker, orphan and image-builder
 * deletes have no row, so this is the only place they are kept. Writing is best effort: a failed insert is logged and
 * never fails the tick or the launch that caused it.
 */

export type ComputeEventKind =
  | "launch_failed" | "reaped" | "worker_deleted" | "orphan_deleted" | "image_builder_deleted" | "tick_error" | "admin_cancel";

export interface ComputeEvent {
  kind: ComputeEventKind;
  sandbox_id?: string | null; orchestrator_id?: string | null; job_id?: string | null; session_id?: string | null;
  /** launch_failed: the launch step that failed (create, name, ready, code upload, configure, preflight, start). */
  step?: string | null;
  reason?: string | null;
  /** admin_cancel: who did it. */
  actor?: string | null;
  trace_id?: string | null;
}

export async function recordComputeEvent(ev: ComputeEvent): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO compute_events (kind, sandbox_id, orchestrator_id, job_id, session_id, step, reason, actor, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ev.kind, ev.sandbox_id ?? null, ev.orchestrator_id ?? null, ev.job_id ?? null, ev.session_id ?? null,
       ev.step ?? null, ev.reason?.slice(0, 1000) ?? null, ev.actor ?? null, ev.trace_id ?? null]);
  } catch (e) {
    console.error(`compute event ${ev.kind} not recorded: ${(e as Error).message}`);
  }
}

/**
 * The failed step and its error, from what `launchOrchestrator` throws: it sets `launchStep` and `launchError` on the
 * error, and also prefixes the message ("ready (240s): ..."). A failure outside the launch steps (say, recording the
 * result) has no step: "unknown".
 */
export function launchFailure(e: unknown): { step: string; error: string; message: string } {
  const err = e as { message?: unknown; launchStep?: unknown; launchError?: unknown };
  const message = String(err?.message ?? e);
  if (typeof err?.launchStep === "string") return { step: err.launchStep, error: String(err.launchError ?? message), message };
  const m = LAUNCH_ERROR.exec(message);
  return m ? { step: m[1]!, error: m[2]!, message } : { step: "unknown", error: message, message };
}
