/**
 * The web server's wiring for lib/chat-queue-drain.ts: the database under row-level security, eve over HTTP, and
 * the owner's sign-in (their own from a tab, or one this server signs). Everything with a decision in it lives in
 * the drain and in lib/chat-queue-server.ts; this file only connects them.
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { chatSessions } from "@/agent/lib/db/schema";
import { GOAL_OUTCOME_SCHEMA } from "@/app/_components/goal-mode";
import { emailSignInConfigured, mintQueueDeliveryToken } from "@/lib/auth-session";
import { drainSession, stoppedRequestIds, type DrainDeps, type DrainResult, type TailEvent } from "@/lib/chat-queue-drain";
import type { RunIn } from "@/lib/chat-queue-server";
import type { DeliveryScope } from "@/lib/queue-delivery-token";
import { withOrgRls } from "@/lib/ops-db";

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";
/** How many of the stream's last events decide "at rest" (see `sessionRest`). */
const TAIL_EVENTS = 12;

export const runInOrg: RunIn = (scope, fn) =>
  withOrgRls({ orgId: scope.orgId, principal: scope.principal ?? null }, fn as never) as never;

/**
 * The last `count` events of a session. A tail-relative read of a waiting session is a LIVE tail that does not end on
 * its own, so it is cut once the backlog has arrived: at `TAIL_EVENTS` lines, or 600 ms of quiet after the first,
 * or 5 s at worst.
 */
async function readTail(sessionId: string, bearer: string, count = TAIL_EVENTS): Promise<TailEvent[] | null> {
  if (!AGENT_URL) return null;
  const ctrl = new AbortController();
  const hard = setTimeout(() => ctrl.abort(), 5_000);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const out: TailEvent[] = [];
  try {
    const res = await fetch(
      `${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=-${count}`,
      { headers: { authorization: `Bearer ${bearer}` }, signal: ctrl.signal, cache: "no-store" },
    );
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l) as TailEvent);
        } catch {
          /* a malformed line is skipped */
        }
      }
      if (out.length >= count) break;
      if (out.length > 0) {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => ctrl.abort(), 600);
      }
    }
    return out;
  } catch {
    return out.length > 0 ? out : null;
  } finally {
    clearTimeout(hard);
    if (quiet) clearTimeout(quiet);
    ctrl.abort();
  }
}

async function post(sessionId: string, bearer: string, body: Record<string, unknown>): Promise<{ status: number; text?: string }> {
  if (!AGENT_URL) return { status: 0 };
  try {
    const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, text: text.slice(0, 500) };
  } catch {
    return { status: 0 };
  }
}

/** A queue-delivery token: two minutes, this session and one action only, not a sign-in (lib/auth-session.ts). */
async function mint(email: string, orgId: string, sessionId: string, scope: DeliveryScope): Promise<string | null> {
  if (!emailSignInConfigured()) return null;
  try {
    return await mintQueueDeliveryToken(email, { org: orgId, sessionId, scope });
  } catch {
    return null;
  }
}

async function stoppedRequests(orgId: string, email: string, sessionId: string): Promise<ReadonlySet<string>> {
  try {
    const rows = await withOrgRls({ orgId, principal: email }, (tx) =>
      tx
        .select({ markers: chatSessions.clientMarkers })
        .from(chatSessions)
        .where(and(eq(chatSessions.eveSessionId, sessionId), eq(chatSessions.ownerEmail, email.toLowerCase())))
        .limit(5),
    );
    return stoppedRequestIds(rows.flatMap((r) => (Array.isArray(r.markers) ? r.markers : [])));
  } catch {
    // Before migration 0020 there is no marker column: no Stop is known, so a parked chat simply waits.
    return new Set();
  }
}

export const drainDeps: DrainDeps = {
  runIn: runInOrg,
  readTail,
  post,
  mint,
  stoppedRequests,
  goalSchema: GOAL_OUTCOME_SCHEMA as unknown as object,
};

/** Can this server send a queued message with no tab open? (It signs the owner's sign-in to do it.) */
export function backgroundDeliveryAvailable(): boolean {
  return Boolean(AGENT_URL) && emailSignInConfigured();
}

export function drain(input: Parameters<typeof drainSession>[1]): Promise<DrainResult> {
  return drainSession(drainDeps, input);
}
