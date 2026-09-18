/** Exactly one execution-mode frame for this specialist session. */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { renderPromptMode, resolvePromptMode } from "#lib/prompt-context.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: renderPromptMode(resolvePromptMode(ctx)) }),
  },
});
