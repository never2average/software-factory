import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { apps } from "@/agent/lib/db/schema";
import { cronMatches } from "@/agent/lib/cron-match";
import { refreshApp } from "@/lib/app-refresh";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "@/lib/ops-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Regenerates every APP whose refresh cadence is due this minute.
 *
 * AUTH mirrors run-cron-workflows: the front-end's own Vercel OIDC service
 * token (the agent trusts this project's subject); CRON_SECRET guards the
 * endpoint. Each app is CLAIMED atomically (refreshing_at) so two ticks — or a
 * tick overlapping a long refresh — never regenerate the same document twice.
 */
// One app per tick: a dashboard refresh can run up to ~250s, so two in a single
// invocation could exceed the 300s function limit. One a minute is ample.
const PER_TICK = 1;
// A claim older than this is treated as abandoned (the function died mid-run).
const CLAIM_STALE_MS = 10 * 60 * 1000;

function serviceBearer(request: NextRequest): string | null {
  return request.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN ?? null;
}

export async function GET(request: NextRequest) {
  // FAIL CLOSED. This was `if (secret && …)`, which skips the check entirely
  // when CRON_SECRET is unset — and it is set on Production ONLY, so every
  // preview deployment exposed this endpoint unauthenticated. A missing
  // secret is a misconfiguration, not an open door (same shape as
  // /api/ops/run, which already got this right).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured, so this cron is disabled." },
      { status: 503 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const bearer = serviceBearer(request);

  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);

  /**
   * Live, cadenced apps not currently being refreshed — swept per workspace.
   *
   * Cross-workspace by design: one tick refreshes whichever app is due next,
   * whoever owns it. A single unscoped scan returns nothing once the policy
   * fails closed, and a refresh cron that finds nothing looks exactly like one
   * with nothing due.
   */
  const candidates = await acrossOrgsRls((tx) =>
    tx
      .select()
      .from(apps)
      .where(
        and(
          eq(apps.enabled, true),
          isNull(apps.deletedAt),
          or(isNull(apps.refreshingAt), lt(apps.refreshingAt, staleBefore)),
        ),
      ),
  );

  const outcomes: Array<{ app: string; status: string }> = [];
  let ran = 0;
  for (const app of candidates) {
    if (ran >= PER_TICK) break;
    const expr = app.refreshCron?.trim();
    if (!expr) continue;
    // Due this minute? An unparseable expression never fires (and is refused at
    // write time anyway) — skip rather than throw the whole tick.
    try {
      if (!cronMatches(expr, now)) continue;
    } catch {
      continue;
    }
    // Already refreshed within this same minute — don't fire twice.
    if (app.lastRefreshAt && now.getTime() - app.lastRefreshAt.getTime() < 60_000) continue;

    // Claim it atomically: only the tick that flips refreshing_at proceeds.
    /**
     * The claim is short and scoped; the REFRESH below is not wrapped at all.
     *
     * refreshApp can run ~250s, and withOrgRls holds a transaction — wrapping
     * it would pin a pooled connection for the duration. Short statements get
     * their own scope, the long agent call stays outside any transaction, and
     * refreshApp scopes its own writes.
     */
    const claimed = await withOrgRls(app.orgId, (tx) =>
      tx
        .update(apps)
        .set({ refreshingAt: now })
        .where(
          and(
            eq(apps.id, app.id),
            or(isNull(apps.refreshingAt), lt(apps.refreshingAt, staleBefore)),
          ),
        )
        .returning({ id: apps.id }),
    );
    if (claimed.length === 0) continue;

    if (!bearer) {
      await withOrgRls(app.orgId, (tx) =>
        tx
          .update(apps)
          .set({ refreshingAt: null, lastError: "No service token available to reach the agent." })
          .where(eq(apps.id, app.id)),
      );
      outcomes.push({ app: app.slug, status: "no-service-token" });
      ran++;
      continue;
    }

    const outcome = await refreshApp(db, app, bearer);
    outcomes.push({ app: app.slug, status: outcome.ok ? "refreshed" : "failed" });
    ran++;
  }

  return NextResponse.json({ scanned: candidates.length, ran, outcomes });
}
