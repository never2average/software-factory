import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { acrossOrgsRls, getOpsDb } from "@/lib/ops-db";
import { drain, runInOrg } from "@/lib/chat-queue-runtime";
import { purgeOld, sessionsWithQueued, staleClaims } from "@/lib/chat-queue-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The SAFETY NET under queued chat messages (lib/chat-queue-drain.ts). The agent's hook nudges the moment a session
 * comes to rest; this catches what that missed — a hook that could not reach this server, a nudge lost to a cold
 * start, a claim whose sender died mid-delivery — once a minute. Every drain decides from the session's own stream,
 * so running it on a session that is not due does nothing.
 *
 * Guarded by CRON_SECRET, and fail-closed without it, like every cron here.
 *
 * tenancy-ok: cross-workspace by design, through `acrossOrgsRls` (one scoped pass per workspace); every read and
 * write inside it is scoped to that workspace.
 */
const PER_TICK = 20;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured, so this cron is disabled." }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!getOpsDb()) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const work = await acrossOrgsRls(async (_tx, orgId) => {
    const stale = (await staleClaims(runInOrg, { orgId })).map((r) => r.eveSessionId);
    const waiting = await sessionsWithQueued(runInOrg, { orgId, olderThanMs: 30_000, limit: PER_TICK });
    await purgeOld(runInOrg, { orgId }).catch(() => undefined);
    return [...new Set([...stale, ...waiting])].map((sessionId) => ({ orgId, sessionId }));
  });
  const outcomes: Array<{ sessionId: string; reason: string }> = [];
  for (const w of work.slice(0, PER_TICK)) {
    try {
      const r = await drain({ orgId: w.orgId, sessionId: w.sessionId, by: "server" });
      outcomes.push({ sessionId: w.sessionId, reason: r.reason });
    } catch (e) {
      outcomes.push({ sessionId: w.sessionId, reason: `error: ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}` });
    }
  }
  return NextResponse.json({ checked: outcomes.length, outcomes });
}
