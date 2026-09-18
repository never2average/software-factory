import { NextRequest, NextResponse } from "next/server";
import { orgContextForRequest } from "@/lib/org-context";
import { ingestEmail } from "@/lib/inbox-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// IMAP round-trips per message body; the default would cut a large mailbox off
// mid-sync. Idempotency makes a re-run safe, but a truncated run is still a
// worse first impression than a slow one.
export const maxDuration = 300;

/**
 * POST /api/ops/inbox/sync — pull recent mail into the Inbox for this workspace.
 *
 * Manual trigger for the button in the panel; the cron calls the same code
 * path so scheduled and on-demand syncs cannot behave differently.
 *
 * Always 200 with a result body, even when IMAP is unconfigured or a message
 * fails: a partial sync is the normal case, and the caller needs the counts to
 * say what happened. Only an auth failure is a non-200.
 */
export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { sinceDays?: number; max?: number } | null;
  const sinceDays = Math.min(Math.max(body?.sinceDays ?? 7, 1), 90);
  const max = Math.min(Math.max(body?.max ?? 100, 1), 500);

  const result = await ingestEmail(ctx.orgId, sinceDays, max);
  return NextResponse.json(result);
}
