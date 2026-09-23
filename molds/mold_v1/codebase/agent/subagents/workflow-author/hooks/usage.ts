/**
 * Run + token accounting for the "workflow-author" workflow.
 *
 * Subagent hooks fire only inside this subagent's scope, so every event here
 * belongs to a workflow-author turn. `turn.started` OPENS this turn's automation_runs
 * row, each model step adds its usage to it, and turn.completed / turn.failed
 * close it out. That row is what the Ops Center's run history and token usage
 * read.
 *
 * Two things here are load-bearing and were each measured wrong once:
 *
 *   - the row is opened on turn.started, not created by the first step that
 *     reports TOKENS. Accounting used to create it from usage, so a turn whose
 *     provider reported none left no row at all and the operator saw no history
 *     of the run ever happening (automation_runs empty across six live
 *     sessions, 2026-09-23);
 *   - `ctx.session.id` is passed to every call. eve numbers turns WITHIN a
 *     session (`turn_${sequence}`) and a delegated child session is new every
 *     time, so its first turn is always `turn_0`; without the session id the
 *     run key was identical for every invocation and run two silently merged
 *     into run one (three invocations, one row — measured 2026-09-23).
 *
 * Observe-only, and never throws: eve escalates a thrown hook to turn.failed,
 * so the recorder swallows its own errors (see agent/lib/workflow-usage.ts).
 */
import { defineHook } from "eve/hooks";
import { finishWorkflowRun, openWorkflowRun, recordWorkflowStep } from "#lib/workflow-usage.js";

const WORKFLOW = "workflow-author";

export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      await openWorkflowRun(WORKFLOW, event.data.turnId, ctx.session.id);
    },
    async "step.completed"(event, ctx) {
      await recordWorkflowStep(WORKFLOW, event.data.turnId, event.data.usage, ctx.session.id);
    },
    async "turn.completed"(event, ctx) {
      await finishWorkflowRun(WORKFLOW, event.data.turnId, { status: "success" }, ctx.session.id);
    },
    async "turn.failed"(event, ctx) {
      await finishWorkflowRun(
        WORKFLOW,
        event.data.turnId,
        { status: "failed", error: event.data.message },
        ctx.session.id,
      );
    },
  },
});
