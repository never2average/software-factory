/**
 * Run + token accounting for the "lodr-filings" workflow.
 *
 * Subagent hooks fire only inside this subagent's scope, so every event here
 * belongs to a lodr-filings turn. `turn.started` OPENS this turn's automation_runs
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
 *   - the session's workspace (`orgForSession(ctx)`) is passed too. A workflow
 *     NAME is not unique across workspaces, so the recorder files the run in
 *     the workspace it ran in and only there; since fde-agent #85 a call with
 *     no workspace records nothing at all. The recorders are called through a
 *     4-parameter type so this also compiles against a base without that
 *     parameter (where the extra argument is simply ignored).
 *
 * Observe-only, and never throws: eve escalates a thrown hook to turn.failed,
 * so the recorder swallows its own errors (see agent/lib/workflow-usage.ts).
 */
import { defineHook } from "eve/hooks";
import {
  finishWorkflowRun as finishRun,
  openWorkflowRun as openRun,
  recordWorkflowStep as recordStep,
} from "#lib/workflow-usage.js";
import { orgForSession } from "#lib/org-context.js";

type Outcome = { status: "success" | "failed"; error?: string };
type StepUsage = Parameters<typeof recordStep>[2];
type OrgId = string | null;

// Assignment (not a cast) keeps these type-checked: a base whose recorders take
// the workspace matches exactly, an older one takes fewer parameters.
const openWorkflowRun: (name: string, turnId: string, sessionId?: string, orgId?: OrgId) => Promise<void> = openRun;
const recordWorkflowStep: (
  name: string,
  turnId: string,
  usage: StepUsage,
  sessionId?: string,
  orgId?: OrgId,
) => Promise<void> = recordStep;
const finishWorkflowRun: (
  name: string,
  turnId: string,
  outcome: Outcome,
  sessionId?: string,
  orgId?: OrgId,
) => Promise<void> = finishRun;

/**
 * The workspace this run belongs to — the session's own (a delegated child's is
 * its root's). Never throws (see above).
 */
const workspaceOf = (ctx: Parameters<typeof orgForSession>[0]): Promise<OrgId> =>
  orgForSession(ctx).catch(() => null);

const WORKFLOW = "lodr-filings";

export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      await openWorkflowRun(WORKFLOW, event.data.turnId, ctx.session.id, await workspaceOf(ctx));
    },
    async "step.completed"(event, ctx) {
      await recordWorkflowStep(WORKFLOW, event.data.turnId, event.data.usage, ctx.session.id, await workspaceOf(ctx));
    },
    async "turn.completed"(event, ctx) {
      await finishWorkflowRun(WORKFLOW, event.data.turnId, { status: "success" }, ctx.session.id, await workspaceOf(ctx));
    },
    async "turn.failed"(event, ctx) {
      await finishWorkflowRun(
        WORKFLOW,
        event.data.turnId,
        { status: "failed", error: event.data.message },
        ctx.session.id,
        await workspaceOf(ctx),
      );
    },
  },
});
