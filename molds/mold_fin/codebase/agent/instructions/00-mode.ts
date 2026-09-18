/** Exactly one execution-mode frame, resolved once per turn. */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { renderPromptMode, resolvePromptMode } from "../lib/prompt-context.ts";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: renderPromptMode(resolvePromptMode(ctx)) }),
  },
});
