import { after, NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { drain } from "@/lib/chat-queue-runtime";
import { createNudgeGate } from "@/lib/nudge-gate";
import { NUDGE_HEADER } from "@/lib/secret-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/chat-queue/nudge { sessionId, orgId } — the agent's hook (agent/hooks/chat-queue.ts) says a session it
 * holds queued messages for just reached `session.waiting`. This is how a queued message is sent after its tab has
 * closed: nothing in the browser is left to send it.
 *
 * ONLY THE AGENT MAY NUDGE: the request is signed with CRON_SECRET (HMAC over workspace, session and time, one
 * minute's validity, compared in constant time — lib/secret-compare.ts), and each session is rate-limited
 * (lib/nudge-gate.ts), so nobody can make this route run transactions, sign tokens or hold eve's stream at will.
 * Even a valid nudge carries no authority beyond "look now": the drain decides everything from the session's own
 * stream and its owner's rows, and sends at most the ONE next item that owner queued, as them, exactly once
 * (lib/chat-queue-drain.ts). Outside /api/ops because the ops gate would ask the agent for a person it does not
 * have.
 *
 * It answers at once and drains AFTER the response (`after`): the hook that nudges runs inside the very session
 * the drain is about to send into, and must never wait on that delivery.
 *
 * A burst for one session is folded into one drain (per instance).
 *
 * tenancy-ok: the drain reads and writes only through `runInOrg` (withOrgRls) in the named workspace. The only bare
 * handle is the `getOpsDb()` null check, which opens no connection.
 */
const inFlight = new Map<string, { again: boolean }>();
const gate = createNudgeGate();

/** One drain per session at a time; a nudge that lands meanwhile runs one more drain after it (a new rest). */
async function drainLoop(orgId: string, sessionId: string, key: string): Promise<void> {
  const slot = inFlight.get(key);
  try {
    do {
      if (slot) slot.again = false;
      await drain({ orgId, sessionId, by: "server" }).catch((e) =>
        console.error(`[chat-queue] drain of ${sessionId} failed:`, e instanceof Error ? e.message : e),
      );
    } while (slot?.again);
  } finally {
    inFlight.delete(key);
  }
}

export async function POST(request: NextRequest) {
  if (!getOpsDb()) return NextResponse.json({ ok: false }, { status: 503 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { sessionId?: unknown; orgId?: unknown };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 200) : "";
  const orgId = typeof body.orgId === "string" ? body.orgId.slice(0, 200) : "";
  if (!sessionId || !orgId) return NextResponse.json({ ok: false }, { status: 400 });
  const verdict = gate.check({ signature: request.headers.get(NUDGE_HEADER), secret: process.env.CRON_SECRET, orgId, sessionId });
  if (verdict === "unsigned") return NextResponse.json({ ok: false }, { status: 401 });
  if (verdict === "rate-limited") return NextResponse.json({ ok: false }, { status: 429 });
  const key = `${orgId}:${sessionId}`;
  const running = inFlight.get(key);
  if (running) {
    running.again = true;
  } else {
    inFlight.set(key, { again: false });
    const p = drainLoop(orgId, sessionId, key);
    after(() => p);
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
