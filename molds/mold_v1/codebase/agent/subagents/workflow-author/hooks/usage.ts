/**
 * Run + token accounting for the "workflow-author" workflow.
 *
 * Subagent hooks fire only inside this subagent's scope, so every event here
 * belongs to a workflow-author turn. `turn.started` OPENS this turn's automation_runs
 * row, each model step adds its usage to it, and turn.completed / turn.failed
 * close it out. That row is what the Ops Center's run history and token usage
 * read.
 *
 * The row is opened on turn.started, not on the first step that reports tokens:
 * accounting used to CREATE the row from usage, so a turn whose provider
 * reported none left no row at all and the operator saw no history of the run
 * ever happening (automation_runs was empty across six live sessions,
 * 2026-09-23). A run is an invocation; it is recorded when it starts.
 *
 * Observe-only, and never throws: eve escalates a thrown hook to turn.failed,
 * so the recorder swallows its own errors (see agent/lib/workflow-usage.ts).
 */
import { defineHook } from "eve/hooks";
import { finishWorkflowRun, openWorkflowRun, recordWorkflowStep } from "#lib/workflow-usage.js";

const WORKFLOW = "workflow-author";

export default defineHook({
  events: {
    async "turn.started"(event) {
      await openWorkflowRun(WORKFLOW, event.data.turnId);
    },
    async "step.completed"(event) {
      await recordWorkflowStep(WORKFLOW, event.data.turnId, event.data.usage);
    },
    async "turn.completed"(event) {
      await finishWorkflowRun(WORKFLOW, event.data.turnId, { status: "success" });
    },
    async "turn.failed"(event) {
      await finishWorkflowRun(WORKFLOW, event.data.turnId, {
        status: "failed",
        error: event.data.message,
      });
    },
  },
});
