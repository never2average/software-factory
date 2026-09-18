/**
 * Run + token accounting for the "follow-ups" workflow.
 *
 * Subagent hooks fire only inside this subagent's scope, so every event here
 * belongs to a follow-ups turn. Each model step adds its usage to this turn's
 * automation_runs row; turn.completed / turn.failed close it out. That row is
 * what the Ops Center's run history and token usage read.
 *
 * Observe-only, and never throws: eve escalates a thrown hook to turn.failed,
 * so the recorder swallows its own errors (see agent/lib/workflow-usage.ts).
 */
import { defineHook } from "eve/hooks";
import { finishWorkflowRun, recordWorkflowStep } from "#lib/workflow-usage.js";

const WORKFLOW = "follow-ups";

export default defineHook({
  events: {
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
