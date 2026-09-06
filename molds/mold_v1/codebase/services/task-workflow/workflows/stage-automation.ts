import { applyStageAssignment, type StageAutomationInput } from "@/lib/engine";

export async function stageAutomationWorkflow(input: StageAutomationInput) {
  "use workflow";

  console.log("Starting task stage automation", { taskId: input.taskId, transitionEventId: input.transitionEventId });
  const result = await applyStageAssignmentStep(input);
  console.log("Task stage automation completed", { taskId: input.taskId, status: result.status });
  return result;
}

async function applyStageAssignmentStep(input: StageAutomationInput) {
  "use step";

  console.log("Resolving task stage assignment", { taskId: input.taskId });
  return applyStageAssignment(input);
}
