/**
 * Run and token accounting for the "story-briefing" workflow: turn.started opens this turn's automation_runs row, each model
 * step adds its usage, turn.completed / turn.failed close it. The session id and the session's workspace are passed
 * on every call, so runs never merge and are filed in the workspace they ran in. Observe-only; never throws.
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

const openWorkflowRun: (name: string, turnId: string, sessionId?: string, orgId?: OrgId) => Promise<void> = openRun;
const recordWorkflowStep: (name: string, turnId: string, usage: StepUsage, sessionId?: string, orgId?: OrgId) => Promise<void> = recordStep;
const finishWorkflowRun: (name: string, turnId: string, outcome: Outcome, sessionId?: string, orgId?: OrgId) => Promise<void> = finishRun;

const workspaceOf = (ctx: Parameters<typeof orgForSession>[0]): Promise<OrgId> => orgForSession(ctx).catch(() => null);

const WORKFLOW = "story-briefing";

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
      await finishWorkflowRun(WORKFLOW, event.data.turnId, { status: "failed", error: event.data.message }, ctx.session.id, await workspaceOf(ctx));
    },
  },
});
