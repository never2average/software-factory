import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { CHAT_TELEMETRY_KINDS, chatTelemetrySentence } from "@/lib/chat-telemetry";

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
 * have next week. `automation_type = 'chat'`, `automation_id` = a HASH of the
 * session — see below for why the raw id stopped going in.
 *
 * Fire-and-forget by contract: it always answers 202, even on failure. Chat must
 * never get worse because its telemetry is unhappy.
 *
 * tenancy-ok: the only database write here is recordOpsAudit(), which now
 * opens its own workspace-scoped transaction (lib/ops-audit.ts).
 */

/**
 * The enum is DERIVED from lib/chat-telemetry's kind→sentence map, never listed
 * again here.
 *
 * Because this route answers 202 on a parse failure, a kind that is emitted but
 * missing from the enum is accepted, dropped, and indistinguishable from a kind
 * that never fired. That already happened twice: `resync` and `stop` have been
 * emitted by app/_components/agent-chat.tsx since they shipped and have never
 * once reached `automation_audit`. Deriving the enum from the sentences makes a
 * kind the route cannot describe a kind it cannot accept — and a kind it can
 * describe is accepted without anyone remembering to come here.
 */
const schema = z.object({
  sessionId: z.string().max(200).optional(),
  kind: z.enum(CHAT_TELEMETRY_KINDS),
  detail: z.string().max(400).optional(),
  elapsedMs: z.number().int().nonnegative().max(86_400_000).optional(),
  attempt: z.number().int().nonnegative().max(10_000).optional(),
});

/**
 * The session id, as something you can CORRELATE but not USE.
 *
 * `automation_id` was the raw eve session id, and `GET /api/ops/orgs/:id/audit`
 * returns the last 100 rows of this table to anyone in the workspace. So the
 * telemetry written when a chat went wrong published the ids of the chats it
 * went wrong in — which is the one secret every other hole in this area needs.
 * A session id is a capability in this system's shape: it is what the eve gate
 * decides on, what the transcript cache is keyed by, and what the mirror row
 * used to let a colleague claim.
 *
 * A truncated SHA-256 keeps the only property the feed actually uses — two
 * lines about the same chat carry the same id, so "this conversation has
 * severed six times in twelve minutes" is still visible at 2am — while the
 * value in the row opens nothing. 16 hex characters is 64 bits: far beyond
 * collision range for a chat feed, and short enough to read.
 *
 * NOT reversible by a reader, and not meant to be private FROM us: the same
 * hash of the same id computed here is how an operator matches a row back to a
 * session they already legitimately hold.
 */
function sessionTag(sessionId: string): string {
  return `chat_${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

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
    const parts = [chatTelemetrySentence(kind)];
    if (typeof attempt === "number") parts.push(`attempt ${attempt}`);
    if (typeof elapsedMs === "number") parts.push(`after ${Math.round(elapsedMs / 1000)}s`);
    if (detail) parts.push(`— ${detail}`);

    await recordOpsAudit(db, {
      automationType: "chat",
      automationId: sessionId ? sessionTag(sessionId) : "unknown",
      actor: ctx.orgId ? "web" : "web",
      event: parts.join(" · "),
      orgId: ctx.orgId,
    });
  } catch {
    // Deliberately silent: see the contract above.
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
