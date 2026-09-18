import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { subagentRuns } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Persisted codenames for subagent runs (see lib/subagent-names.ts). The Control
 * Panel derives a stable name per run and upserts it here so the label is
 * authoritative and consistent across reloads and clients.
 *
 * GET  /api/ops/subagent-runs?keys=a,b,c  → { labels: { [runKey]: label } }
 * POST /api/ops/subagent-runs { runKey, sessionId?, subagentType?, label }
 *      → { label }  (FIRST assignment wins — re-posts return the stored label)
 */
export async function GET(request: NextRequest) {
  // Labels are tenant data — this read was scoped by run key alone, and keys
  // are guessable enough that "someone else's run names" was one request away.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ labels: {} });
  const raw = request.nextUrl.searchParams.get("keys") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (keys.length === 0) return NextResponse.json({ labels: {} });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ runKey: subagentRuns.runKey, label: subagentRuns.label })
        .from(subagentRuns)
        .where(and(eq(subagentRuns.orgId, ctx.orgId), inArray(subagentRuns.runKey, keys))),
    );
    const labels: Record<string, string> = {};
    for (const r of rows) labels[r.runKey] = r.label;
    return NextResponse.json({ labels });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

const postSchema = z.strictObject({
  runKey: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  subagentType: z.string().nullable().optional(),
  label: z.string().min(1),
});

export async function POST(request: NextRequest) {
  // This route resolved no workspace at all — it wrote tenant rows owned by
  // whatever the column defaulted to. The label belongs to the workspace whose
  // run it names.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "runKey and label are required" }, { status: 400 });
  }
  const { runKey, sessionId, subagentType, label } = parsed.data;
  try {
    // First assignment wins: a conflicting insert is ignored, and we return the
    // already-stored label so a run's name is stable once minted.
    await withOrgRls(ctx.orgId, (tx) =>
      tx
      .insert(subagentRuns)
      .values({ orgId: ctx.orgId, runKey, sessionId: sessionId ?? null, subagentType: subagentType ?? null, label })
      .onConflictDoNothing({ target: subagentRuns.runKey }),
    );
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ label: subagentRuns.label })
        .from(subagentRuns)
        .where(inArray(subagentRuns.runKey, [runKey])),
    );
    return NextResponse.json({ label: row?.label ?? label });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
