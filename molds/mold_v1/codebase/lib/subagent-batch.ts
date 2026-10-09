/**
 * WHO GETS PER-RESULT DELEGATION (mold_v1-184). The root agent sets `subagents: { batch: "detach" }`
 * (patches/eve+0.25.1.patch): specialists called together report one at a time, a late one as a turn of its own. That is
 * for a PERSON in the chat. A session a PROGRAM starts — a workflow step, an app refresh, a cron step
 * (lib/workflow-delegate.ts) — takes the main agent's last reply as its value, and after a hand-over that would be the
 * late result's own turn, perhaps a short addendum, not the full answer. So such a session keeps eve's own batch.
 *
 * The program says so with {@link SUBAGENT_BATCH_HEADER} when it opens the session; the agent's channel
 * (agent/channels/eve.ts `onMessage`, agent/lib/subagent-batch-auth.ts) puts {@link SUBAGENT_BATCH_AUTH_ATTRIBUTE}
 * `"all"` on the auth the session is created with — also for any service principal, header or not — and the patched eve
 * reads it from the session's creator (`subagentBatchStepFields`). It can only narrow: nobody can turn "detach" on.
 */
export const SUBAGENT_BATCH_HEADER = "x-eve-subagent-batch";
/** The creator-auth attribute the patched eve reads (scripts/eve-patch/files/harness/detached-delegations.js). */
export const SUBAGENT_BATCH_AUTH_ATTRIBUTE = "eve_subagent_batch";
