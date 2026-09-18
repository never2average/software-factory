/**
 * Operator override — eve dynamic instructions on `turn.started`.
 *
 * The Ops Center stores a per-workflow `instructions` override in the
 * `workflows` table; the row whose `name` is "annual-report-format" targets THIS
 * subagent. Before every turn this resolver loads that override (best-effort;
 * see #lib/workflow-override.js) and appends it to the context as a clearly
 * delimited addendum AFTER the authored instructions.md — eve places the root
 * instructions file first, then this directory's dynamic entries. No row, a
 * disabled row, empty text, or no DATABASE_URL resolve to null: no addendum.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadWorkflowOverride, renderWorkflowOverride } from "#lib/workflow-override.js";
import { orgForSession } from "#lib/org-context.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const orgId = await orgForSession(ctx);
      const override = await loadWorkflowOverride("annual-report-format", orgId);
      if (!override) return null;
      const principalId = ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId;
      return defineInstructions({ markdown: renderWorkflowOverride(override, orgId, principalId) });
    },
  },
});
