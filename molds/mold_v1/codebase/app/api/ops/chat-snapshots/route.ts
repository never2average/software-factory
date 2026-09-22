import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { chatTranscriptSnapshots } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isEmptyStore } from "@/lib/pg-error";
import { accessForSession } from "@/lib/chat-session-access";
import { SNAPSHOT_VERSION, type TranscriptSnapshot } from "@/lib/chat-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The transcript cache behind "reopening an old chat is very very slow".
 *
 *   GET    /api/ops/chat-snapshots?session=<eve session id>  — the cached transcript
 *   POST   /api/ops/chat-snapshots                           — store/replace one
 *   DELETE /api/ops/chat-snapshots?session=<eve session id>  — forget one
 *
 * Opening a thread used to re-read the session's ENTIRE event stream and
 * re-reduce it in the browser, so the cost grew with everything that had ever
 * happened in the conversation. A row here is the prefix that has already been
 * shown plus the absolute stream index it covers; the client mounts it at once
 * and replays only the tail (see app/_components/chat-shell.tsx and
 * lib/chat-snapshot.ts, which owns every rule about when a row may be trusted).
 *
 * WHO MAY READ ONE is thread membership, not the key. A transcript is the most
 * complete copy of a conversation this system stores, so the check here is the
 * same one the shared-thread stream proxy makes: the owner, or a non-revoked
 * member, and nobody else. `snapshotAccess` holds that decision as a pure
 * function so this route and its tests cannot drift apart.
 *
 * tenancy-ok: every read and write below runs inside `withOrgRls(ctx.orgId, …)`,
 * so a row belonging to another workspace is not merely filtered out, it is
 * invisible to the query. The only unscoped handle is the `getOpsDb()` null
 * check, which opens no connection.
 */

/**
 * A ceiling on one cached transcript.
 *
 * A cache that can be arbitrarily large stops being a cache: the fetch that was
 * meant to replace a slow replay becomes a slow fetch, and the row competes for
 * the same bandwidth as the stream it is standing in for. Past this the row is
 * refused and the thread simply keeps the old full-replay open — slow, but
 * exactly as slow as it is today, which is the correct failure direction for a
 * cache. Sized against the measured shape: a 37-message, two-day thread compacts
 * to well under a megabyte.
 */
const MAX_SNAPSHOT_BYTES = 4_000_000;

async function callerEmail(request: NextRequest): Promise<string | null> {
  return (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? null;
}

export async function GET(request: NextRequest) {
  const email = (await callerEmail(request))?.toLowerCase();
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const db = getOpsDb();
  // No database configured is the JSON-fallback deployment: there is genuinely
  // no cache, and the caller falls back to a full replay.
  if (!db) return NextResponse.json({ snapshot: null });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "workspace unavailable" }, { status: 503 });
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return NextResponse.json({ error: "session required" }, { status: 400 });

  try {
    const access = await accessForSession(ctx.orgId, email, sessionId);
    if (!access.read) {
      return NextResponse.json({ error: "You don't have access to this thread." }, { status: 403 });
    }
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(chatTranscriptSnapshots)
        .where(
          and(
            eq(chatTranscriptSnapshots.orgId, ctx.orgId),
            eq(chatTranscriptSnapshots.eveSessionId, sessionId),
          ),
        )
        .limit(1),
    );
    // A miss is a legitimate answer with a legitimate consequence (full replay),
    // so it is `null` rather than a 404 the client would have to interpret.
    if (!row) return NextResponse.json({ snapshot: null });
    const snapshot: TranscriptSnapshot = {
      version: row.version,
      eveSessionId: row.eveSessionId,
      eventIndex: row.eventIndex,
      events: row.events ?? [],
      clientEvents: row.clientEvents ?? [],
      updatedAt: row.updatedAt?.getTime(),
    };
    return NextResponse.json({ snapshot });
  } catch (e) {
    // A table that does not exist yet means no cache; anything else means there
    // is a cache we could not read. Both fall back to the full replay, and the
    // client treats a 503 as "no snapshot" — but they must not be the same
    // ANSWER, because only one of them is a fault worth seeing.
    if (isEmptyStore(e)) return NextResponse.json({ snapshot: null });
    console.error("chat-snapshots GET failed", e);
    return NextResponse.json({ error: "snapshot store unavailable" }, { status: 503 });
  }
}

const bodySchema = z.object({
  eveSessionId: z.string().min(1),
  chatSessionId: z.string().min(1).optional().nullable(),
  version: z.number().int(),
  eventIndex: z.number().int().min(1),
  events: z.array(z.unknown()).min(1),
  clientEvents: z.array(z.unknown()).optional().nullable(),
});

export async function POST(request: NextRequest) {
  const email = (await callerEmail(request))?.toLowerCase();
  if (!email) return NextResponse.json({ ok: false }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ ok: false, reason: "no-store" });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ ok: false }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid" }, { status: 400 });
  const d = parsed.data;
  /**
   * A snapshot written by a build that projects events differently is not a
   * cache, it is a transcript rendered by rules that no longer exist. Refusing
   * the WRITE as well as the read keeps a mid-deploy browser from filling the
   * table with rows every reader will then discard.
   */
  if (d.version !== SNAPSHOT_VERSION) {
    return NextResponse.json({ ok: false, reason: "version" }, { status: 409 });
  }
  // `events.length > eventIndex` is impossible: compaction only ever removes
  // events, so a transcript can be shorter than the stream it covers, never
  // longer. A payload like that did not come from this system's writer.
  if (d.events.length > d.eventIndex) {
    return NextResponse.json({ ok: false, reason: "index" }, { status: 400 });
  }
  const bytes = Buffer.byteLength(JSON.stringify({ events: d.events, clientEvents: d.clientEvents ?? [] }));
  if (bytes > MAX_SNAPSHOT_BYTES) {
    return NextResponse.json({ ok: false, reason: "too-large", bytes }, { status: 413 });
  }

  try {
    const access = await accessForSession(ctx.orgId, email, d.eveSessionId);
    if (!access.write) {
      return NextResponse.json({ error: "You don't have access to this thread." }, { status: 403 });
    }
    const values = {
      orgId: ctx.orgId,
      eveSessionId: d.eveSessionId,
      ownerEmail: email,
      chatSessionId: d.chatSessionId ?? null,
      version: d.version,
      eventIndex: d.eventIndex,
      events: d.events,
      clientEvents: d.clientEvents ?? [],
      bytes,
      updatedAt: new Date(),
    };
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(chatTranscriptSnapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [chatTranscriptSnapshots.orgId, chatTranscriptSnapshots.eveSessionId],
          /**
           * NEVER move a transcript backwards.
           *
           * Two tabs on the same thread race: one has replayed the whole stream,
           * the other mounted a truncated read that hit its own deadline. Last
           * write wins would let the short one overwrite the long one, and the
           * next open would mount the truncation — the same "transcript stops in
           * the middle of a turn" failure the segmented replay exists to
           * prevent, made durable. The row only ever grows.
           */
          setWhere: sql`${chatTranscriptSnapshots.eventIndex} <= excluded.event_index`,
          set: values,
        }),
    );
    return NextResponse.json({ ok: true, bytes });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ ok: false, reason: "no-table" });
    console.error("chat-snapshots POST failed", e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const email = (await callerEmail(request))?.toLowerCase();
  if (!email) return NextResponse.json({ ok: false }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ ok: false });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ ok: false }, { status: 401 });
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return NextResponse.json({ ok: false, error: "session required" }, { status: 400 });
  try {
    const access = await accessForSession(ctx.orgId, email, sessionId);
    if (!access.write) {
      return NextResponse.json({ error: "You don't have access to this thread." }, { status: 403 });
    }
    // Deleting a chat has to delete the copy of it we made to open it faster.
    // A cache that outlives the thing it caches is a transcript the user
    // believes they deleted.
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(chatTranscriptSnapshots)
        .where(
          and(
            eq(chatTranscriptSnapshots.orgId, ctx.orgId),
            eq(chatTranscriptSnapshots.eveSessionId, sessionId),
          ),
        ),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ ok: true });
    console.error("chat-snapshots DELETE failed", e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
