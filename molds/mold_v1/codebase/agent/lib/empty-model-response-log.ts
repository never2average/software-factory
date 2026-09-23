/**
 * GETTING AN EMPTY-RESPONSE RECORD FROM THE MODEL CALL TO WHERE AN OPERATOR
 * READS IT.
 *
 * The facts are only available at the model boundary (finish reason, usage, the
 * output cap actually in force — see agent/lib/empty-model-response.ts). The
 * WORKSPACE is only available where eve hands over a session context: a hook, a
 * tool, an instruction resolver. Neither half can write the row on its own.
 *
 * So the record travels through eve's own per-step context. `defineState` is a
 * named slot on the ALS-scoped harness step ("available to all authored
 * callbacks that run inside the ALS-scoped harness step — tools, hooks, channel
 * events"), and the model middleware runs inside that same step, so the slot is
 * the one channel that cannot mix two sessions up.
 *
 * WHY NOT A MODULE-LEVEL QUEUE. A warm serverless instance serves many sessions
 * at once. `agent/hooks/delegation-runs.ts` documents what that costs: keyed on
 * a call id alone, one session's failure was filed against another session's
 * live child. A process-wide "last empty response" would file one person's
 * incident under another person's workspace, which is a tenancy bug wearing a
 * diagnostics hat.
 *
 * WHY NOT THE ROUTE. `/api/ops/chat-telemetry` is the browser's door and needs a
 * signed-in request; the agent is a separate deployment with its own database
 * layer (`withOrgDb`, not `withOrgRls`). So the row is written directly, with
 * the SAME sentence map and the SAME session hash the route uses
 * (`lib/chat-telemetry.ts`) — the drift those two files would otherwise develop
 * is the exact failure that made `resync` and `stop` invisible for months.
 *
 * Best-effort throughout: nothing here may throw into a turn, and a missing
 * database is a no-op. An instrument that can kill the turn it measures is worse
 * than no instrument.
 */
import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import { chatSessionTag, chatTelemetrySentence } from "../../lib/chat-telemetry.ts";
import { recordAudit } from "./automation-audit.ts";
import { formatEmptyResponseDetail, kindForRecord, type EmptyResponseRecord } from "./empty-model-response.ts";
import { callerFromCtx, orgForSession, type SessionCtxLike } from "./org-context.ts";

/**
 * At most this many records survive in one step's slot.
 *
 * The slot is DURABLE — eve serializes it at the end of the step and it travels
 * with the session — so an unbounded list would grow a session's stored state
 * forever on a deployment where the model answers empty a lot. Eight is more
 * than the ladder can produce for one step (3) plus eve's own reissue (3), so a
 * drop means something far stranger than the defect this measures.
 */
export const MAX_PENDING_RECORDS = 8;

const pending = defineState<EmptyResponseRecord[]>("chat.empty-model-response", () => []);

/**
 * Stash one record on the current step. Never throws.
 *
 * `defineState` throws outside an active eve context, and the model middleware
 * can legitimately run outside one (a script, an eval, a test). Losing the
 * record is the correct outcome there — losing the TURN is not.
 */
export function publishEmptyResponse(record: EmptyResponseRecord): void {
  try {
    pending.update((current) => {
      const next = [...current, record];
      return next.length > MAX_PENDING_RECORDS ? next.slice(-MAX_PENDING_RECORDS) : next;
    });
  } catch {
    // No eve context here — see above.
  }
}

/**
 * Ids already written by this process.
 *
 * The slot is durable, so a drain whose `update(() => [])` does not make it into
 * the step's serialized state would hand the same records back on the next
 * terminal event. `automation_audit` is append-only with no unique key to lean
 * on, so the duplicate would be a second identical row claiming a second
 * incident. Bounded, because a process that never restarts must not grow a set
 * forever.
 */
const written = new Set<string>();
const MAX_WRITTEN = 2_000;
function alreadyWritten(id: string): boolean {
  if (written.has(id)) return true;
  if (written.size >= MAX_WRITTEN) written.delete(written.values().next().value as string);
  written.add(id);
  return false;
}

/** Take everything stashed on this step, clearing the slot. Never throws. */
export function drainEmptyResponses(): EmptyResponseRecord[] {
  try {
    const records = pending.get();
    if (records.length === 0) return [];
    pending.update(() => []);
    return records.filter((record) => !alreadyWritten(record.id));
  } catch {
    return [];
  }
}

/**
 * The workspace this incident belongs to, or null.
 *
 * Deliberately the same rule as `agent/lib/chat-usage.ts`: `orgForSession` fails
 * SAFE for the agent's TOOLS (an unknown identity gets an isolated workspace,
 * none at all gets `personal:unknown`), and a record filed under a guessed
 * workspace is worse than no record — it is a row in someone else's feed.
 */
async function resolveOrg(ctx: SessionCtxLike): Promise<string | null> {
  const { email, hd } = callerFromCtx(ctx);
  if (!email && !hd) return null;
  const org = await orgForSession(ctx);
  return org && org !== "personal:unknown" ? org : null;
}

function sessionTag(sessionId: string): string {
  return chatSessionTag(sessionId, (value) => createHash("sha256").update(value).digest("hex"));
}

/** One audit row per record: the kind's sentence, then the shape. */
export function eventSentence(record: EmptyResponseRecord): string {
  return `${chatTelemetrySentence(kindForRecord(record))} · attempt ${record.attempt} · ${formatEmptyResponseDetail(record)}`;
}

/**
 * Write everything this step stashed. Awaited by the hook so the writes settle
 * in order, but every failure is swallowed: eve escalates a thrown hook to
 * `turn.failed`, which would mean the telemetry for a survived empty response
 * killed the turn it had just saved.
 */
export async function flushEmptyResponses(ctx: SessionCtxLike): Promise<void> {
  const records = drainEmptyResponses();
  if (records.length === 0) return;
  try {
    const orgId = await resolveOrg(ctx);
    const sessionId = ctx.session?.id;
    if (!orgId) {
      // Said out loud rather than dropped: the alternative is a silence that
      // looks exactly like "the model never answered empty".
      console.warn(
        `[empty-model-response] ${records.length} empty response(s) in session ${sessionId ?? "unknown"} have no resolvable workspace — not recorded`,
      );
      return;
    }
    for (const record of records) {
      await recordAudit({
        orgId,
        automationType: "chat",
        automationId: sessionId ? sessionTag(sessionId) : "unknown",
        actor: "agent",
        event: eventSentence(record),
      });
    }
  } catch (error) {
    console.error("[empty-model-response] could not record the empty responses:", error);
  }
}
