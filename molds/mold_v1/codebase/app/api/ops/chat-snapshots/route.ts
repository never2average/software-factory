import { NextRequest, NextResponse } from "next/server";
import { and, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { chatTranscriptSnapshots } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isEmptyStore } from "@/lib/pg-error";
import { accessForChildSession, accessForSession } from "@/lib/chat-session-access";
import { SNAPSHOT_VERSION, type TranscriptSnapshot } from "@/lib/chat-snapshot";
import {
  CHILD_COPY_MAX_BYTES,
  CHILD_COPY_PREFIX,
  CHILD_COPY_VERSION,
  childCopyBytes,
  childCopyKey,
  childCopyUsable,
  type ChildCopy,
} from "@/lib/child-copy";
import { serverStopwatch } from "@/lib/server-timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The transcript cache behind "reopening an old chat is very very slow".
 *
 *   GET    /api/ops/chat-snapshots?session=<eve session id>  — the cached transcript
 *   POST   /api/ops/chat-snapshots                           — store/replace one
 *   DELETE /api/ops/chat-snapshots?session=<eve session id>  — forget one (and its specialists' copies)
 *
 * With `kind=child` (query, or `kind: "child"` in the POST body) the same three verbs keep the SAVED COPY OF A
 * SPECIALIST'S FEED (lib/child-copy.ts): what the chat's Control Panel folded from a delegated session, so the next page
 * shows it without reading that session's stream from event 0. Same table, same workspace scope and row-level
 * security, same size cap, same never-move-backwards rule, under its own key (`child:<session>`, which no chat's own
 * read can name). Narrower access: the specialist's recorded owner only (lib/session-gate.ts
 * `readChildTranscriptAccess`), and every refusal is a 404, so nobody learns whose specialist a session is.
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
  // Server-Timing (lib/server-timing.ts): sign-in, the access check, the saved copy's read, and the total. The open's
  // record (lib/chat-open-timing.ts) keeps them beside the browser's own time for this request.
  const watch = serverStopwatch();
  const timed = <T extends Response>(res: T): T => {
    res.headers.set("server-timing", watch.header());
    return res;
  };
  const email = (await callerEmail(request))?.toLowerCase();
  watch.mark("auth");
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const db = getOpsDb();
  // No database configured is the JSON-fallback deployment: there is genuinely
  // no cache, and the caller falls back to a full replay.
  if (!db) return NextResponse.json({ snapshot: null });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "workspace unavailable" }, { status: 503 });
  if (ctx instanceof Response) return ctx;
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return NextResponse.json({ error: "session required" }, { status: 400 });
  if (isChild(request)) return getChildCopy(ctx.orgId, email, sessionId);

  try {
    const access = await accessForSession(ctx.orgId, email, sessionId);
    watch.mark("access");
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
    watch.mark("snapshot");
    // A miss is a legitimate answer with a legitimate consequence (full replay),
    // so it is `null` rather than a 404 the client would have to interpret.
    if (!row) return timed(NextResponse.json({ snapshot: null }));
    const snapshot: TranscriptSnapshot = {
      version: row.version,
      eveSessionId: row.eveSessionId,
      eventIndex: row.eventIndex,
      events: row.events ?? [],
      clientEvents: row.clientEvents ?? [],
      updatedAt: row.updatedAt?.getTime(),
    };
    return timed(NextResponse.json({ snapshot }));
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
  if (ctx instanceof Response) return ctx;
  const body: unknown = await request.json().catch(() => null);
  if ((body as { kind?: unknown } | null)?.kind === "child") return postChildCopy(ctx.orgId, email, body);
  const parsed = bodySchema.safeParse(body);
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
  if (ctx instanceof Response) return ctx;
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return NextResponse.json({ ok: false, error: "session required" }, { status: 400 });
  if (isChild(request)) return deleteChildCopy(ctx.orgId, email, sessionId);
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
    // …and the copies of its specialists' feeds, which are filed under it (see postChildCopy).
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(chatTranscriptSnapshots)
        .where(
          and(
            eq(chatTranscriptSnapshots.orgId, ctx.orgId),
            eq(chatTranscriptSnapshots.chatSessionId, sessionId),
            like(chatTranscriptSnapshots.eveSessionId, `${CHILD_COPY_PREFIX}%`),
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

/* ================================================================================================================ */
/* kind=child: the saved copy of a specialist's feed.                                                               */
/* ================================================================================================================ */

function isChild(request: NextRequest): boolean {
  return new URL(request.url).searchParams.get("kind") === "child";
}

/** Every refusal, whatever the reason: the same answer as a session nobody recorded. */
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

async function getChildCopy(orgId: string, email: string, sessionId: string): Promise<Response> {
  try {
    const access = await accessForChildSession(orgId, email, sessionId);
    if (!access.read) return notFound();
    const [row] = await withOrgRls(orgId, (tx) =>
      tx
        .select()
        .from(chatTranscriptSnapshots)
        .where(and(eq(chatTranscriptSnapshots.orgId, orgId), eq(chatTranscriptSnapshots.eveSessionId, childCopyKey(sessionId))))
        .limit(1),
    );
    if (!row) return NextResponse.json({ copy: null });
    const copy: ChildCopy = {
      version: row.version,
      sessionId,
      cursor: row.eventIndex,
      events: (row.events ?? []) as ChildCopy["events"],
    };
    // A row written under other rules is not a copy any more: answered as none, and replaced by the next harvest.
    return NextResponse.json({ copy: childCopyUsable(copy, sessionId) ? copy : null });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ copy: null });
    console.error("chat-snapshots GET (child) failed", e);
    return NextResponse.json({ error: "snapshot store unavailable" }, { status: 503 });
  }
}

const childBodySchema = z.object({
  kind: z.literal("child"),
  sessionId: z.string().min(1),
  version: z.number().int(),
  cursor: z.number().int().min(1),
  events: z.array(z.object({ i: z.number().int().min(0), line: z.string().min(1) })).min(1),
});

async function postChildCopy(orgId: string, email: string, body: unknown): Promise<Response> {
  const parsed = childBodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid" }, { status: 400 });
  const d = parsed.data;
  if (d.version !== CHILD_COPY_VERSION) return NextResponse.json({ ok: false, reason: "version" }, { status: 409 });
  const copy: ChildCopy = { version: d.version, sessionId: d.sessionId, cursor: d.cursor, events: d.events };
  // The writer's own shape: indexes increasing and below the cursor, ending on a session boundary. Anything else did
  // not come from lib/child-feed.ts and would only be refused by every reader.
  if (!childCopyUsable(copy, d.sessionId)) return NextResponse.json({ ok: false, reason: "shape" }, { status: 400 });
  const bytes = childCopyBytes(copy);
  if (bytes > CHILD_COPY_MAX_BYTES) return NextResponse.json({ ok: false, reason: "too-large", bytes }, { status: 413 });
  try {
    const access = await accessForChildSession(orgId, email, d.sessionId);
    if (!access.write || !access.rootSessionId) return notFound();
    const values = {
      orgId,
      eveSessionId: childCopyKey(d.sessionId),
      ownerEmail: email,
      // Filed under the chat it belongs to, so deleting the chat deletes it (see DELETE).
      chatSessionId: access.rootSessionId,
      version: d.version,
      eventIndex: d.cursor,
      events: d.events as unknown[],
      clientEvents: [],
      bytes,
      updatedAt: new Date(),
    };
    const stored = await withOrgRls(orgId, (tx) =>
      tx
        .insert(chatTranscriptSnapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [chatTranscriptSnapshots.orgId, chatTranscriptSnapshots.eveSessionId],
          // NEVER move a copy backwards: a tab that read less (a lost race, an older page) must not shrink it. A copy
          // the stream disagrees with is DELETED by its reader first (the seam rule), then written afresh.
          setWhere: sql`${chatTranscriptSnapshots.eventIndex} <= excluded.event_index`,
          set: values,
        })
        .returning({ id: chatTranscriptSnapshots.id }),
    );
    if (stored.length === 0) return NextResponse.json({ ok: false, reason: "older" }, { status: 409 });
    return NextResponse.json({ ok: true, bytes });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ ok: false, reason: "no-table" });
    console.error("chat-snapshots POST (child) failed", e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

async function deleteChildCopy(orgId: string, email: string, sessionId: string): Promise<Response> {
  try {
    const access = await accessForChildSession(orgId, email, sessionId);
    if (!access.write) return notFound();
    await withOrgRls(orgId, (tx) =>
      tx
        .delete(chatTranscriptSnapshots)
        .where(and(eq(chatTranscriptSnapshots.orgId, orgId), eq(chatTranscriptSnapshots.eveSessionId, childCopyKey(sessionId)))),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ ok: true });
    console.error("chat-snapshots DELETE (child) failed", e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
