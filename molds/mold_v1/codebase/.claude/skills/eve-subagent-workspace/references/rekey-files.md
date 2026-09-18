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
import { finishWorkflowRun, recordWorkflowStep } from "#lib/workflow-usage.js";

const WORKFLOW = "<key>";

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
```

What it does: every model step upserts one `automation_runs` row keyed
`<workflow id>:<turn id>` and adds its tokens; `turn.completed` closes it. The workflow is
found **by name**, so with no `workflows` row named `<key>` nothing is recorded and nothing
fails (`agent/lib/workflow-usage.ts`). `provisionWorkspace` seeds that row for every
declared subagent when a workspace is created; an existing workspace needs it added once
(eve-subagent-wiring, section 3). The recorder never throws, because eve escalates a thrown
hook to `turn.failed`.

Keep the explanatory comment blocks from the research originals when you copy; only the
quoted key in them changes.
