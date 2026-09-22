import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/chat-telemetry — record something that went wrong in a chat.
 *
 * The chat component is 2,600 lines with no logging and fourteen empty catch
 * blocks. A live run was severed six times in twelve minutes and left no trace
 * anywhere: no log, no metric, no error on screen. Every chat incident so far
 * has been diagnosed by someone noticing and someone else going digging, which
 * does not scale past one customer and did not scale past one afternoon.
 *
 * Writes to `automation_audit` rather than a new table on purpose: it already
 * carries (type, id, actor, sentence, time) with a tenant column and an index,
 * a new table means a migration, and a signal you have today beats a schema you
 * have next week. `automation_type = 'chat'`, `automation_id` = the session.
 *
 * Fire-and-forget by contract: it always answers 202, even on failure. Chat must
 * never get worse because its telemetry is unhappy.
 *
 * tenancy-ok: the only database write here is recordOpsAudit(), which now
 * opens its own workspace-scoped transaction (lib/ops-audit.ts).
 */

const schema = z.object({
  sessionId: z.string().max(200).optional(),
  kind: z.enum(["stream-error", "stream-gave-up", "save-failed", "resume", "gate-denied", "render-loop"]),
  detail: z.string().max(400).optional(),
  elapsedMs: z.number().int().nonnegative().max(86_400_000).optional(),
  attempt: z.number().int().nonnegative().max(10_000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const ctx = await orgContextForRequest(request);
    if (!ctx) return NextResponse.json({ ok: true }, { status: 202 });
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: true }, { status: 202 });
    const db = getOpsDb();
    if (!db) return NextResponse.json({ ok: true }, { status: 202 });

    const { sessionId, kind, detail, elapsedMs, attempt } = parsed.data;
    // A sentence, because that is what this table holds and what a human reads
    // at 2am. The numbers stay in it rather than in columns that do not exist.
    const parts = [
      kind === "stream-error"
        ? "Chat stream errored"
        : kind === "stream-gave-up"
          ? "Chat stream ended mid-turn and stopped resuming"
          : kind === "save-failed"
            ? "Chat list failed to save"
            : kind === "gate-denied"
              ? "Session access denied"
              // A React render loop that reached the eve store. Its own sentence, because
              // falling through to "resumed" would file the one error nobody can see from
              // the outside under the one word that means everything is fine.
              : kind === "render-loop"
                ? "Chat render loop (turn kept running)"
                : "Chat stream resumed",
    ];
    if (typeof attempt === "number") parts.push(`attempt ${attempt}`);
    if (typeof elapsedMs === "number") parts.push(`after ${Math.round(elapsedMs / 1000)}s`);
    if (detail) parts.push(`— ${detail}`);

    await recordOpsAudit(db, {
      automationType: "chat",
      automationId: sessionId ?? "unknown",
      actor: ctx.orgId ? "web" : "web",
      event: parts.join(" · "),
      orgId: ctx.orgId,
    });
  } catch {
    // Deliberately silent: see the contract above.
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
