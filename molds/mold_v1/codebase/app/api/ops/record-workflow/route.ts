import type { NextRequest } from "next/server";
import { getRecordWorkflow } from "@/lib/record-workflow-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/ops/record-workflow: a record's workflow, or the cards' line for several (lib/record-workflow-routes.ts). */
export async function GET(request: NextRequest) {
  return getRecordWorkflow(request);
}
