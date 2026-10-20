// The Compute page's only two actions (/admin/compute, docs/compute-and-traces-spec.md §2 and step 7). Everything else
// on the page is read only. Both write an admin audit line (src/admin.ts log): who, what, and what came of it.
//
//   POST /compute/tick                 Run a tick now: one autoscaler tick at once (src/autoscaler.ts runTickNow).
//   POST /compute/sessions/:id/cancel  Cancel a queued or running session. Only the database changes here: a running
//                                      session's next heartbeat is refused (409), so its orchestrator kills the
//                                      sandbox and does not report it complete (orchestrator/core/session.ts).
import { AdminError, log } from "./admin.js";
import { getDb } from "./db.js";
import { runTickNow } from "./autoscaler.js";
import { finishSimulationIfDone } from "./worker.js";
import { recordComputeEvent } from "./compute-events.js";
import { reportSessionSpend } from "./billing.js";

/** What "Run a tick now" shows: the counts for its toast, the tick's note or error, and whether this server led it. */
export interface TickResult {
  at: string; leader: boolean; holder: string; launched: number; reaped: number; note: string | null; error: string | null;
  /** One plain-English line for the toast. */
  message: string;
}

export function tickMessage(st: { leader: boolean; launched?: string[]; reaped?: unknown[]; note?: string; error?: string }): string {
  if (st.error) return `The tick failed: ${st.error}`;
  if (!st.leader) return "Another server holds the autoscaler lease and ticks on its own; this one did nothing.";
  return `Tick ran: launched ${st.launched?.length ?? 0}, reaped ${st.reaped?.length ?? 0}.${st.note ? ` ${st.note}` : ""}`;
}

export async function runTick(actor: string): Promise<TickResult> {
  const st = await runTickNow();
  const r: TickResult = { at: st.at, leader: st.leader, holder: st.holder, launched: st.launched?.length ?? 0, reaped: st.reaped?.length ?? 0,
    note: st.note ?? null, error: st.error ?? null, message: tickMessage(st) };
  log(actor, "compute.tick", null, { leader: r.leader, launched: st.launched ?? [], reaped: r.reaped, note: r.note, error: r.error });
  return r;
}

/**
 * Cancel one session: queued or running becomes cancelled, its gateway tokens are revoked (no more model calls), and
 * who cancelled it is kept in its metadata and in compute_events (admin_cancel). A queued session is simply never
 * claimed. A running one never reports /complete (its heartbeat is refused), so what the gateway metered for it is
 * folded into its cost here, as completeSession would, and reported for usage billing. When it was the last open
 * session of its run, the run finishes, but never samples more: an adaptive run is not extended by a cancel.
 */
export async function cancelSession(actor: string, id: string) {
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const [s] = await tx.query<{ status: string; simulation_id: string; worker_id: string | null; sandbox_id: string | null; slug: string | null }>(
      `/* tenant: internal: admin Compute page, one session by id (admin only) */
       SELECT s.status, s.simulation_id, s.worker_id, s.sandbox_id, o.slug FROM agent_sessions s LEFT JOIN organizations o ON o.id = s.org_id
        WHERE s.id = $1 FOR UPDATE OF s`, [id]);
    if (!s) throw new AdminError(`No session ${id}`, 404);
    if (!["queued", "running"].includes(s.status)) throw new AdminError(`Session ${id} has already ended (${s.status}).`, 409);
    await tx.query(
      `/* tenant: internal: admin Compute page, one session by id (admin only) */ UPDATE agent_sessions SET status = 'cancelled', ended_at = now(),
              metadata = metadata || jsonb_build_object('cancelled_by', $2::text, 'cancelled_at', now(), 'cancelled_from', $3::text)
        WHERE id = $1`, [id, actor, s.status]);
    await tx.query("/* tenant: internal: admin Compute page, one session by id (admin only) */ UPDATE gateway_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [id]);
    // The gateway's meter is the session's spend (the worker never reports it now); larger figures win, as on /complete.
    await tx.query(
      `/* tenant: internal: admin Compute page, one session by id (admin only) */
       UPDATE agent_sessions s SET tokens_in = greatest(s.tokens_in, u.input_tokens), tokens_out = greatest(s.tokens_out, u.output_tokens),
              cost_usd = greatest(s.cost_usd, u.cost_usd)
         FROM (SELECT coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cost_usd), 0) AS cost_usd,
                      count(*) AS n FROM gateway_usage WHERE session_id = $1) u
        WHERE s.id = $1 AND u.n > 0`, [id]);
    return s;
  });
  const was = row.status;
  // The audit lines first: the session is cancelled now, whatever finishing its run does next.
  log(actor, "compute.session.cancel", row.slug, { session_id: id, was, simulation_id: row.simulation_id, worker_id: row.worker_id, sandbox_id: row.sandbox_id });
  // On the orchestrator that ran it (the fleet row whose worker id claimed it), so its peek lists the cancel too.
  const [orch] = row.worker_id ? await db.query<{ id: string }>("SELECT id FROM orchestrators WHERE meta->>'worker_id' = $1 LIMIT 1", [row.worker_id]) : [];
  await recordComputeEvent({ kind: "admin_cancel", session_id: id, job_id: row.simulation_id, orchestrator_id: orch?.id ?? null, sandbox_id: row.sandbox_id,
    actor, reason: `cancelled while ${was}` });
  reportSessionSpend(id);
  try { await finishSimulationIfDone(row.simulation_id, { extend: false }); }
  catch (e) { console.error(`cancel ${id}: run ${row.simulation_id} not finished: ${(e as Error).message}`); }
  return { id, status: "cancelled" as const, was,
    message: was === "running" ? "Session cancelled. Its sandbox stops when its orchestrator next heartbeats." : "Session cancelled. No orchestrator will claim it." };
}
