/**
 * Operator override: the workflows row named "inspection-intake" may carry instructions an owner added in the Control Panel.
 * Loaded before every turn (best effort) and appended after instructions.md; no row, a disabled row or empty text
 * add nothing.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadWorkflowOverride, renderWorkflowOverride } from "#lib/workflow-override.js";
import { orgForSession } from "#lib/org-context.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const orgId = await orgForSession(ctx);
      const override = await loadWorkflowOverride("inspection-intake", orgId);
      if (!override) return null;
      const principalId = ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId;
      return defineInstructions({ markdown: renderWorkflowOverride(override, orgId, principalId) });
    },
  },
});
