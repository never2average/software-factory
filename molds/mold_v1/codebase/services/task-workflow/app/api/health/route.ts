import { checkDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await checkDb();
    return Response.json({ ok: true, service: "task-workflow", checkedAt: new Date().toISOString(), db });
  } catch (error) {
    console.error("Task workflow health check failed", error);
    return Response.json({ ok: false, service: "task-workflow", checkedAt: new Date().toISOString() }, { status: 503 });
  }
}
