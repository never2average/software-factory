/**
 * Operator override — eve dynamic instructions on `turn.started`.
 *
 * Same contract as every other subagent: the Ops Center's `workflows` row named
 * "workflow-author" (if an operator makes one) is appended to this subagent's
 * context after its authored instructions.md. No row, a disabled row, empty
 * text, or no DATABASE_URL all resolve to null — no addendum.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadWorkflowOverride, renderWorkflowOverride } from "#lib/workflow-override.js";
import { orgForSession } from "#lib/org-context.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const orgId = await orgForSession(ctx);
      const override = await loadWorkflowOverride("workflow-author", orgId);
      if (!override) return null;
      const principalId = ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId;
      return defineInstructions({ markdown: renderWorkflowOverride(override, orgId, principalId) });
    },
  },
});
