import type { NextRequest } from "next/server";
import { changeRecordWorkflowStep } from "@/lib/record-workflow-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/ops/record-workflow/due: a step's one-time due-date extension (lib/record-workflow-routes.ts). */
export async function POST(request: NextRequest) {
  return changeRecordWorkflowStep(request, "due_on");
}
