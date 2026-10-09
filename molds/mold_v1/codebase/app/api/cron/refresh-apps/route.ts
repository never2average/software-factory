import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secret-compare";
import { and, eq, isNull } from "drizzle-orm";
import { apps } from "@/agent/lib/db/schema";
import { cronMatches } from "@/agent/lib/cron-match";
import { collectAppRefreshes, driveAppRefresh, refreshBackgroundMs, startAppRefresh } from "@/lib/app-refresh";
import { acrossOrgsRls, getOpsDb, withOrgRls } from "@/lib/ops-db";
import { serviceBearerFor } from "@/lib/service-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Every minute, two jobs, in this order:
 *
 *  1. COLLECT. Every app with a refresh in progress, in every workspace: a refresh started by a person, the agent or
 *     an earlier tick is finished here when the function that started it was killed (Vercel's 300 s, a crash, a
 *     deploy) — its session is read from the first event (durable on the agent), its workflow run's row is read
 *     (the resume-workflows cron re-drives the script) — and a marker its work outlived is ended as a failure with
 *     a sentence (lib/app-refresh.ts `refreshVerdict`). Never "refreshing" for ever.
 *  2. START what is due. Every live app whose cadence matches this minute and that is not already refreshing, one
 *     per tick, followed inline for what is left of this invocation; the next ticks collect the rest.
 *
 * AUTH mirrors run-cron-workflows: the front-end's own Vercel OIDC service token (the agent trusts this project's
 * subject) — or, off Vercel with SERVICE_AUTH=session-key, the service token it signs itself
 * (lib/service-identity.ts); CRON_SECRET guards the endpoint. A start CLAIMS the app atomically (refreshing_at), so
 * two ticks — or a tick and a person's Try again — never run the same app twice.
 */
const PER_TICK = 1;
/** How long one tick reads each refreshing app's session before moving on (in parallel). */
const COLLECT_FOLLOW_MS = 20_000;
/** What this invocation may spend following the refresh it started (under the 300 s limit, after collecting). */
const DRIVE_CAP_MS = 240_000;

export async function GET(request: NextRequest) {
  const begun = Date.now();
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
  const bearer = serviceBearerFor(request);

  // 1. Whatever is in progress, wherever it was started.
  const collected = await collectAppRefreshes({ bearer, followMs: COLLECT_FOLLOW_MS });

  // 2. What is due now.
  const now = new Date();
  /**
   * Live, cadenced apps not currently being refreshed — swept per workspace.
   *
   * Cross-workspace by design: one tick refreshes whichever app is due next,
   * whoever owns it. A single unscoped scan returns nothing once the policy
   * fails closed, and a refresh cron that finds nothing looks exactly like one
   * with nothing due.
   */
  const candidates = await acrossOrgsRls((tx, orgId) =>
    tx
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, orgId), eq(apps.enabled, true), isNull(apps.deletedAt), isNull(apps.refreshingAt))),
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

    if (!bearer) {
      await withOrgRls(app.orgId, (tx) =>
        tx
          .update(apps)
          .set({ lastError: "No service token available to reach the agent." })
          .where(and(eq(apps.id, app.id), eq(apps.orgId, app.orgId), isNull(apps.refreshingAt))),
      );
      outcomes.push({ app: app.slug, status: "no-service-token" });
      ran++;
      continue;
    }

    const started = await startAppRefresh(app, { bearer, actor: "cron" });
    if (started.status === "running") continue; // claimed by somebody else a moment ago
    ran++;
    if (started.status === "failed") {
      outcomes.push({ app: app.slug, status: "failed" });
      continue;
    }
    const budgetMs = Math.max(1_000, Math.min(refreshBackgroundMs(), DRIVE_CAP_MS, 270_000 - (Date.now() - begun)));
    const driven = await driveAppRefresh(started.handle, { bearer, budgetMs });
    outcomes.push({ app: app.slug, status: driven });
  }

  return NextResponse.json({
    scanned: candidates.length,
    ran,
    outcomes,
    collected: collected.map((c) => ({ app: c.app, status: c.status })),
  });
}
