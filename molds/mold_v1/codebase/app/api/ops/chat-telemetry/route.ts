import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { CHAT_TELEMETRY_KINDS, chatSessionTag, chatTelemetrySentence } from "@/lib/chat-telemetry";

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
 * The rule itself — a truncated SHA-256, and why a raw session id must never
 * reach this table — now lives in `lib/chat-telemetry.ts` beside the kinds,
 * because the agent runtime writes rows of the same shape from the other side
 * of the deployment boundary (agent/lib/empty-model-response-log.ts) and two
 * copies of a hash is exactly how "this conversation has severed six times in
 * twelve minutes" stops being visible.
 */
function sessionTag(sessionId: string): string {
  return chatSessionTag(sessionId, (value) => createHash("sha256").update(value).digest("hex"));
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await orgContextForRequest(request);
    if (!ctx) return NextResponse.json({ ok: true }, { status: 202 });
    if (ctx instanceof Response) return ctx;
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
