/**
 * Run history for the delegations the CHILD cannot record itself.
 *
 * `agent/subagents/<id>/hooks/usage.ts` records a specialist's run from inside
 * the child, off its own turn events. Two measured cases produce no turn event
 * to record, and both are visible only from the parent's stream — which is this
 * agent's stream, so they are recorded here:
 *
 *   `actions.requested` the call ids this agent asked for itself, which is how
 *                      a proxied child question is told from the parent's own
 *                      approval.
 *   `subagent.called`  remembers which child session an invocation belongs to;
 *                      the failed result below does not carry it, and the run
 *                      key is nothing without it.
 *   `input.requested`  a child that PARKS is live for as long as nobody
 *                      answers, so its open row is marked as waiting and the
 *                      abandoned-run sweeper leaves it alone.
 *   `action.result`    a child that died before `turn.started` (a sandbox
 *                      bootstrap failure — measured, and recorded in
 *                      scripts/fixtures/subagent-delivery/child-fails.ndjson)
 *                      left NO history at all. eve tells the parent, as a
 *                      `subagent-result` flagged `isError`, and that is enough
 *                      to file the invocation and how it ended.
 *
 * WHY HERE AND NOT IN THE SUBAGENTS' HOOKS. The four specialists that actually
 * run in production ship in a pack (docs/SUBAGENT_PACKS.md) with their own copy
 * of `hooks/usage.ts`. #42 fixed this repo's ten subagents, never reached those
 * four, and reported itself green. `agent/hooks/` is the root agent's, is never
 * pack-supplied, and the root agent is the parent of every delegation — so one
 * file here covers every specialist, pack's included, and cannot drift from
 * them.
 *
 * The decisions are all in `#lib/delegation-failures.js`, which is pure and is
 * executed by scripts/test-subagent-delivery.mjs against the real recorded
 * streams. This file is the wiring.
 *
 * Observe-only and never throws: eve escalates a thrown hook to `turn.failed`,
 * so every recorder below swallows its own errors (see
 * agent/lib/workflow-usage.ts). Awaited rather than fire-and-forget, unlike
 * agent/hooks/chat-usage.ts: these writes race the child's own
 * `openWorkflowRun` for one `run_key`, and the unique index settles that race
 * correctly only if each write actually completes.
 */
import { defineHook } from "eve/hooks";
import { createDelegationTracker } from "#lib/delegation-failures.js";
import {
  clearDelegationPark,
  markDelegationParked,
  recordFailedDelegation,
} from "#lib/workflow-usage.js";

/**
 * Module scope, and safe there BECAUSE every entry is keyed by the parent
 * session id as well as the call id.
 *
 * A warm serverless instance serves many sessions, and call ids are counters on
 * this fleet's models (agent/lib/unique-tool-call-ids.ts) — the recorded
 * streams all use `call_000000000000000000000002` for their one delegation.
 * Keyed on the call id alone, one session's failure would be filed against
 * another session's live child. See the module's own comment.
 */
const delegations = createDelegationTracker();

export default defineHook({
  events: {
    "actions.requested"(event, ctx) {
      // What the PARENT asked for itself. A proxied child question is
      // identified by exclusion from this set — see the tracker's `parked`.
      delegations.declared(ctx.session.id, event.data);
    },
    "subagent.called"(event, ctx) {
      delegations.called(ctx.session.id, event.data);
    },
    async "input.requested"(event, ctx) {
      for (const parked of delegations.parked(ctx.session.id, event.data)) {
        await markDelegationParked(parked.name, parked.childSessionId);
      }
    },
    async "action.result"(event, ctx) {
      const settled = delegations.settled(ctx.session.id, event.data);
      if (!settled) return;
      if (settled.failed) {
        // Keyed on the run key the child's own `openWorkflowRun` would have
        // used, and inserted with `onConflictDoNothing`, so a child that DID
        // start keeps its own row and this is a no-op.
        await recordFailedDelegation(settled.name, settled.childSessionId, settled.message);
        return;
      }
      // Came back answered: it is no longer waiting on anyone, so it becomes
      // sweepable again if it later dies without closing itself.
      await clearDelegationPark(settled.name, settled.childSessionId);
    },
  },
});
