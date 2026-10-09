# The three files every subagent copies

Source of truth: `agent/subagents/research/`. Replace `<key>` with the subagent's directory
name. Nothing else changes.

## `instructions/00-mode.ts` (verbatim)

```ts
/** Exactly one execution-mode frame for this specialist session. */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { renderPromptMode, resolvePromptMode } from "#lib/prompt-context.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: renderPromptMode(resolvePromptMode(ctx)) }),
  },
});
```

The `00-` prefix matters. eve combines `instructions/` entries *"in alphabetical order by
filename"*, after the root `instructions.md`, so the mode frame comes before the operator
override.

## `instructions/operator-override.ts` (re-key one string)

```ts
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadWorkflowOverride, renderWorkflowOverride } from "#lib/workflow-override.js";
import { orgForSession } from "#lib/org-context.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const orgId = await orgForSession(ctx);
      const override = await loadWorkflowOverride("<key>", orgId);
      if (!override) return null;
      const principalId = ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId;
      return defineInstructions({ markdown: renderWorkflowOverride(override, orgId, principalId) });
    },
  },
});
```

What it does: before every turn it reads the `workflows` row whose `name` is `<key>` in the
caller's workspace. When that row is enabled, has `instructions` text and
`instructions_enabled` is true, the text is appended after `instructions.md` as a delimited,
untrusted-preference block. No database, no row, a disabled row or empty text all resolve
to `null`: no addendum, never an exception (`agent/lib/workflow-override.ts`).

## `hooks/usage.ts` (re-key one string)

```ts
import { defineHook } from "eve/hooks";
import { finishWorkflowRun, openWorkflowRun, recordWorkflowStep } from "#lib/workflow-usage.js";
import { orgForSession } from "#lib/org-context.js";

/** The session's own workspace (a delegated child's is its root's). Never throws. */
const workspaceOf = (ctx: Parameters<typeof orgForSession>[0]): Promise<string | null> =>
  orgForSession(ctx).catch(() => null);

const WORKFLOW = "<key>";

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
```

What it does: `turn.started` opens one `automation_runs` row per invocation (keyed by the
workflow id, the session id and the turn id), every model step adds its tokens, and
`turn.completed` / `turn.failed` close it. The workflow is found **by name in the session's
own workspace** — a name is not unique across workspaces, and the recorder never looks in
another one — so with no `workflows` row named `<key>` there, or no workspace passed, nothing
is recorded and nothing fails (`agent/lib/workflow-usage.ts`). `provisionWorkspace` seeds that row for every
declared subagent when a workspace is created; an existing workspace needs it added once
(eve-subagent-wiring, section 3). The recorder never throws, because eve escalates a thrown
hook to `turn.failed`.

Keep the explanatory comment blocks from the research originals when you copy; only the
quoted key in them changes.
