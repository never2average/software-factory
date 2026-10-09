import { start } from "workflow/api";
import { markAutomationFailed, type StageAutomationInput } from "@/lib/engine";
import { stageAutomationWorkflow } from "@/workflows/stage-automation";

export async function enqueueStageAutomation(input: StageAutomationInput | null): Promise<string | null> {
  if (!input) return null;
  try {
    const run = await start(stageAutomationWorkflow, [input], { deploymentId: "latest" });
    return run.runId;
  } catch (error) {
    await markAutomationFailed(input, error).catch((markError) => {
      console.error("Could not mark task automation as failed", markError);
    });
    throw error;
  }
}
