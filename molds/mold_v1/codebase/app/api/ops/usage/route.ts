import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { getOpsDb } from "@/lib/ops-db";
import { readUsage, zero } from "@/lib/usage-report";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function daysParam(url: URL): number {
  const raw = Number(url.searchParams.get("days") ?? DEFAULT_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_DAYS;
  return Math.min(Math.floor(raw), MAX_DAYS);
}

/**
 * GET /api/ops/usage?days=30 — what the workspace's ordinary chat turns, and its dictation, cost.
 *
 * Read-only. Sums `chat_turn_usage` for the caller's workspace over the last
 * `days` (default 30, max 365): turn and step counts, the four token counters,
 * and an estimated cost priced at request time from `lib/inference-pricing.ts`
 * (tokens are stored, prices are not). Also a per-day series and a per-model
 * breakdown, so an unpriced model shows up by name rather than as a hole in
 * the total. Dictation (the composer's microphone, lib/dictation.ts) is in the
 * same table as rows of kind "dictation": counted as `dictations` and
 * `audio_seconds`, never as turns, and priced per audio minute. Workflow
 * (subagent) usage lives in `automation_runs` and is not included here.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const url = new URL(request.url);
  const days = daysParam(url);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ days, since: since.toISOString(), totals: zero(), by_model: [], by_day: [] });
  }
  try {
    const report = await readUsage(ctx.orgId, since);
    return NextResponse.json({ days, since: since.toISOString(), ...report });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
