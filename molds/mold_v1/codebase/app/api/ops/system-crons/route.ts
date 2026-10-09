import { NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { systemCronOverrides } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pause / soft-delete state for the three code-authored crons. A cron with no
 * row here is active — the table only ever holds overrides, so an empty result
 * (or no database at all) means "all three are live", which is the same
 * fail-open default the schedules themselves apply.
 *
 * tenancy-ok: system_cron_overrides is a GLOBAL definitions table — it has no
 * org_id and carries no RLS, because a code-authored cron is one definition
 * shared by every workspace. Which workspace a FIRE belongs to is decided in
 * run-cron-workflows, on the automation_runs row, which is scoped.
 */
export async function GET() {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  try {
    const items = await db.select().from(systemCronOverrides);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
