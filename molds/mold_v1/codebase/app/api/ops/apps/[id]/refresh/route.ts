import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apps } from "@/agent/lib/db/schema";
import { driveAppRefresh, refreshBackgroundMs, startAppRefresh } from "@/lib/app-refresh";
import { inBackground } from "@/lib/background";
import { generateFirstDocument } from "@/lib/starter-apps";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { serviceBearerFor } from "@/lib/service-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The refresh is NOT done inside this request: the request only starts it. This is how long the function may keep
// following it after answering (lib/background.ts); the refresh-apps cron collects whatever is left.
export const maxDuration = 300;

/**
 * POST /api/ops/apps/:id/refresh — regenerate this app's document.
 *
 * Answers 202 at once, with the session or workflow run the refresh opened (`sessionId` / `runId`, also on the app as
 * `lastSessionId` / `lastRunId`) and when it started; the document is written when the work ends, however long that
 * takes (lib/app-refresh.ts). A refresh already in progress is JOINED (202, `joined: true`, its ids): a second Try
 * again never starts a second run. A source that cannot run is refused (409) with the sentence the app now carries.
 *
 * `?first=1` — write the FIRST document of an app that has none, and only if nobody has: what the Apps tab asks when
 * a person opens a starter app that was created without content (lib/starter-apps.ts). It starts at most one
 * generation however many people, tabs or reloads ask (202, as above); the rest get 200 with `started: false` and
 * the row as it is.
 *
 * The caller must be a signed-in member of the app's workspace. The work itself runs as the platform's service
 * identity scoped to that workspace, like the scheduled refresh: the document is the workspace's, and it is written
 * after the person's own sign-in may have lapsed. Where the platform has no service identity, the person's own token
 * starts it, as before.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const begun = Date.now();
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid app id" }, { status: 400 });

  const own = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  const bearer = serviceBearerFor(request) ?? own;
  if (!bearer) {
    return NextResponse.json(
      { error: "Sign in again — refreshing an app needs credentials to reach the agent." },
      { status: 401 },
    );
  }

  const read = () =>
    withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(apps).where(and(eq(apps.id, id), eq(apps.orgId, ctx.orgId))).limit(1),
    );
  const [app] = await read();
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  const actor = request.headers.get("x-ops-actor") ?? "web";
  const budgetMs = () => Math.max(1_000, refreshBackgroundMs() - (Date.now() - begun));
  const outcome = request.nextUrl.searchParams.get("first") === "1"
    ? await generateFirstDocument(db, ctx.orgId, id, bearer, actor, budgetMs)
    : await startAppRefresh(app, { bearer, actor }).then((started) => {
        if (started.status === "started") {
          const handle = started.handle;
          inBackground(() => driveAppRefresh(handle, { bearer, budgetMs: budgetMs() }), `refresh of app ${app.id}`);
        }
        return started;
      });
  const [item] = await read();
  if (outcome.status === "skipped") return NextResponse.json({ item, started: false, ok: true, why: outcome.why });
  if (outcome.status === "failed") {
    // A source that cannot run is the request's problem, said in a sentence the person can act on (409); a start
    // that was attempted and failed is ours (500). Either way the app row now carries the error.
    return NextResponse.json(
      { item, started: true, ok: false, error: outcome.error, ...(outcome.cause ? { cause: outcome.cause } : {}) },
      { status: outcome.cause === "source" ? 409 : 500 },
    );
  }
  return NextResponse.json(
    {
      item,
      ok: true,
      started: outcome.status === "started",
      joined: outcome.status === "running",
      startedAt: outcome.startedAt,
      sessionId: outcome.sessionId,
      runId: outcome.runId,
    },
    { status: 202 },
  );
}
