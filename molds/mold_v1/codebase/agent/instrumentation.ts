/** Prompt-shape telemetry without exporting customer inputs or model outputs. */
import type { SystemModelMessage } from "ai";
import { defineInstrumentation } from "eve/instrumentation";
import { promptTelemetry } from "./lib/prompt-context.ts";

function instructionsText(value: string | SystemModelMessage | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.content;
}

export default defineInstrumentation({
  // Prompt telemetry is structural only. Never export workspace messages.
  recordInputs: false,
  recordOutputs: false,
  events: {
    "step.started"(input) {
      const metrics = promptTelemetry(
        instructionsText(input.modelInput.instructions),
        input.modelInput.messages,
      );
      return {
        runtimeContext: {
          "prompt.mode": metrics.mode,
          "prompt.stable_tokens": metrics.stableTokens,
          "prompt.volatile_tokens": metrics.volatileTokens,
          "prompt.compaction_reason": metrics.compactionReason,
        },
      };
    },
  },
});
